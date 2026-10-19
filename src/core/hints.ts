/**
 * Patterns worth a second look when they sit on a hot line. These are hints, not diagnoses: the
 * profile proves the line is hot; the pattern only suggests a common reason why.
 */
const LINE_HINTS: { test: RegExp; hint: (m: RegExpExecArray) => string }[] = [
  {
    test: /\.(includes|indexOf|lastIndexOf|find|findIndex|findLast|some|every)\(/,
    hint: (m) =>
      `.${m[1]}() scans the whole array. Inside a loop that is O(n²); a Set or Map lookup is O(1).`,
  },
  {
    test: /\.filter\([^)]*\)\s*\.length|\.filter\([^)]*\)\[0\]/,
    hint: () => '.filter() builds a new array just to count or take the first item.',
  },
  {
    test: /\bnew RegExp\(/,
    hint: () => 'A RegExp is compiled on a hot line; build it once outside the loop.',
  },
  {
    test: /JSON\.(parse|stringify)\(/,
    hint: (m) =>
      `JSON.${m[1]}() on a hot line: avoid round-tripping (deep copies, cache keys) or cache the result.`,
  },
  {
    test: /\b(readFileSync|writeFileSync|existsSync|statSync|readdirSync|execSync|execFileSync|spawnSync)\(/,
    hint: (m) => `${m[1]}() blocks the thread; batch it, cache it, or move it out of the loop.`,
  },
  {
    test: /\.sort\(/,
    hint: () =>
      'Sorting on a hot line: if this runs repeatedly, sort once or keep the data ordered.',
  },
  {
    test: /\[\s*\.\.\.\w|\{\s*\.\.\.\w|\.concat\(/,
    hint: () =>
      'Spreading or concatenating copies the whole collection each time; in a loop that is O(n²).',
  },
  {
    test: /\bdelete\s+\w+[.[]/,
    hint: () =>
      '`delete` turns objects into slow dictionary mode; set the field to undefined or use a Map.',
  },
  {
    test: /\.(shift|unshift|splice)\(/,
    hint: (m) =>
      `.${m[1]}() moves every element; for queues use an index pointer or a ring buffer.`,
  },
  {
    test: /\btry\s*\{.*\bcatch\b|\bthrow new\b/,
    hint: () => 'Exceptions on a hot path are slow; use return values for expected failures.',
  },
];

export function lineHint(code: string): string | undefined {
  const text = code.replace(/\/\/.*$/, '');
  for (const { test, hint } of LINE_HINTS) {
    const m = test.exec(text);
    if (m) return hint(m);
  }
  return undefined;
}
