import { selfTimes, type NamedProfile, type ProfileNode } from './profile';
import { functionEndLine } from './ranges';
import { categorize, displayPath, packageName, type Category, CATEGORY_LABEL } from './paths';

export interface FunctionStat {
  name: string;
  file: string;
  url: string;
  /** 1-based */
  line: number;
  category: Category;
  selfMs: number;
  totalMs: number;
}

export interface Snippet {
  /** 1-based number of the first line in `code` */
  start: number;
  code: string[];
}

export interface LineStat {
  file: string;
  url: string;
  /** 1-based */
  line: number;
  /** Best guess at the enclosing function (inlining can hide the real frame). */
  fn: string;
  category: Category;
  selfMs: number;
  snippet?: Snippet;
  hint?: string;
}

export interface ProcessSummary {
  name: string;
  label: string;
  cpuMs: number;
  waitMs: number;
  idleMs: number;
  durationMs: number;
}

export interface FlameNode {
  name: string;
  file?: string;
  line?: number;
  category: Category;
  selfMs: number;
  totalMs: number;
  children?: FlameNode[];
}

export interface Analysis {
  version: 1;
  command?: string;
  wallMs?: number;
  exitCode?: number | null;
  createdAt?: string;
  /** Every sampled millisecond, idle and waiting included. */
  sampledMs: number;
  /** Sampled time minus idle and waiting on child processes. */
  cpuMs: number;
  categories: { category: Category; ms: number }[];
  processes: ProcessSummary[];
  functions: FunctionStat[];
  lines: LineStat[];
  flame: FlameNode;
  hints: string[];
}

export interface AnalyzeOptions {
  /** Directory paths are shown relative to. */
  root?: string;
  command?: string;
  wallMs?: number;
  exitCode?: number | null;
  /** Keep this many functions and lines (default 50). */
  limit?: number;
  /** Drop flame graph nodes smaller than this fraction of the total (default 0.001). */
  flameMinFraction?: number;
  /** Source lines for a frame URL, when available; improves function names for hot lines. */
  source?: (url: string) => string[] | null | undefined;
}

const OFF_CPU: ReadonlySet<Category> = new Set(['idle', 'wait', 'root']);

interface Frame {
  key: string;
  name: string;
  url: string;
  line: number;
  column: number;
  file: string;
  category: Category;
}

function frameOf(node: ProfileNode, root?: string): Frame {
  const { functionName, url, lineNumber, columnNumber = 0 } = node.callFrame;
  const category = categorize(functionName, url);
  let name = functionName;
  if (!name) name = lineNumber <= 0 && columnNumber <= 0 && url ? '(module)' : '(anonymous)';
  const key = url ? `${url}\0${lineNumber}\0${columnNumber}\0${name}` : `\0${name}`;
  return {
    key,
    name,
    url,
    line: lineNumber + 1,
    column: columnNumber,
    file: displayPath(url, root),
    category,
  };
}

