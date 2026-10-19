import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BenchResult } from '../core/report';
import { summarize } from '../core/stats';
import { commandLine, runCommand } from './command';

export interface BenchOptions {
  argv: string[];
  cwd: string;
  runs: number;
  warmup: number;
  showOutput: boolean;
  onProgress?: (done: number, total: number) => void;
}

export class BenchError extends Error {
  override name = 'BenchError';
}

/** Time a command `runs` times (after `warmup` untimed runs). Every run must succeed. */
export async function bench(opts: BenchOptions): Promise<BenchResult> {
  const total = opts.warmup + opts.runs;
  const runs: number[] = [];
  for (let i = 0; i < total; i++) {
    const r = await runCommand(opts.argv, {
      cwd: opts.cwd,
      output: opts.showOutput ? 'inherit' : 'hide',
    });
    if (r.exitCode !== 0) {
      const why = r.signal ? `was killed by ${r.signal}` : `exited with code ${r.exitCode}`;
      throw new BenchError(
        `The command ${why} on run ${i + 1}. Benchmarks only count successful runs.${r.tail ? `\n\nLast output:\n${r.tail.trimEnd()}` : ''}`,
      );
    }
    if (i >= opts.warmup) runs.push(r.wallMs);
    opts.onProgress?.(i + 1, total);
  }
  return {
    command: commandLine(opts.argv),
    runs,
    summary: summarize(runs),
    failures: 0,
    node: process.version,
    createdAt: new Date().toISOString(),
  };
}

/** A name like "before" maps to .perfproof/baselines/before.json; a path is used as is. */
export function baselinePath(cwd: string, name: string): string {
  if (/[\\/]|\.json$/.test(name)) return resolve(cwd, name);
  if (!/^[\w.-]+$/.test(name)) {
    throw new BenchError(`Baseline names may only use letters, digits, ".", "-" and "_": ${name}`);
  }
  return join(resolve(cwd, '.perfproof'), 'baselines', `${name}.json`);
}

export function saveBaseline(cwd: string, name: string, result: BenchResult): string {
  const file = baselinePath(cwd, name);
  mkdirSync(dirname(file), { recursive: true });
  const base = resolve(cwd, '.perfproof');
  const ignore = join(base, '.gitignore');
  if (file.startsWith(base) && !existsSync(ignore)) writeFileSync(ignore, '*\n');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return file;
}

export function loadBaseline(cwd: string, name: string): BenchResult {
  const file = baselinePath(cwd, name);
  if (!existsSync(file)) {
    throw new BenchError(
      `No baseline "${name}" (${file}). Save one first: perfproof bench --save ${name} -- <command>`,
    );
  }
  let data: BenchResult;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as BenchResult;
  } catch {
    throw new BenchError(`The baseline ${file} is not valid JSON.`);
  }
  if (
    !Array.isArray(data.runs) ||
    data.runs.length === 0 ||
    !data.runs.every((x) => typeof x === 'number')
  ) {
    throw new BenchError(`The baseline ${file} has no timings.`);
  }
  return { ...data, summary: summarize(data.runs) };
}
