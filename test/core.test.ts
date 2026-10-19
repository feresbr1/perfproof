import { describe, expect, it } from 'vitest';
import { lineHint } from '../src/core/hints';
import { categorize, displayPath, fileFromUrl, packageName } from '../src/core/paths';
import { functionEndLine } from '../src/core/ranges';
import { benchText, markdownReport, textReport, verdictLine } from '../src/core/report';
import { compare, summarize, tCdf, tQuantile } from '../src/core/stats';
import { analyzeProfiles } from '../src/core/analyze';
import { scriptSafeJson, analysisToHtml } from '../src/node/html';
import { makeProfile } from './helpers';

describe('stats', () => {
  it('matches reference values of the t distribution', () => {
    // Two-sided p for t = 2.0, df = 10 is 0.0734 (R: 2*pt(-2, 10)).
    expect(2 * (1 - tCdf(2, 10))).toBeCloseTo(0.07339, 4);
    expect(tQuantile(0.975, 9)).toBeCloseTo(2.262157, 4);
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.962339, 3);
    expect(tCdf(0, 5)).toBeCloseTo(0.5, 10);
  });

  it('summarizes timings', () => {
    const s = summarize([10, 12, 11, 13, 9]);
    expect(s.mean).toBe(11);
    expect(s.median).toBe(11);
    expect(s.sd).toBeCloseTo(1.5811, 4);
    expect(s.ci95).toBeCloseTo(2.776 * (1.5811 / Math.sqrt(5)), 2);
    expect(() => summarize([])).toThrow();
  });

  it('calls a clear improvement faster and noise the same', () => {
    const before = [100, 102, 98, 101, 99, 100, 103, 97];
    const after = [50, 52, 49, 51, 50, 48, 51, 50];
    const c = compare(before, after);
    expect(c.verdict).toBe('faster');
    expect(c.speedup).toBeCloseTo(2, 1);
    expect(c.p).toBeLessThan(0.0001);
    expect(compare(after, before).verdict).toBe('slower');
    const noisy = compare(before, [101, 99, 100, 102, 98, 100, 99, 101]);
    expect(noisy.verdict).toBe('same');
  });

  it('ignores significant but tiny differences', () => {
    const c = compare([100, 100, 100, 100], [99.5, 99.5, 99.5, 99.5]);
    expect(c.p).toBe(0);
    expect(c.verdict).toBe('same');
  });

  it('words verdicts without overstating them', () => {
    expect(verdictLine(compare([100, 101, 99, 100], [50, 51, 49, 50]))).toMatch(
      /^FASTER: 2\.00× faster/,
    );
    expect(verdictLine(compare([100, 101, 99, 100], [100, 102, 98, 100]))).toMatch(
      /^NO SIGNIFICANT DIFFERENCE/,
    );
  });
});

describe('paths', () => {
  it('categorizes frames', () => {
    expect(categorize('(garbage collector)', '')).toBe('gc');
    expect(categorize('(idle)', '')).toBe('idle');
    expect(categorize('spawnSync', 'node:child_process')).toBe('wait');
    expect(categorize('readFile', 'node:fs')).toBe('node');
    expect(categorize('x', 'file:///a/node_modules/b/c.js')).toBe('deps');
    expect(categorize('x', 'file:///a/src/c.js')).toBe('user');
    expect(categorize('x', 'file:///tmp/r/perfproof-preload.cjs')).toBe('node');
    expect(categorize('includes', '')).toBe('native');
  });

  it('shortens paths', () => {
    expect(displayPath('file:///C:/work/app/src/a.js', 'C:\\work\\app')).toBe('src/a.js');
    expect(displayPath('file:///home/me/app/src/a.js', '/home/me/app')).toBe('src/a.js');
    expect(displayPath('file:///home/me/app/node_modules/@x/y/i.js', '/home/me/app')).toBe(
      'node_modules/@x/y/i.js',
    );
    expect(displayPath('file:///home/me/my%20app/a.js')).toBe('/home/me/my app/a.js');
    expect(displayPath('https://example.com/static/app.js?v=1')).toBe('example.com/static/app.js');
    expect(displayPath('node:internal/fs')).toBe('node:internal/fs');
    expect(fileFromUrl('file:///C:/a/b.js')).toBe('C:/a/b.js');
    expect(fileFromUrl('node:fs')).toBeNull();
    expect(packageName('node_modules/@scope/pkg/lib/x.js')).toBe('@scope/pkg');
    expect(packageName('a/node_modules/pkg/x.js')).toBe('pkg');
  });
});