/** Aggregate one or more CPU profiles (e.g. one per process) into a single report. */
export function analyzeProfiles(profiles: NamedProfile[], opts: AnalyzeOptions = {}): Analysis {
  const { root, limit = 50, flameMinFraction = 0.001 } = opts;
  const fnStats = new Map<string, FunctionStat>();
  const lineStats = new Map<string, LineStat>();
  const categoryMs = new Map<Category, number>();
  const processes: ProcessSummary[] = [];
  const flameRoot: FlameNode = { name: 'all', category: 'root', selfMs: 0, totalMs: 0 };
  // Function start lines per url, to name the function that owns a hot line.
  const starts = new Map<string, { line: number; column: number; name: string }[]>();
  // Which function's samples landed on each line, to name the line when sources are unavailable.
  const lineOwners = new Map<string, Map<string, number>>();

  for (const { name: processName, profile } of profiles) {
    const byId = new Map<number, ProfileNode>();
    for (const node of profile.nodes) byId.set(node.id, node);
    const isChild = new Set<number>();
    for (const node of profile.nodes) for (const c of node.children ?? []) isChild.add(c);
    const roots = profile.nodes.filter((n) => !isChild.has(n.id));
    const self = selfTimes(profile);
    const frames = new Map<number, Frame>();
    for (const node of profile.nodes) frames.set(node.id, frameOf(node, root));

    // Subtree totals (microseconds), iteratively to survive deep recursion.
    const subtree = new Map<number, number>();
    const order: number[] = [];
    const stack = roots.map((r) => r.id);
    while (stack.length) {
      const id = stack.pop()!;
      order.push(id);
      for (const c of byId.get(id)?.children ?? []) stack.push(c);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]!;
      let sum = self.get(id) ?? 0;
      for (const c of byId.get(id)?.children ?? []) sum += subtree.get(c) ?? 0;
      subtree.set(id, sum);
    }

    const proc: ProcessSummary = {
      name: processName,
      label: '',
      cpuMs: 0,
      waitMs: 0,
      idleMs: 0,
      durationMs: (profile.endTime - profile.startTime) / 1000,
    };
    const procFlame: FlameNode = {
      name: processName,
      category: 'root',
      selfMs: 0,
      totalMs: 0,
      children: [],
    };
    const userTotals = new Map<string, number>();

    // Walk the tree once: self/total per function, line ticks, flame graph.
    type Item = { id: number; flame: FlameNode; enter: boolean };
    const onPath = new Map<string, number>();
    const work: Item[] = roots.map((r) => ({ id: r.id, flame: procFlame, enter: true }));
    while (work.length) {
      const item = work.pop()!;
      const node = byId.get(item.id)!;
      const frame = frames.get(item.id)!;
      if (!item.enter) {
        const n = (onPath.get(frame.key) ?? 1) - 1;
        if (n === 0) onPath.delete(frame.key);
        else onPath.set(frame.key, n);
        continue;
      }
      const selfUs = self.get(item.id) ?? 0;
      const totalUs = subtree.get(item.id) ?? 0;
      const selfMs = selfUs / 1000;

      if (frame.category !== 'root') {
        let stat = fnStats.get(frame.key);
        if (!stat) {
          stat = {
            name: frame.name,
            file: frame.file,
            url: frame.url,
            line: frame.line,
            category: frame.category,
            selfMs: 0,
            totalMs: 0,
          };
          fnStats.set(frame.key, stat);
          if (frame.url) {
            const list = starts.get(frame.url) ?? [];
            list.push({ line: frame.line, column: frame.column, name: frame.name });
            starts.set(frame.url, list);
          }
        }
        stat.selfMs += selfMs;
        // Count recursive frames once: only the outermost occurrence adds its subtree.
        if (!onPath.has(frame.key)) stat.totalMs += totalUs / 1000;
        if (frame.category === 'user' && !onPath.has(frame.key)) {
          userTotals.set(stat.file, (userTotals.get(stat.file) ?? 0) + totalUs / 1000);
        }

        categoryMs.set(frame.category, (categoryMs.get(frame.category) ?? 0) + selfMs);
        if (frame.category === 'idle') proc.idleMs += selfMs;
        else if (frame.category === 'wait') proc.waitMs += selfMs;
        else proc.cpuMs += selfMs;

        if (selfUs > 0 && frame.url && !OFF_CPU.has(frame.category)) {
          const ticks = node.positionTicks?.filter((p) => p.ticks > 0) ?? [];
          const sum = ticks.reduce((s, p) => s + p.ticks, 0);
          const parts =
            sum > 0
              ? ticks.map((p) => [p.line, p.ticks / sum] as const)
              : [[frame.line, 1] as const];
          for (const [line, share] of parts) {
            const key = `${frame.url}\0${line}`;
            let ls = lineStats.get(key);
            if (!ls) {
              ls = {
                file: frame.file,
                url: frame.url,
                line,
                fn: frame.name,
                category: frame.category,
                selfMs: 0,
              };
              lineStats.set(key, ls);
            }
            ls.selfMs += selfMs * share;
            const owners = lineOwners.get(key) ?? new Map<string, number>();
            owners.set(frame.name, (owners.get(frame.name) ?? 0) + selfMs * share);
            lineOwners.set(key, owners);
          }
        }
      }

      // Flame graph: merge children that are the same function.
      let flame = item.flame;
      if (frame.category !== 'root') {
        flame.children ??= [];
        let child = flame.children.find(
          (c) =>
            c.name === frame.name &&
            c.file === (frame.url ? frame.file : undefined) &&
            c.line === (frame.url ? frame.line : undefined),
        );
        if (!child) {
          child = {
            name: frame.name,
            file: frame.url ? frame.file : undefined,
            line: frame.url ? frame.line : undefined,
            category: frame.category,
            selfMs: 0,
            totalMs: 0,
          };
          flame.children.push(child);
        }
        child.selfMs += selfMs;
        child.totalMs += totalUs / 1000;
        flame = child;
      }

      onPath.set(frame.key, (onPath.get(frame.key) ?? 0) + 1);
      work.push({ id: item.id, flame, enter: false });
      for (const c of node.children ?? []) work.push({ id: c, flame, enter: true });
    }

    const top = [...userTotals].sort((a, b) => b[1] - a[1])[0];
    proc.label = top ? top[0] : (guessLabel(profile.nodes, frames) ?? 'node');
    procFlame.name = `${proc.label} (${processName})`;
    procFlame.totalMs = sumChildren(procFlame);
    processes.push(proc);
    if (profiles.length === 1) {
      flameRoot.children = procFlame.children;
      flameRoot.name = proc.label;
    } else {
      (flameRoot.children ??= []).push(procFlame);
    }
  }

  flameRoot.totalMs = sumChildren(flameRoot);
  prune(flameRoot, flameRoot.totalMs * flameMinFraction);

  // Name each hot line. With the source at hand, use the innermost function whose range contains
  // the line (inlining puts a callee's lines under its caller's frame). Otherwise use the frame that
  // owned most of the line's samples.
  for (const [key, ls] of lineStats) {
    const owners = [...(lineOwners.get(key) ?? [])].sort((a, b) => b[1] - a[1]);
    ls.fn = owners[0]?.[0] ?? ls.fn;
    const src = opts.source?.(ls.url);
    if (!src) continue;
    let best: { line: number; name: string } | undefined;
    for (const f of starts.get(ls.url) ?? []) {
      if (f.name === '(module)' || f.line > ls.line || (best && f.line < best.line)) continue;
      const end = functionEndLine(src, f.line - 1, f.column);
      if (end !== null && end + 1 >= ls.line) best = f;
    }
    ls.fn = best ? best.name : '(module)';
  }

  const sampledMs = [...categoryMs].reduce((s, [c, ms]) => (c === 'root' ? s : s + ms), 0);
  const cpuMs = [...categoryMs].reduce((s, [c, ms]) => (OFF_CPU.has(c) ? s : s + ms), 0);
  const functions = [...fnStats.values()]
    .filter((f) => !OFF_CPU.has(f.category) && f.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit);
  const lines = [...lineStats.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);
  const categories = [...categoryMs]
    .filter(([c, ms]) => c !== 'root' && ms > 0)
    .map(([category, ms]) => ({ category, ms }))
    .sort((a, b) => b.ms - a.ms);

  const analysis: Analysis = {
    version: 1,
    command: opts.command,
    wallMs: opts.wallMs,
    exitCode: opts.exitCode,
    sampledMs,
    cpuMs,
    categories,
    processes,
    functions,
    lines,
    flame: flameRoot,
    hints: [],
  };
  analysis.hints = globalHints(analysis, [...fnStats.values()]);
  return analysis;
}

