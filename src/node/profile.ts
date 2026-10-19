import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { analyzeProfiles, type Analysis, type AnalyzeOptions } from '../core/analyze';
import { lineHint } from '../core/hints';
import { fileFromUrl, PRELOAD_NAME } from '../core/paths';
import { parseCpuProfile, ProfileError, type NamedProfile } from '../core/profile';
import { commandLine, runCommand, type Spawned } from './command';

export interface ProfileRunOptions {
  argv: string[];
  cwd: string;
  /** Where the .cpuprofile files are written. */
  dir: string;
  /** Sampling interval in microseconds. */
  interval: number;
  /** Disable on-stack replacement so hot loops are attributed to their own line (default true). */
  precise: boolean;
  quiet: boolean;
}

export interface ProfileRun extends Spawned {
  profiles: NamedProfile[];
  /** Profiles that could not be read (e.g. a process killed while writing it). */
  skipped: string[];
}

/** Path form that survives NODE_OPTIONS parsing (which treats backslashes as escapes). */
function nodeOptionPath(p: string): string {
  return `"${p.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

/**
 * Run a command with the V8 CPU profiler switched on through NODE_OPTIONS, so every Node.js
 * process it starts (npm scripts, test workers, child processes) writes its own profile.
 */
export async function profileCommand(opts: ProfileRunOptions): Promise<ProfileRun> {
  mkdirSync(opts.dir, { recursive: true });
  const flags = [
    '--cpu-prof',
    `--cpu-prof-dir=${nodeOptionPath(opts.dir)}`,
    `--cpu-prof-interval=${Math.max(50, Math.round(opts.interval))}`,
  ];
  // Always preloaded: makes signal-terminated processes write their profile, and in precise mode
  // turns off on-stack replacement. V8 cannot walk the stack correctly through on-stack-replaced
  // frames, which makes time inside a hot loop show up on the caller's line. Only some V8 flags are
  // allowed in NODE_OPTIONS, so this one is set from the preload.
  const preload = join(opts.dir, PRELOAD_NAME);
  writeFileSync(preload, preloadSource(opts.precise));
  flags.push(`--require=${nodeOptionPath(preload)}`);
  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...flags].filter(Boolean).join(' '),
  };
  const result = await runCommand(opts.argv, {
    cwd: opts.cwd,
    env,
    output: opts.quiet ? 'hide' : 'inherit',
  });
  rmSync(preload, { force: true });
  await settle(opts.dir);
  const profiles: NamedProfile[] = [];
  const skipped: string[] = [];
  for (const f of readdirSync(opts.dir)
    .filter((f) => f.endsWith('.cpuprofile'))
    .sort()) {
    try {
      profiles.push(...readProfiles([join(opts.dir, f)]));
    } catch {
      skipped.push(f);
    }
  }
  return { ...result, profiles, skipped };
}

/**
 * The command can finish while its children are still exiting and writing their profiles (an
 * orphaned or just-killed worker). Wait until the folder stops changing, for at most ~3 seconds.
 */
async function settle(dir: string): Promise<void> {
  const snapshot = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.cpuprofile'))
      .map((f) => `${f}:${statSync(join(dir, f)).size}`)
      .sort()
      .join('|');
  let last = snapshot();
  let stable = 0;
  for (let waited = 0; waited < 3000 && stable < 2; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
    const now = snapshot();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

export function preloadSource(precise: boolean): string {
  return `'use strict';
${precise ? "require('node:v8').setFlagsFromString('--no-use-osr');" : ''}
// --cpu-prof writes the profile on a normal exit only. Test runners stop workers with SIGTERM, so
// turn an otherwise unhandled SIGTERM/SIGINT into a normal exit (programs with their own handlers
// keep them).
if (require('node:worker_threads').isMainThread) {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.on(signal, () => {
      if (process.listenerCount(signal) === 1) process.exit(code);
    });
  }
}
`;
}

/** Load every .cpuprofile in the given files and directories. */
export function readProfiles(paths: string[]): NamedProfile[] {
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new ProfileError(`Not found: ${p}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith('.cpuprofile')) files.push(join(p, f));
      }
    } else {
      files.push(p);
    }
  }
  return files.map((file) => {
    try {
      return { name: profileName(file), profile: parseCpuProfile(readFileSync(file, 'utf8')) };
    } catch (err) {
      throw new ProfileError(`${file}: ${(err as Error).message}`);
    }
  });
}

/** CPU.20260101.120000.<pid>.<thread>.<seq>.cpuprofile -> "pid 123" / "pid 123/2" */
function profileName(file: string): string {
  const base = file.split(/[\\/]/).pop()!;
  const m = /^CPU\.\d+\.\d+\.(\d+)\.(\d+)\.\d+\.cpuprofile$/.exec(base);
  if (m) return m[2] === '0' ? `pid ${m[1]}` : `pid ${m[1]}/${m[2]}`;
  return base.replace(/\.cpuprofile$/, '');
}

/** Analyze, then attach source snippets and hints for hot lines in local files. */
export function analyzeWithSource(profiles: NamedProfile[], opts: AnalyzeOptions): Analysis {
  const cache = new Map<string, string[] | null>();
  const source = (url: string) => {
    if (!cache.has(url)) {
      const file = fileFromUrl(url);
      let lines: string[] | null = null;
      if (file && !/[\\/]node_modules[\\/]/.test(file)) {
        try {
          lines = readFileSync(file, 'utf8').split(/\r?\n/);
        } catch {
          lines = null;
        }
      }
      cache.set(url, lines);
    }
    return cache.get(url);
  };
  const analysis = analyzeProfiles(profiles, { ...opts, source });
  for (const ls of analysis.lines.slice(0, 20)) {
    if (ls.category !== 'user') continue;
    const src = source(ls.url);
    if (!src || ls.line < 1 || ls.line > src.length) continue;
    const start = Math.max(1, ls.line - 2);
    const end = Math.min(src.length, ls.line + 2);
    ls.snippet = {
      start,
      code: src.slice(start - 1, end).map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l)),
    };
    ls.hint = lineHint(src[ls.line - 1]!);
  }
  return analysis;
}

export function newRunDir(cwd: string): string {
  const base = resolve(cwd, '.perfproof');
  mkdirSync(base, { recursive: true });
  // Keep profiles out of git without touching the user's .gitignore.
  const ignore = join(base, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let dir = join(base, 'runs', stamp);
  for (let i = 2; existsSync(dir); i++) dir = join(base, 'runs', `${stamp}-${i}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { commandLine };
