# Contributing to perfproof

Welcome contributions, roughly in order of value:

1. **Accuracy fixes.** A profile where perfproof blames the wrong line or function is a bug. Please
   attach the `.cpuprofile` (or a small program that reproduces it) and the Node.js version.
2. **New line hints** in `src/core/hints.ts`, for slow patterns you have actually seen on hot lines.
   Each hint needs a test in `test/core.test.ts` and should be phrased as a lead, not a diagnosis.
3. **Real-world reports**: how perfproof behaves with your test runner, bundler or monorepo tool.

## Development

Requires Node.js 22.15+.

```sh
npm install
npm run check                 # format, lint, typecheck, unit + CLI tests, build
npx playwright install chromium
npm run test:e2e              # the web viewer, desktop and mobile
npm run dev                   # the website on http://localhost:5173/perfproof/
```

## Layout

```
src/core/     profile parsing, aggregation (analyze.ts), stats, hints, text/Markdown reports
src/node/     running commands, profiling via NODE_OPTIONS, benchmarks, HTML export
src/cli/      argument parsing and commands
src/viewer/   the report + flame graph UI (used by the site and by flamegraph.html)
src/site/     the website
skills/       the agent skill
examples/     programs used for the demo and CI
```

## Rules

- Never print a number perfproof did not measure. Reports and docs show real output only.
- The text report is read by people and by coding agents: keep it short, ranked and stable.
- Rebuild and commit `dist/cli/` (`npm run build:cli`) when core, node, CLI or viewer code changes.
- If you change what the profile shows for `examples/log-report`, refresh the demo with
  `npm run build:cli && npm run demo-data`.

By contributing you agree that your contributions are licensed under the MIT License and that you
will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