function guessLabel(nodes: ProfileNode[], frames: Map<number, Frame>): string | undefined {
  // Prefer the first non-internal module that ran (npm, a test runner, ...).
  for (const node of nodes) {
    const f = frames.get(node.id)!;
    if (f.category === 'user') return f.file;
    // A tool such as npm or a test runner: its package name says more than an internal chunk file.
    if (f.category === 'deps') return packageName(f.file) ?? f.file;
  }
  return undefined;
}

function sumChildren(node: FlameNode): number {
  return node.selfMs + (node.children ?? []).reduce((s, c) => s + c.totalMs, 0);
}

function prune(node: FlameNode, min: number): void {
  if (!node.children) return;
  node.children = node.children
    .filter((c) => c.totalMs >= min)
    .sort((a, b) => b.totalMs - a.totalMs);
  for (const c of node.children) prune(c, min);
  if (node.children.length === 0) delete node.children;
}

export function share(ms: number, of: number): number {
  return of > 0 ? (ms / of) * 100 : 0;
}

function globalHints(a: Analysis, allFns: FunctionStat[]): string[] {
  const hints: string[] = [];
  const cat = (c: Category) => a.categories.find((x) => x.category === c)?.ms ?? 0;
  const pct = (ms: number) => `${share(ms, a.cpuMs).toFixed(0)}%`;
  if (a.cpuMs <= 0) return ['No CPU samples were recorded. Did the command run any JavaScript?'];

  const gc = cat('gc');
  if (share(gc, a.cpuMs) >= 10) {
    hints.push(
      `Garbage collection is ${pct(gc)} of CPU time: the hot code allocates a lot (temporary arrays, objects, strings, closures). Reusing or avoiding those allocations helps.`,
    );
  }
  const deps = cat('deps');
  const user = cat('user');
  if (share(deps, a.cpuMs) >= 35 && deps > user) {
    const byPkg = new Map<string, number>();
    for (const f of allFns) {
      if (f.category !== 'deps') continue;
      const pkg = packageName(f.file) ?? f.file;
      byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + f.selfMs);
    }
    const topPkgs = [...byPkg]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([p, ms]) => `${p} ${pct(ms)}`)
      .join(', ');
    hints.push(
      `Most CPU time is inside dependencies (${topPkgs}). Before tuning your own lines, check how often your code calls into them and with how much data.`,
    );
  }
  const node = cat('node');
  if (share(node, a.cpuMs) >= 35) {
    hints.push(
      `Node.js internals take ${pct(node)} of CPU time. That is usually module loading, I/O or stream handling; look at the hot functions' callers in the flame graph.`,
    );
  }
  const program = cat('program');
  if (share(program, a.cpuMs) >= 30) {
    hints.push(
      `${pct(program)} is "(program)": native work V8 cannot attribute to a JS function (startup, compilation, native addons). Short commands are often dominated by it.`,
    );
  }
  const wait = cat('wait');
  if (wait > a.cpuMs && a.processes.length > 1) {
    hints.push(
      `Parent processes mostly wait for children (${CATEGORY_LABEL.wait}); the work happens in the child processes listed below.`,
    );
  }
  if (a.wallMs && a.processes.length === 1 && a.cpuMs < a.wallMs * 0.5) {
    hints.push(
      `CPU was busy for only ${share(a.cpuMs, a.wallMs).toFixed(0)}% of the wall-clock time. The rest is waiting (network, disk, timers), which a CPU profile cannot explain.`,
    );
  }
  return hints;
}
