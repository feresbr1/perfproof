import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { benchMarkdown, benchText, markdownReport, textReport } from '../core/report';
import { compare } from '../core/stats';
import { ProfileError } from '../core/profile';
import { bench, BenchError, loadBaseline, saveBaseline } from '../node/bench';
import { analysisToHtml } from '../node/html';
import {
  analyzeWithSource,
  commandLine,
  newRunDir,
  profileCommand,
  readProfiles,
} from '../node/profile';
import type { Analysis } from '../core/analyze';

declare const __VERSION__: string | undefined;
declare const __GUIDE__: string | undefined;

export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
  isTTY: boolean;
}

const HELP = `perfproof ${VERSION}: find out why Node.js code is slow, and prove a fix made it faster.

Usage
  perfproof run [options] -- <command...>      Profile a command and every Node.js process it starts
  perfproof bench [options] -- <command...>    Time a command, save a baseline, compare against it
  perfproof analyze <file|dir>... [options]    Report on existing .cpuprofile files
  perfproof guide                              The workflow, written for coding agents

run / analyze options
  --top <n>          Hot lines and functions to show (default 8)
  --json             Print the full report as JSON
  --md               Print the report as Markdown
  --html <file>      (analyze) Also write a flame graph HTML file
  --interval <us>    (run) Sampling interval in microseconds (default 500)
  --no-precise       (run) Keep V8's on-stack replacement (faster, less exact line attribution)
  -q, --quiet        (run) Hide the command's own output
  --no-save          (run) Do not keep the run in .perfproof/runs/
  --open             Open the flame graph in a browser

bench options
  -n, --runs <n>     Timed runs (default 10)
  -w, --warmup <n>   Untimed warm-up runs (default 1)
  --save [name]      Save the timings as a baseline (default name: baseline)
  --compare [name]   Compare against a saved baseline (Welch's t-test)
  --fail-if-slower   Exit with code 1 when significantly slower than the baseline
  --show-output      Show the command's output
  --json, --md       Machine-readable output

Examples
  perfproof run -- node scripts/build.js
  perfproof run -- npm test
  perfproof bench --save before -- node scripts/build.js
  # ...change the code...
  perfproof bench --compare before -- node scripts/build.js

Docs: https://github.com/feresbr1/perfproof
`;

export class UsageError extends Error {
  override name = 'UsageError';
}

interface Parsed {
  flags: Map<string, string | true>;
  positionals: string[];
  command: string[];
}

const VALUE_FLAGS = new Set(['--top', '--interval', '--html', '-n', '--runs', '-w', '--warmup']);
const OPTIONAL_VALUE_FLAGS = new Set(['--save', '--compare']);
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--md',
  '--no-precise',
  '-q',
  '--quiet',
  '--no-save',
  '--open',
  '--fail-if-slower',
  '--show-output',
  '-h',
  '--help',
  '-v',
  '--version',
]);

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      command = argv.slice(i + 1);
      break;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '--') throw new UsageError(`${name} needs a value.`);
      flags.set(name, value);
    } else if (OPTIONAL_VALUE_FLAGS.has(name)) {
      if (eq > 0) flags.set(name, arg.slice(eq + 1));
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-'))
        flags.set(name, argv[++i]!);
      else flags.set(name, true);
    } else if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (arg.startsWith('-') && arg.length > 1) {
      throw new UsageError(`Unknown option: ${arg}. Put the command to run after "--".`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals, command };
}

