import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli/main';
import type { Analysis } from '../src/core/analyze';

const fixtures = resolve('test/fixtures');
const work = mkdtempSync(join(tmpdir(), 'perfproof-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function cli(argv: string[], cwd = fixtures) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    cwd,
    isTTY: false,
  });
  return { code, out, err };
}

describe('parseArgs', () => {
  it('splits options from the command after --', () => {
    const p = parseArgs(['--top', '3', '--json', '--', 'node', '--inspect', 'a.js']);
    expect(p.flags.get('--top')).toBe('3');
    expect(p.flags.get('--json')).toBe(true);
    expect(p.command).toEqual(['node', '--inspect', 'a.js']);
  });

  it('supports optional values', () => {
    expect(parseArgs(['--save', '--', 'x']).flags.get('--save')).toBe(true);
    expect(parseArgs(['--save', 'before', '--', 'x']).flags.get('--save')).toBe('before');
    expect(parseArgs(['--compare=old']).flags.get('--compare')).toBe('old');
  });

  it('rejects unknown options and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--top'])).toThrow(/needs a value/);
  });
});

describe('perfproof run', () => {
  it('profiles a parent and its child process and finds the hot line', async () => {
    const r = await cli(['run', '--json', '-q', '--no-save', '--', 'node', 'parent.js']);
    expect(r.code).toBe(0);
    const a = JSON.parse(r.out) as Analysis;
    expect(a.processes.length).toBe(2);
    expect(a.command).toBe('node parent.js');
    const top = a.lines[0]!;
    expect(top).toMatchObject({ file: 'child.js', line: 4, fn: 'unique', category: 'user' });
    expect(top.snippet!.code).toContain('    if (!seen.includes(i % 4000)) seen.push(i % 4000);');
    expect(top.hint).toMatch(/Set or Map/);
    expect(a.processes.find((p) => p.label === 'child.js')).toBeTruthy();
    expect(a.processes.some((p) => p.waitMs > 0)).toBe(true);
  });

  it('saves the run with reports, profiles and a flame graph, ignored by git', async () => {
    const dir = mkdtempSync(join(work, 'run-'));
    writeFileSync(join(dir, 'busy.js'), readFileSync(join(fixtures, 'child.js')));
    const r = await cli(['run', '-q', '--top', '3', '--', 'node', 'busy.js', '30000'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Hot lines (self time)');
    expect(r.out).toMatch(/1\. busy\.js:4 {2}unique/);
    expect(readFileSync(join(dir, '.perfproof', '.gitignore'), 'utf8')).toBe('*\n');
    const runs = readdirSync(join(dir, '.perfproof', 'runs'));
    expect(runs).toHaveLength(1);
    const files = readdirSync(join(dir, '.perfproof', 'runs', runs[0]!));
    expect(files).toEqual(expect.arrayContaining(['report.json', 'report.md', 'flamegraph.html']));
    expect(files.some((f) => f.endsWith('.cpuprofile'))).toBe(true);
    expect(files).not.toContain('perfproof-preload.cjs');
    const html = readFileSync(join(dir, '.perfproof', 'runs', runs[0]!, 'flamegraph.html'), 'utf8');
    expect(html).toContain('perfproof-data');
  });

  it('passes the exit code through and still reports', async () => {
    const r = await cli(['run', '-q', '--no-save', '--', 'node', 'fail.js']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('something broke');
    expect(r.out).toContain('exit code 3');
  });

  it('explains when nothing could be profiled', async () => {
    const r = await cli(['run', '--no-save', '--', 'definitely-not-a-command-xyz']);
    expect(r.code).toBeGreaterThan(0);
    expect(r.err).toMatch(/no Node\.js process wrote a profile|Command not found/);
  });

  it('prints Markdown with --md', async () => {
    const r = await cli(['run', '--md', '-q', '--no-save', '--', 'node', 'child.js', '20000']);
    expect(r.out).toContain('## perfproof profile: `node child.js 20000`');
    expect(r.out).toContain('### Hot lines');
  });

  it('requires a command', async () => {
    const r = await cli(['run']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Nothing to run');
  });
});

describe('perfproof analyze', () => {
  it('reports on existing .cpuprofile files and writes HTML', async () => {
    const dir = mkdtempSync(join(work, 'an-'));
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [
      '--cpu-prof',
      `--cpu-prof-dir=${dir}`,
      '--no-use-osr',
      join(fixtures, 'child.js'),
      '30000',
    ]);
    const r = await cli(['analyze', dir, '--html', join(dir, 'out.html'), '--top', '2'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('child.js:4');
    expect(existsSync(join(dir, 'out.html'))).toBe(true);
  });

  it('fails clearly on a bad file', async () => {
    const bad = join(work, 'bad.cpuprofile');
    writeFileSync(bad, '{"traceEvents": []}');
    const r = await cli(['analyze', bad]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Performance trace/);
  });
});

describe('perfproof bench', () => {
  it('labels a baseline given as a file path by its file name', async () => {
    const dir = mkdtempSync(join(work, 'bench-path-'));
    writeFileSync(join(dir, 'slow.js'), readFileSync(join(fixtures, 'child.js')));
    const file = join(dir, 'base.json');
    const save = await cli(
      ['bench', '-n', '2', '-w', '0', '--save', file, '--', 'node', 'slow.js', '2000'],
      dir,
    );
    expect(save.code).toBe(0);
    const cmp = await cli(
      ['bench', '-n', '2', '-w', '0', '--compare', file, '--md', '--', 'node', 'slow.js', '2000'],
      dir,
    );
    expect(cmp.code).toBe(0);
    expect(cmp.out).toContain('| Baseline (base) |');
  });

  it('saves a baseline and compares against it', async () => {
    const dir = mkdtempSync(join(work, 'bench-'));
    writeFileSync(join(dir, 'slow.js'), readFileSync(join(fixtures, 'child.js')));
    const save = await cli(
      ['bench', '-n', '3', '-w', '0', '--save', 'before', '--', 'node', 'slow.js', '60000'],
      dir,
    );
    expect(save.code).toBe(0);
    expect(save.out).toContain('3 runs:');
    expect(existsSync(join(dir, '.perfproof', 'baselines', 'before.json'))).toBe(true);

    const cmp = await cli(
      [
        'bench',
        '-n',
        '3',
        '-w',
        '0',
        '--compare',
        'before',
        '--json',
        '--',
        'node',
        'slow.js',
        '100',
      ],
      dir,
    );
    expect(cmp.code).toBe(0);
    const result = JSON.parse(cmp.out);
    expect(result.runs).toHaveLength(3);
    expect(result.baseline.name).toBe('before');
    expect(['faster', 'same']).toContain(result.baseline.comparison.verdict);
  });

  it('fails when a run fails, or the baseline is missing', async () => {
    const r = await cli(['bench', '-n', '2', '--', 'node', 'fail.js']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/exited with code 3 on run 1/);
    expect(r.err).toContain('something broke');
    const missing = await cli(['bench', '--compare', 'nope', '--', 'node', 'child.js']);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/No baseline "nope"/);
  });
});

describe('misc commands', () => {
  it('prints help, version and suggests run for bare commands', async () => {
    expect((await cli(['--help'])).out).toContain('perfproof run [options] -- <command...>');
    expect((await cli(['--version'])).out).toMatch(/\d+\.\d+\.\d+/);
    const r = await cli(['node', 'x.js']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('perfproof run -- node x.js');
  });
});

describe('supportsCpuProfInNodeOptions', () => {
  it('knows the first Node.js version that allows --cpu-prof in NODE_OPTIONS', async () => {
    const { supportsCpuProfInNodeOptions } = await import('../src/cli/main');
    expect(supportsCpuProfInNodeOptions('22.14.0')).toBe(false);
    expect(supportsCpuProfInNodeOptions('20.19.0')).toBe(false);
    expect(supportsCpuProfInNodeOptions('22.15.0')).toBe(true);
    expect(supportsCpuProfInNodeOptions('24.11.0')).toBe(true);
  });
});
