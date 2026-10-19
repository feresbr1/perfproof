// Regenerate the website's demo from a real profile of examples/log-report.
// Usage: npm run build:cli && npm run demo-data
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = resolve('dist/cli/perfproof.mjs');
const cwd = resolve('examples/log-report');
const json = execFileSync(
  process.execPath,
  [cli, 'run', '--json', '-q', '--no-save', '--', 'node', 'report.js'],
  {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
// Replace this machine's paths with a neutral one before publishing the data.
const local = pathToFileURL(cwd).href;
const scrub = (text) =>
  text
    .split(local)
    .join('file:///home/dev/perfproof/examples/log-report')
    .replace(/"[^"]*perfproof-preload\.cjs"/g, '"perfproof-preload.cjs"');
const analysis = JSON.parse(scrub(json));
delete analysis.createdAt;
writeFileSync('src/site/demo-report.json', JSON.stringify(analysis) + '\n');

// A raw .cpuprofile visitors can download and drop back into the viewer.
const dir = mkdtempSync(join(tmpdir(), 'perfproof-demo-'));
try {
  execFileSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${dir}`, 'report.js'], {
    cwd,
    stdio: 'ignore',
  });
  const file = readdirSync(dir).find((f) => f.endsWith('.cpuprofile'));
  writeFileSync('public/demo/log-report.cpuprofile', scrub(readFileSync(join(dir, file), 'utf8')));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// Real before/after timings for the landing page (the fix is in report.fast.js).
const timings = (script) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, 'bench', '-n', '10', '--json', '--', 'node', script], {
      cwd,
      encoding: 'utf8',
    }),
  );
const before = timings('report.js');
const after = timings('report.fast.js');
for (const r of [before, after]) delete r.baseline;
writeFileSync('src/site/demo-bench.json', JSON.stringify({ before, after }, null, 2) + '\n');

console.log(`demo: ${analysis.lines.length} hot lines, CPU ${analysis.cpuMs.toFixed(0)} ms`);
