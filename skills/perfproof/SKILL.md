---
name: perfproof
description: Measure before optimizing Node.js/JavaScript/TypeScript code. Use when the user asks to make code, a script, a build, a CLI or a test suite faster, investigates slowness or high CPU, or wants proof that a change improved performance. Profiles the real command to find the hot lines, then benchmarks before/after with a significance test.
---

# perfproof: measure, fix, prove

Never guess where time goes. Profile the real workload, fix what the profile shows, and report a
benchmark verdict, not an impression.

Run the CLI with `npx -y github:feresbr1/perfproof <command>` (Node.js 22.15+). Below, `perfproof`
stands for that.

## 1. Find a command that reproduces the slowness

Pick the smallest real command that shows the problem: `node scripts/build.js`, `npm test`,
`npx vitest run some.test.ts`, `node bin/cli.js --flag input.json`. It must be deterministic and take
roughly 0.2 s to 60 s. If the slow path needs input data, create a realistic input file first.

## 2. Save a baseline before changing anything

```sh
perfproof bench --save before -- <command>
```

This runs the command 1 + 10 times (`-n` to change) and stores the timings in
`.perfproof/baselines/before.json`. Every run must exit with code 0.

## 3. Profile

```sh
perfproof run -q -- <command>
```

`-q` hides the command's own output. The report lists:

- **Where the CPU time goes**: your code vs dependencies vs Node.js internals vs GC.
- **Hot lines**: file:line, enclosing function, self time and share, the code around it, and a hint
  when the line matches a known slow pattern. Start here.
- **Hot functions**: self time (spent in the function itself) and total time (including callees).
- **Notes**: e.g. heavy GC, time dominated by a dependency, or a mostly idle (I/O-bound) process.

Profiles cover every Node.js process the command starts (npm, test workers, child processes). Add
`--md` for a Markdown report, `--json` for the full data. A flame graph is saved to
`.perfproof/runs/<timestamp>/flamegraph.html`.

## 4. Fix the hottest code you own

- Work top-down on the hot lines in **your code**. A hint is a lead, not a diagnosis; read the code.
- Typical wins: Set/Map instead of `includes`/`indexOf`/`find` in loops, hoisting regexes, caches and
  invariant work out of loops, avoiding repeated `JSON.parse(JSON.stringify())`, sync I/O in loops,
  and quadratic spreading/concatenation.
- If dependencies dominate, look at how often and with what data your code calls them.
- If CPU time is far below wall time, the program is waiting (network, disk, timers): a CPU profile
  will not explain that part; say so.
- Keep behaviour identical. Run the project's tests after the change.

## 5. Prove it

```sh
perfproof bench --compare before -- <command>
```

The verdict line is one of:

- `FASTER: 2.59× faster than the baseline (-61.4% time, p < 0.0001)`
- `SLOWER: ...`
- `NO SIGNIFICANT DIFFERENCE (...)`: treat it as noise; do not claim an improvement.

Use `--fail-if-slower` in scripts to exit with code 1 on a significant slowdown. If runs vary by
more than 10% (perfproof prints a note), raise `-n`.

## 6. Report

Tell the user: the command measured, what the profile showed (top hot line and its share), what you
changed, and the bench verdict line with the numbers. Paste `perfproof bench --compare before --md`
output if they want a table. Do not round up or claim speed-ups the verdict does not support.

## Limits

- Node.js only (not Bun or Deno; not browser code, though a Chrome DevTools `.cpuprofile` can be
  analysed with `perfproof analyze file.cpuprofile`).
- Line numbers refer to the code Node.js ran. For TypeScript run with Node's built-in type stripping
  they match the source; for bundled or transpiled output they refer to the generated files.
- A process only writes its profile when it exits normally. perfproof turns an unhandled
  SIGTERM/SIGINT into a normal exit, so test-runner workers are captured on Linux and macOS. On
  Windows, killed workers cannot be captured: run Vitest with `--pool=threads` (worker threads are
  profiled) or profile a single test file.
- `run` disables V8 on-stack replacement for accurate line attribution, which can make long loops
  slightly slower while profiling. Use `bench` (no profiler) for timing claims.
