# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-20

### Added

- GitHub Action: `uses: feresbr1/perfproof@v1` benchmarks a pull request against its base branch
  in the same job, fails it when it is significantly slower, and adds the hot lines to the job
  summary.

### Changed

- A baseline given as a file path (`--compare path/to/base.json`) is labelled by its file name.

## [1.0.0] - 2026-10-19

### Added

- `perfproof run`: profiles a command and every Node.js process and worker thread it starts
  (via `--cpu-prof` in `NODE_OPTIONS`), with accurate line attribution (on-stack replacement turned
  off while profiling) and capture of workers stopped by SIGTERM/SIGINT on Linux and macOS.
- Reports: hot lines with source snippets, enclosing function and pattern hints; hot functions with
  self and total time; CPU split by your code, dependencies, Node.js internals, native code and GC;
  per-process summary; notes. Text, Markdown, JSON, and a self-contained flame graph HTML.
- `perfproof bench`: warm-up and timed runs, mean ± 95% CI, saved baselines, Welch's t-test verdict,
  `--fail-if-slower`.
- `perfproof analyze` for existing `.cpuprofile` files (Node.js or Chrome DevTools).
- `perfproof guide` and an agent skill (`npx skills add feresbr1/perfproof`).
- Web viewer with a real demo report and drag-and-drop `.cpuprofile` loading.

[1.0.1]: https://github.com/feresbr1/perfproof/releases/tag/v1.0.1
[1.0.0]: https://github.com/feresbr1/perfproof/releases/tag/v1.0.0