describe('functionEndLine', () => {
  const src = [
    'function a(x) {', // 0
    '  const s = "}";', // 1
    '  // }', // 2
    '  return { x };', // 3
    '}', // 4
    'const b = (y) => y * 2;', // 5
    'const c = ({ k }) => {', // 6
    '  return k;', // 7
    '};', // 8
    'arr.sort((p, q) => p - q);', // 9
    'const d = (z) =>', // 10
    '  z + 1;', // 11
  ];
  it('finds block and expression bodies', () => {
    expect(functionEndLine(src, 0, 10)).toBe(4);
    expect(functionEndLine(src, 5, 10)).toBe(5);
    expect(functionEndLine(src, 6, 10)).toBe(8);
    expect(functionEndLine(src, 9, 9)).toBe(9);
    expect(functionEndLine(src, 10, 10)).toBe(11);
    expect(functionEndLine(src, 99, 0)).toBeNull();
  });
});

describe('lineHint', () => {
  it('recognises common hot-line patterns', () => {
    expect(lineHint('if (!seen.includes(x)) seen.push(x);')).toMatch(/Set or Map/);
    expect(lineHint('const m = new RegExp(p).exec(s);')).toMatch(/RegExp/);
    expect(lineHint('const copy = JSON.parse(JSON.stringify(o));')).toMatch(/JSON/);
    expect(lineHint('const t = readFileSync(f, "utf8");')).toMatch(/blocks the thread/);
    expect(lineHint('acc = [...acc, item];')).toMatch(/O\(n²\)/);
    expect(lineHint('queue.shift();')).toMatch(/ring buffer/);
    expect(lineHint('total += price * qty;')).toBeUndefined();
    expect(lineHint('x += 1; // seen.includes(x)')).toBeUndefined();
  });
});

describe('reports', () => {
  const p = makeProfile([
    { name: 'hot', url: 'file:///w/a.js', line: 1, samples: 30, ticks: { 2: 30 } },
    { name: '(garbage collector)', samples: 2 },
  ]);
  const a = analyzeProfiles([{ name: 'pid 1', profile: p }], {
    root: '/w',
    command: 'node a.js',
    wallMs: 40,
  });
  a.lines[0]!.snippet = { start: 1, code: ['function hot() {', '  return list.indexOf(x);', '}'] };
  a.lines[0]!.hint = 'a hint';

  it('renders a ranked text report with code', () => {
    const t = textReport(a, { savedTo: '.perfproof/runs/x' });
    expect(t).toContain('perfproof · node a.js');
    expect(t).toContain('wall 40.0 ms · CPU 32.0 ms · 1 process');
    expect(t).toMatch(/1\. a\.js:2 {2}hot {2}30\.0 ms {2}94%/);
    expect(t).toContain('    > 2 |   return list.indexOf(x);');
    expect(t).toContain('hint: a hint');
    expect(t).toContain('Saved .perfproof/runs/x');
  });

  it('renders Markdown tables', () => {
    const m = markdownReport(a);
    expect(m).toContain('| 1 | `a.js:2` | `hot` | 30.0 ms | 94% |');
    expect(m).toContain('```js');
  });

  it('renders bench results', () => {
    const before = [100, 101, 99, 100];
    const after = [50, 51, 49, 50];
    const r = { command: 'node a.js', runs: after, summary: summarize(after), failures: 0 };
    const t = benchText(r, {
      name: 'before',
      result: { command: 'node a.js', runs: before, summary: summarize(before), failures: 0 },
      cmp: compare(before, after),
    });
    expect(t).toContain('4 runs: 50.0 ms');
    expect(t).toContain('baseline "before": 100 ms');
    expect(t).toContain('FASTER');
  });
});

describe('html', () => {
  it('cannot be broken out of by profile data', () => {
    const json = scriptSafeJson({
      name: '</script><script>alert(1)</script>',
      sep: String.fromCharCode(0x2028),
    });
    expect(json).not.toContain('</script');
    expect(json).not.toContain(String.fromCharCode(0x2028));
    expect(JSON.parse(json)).toEqual({
      name: '</script><script>alert(1)</script>',
      sep: String.fromCharCode(0x2028),
    });
    expect(json).toContain(String.fromCharCode(92) + 'u003c/script>');
  });

  it('writes a self-contained page', () => {
    const p = makeProfile([{ name: 'x', url: 'file:///w/a.js', samples: 1 }]);
    const html = analysisToHtml(
      analyzeProfiles([{ name: 'p', profile: p }], { command: 'node <a>.js' }),
      'console.log(1)',
    );
    expect(html).toContain('<title>perfproof · node &lt;a&gt;.js</title>');
    expect(html).toContain('<script id="perfproof-data" type="application/json">');
    expect(html).not.toMatch(/src="http/);
  });
});
