import { describe, expect, it } from 'vitest';
import { analyzeProfiles } from '../src/core/analyze';
import { parseCpuProfile, ProfileError, selfTimes } from '../src/core/profile';
import { makeProfile } from './helpers';

const APP = 'file:///work/app/src/index.js';
const LIB = 'file:///work/app/node_modules/@acme/lib/index.js';

function sample() {
  return makeProfile([
    {
      name: '',
      url: APP,
      line: 1,
      samples: 2,
      ticks: { 20: 2 },
      children: [
        {
          name: 'main',
          url: APP,
          line: 3,
          samples: 5,
          ticks: { 4: 5 },
          children: [
            { name: 'hot', url: APP, line: 10, samples: 40, ticks: { 11: 30, 12: 10 } },
            { name: 'parse', url: LIB, line: 1, samples: 20, ticks: { 2: 20 } },
            { name: 'readFileUtf8', url: '', samples: 3 },
          ],
        },
      ],
    },
    { name: '(garbage collector)', samples: 10 },
    { name: '(idle)', samples: 100 },
    { name: '(program)', samples: 5 },
  ]);
}

describe('selfTimes', () => {
  it('weights each sample by the gap to the next sample', () => {
    const p = makeProfile([
      { name: 'a', url: APP, samples: 2 },
      { name: 'b', url: APP, samples: 1 },
    ]);
    p.timeDeltas = [5, 1000, 3000];
    const t = selfTimes(p);
    // a: 1000 + 3000 µs; b: the last sample gets the average gap (2000 µs)
    expect(t.get(2)).toBe(4000);
    expect(t.get(3)).toBe(2000);
  });

  it('falls back to hitCount when there is no sample timeline', () => {
    const p = makeProfile([
      { name: 'a', url: APP, samples: 3 },
      { name: 'b', url: APP, samples: 1 },
    ]);
    delete p.samples;
    delete p.timeDeltas;
    p.endTime = 8000;
    const t = selfTimes(p);
    expect(t.get(2)).toBe(6000);
    expect(t.get(3)).toBe(2000);
  });
});

