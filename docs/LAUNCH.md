# Launch kit

Nothing here has been posted yet. Every channel needs the maintainer's account; follow each
community's rules on self-promotion and post in one place at a time.

**Assets:** https://feresbr1.github.io/perfproof/ · demo report https://feresbr1.github.io/perfproof/#/demo ·
screenshots in `docs/images/` (`report.png`, `flamegraph.png`, `site.png`) · social card
`public/og.png` · real terminal output in the README.

## One-liners

- **perfproof**: find the slow line, prove the fix. A Node.js CPU profiler that answers with hot
  lines and code, plus before/after benchmarks with a significance test.
- `perfproof run -- npm test` profiles every Node.js process in the tree. `perfproof bench --compare before`
  tells you if your fix is real or noise.
- Give your coding agent a profiler: it stops guessing and reports "2.88× faster, p < 0.0001".

## GitHub release announcement

> **perfproof 1.0**: a CPU profiler for Node.js that answers with the lines to fix.
>
> `npx github:feresbr1/perfproof run -- <any command>` profiles every Node.js process the command
> starts (npm scripts, test runners, workers, child processes), ranks the hot lines, shows the code
> around them and flags common slow patterns. `perfproof bench --save before` /
> `--compare before` then gives a Welch's t-test verdict on your change. Every run also writes a
> self-contained flame graph HTML file. There is an agent skill (`npx skills add feresbr1/perfproof`)
> so coding agents measure before they optimise. One file, no dependencies, MIT. Requires Node.js 22.15+.

## Show HN

**Title:** `Show HN: Perfproof – find the slow line in Node.js, then prove the fix`

> I wanted something between `node --cpu-prof` (a JSON call tree you explore by hand) and
> hyperfine (timings, but no idea _why_). perfproof wraps any command, `perfproof run -- npm test`,
> and prints the lines that burned the most CPU with the code around them, across every Node.js
> process in the tree. That last part only became possible recently: Node.js accepts `--cpu-prof` in
> `NODE_OPTIONS` since 22.15 / 23.9 (nodejs/node#56944 has the backstory: profiling monorepo builds
> made of thousands of processes started by npm scripts).
>
> Two things surprised me while building it. First, a plain `--cpu-prof` often blames the wrong
> line: when V8 on-stack-replaces a hot loop, the samples land on the line that _called_ the
> function. In my test, 596 samples sat on `console.log(dedupe(data).length)` instead of the
> `out.includes(x)` inside `dedupe`. Turning off OSR from a preload fixes it (`--no-use-osr` isn't
> allowed in NODE_OPTIONS, so it's set with `v8.setFlagsFromString`). Second, test runners stop
> their workers with SIGTERM, and V8 only writes a profile on a normal exit, so the preload turns an
> unhandled SIGTERM into `process.exit()` (works on Linux/macOS; on Windows killed workers can't be
> captured, documented).
>
> Then `perfproof bench --save before` / `--compare before` runs the command N times and applies
> Welch's t-test, so "it feels faster" becomes "2.88× faster, p < 0.0001" or "no significant
> difference". The text output is deliberately short so coding agents can use it; there's a skill
> for that. Web viewer for any .cpuprofile (nothing uploaded): https://feresbr1.github.io/perfproof/

## Reddit

| Community                             | Angle                                                                                    | Notes                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| r/node                                | `perfproof run -- npm test`, the OSR line-attribution finding                            | Self-promotion limits apply; lead with the technical finding |
| r/javascript                          | Before/after with real numbers on the log-report example                                 | Link the demo report                                         |
| r/typescript                          | Works with Node's built-in type stripping (`node app.ts`), lines map to the `.ts` source |                                                              |
| r/webdev                              | Profiling slow builds and test suites                                                    | Showoff Saturday rules                                       |
| r/ClaudeAI, r/cursor, r/ChatGPTCoding | "Give your agent a profiler": a real agent session using the skill                       | Record a real session first                                  |
| r/programming                         | The OSR misattribution write-up                                                          | Only as an article, not a product post                       |

## Other channels

- **Write-up for a blog / dev.to / Hashnode:** "Your Node.js CPU profile is blaming the wrong line"
  (the OSR finding with the minimal reproduction from `docs/PRODUCT_DECISIONS.md`).
- **Node.js community:** a comment on nodejs/node#56944 only if it adds value (for example the SIGTERM
  caveat), not as an advert.
- **Awesome lists:** awesome-nodejs (Debugging / Profiling), awesome-claude-code, awesome-agent-skills,
  skills directories that index `SKILL.md` repos.
- **Test-runner communities:** Vitest/Jest discussions about slow suites, pointing at the
  `--pool=threads` note for Windows.
- **X / Bluesky / Mastodon:** the bench verdict screenshot + the hot-line screenshot, one post each.

## Keywords and search queries

`node.js profiler` · `node cpu profile` · `cpuprofile viewer` · `node --cpu-prof` ·
`profile npm test` · `profile child processes node` · `NODE_OPTIONS cpu-prof` · `flame graph node.js` ·
`find slow code node.js` · `why is my node script slow` · `benchmark before after` ·
`hyperfine alternative node` · `clinic.js alternative` · `0x alternative` · `speedscope cpuprofile` ·
`vitest slow tests profile` · `profile typescript node` · `claude code skill performance` ·
`ai agent profiler`

## Remaining actions (need the maintainer)

- [ ] Post Show HN (weekday morning US time) and answer questions.
- [ ] One Reddit post in r/node, later r/javascript.
- [ ] Submit to awesome-nodejs and an agent-skills directory.
- [ ] Record a short real agent session with the skill for the README and social posts.
