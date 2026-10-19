import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FlameNode } from '../core/analyze';
import { ms, pct } from '../core/format';
import { CATEGORY_LABEL, type Category } from '../core/paths';

const ROW = 22;
const MAX_ITEMS = 2500;

interface Item {
  node: FlameNode;
  path: FlameNode[];
  x: number;
  w: number;
  depth: number;
}

const HUES: Record<Category, [number, number, number, number]> = {
  // hue, hue spread, saturation, lightness
  user: [14, 26, 82, 50],
  deps: [262, 22, 60, 58],
  node: [190, 20, 70, 36],
  native: [30, 8, 8, 46],
  gc: [44, 6, 90, 48],
  program: [30, 6, 6, 60],
  idle: [210, 6, 20, 80],
  wait: [215, 8, 25, 70],
  root: [30, 0, 6, 30],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function colorFor(node: FlameNode): string {
  const [h, spread, s, l] = HUES[node.category];
  const r = hash(node.name + (node.file ?? ''));
  return `hsl(${(h + (r - 0.5) * spread).toFixed(0)} ${s}% ${(l + (r - 0.5) * 8).toFixed(0)}%)`;
}

const LIGHT_TEXT: ReadonlySet<Category> = new Set(['gc', 'program', 'idle', 'wait']);

function layout(view: FlameNode, ancestors: FlameNode[], width: number): Item[] {
  const items: Item[] = [];
  const scale = view.totalMs > 0 ? width / view.totalMs : 0;
  const stack: Item[] = [{ node: view, path: [...ancestors, view], x: 0, w: width, depth: 0 }];
  while (stack.length && items.length < MAX_ITEMS) {
    const item = stack.pop()!;
    items.push(item);
    let x = item.x;
    const next: Item[] = [];
    for (const child of item.node.children ?? []) {
      const w = child.totalMs * scale;
      if (w >= 2)
        next.push({ node: child, path: [...item.path, child], x, w, depth: item.depth + 1 });
      x += w;
    }
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
  }
  return items;
}

function matches(node: FlameNode, q: string): boolean {
  return node.name.toLowerCase().includes(q) || (node.file ?? '').toLowerCase().includes(q);
}

export function Flame({ root }: { root: FlameNode }) {
  const all = root.totalMs;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [path, setPath] = useState<FlameNode[]>([root]);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<FlameNode | null>(null);

  useEffect(() => setPath([root]), [root]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = path[path.length - 1]!;
  const items = useMemo(() => layout(view, path.slice(0, -1), width), [view, width, path]);
  const depth = items.reduce((d, i) => Math.max(d, i.depth), 0);
  const q = query.trim().toLowerCase();

  const matched = useMemo(() => {
    if (!q) return null;
    const hit = new Set<FlameNode>();
    let total = 0;
    const walk = (n: FlameNode, inside: boolean) => {
      const m = matches(n, q);
      if (m) hit.add(n);
      if (m && !inside) total += n.totalMs;
      for (const c of n.children ?? []) walk(c, inside || m);
    };
    walk(view, false);
    return { hit, total };
  }, [q, view]);

  const shown = hover ?? view;
  const zoomOut = () => setPath((p) => (p.length > 1 ? p.slice(0, -1) : p));

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') zoomOut();
      }}
    >
      <div class="pp-flame-bar">
        <label class="pp-sr" for="pp-flame-search">
          Search functions or files
        </label>
        <input
          id="pp-flame-search"
          type="search"
          placeholder="Search functions or files…"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        {path.length > 1 && (
          <button type="button" class="pp-btn" onClick={() => setPath([root])}>
            Reset zoom
          </button>
        )}
      </div>
      <div class="pp-crumbs" aria-label="Zoom path">
        {path.length > 1 ? (
          path.map((n, i) => (
            <span key={i}>
              {i > 0 && ' › '}
              {i < path.length - 1 ? (
                <button type="button" onClick={() => setPath(path.slice(0, i + 1))}>
                  {n.name}
                </button>
              ) : (
                <b>{n.name}</b>
              )}
            </span>
          ))
        ) : (
          <span>
            Click a frame to zoom in. Esc zooms out. Width is total time, top-down by call.
          </span>
        )}
      </div>
      <div
        ref={box}
        class="pp-flame"
        style={{ height: `${(depth + 1) * ROW}px` }}
        role="group"
        aria-label="Flame graph"
        data-testid="flame"
      >
        {items.map((it) => {
          const dim = matched ? !matched.hit.has(it.node) : false;
          const label = `${it.node.name}${it.node.file ? ` (${it.node.file}:${it.node.line})` : ''}: ${ms(it.node.totalMs)} total, ${ms(it.node.selfMs)} self`;
          return (
            <button
              type="button"
              key={it.path.length + ':' + it.x}
              class={`${dim ? 'is-dim' : ''} ${LIGHT_TEXT.has(it.node.category) ? 'is-light' : ''}`}
              style={{
                left: `${it.x}px`,
                top: `${it.depth * ROW}px`,
                width: `${it.w}px`,
                background: colorFor(it.node),
              }}
              title={label}
              aria-label={label}
              onClick={() =>
                setPath(it.path.length > 1 && it.node === view ? path.slice(0, -1) : it.path)
              }
              onMouseEnter={() => setHover(it.node)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(it.node)}
              onBlur={() => setHover(null)}
            >
              {it.w > 30 ? it.node.name : ''}
            </button>
          );
        })}
      </div>
      <div class="pp-detail" aria-live="polite">
        {matched ? (
          <span>
            “{query.trim()}” matches <b>{matched.hit.size}</b> frames: <b>{ms(matched.total)}</b> (
            {pct(all > 0 ? (matched.total / all) * 100 : 0)} of sampled time)
          </span>
        ) : (
          <span>
            <code>{shown.name}</code>
            {shown.file && (
              <>
                {' '}
                in <code>{`${shown.file}:${shown.line}`}</code>
              </>
            )}
            {' · '}total <b>{ms(shown.totalMs)}</b> (
            {pct(all > 0 ? (shown.totalMs / all) * 100 : 0)}) · self <b>{ms(shown.selfMs)}</b> ·{' '}
            {CATEGORY_LABEL[shown.category]}
          </span>
        )}
      </div>
    </div>
  );
}