function intFlag(p: Parsed, names: string[], fallback: number, min: number): number {
  for (const n of names) {
    const v = p.flags.get(n);
    if (typeof v === 'string') {
      const x = Number(v);
      if (!Number.isInteger(x) || x < min)
        throw new UsageError(`${n} must be a whole number ≥ ${min}.`);
      return x;
    }
  }
  return fallback;
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`perfproof: ${err.message}\nRun "perfproof --help" for usage.\n`);
      return 2;
    }
    if (err instanceof ProfileError || err instanceof BenchError) {
      io.err(`perfproof: ${err.message}\n`);
      return 2;
    }
    io.err(`perfproof: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    io.out(HELP);
    return 0;
  }
  if (sub === '-v' || sub === '--version') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (sub === 'guide') {
    io.out(typeof __GUIDE__ === 'string' ? __GUIDE__ : 'See skills/perfproof/SKILL.md\n');
    return 0;
  }
  if (sub === 'run' || sub === '--') return run(parseArgs(sub === '--' ? argv : rest), io);
  if (sub === 'bench') return benchCmd(parseArgs(rest), io);
  if (sub === 'analyze') return analyze(parseArgs(rest), io);
  throw new UsageError(
    `Unknown command "${sub}". Did you mean: perfproof run -- ${commandLine(argv)}`,
  );
}

function emit(analysis: Analysis, p: Parsed, io: Io, savedTo?: string): void {
  const top = intFlag(p, ['--top'], 8, 1);
  if (p.flags.has('--json')) io.out(JSON.stringify(analysis, null, 2) + '\n');
  else if (p.flags.has('--md')) io.out(markdownReport(analysis, { top }));
  else io.out(textReport(analysis, { top, savedTo }));
}

async function run(p: Parsed, io: Io): Promise<number> {
  const argv = p.command.length ? p.command : p.positionals;
  if (!argv.length) throw new UsageError('Nothing to run. Example: perfproof run -- node app.js');
  if (!supportsCpuProfInNodeOptions(process.versions.node)) {
    throw new UsageError(
      `perfproof run needs Node.js 22.15 or newer (this is ${process.version}): older versions do not allow --cpu-prof in NODE_OPTIONS, which is how child processes get profiled.`,
    );
  }
  const save = !p.flags.has('--no-save');
  const dir = save ? newRunDir(io.cwd) : mkdtempSync(join(tmpdir(), 'perfproof-'));
  const command = commandLine(argv);
  io.err(`perfproof: profiling ${command}\n`);
  try {
    const result = await profileCommand({
      argv,
      cwd: io.cwd,
      dir,
      interval: intFlag(p, ['--interval'], 500, 50),
      precise: !p.flags.has('--no-precise'),
      quiet: p.flags.has('-q') || p.flags.has('--quiet'),
    });
    if (result.profiles.length === 0) {
      const failed =
        result.exitCode !== 0 ? ` The command exited with code ${result.exitCode}.` : '';
      io.err(
        `perfproof: no Node.js process wrote a profile.${failed} perfproof profiles programs run by Node.js 22.15+ (node, npm, npx, test runners); Bun and Deno are not supported.\n`,
      );
      if (result.tail) io.err(result.tail);
      return 2;
    }
    if (result.skipped.length) {
      io.err(`perfproof: skipped ${result.skipped.length} incomplete profile(s): ${result.skipped.join(', ')}
`);
    }
    const analysis = analyzeWithSource(result.profiles, {
      root: io.cwd,
      command,
      wallMs: result.wallMs,
      exitCode: result.exitCode,
    });
    analysis.createdAt = new Date().toISOString();
    const html = join(dir, 'flamegraph.html');
    if (save) {
      writeFileSync(join(dir, 'report.json'), JSON.stringify(analysis, null, 2) + '\n');
      writeFileSync(join(dir, 'report.md'), markdownReport(analysis));
      writeFileSync(html, analysisToHtml(analysis));
    }
    if (result.exitCode !== 0 && result.tail && !p.flags.has('--json')) {
      io.err(
        `perfproof: the command exited with code ${result.exitCode}. Last output:\n${result.tail}\n`,
      );
    }
    emit(analysis, p, io, save ? relative(io.cwd, dir) || '.' : undefined);
    if (p.flags.has('--open')) {
      if (save) openFile(html);
      else io.err('perfproof: --open needs a saved run (drop --no-save).\n');
    }
    return result.exitCode ?? 1;
  } finally {
    if (!save) rmSync(dir, { recursive: true, force: true });
  }
}

async function analyze(p: Parsed, io: Io): Promise<number> {
  const paths = [...p.positionals, ...p.command];
  if (!paths.length) throw new UsageError('Give one or more .cpuprofile files or folders.');
  const profiles = readProfiles(paths.map((x) => resolve(io.cwd, x)));
  if (!profiles.length) throw new ProfileError('No .cpuprofile files found there.');
  const analysis = analyzeWithSource(profiles, { root: io.cwd });
  const html = p.flags.get('--html');
  if (typeof html === 'string') {
    const file = resolve(io.cwd, html);
    writeFileSync(file, analysisToHtml(analysis));
    io.err(`perfproof: wrote ${html}\n`);
    if (p.flags.has('--open')) openFile(file);
  }
  emit(analysis, p, io);
  return 0;
}

async function benchCmd(p: Parsed, io: Io): Promise<number> {
  const argv = p.command.length ? p.command : p.positionals;
  if (!argv.length)
    throw new UsageError('Nothing to time. Example: perfproof bench -- node app.js');
  const runs = intFlag(p, ['-n', '--runs'], 10, 2);
  const warmup = intFlag(p, ['-w', '--warmup'], 1, 0);
  const saveName = p.flags.get('--save');
  const compareName = p.flags.get('--compare');
  const baseline =
    compareName === undefined
      ? undefined
      : {
          // A baseline given as a file path is labelled by its file name: base.json -> "base".
          name: compareName === true ? 'baseline' : basename(compareName).replace(/\.json$/, ''),
          result: loadBaseline(io.cwd, compareName === true ? 'baseline' : compareName),
        };

  io.err(`perfproof: timing ${commandLine(argv)} (${warmup} warm-up + ${runs} runs)\n`);
  const result = await bench({
    argv,
    cwd: io.cwd,
    runs,
    warmup,
    showOutput: p.flags.has('--show-output'),
    onProgress: io.isTTY ? (d, t) => io.err(`\r  run ${d}/${t}${d === t ? '\n' : ''}`) : undefined,
  });

  const base = baseline && { ...baseline, cmp: compare(baseline.result.runs, result.runs) };
  if (base && base.result.command !== result.command) {
    io.err(`perfproof: note: the baseline was recorded for "${base.result.command}".\n`);
  }
  if (p.flags.has('--json')) {
    io.out(
      JSON.stringify(
        {
          ...result,
          baseline: base ? { name: base.name, ...base.result, comparison: base.cmp } : undefined,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (p.flags.has('--md')) {
    io.out(benchMarkdown(result, base));
  } else {
    io.out(benchText(result, base));
  }
  if (saveName !== undefined) {
    const name = saveName === true ? 'baseline' : saveName;
    const file = saveBaseline(io.cwd, name, result);
    io.err(`perfproof: saved baseline "${name}" (${relative(io.cwd, file)})\n`);
  }
  if (base && base.cmp.verdict === 'slower' && p.flags.has('--fail-if-slower')) return 1;
  return 0;
}

/** --cpu-prof became allowed in NODE_OPTIONS in Node.js 22.15.0. */
export function supportsCpuProfInNodeOptions(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 15);
}

function openFile(file: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', file]]
      : process.platform === 'darwin'
        ? ['open', [file]]
        : ['xdg-open', [file]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}