describe('analyzeProfiles', () => {
  const a = analyzeProfiles([{ name: 'pid 1', profile: sample() }], { root: '/work/app' });

  it('separates CPU time from idle time', () => {
    expect(a.sampledMs).toBeCloseTo(185);
    expect(a.cpuMs).toBeCloseTo(85);
    const user = a.categories.find((c) => c.category === 'user')!;
    expect(user.ms).toBeCloseTo(47);
    expect(a.categories.find((c) => c.category === 'deps')!.ms).toBeCloseTo(20);
    expect(a.categories.find((c) => c.category === 'gc')!.ms).toBeCloseTo(10);
    expect(a.categories.find((c) => c.category === 'native')!.ms).toBeCloseTo(3);
  });

  it('ranks functions by self time and computes totals', () => {
    expect(a.functions[0]).toMatchObject({ name: 'hot', file: 'src/index.js', line: 10 });
    expect(a.functions[0]!.selfMs).toBeCloseTo(40);
    const main = a.functions.find((f) => f.name === 'main')!;
    expect(main.totalMs).toBeCloseTo(68);
    const mod = a.functions.find((f) => f.name === '(module)')!;
    expect(mod.totalMs).toBeCloseTo(70);
    expect(a.functions.some((f) => f.category === 'idle')).toBe(false);
  });

  it('splits self time across lines using position ticks', () => {
    expect(a.lines[0]).toMatchObject({ file: 'src/index.js', line: 11, fn: 'hot' });
    expect(a.lines[0]!.selfMs).toBeCloseTo(30);
    const lib = a.lines.find((l) => l.category === 'deps')!;
    expect(lib.file).toBe('node_modules/@acme/lib/index.js');
    expect(lib.selfMs).toBeCloseTo(20);
  });

  it('builds a merged flame graph', () => {
    const mod = a.flame.children!.find((c) => c.name === '(module)')!;
    expect(mod.totalMs).toBeCloseTo(70);
    expect(mod.children![0]!.name).toBe('main');
    expect(a.flame.totalMs).toBeCloseTo(185);
  });

  it('counts recursive functions once in total time', () => {
    const p = makeProfile([
      {
        name: 'fib',
        url: APP,
        line: 1,
        samples: 1,
        children: [
          {
            name: 'fib',
            url: APP,
            line: 1,
            samples: 1,
            children: [{ name: 'fib', url: APP, line: 1, samples: 2 }],
          },
        ],
      },
    ]);
    const r = analyzeProfiles([{ name: 'x', profile: p }]);
    const fib = r.functions.find((f) => f.name === 'fib')!;
    expect(fib.selfMs).toBeCloseTo(4);
    expect(fib.totalMs).toBeCloseTo(4);
  });

  it('merges several processes and labels them by their busiest file', () => {
    const p1 = makeProfile([{ name: 'spawnSync', url: 'node:child_process', samples: 50 }]);
    const p2 = makeProfile([{ name: 'work', url: 'file:///w/child.js', samples: 30 }]);
    const r = analyzeProfiles(
      [
        { name: 'pid 1', profile: p1 },
        { name: 'pid 2', profile: p2 },
      ],
      { root: '/w' },
    );
    expect(r.processes).toHaveLength(2);
    expect(r.processes[0]!.waitMs).toBeCloseTo(50);
    expect(r.processes[1]!.label).toBe('child.js');
    expect(r.cpuMs).toBeCloseTo(30);
    expect(r.flame.children!.map((c) => c.name)).toEqual(['node (pid 1)', 'child.js (pid 2)']);
    expect(r.hints.join(' ')).toMatch(/wait for children/);
  });

  it('names a hot line after the innermost function whose source range contains it', () => {
    const src = [
      'function outer(list) {', // 1
      '  return list.map((x) => {', // 2
      '    return x * 2;', // 3
      '  });', // 4
      '}', // 5
      'outer([1, 2, 3]);', // 6
    ];
    const p = makeProfile([
      {
        name: '',
        url: APP,
        samples: 4,
        ticks: { 6: 4 },
        children: [
          {
            name: 'outer',
            url: APP,
            line: 1,
            column: 14,
            samples: 6,
            // Inlined callback lines show up under the caller's node.
            ticks: { 3: 6 },
            children: [{ name: '', url: APP, line: 2, column: 19, samples: 1, ticks: { 3: 1 } }],
          },
        ],
      },
    ]);
    const r = analyzeProfiles([{ name: 'x', profile: p }], { source: () => src });
    expect(r.lines.find((l) => l.line === 3)!.fn).toBe('(anonymous)');
    expect(r.lines.find((l) => l.line === 6)!.fn).toBe('(module)');
    const noSource = analyzeProfiles([{ name: 'x', profile: p }]);
    expect(noSource.lines.find((l) => l.line === 3)!.fn).toBe('outer');
  });

  it('notes heavy garbage collection and dependency-dominated profiles', () => {
    const p = makeProfile([
      { name: 'parse', url: LIB, samples: 60 },
      { name: 'mine', url: APP, samples: 20 },
      { name: '(garbage collector)', samples: 20 },
    ]);
    const r = analyzeProfiles([{ name: 'x', profile: p }]);
    expect(r.hints.join('\n')).toMatch(/Garbage collection is 20%/);
    expect(r.hints.join('\n')).toMatch(/@acme\/lib 60%/);
  });
});

describe('parseCpuProfile', () => {
  it('accepts a real-shaped profile and the { profile } wrapper', () => {
    const p = makeProfile([{ name: 'a', url: APP, samples: 1 }]);
    expect(parseCpuProfile(JSON.stringify(p)).nodes).toHaveLength(2);
    expect(parseCpuProfile(JSON.stringify({ profile: p })).nodes).toHaveLength(2);
  });

  it('explains what is wrong with other files', () => {
    expect(() => parseCpuProfile('nope')).toThrow(ProfileError);
    expect(() => parseCpuProfile('{"traceEvents":[]}')).toThrow(/Performance trace/);
    expect(() => parseCpuProfile('[]')).toThrow(/Performance trace/);
    expect(() => parseCpuProfile('{"nodes":[]}')).toThrow(/No call tree/);
    expect(() => parseCpuProfile('{"nodes":[{"id":1}]}')).toThrow(/callFrame/);
    expect(() =>
      parseCpuProfile(
        '{"nodes":[{"id":1,"callFrame":{"functionName":"a","url":"","lineNumber":0}}]}',
      ),
    ).toThrow(/startTime/);
  });
});
