# Product decisions

## The bet

**perfproof: a CPU profiler for Node.js that answers with hot lines instead of raw data, plus a
benchmark that says whether a fix really helped.** Built so that a developer, or a coding agent
working for one, can go from "this is slow" to "this is 2.9× faster, p < 0.0001" in one loop.

## Why now

1. **Profiling whole command trees just became possible.** Until recently `--cpu-prof` was rejected
   in `NODE_OPTIONS`, so you could not profile the processes behind `npm test` or a monorepo build
   without rewriting how they are launched. Someone hit exactly that while profiling monorepo builds
   where "thousands of individual NodeJS processes are invoked via npm scripts"
   ([nodejs/node#56944](https://github.com/nodejs/node/issues/56944)). The fix,
   [nodejs/node#57018](https://github.com/nodejs/node/pull/57018), shipped in Node.js 23.9.0 and
   22.15.0 (I checked: 22.14.0 still rejects it, 22.15.0 accepts it). Tools have not caught up.
2. **The raw output is hard to act on.** A `.cpuprofile` is a JSON call tree. Reading it means
   opening DevTools or [speedscope](https://github.com/jlfwong/speedscope) (6.8k★) and exploring
   by hand. Nothing turns it into "line 24 is 60% of your CPU, here is the code" in a terminal.
3. **Coding agents optimise by guessing.** Agents can run commands and read text, but no tool gives
   them a short, ranked, text-first profile. Searching GitHub for profiler MCP servers in October
   2026 finds almost nothing for JavaScript (the top "profiler mcp" results are unrelated or for other
   stacks, e.g. spark-profiler-mcp with 6★). Debugger MCPs exist (devtools-debugger-mcp, 350★), so
   the agent-tooling niche is real, but profiling is a gap.
4. **"Is it faster?" is usually answered by one run.** [hyperfine](https://github.com/sharkdp/hyperfine)
   (29.1k★, active) shows how much people value proper benchmarking, but it does not profile, and
   comparing against a saved baseline from before your change is a manual step.

## Things I verified while building

- `node --cpu-prof` attributes time in a hot loop to the **caller's** line when V8 has used
  on-stack replacement (OSR) on that loop: in a test, 596 samples landed on
  `console.log(dedupe(data).length)` instead of the `out.includes(x)` line inside `dedupe`.
  Turning off inlining did not fix it; `--no-use-osr` did (575 samples on the correct line).
  That flag is not allowed in `NODE_OPTIONS`, so perfproof sets it from a `--require` preload via
  `v8.setFlagsFromString`. This is the single most important accuracy detail in the product.
- Profiles are only written on a normal exit. Test runners stop workers with SIGTERM (Vitest's
  forks pool calls `fork.kill()`), so their profiles were lost. The preload turns an otherwise
  unhandled SIGTERM/SIGINT into `process.exit()`; verified on Linux (Docker, Node 22). On Windows
  `kill()` terminates the process without a signal handler, so this cannot work there; documented,
  with `--pool=threads` as the workaround (worker threads are profiled).
- A parent can finish while a killed child is still writing its profile, so the run waits until the
  profile folder stops changing (max ~3 s) and skips files that are still incomplete.
- TypeScript run through Node's built-in type stripping keeps line numbers, so hot lines point at the
  right `.ts` source lines.

## Candidates considered

|   # | Idea                                                                                        | Evidence checked                                                                                                         | Verdict                                                                                             |
| --: | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
|   1 | **perfproof**: profile command trees, hot lines with code, baseline benchmarks, agent skill | nodejs/node#56944 and #57018; no text-first JS profiler for agents found; hyperfine/speedscope show demand for the parts | **Chosen**                                                                                          |
|   2 | Coding-agent session replay viewer                                                          | [simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) (1.7k★) and others already do it     | Crowded                                                                                             |
|   3 | Modern successor to git-history (animated file history)                                     | [pomber/git-history](https://github.com/pomber/git-history) has 13.7k★, last push 2024-10                                | Strong demand, but mostly a design exercise over the GitHub API; kept as a fallback                 |
|   4 | Another flame graph viewer                                                                  | speedscope (6.8k★, active), Chrome DevTools                                                                              | Solved                                                                                              |
|   5 | Command benchmarking CLI                                                                    | hyperfine (29.1k★, active)                                                                                               | Solved alone; combined with profiling it is perfproof's step 3                                      |
|   6 | JS micro-benchmark library                                                                  | [tinybench](https://github.com/tinylibs/tinybench) (2.4k★), [mitata](https://github.com/evanwashere/mitata) (2.5k★)      | Solved                                                                                              |
|   7 | Debugger bridge for agents                                                                  | [devtools-debugger-mcp](https://github.com/ScriptedAlchemy/devtools-debugger-mcp) (350★)                                 | Exists; profiling is the gap                                                                        |
|   8 | clinic.js-style doctor                                                                      | [node-clinic](https://github.com/clinicjs/node-clinic) (6k★), last push 2024-09                                          | Big scope (event loop, I/O, heap); perfproof covers the CPU part well instead of everything loosely |
|   9 | Flame graphs for Node via `perf`                                                            | [0x](https://github.com/davidmarkclements/0x) (3.6k★)                                                                    | Viewer-centric, no line ranking or benchmarks                                                       |
|  10 | CI performance-regression action                                                            | [github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark) (1.3k★)                           | Exists; also this account's Actions are disabled, so it could not be demonstrated                   |
|  11 | Heap snapshot / leak finder for agents                                                      | Snapshots are large and leaks need scenario scripts                                                                      | Hard to make reliable and fast for a first version                                                  |
|  12 | Native-code profilers for agents (Rust, C++)                                                | [samply](https://github.com/mstange/samply) (4.5k★), [flamegraph-rs](https://github.com/flamegraph-rs/flamegraph) (6k★)  | Different audiences per language; JS has the largest one                                            |
|  13 | Async / event-loop delay profiler                                                           | Waiting time is invisible to CPU profiles; needs async_hooks tracing                                                     | Valuable but harder to explain in 10 seconds                                                        |
|  14 | Node CLI startup-time analyzer (require graph)                                              | Module loading already shows up in a CPU profile                                                                         | Narrower subset of #1                                                                               |
|  15 | Bundle size analyzer                                                                        | webpack-bundle-analyzer, vite-bundle-visualizer and others                                                               | Crowded                                                                                             |
|  16 | Terminal UI designer                                                                        | No requests or discussions found                                                                                         | No demand evidence                                                                                  |

## Why perfproof wins on the criteria

- **Demand**: a real, specific complaint in Node's own tracker, a large audience for each half
  (benchmarking, flame graphs), and a fresh platform capability almost no tool uses yet.
- **Differentiation**: whole command trees, exact line attribution (the OSR fix), hot lines with code
  and hints, and a statistical before/after verdict, in one zero-dependency file. Text output is
  designed for agents; the HTML report for humans.
- **Time to value**: `npx github:feresbr1/perfproof run -- node app.js`, no install or config.
- **Shareability**: the bench verdict ("2.9× faster, p < 0.0001") and the self-contained
  `flamegraph.html` are things people paste into PRs.
- **Maintenance**: built on the stable `.cpuprofile` format and documented Node flags.

## Scope of v1.0

- `run`: profile any command and its Node.js children, merge profiles, rank hot lines and functions,
  attach code and hints, save text/Markdown/JSON/HTML in a self-ignoring `.perfproof/` folder.
- `bench`: warm-up, N runs, mean ± 95% CI, saved baselines, Welch's t-test verdict,
  `--fail-if-slower` for scripts.
- `analyze`: the same report for existing `.cpuprofile` files (Node or Chrome DevTools).
- Web viewer (GitHub Pages): drop `.cpuprofile` files, see the report and flame graph; nothing is
  uploaded. Real demo from `examples/log-report`.
- Agent skill (`npx skills add feresbr1/perfproof`) and `perfproof guide`.

Not in v1: source maps, Bun/Deno, memory profiling, async waiting time.
