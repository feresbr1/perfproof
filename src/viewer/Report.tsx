import { useState } from 'preact/hooks';
import { share, type Analysis, type FunctionStat, type LineStat } from '../core/analyze';
import { ms, pct } from '../core/format';
import { CATEGORY_LABEL, type Category } from '../core/paths';
import { Flame } from './Flame';

export const CATEGORY_COLOR: Record<Category, string> = {
  user: 'var(--c-user)',
  deps: 'var(--c-deps)',
  node: 'var(--c-node)',
  native: 'var(--c-native)',
  gc: 'var(--c-gc)',
  program: 'var(--c-program)',
  idle: 'var(--c-idle)',
  wait: 'var(--c-wait)',
  root: 'var(--c-program)',
};

export function Report({ analysis: a }: { analysis: Analysis }) {
  const cpuCats = a.categories.filter((c) => c.category !== 'idle' && c.category !== 'wait');
  return (
    <div class="pp-report">
      <section class="pp-card" aria-label="Summary">
        <div class="pp-head">
          {a.command && <p class="pp-cmd">$ {a.command}</p>}
          {a.wallMs !== undefined && <Stat label="Wall clock" value={ms(a.wallMs)} />}
          <Stat label="CPU time" value={ms(a.cpuMs)} />
          <Stat
            label={a.processes.length === 1 ? 'Process' : 'Processes'}
            value={String(a.processes.length)}
          />
          {topUserShare(a) !== null && <Stat label="In your code" value={pct(topUserShare(a)!)} />}
          {a.exitCode !== undefined && a.exitCode !== null && a.exitCode !== 0 && (
            <Stat label="Exit code" value={String(a.exitCode)} />
          )}
        </div>
      </section>

      <section class="pp-card" aria-labelledby="pp-where">
        <h2 id="pp-where">Where the CPU time goes</h2>
        <div
          class="pp-stack"
          role="img"
          aria-label={cpuCats
            .map((c) => `${CATEGORY_LABEL[c.category]} ${pct(share(c.ms, a.cpuMs))}`)
            .join(', ')}
        >
          {cpuCats.map((c) => (
            <div
              key={c.category}
              style={{ width: `${share(c.ms, a.cpuMs)}%`, background: CATEGORY_COLOR[c.category] }}
              title={`${CATEGORY_LABEL[c.category]}: ${ms(c.ms)}`}
            />
          ))}
        </div>
        <div class="pp-legend">
          {cpuCats
            .filter((c) => share(c.ms, a.cpuMs) >= 0.5)
            .map((c) => (
              <span key={c.category}>
                <i style={{ background: CATEGORY_COLOR[c.category] }} />
                {CATEGORY_LABEL[c.category]} <em>{pct(share(c.ms, a.cpuMs))}</em>
              </span>
            ))}
        </div>
      </section>

      <section class="pp-card" aria-labelledby="pp-hot">
        <h2 id="pp-hot">Hot lines · self time</h2>
        {a.lines.length ? (
          <HotLines lines={a.lines.slice(0, 10)} cpuMs={a.cpuMs} />
        ) : (
          <p class="pp-empty">No JavaScript lines were sampled.</p>
        )}
      </section>

      {a.hints.length > 0 && (
        <section class="pp-card" aria-labelledby="pp-notes">
          <h2 id="pp-notes">Notes</h2>
          <ul class="pp-notes">
            {a.hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </section>
      )}

      <section class="pp-card" aria-labelledby="pp-flame-title">
        <h2 id="pp-flame-title">Flame graph</h2>
        <Flame root={a.flame} />
      </section>

      <section class="pp-card" aria-labelledby="pp-fns">
        <h2 id="pp-fns">Hot functions</h2>
        <Functions fns={a.functions.slice(0, 20)} cpuMs={a.cpuMs} />
      </section>

      {a.processes.length > 1 && (
        <section class="pp-card" aria-labelledby="pp-procs">
          <h2 id="pp-procs">Processes</h2>
          <div class="pp-table-wrap">
            <table class="pp-table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Main script</th>
                  <th class="num">CPU</th>
                  <th class="num">Waiting on children</th>
                </tr>
              </thead>
              <tbody>
                {[...a.processes]
                  .sort((x, y) => y.cpuMs - x.cpuMs)
                  .map((p) => (
                    <tr key={p.name}>
                      <td class="mono">{p.name}</td>
                      <td>
                        <code>{p.label}</code>
                      </td>
                      <td class="num">{ms(p.cpuMs)}</td>
                      <td class="num">{p.waitMs > 1 ? ms(p.waitMs) : '–'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function topUserShare(a: Analysis): number | null {
  const user = a.categories.find((c) => c.category === 'user');
  return user ? share(user.ms, a.cpuMs) : null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="pp-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function HotLines({ lines, cpuMs }: { lines: LineStat[]; cpuMs: number }) {
  const [open, setOpen] = useState<number | null>(lines[0]?.snippet ? 0 : null);
  const max = lines[0]?.selfMs ?? 1;
  return (
    <ol class="pp-lines">
      {lines.map((l, i) => {
        const expandable = Boolean(l.snippet || l.hint);
        const isOpen = open === i && expandable;
        return (
          <li class="pp-line" key={`${l.url}:${l.line}`}>
            <button
              type="button"
              aria-expanded={expandable ? isOpen : undefined}
              onClick={() => expandable && setOpen(isOpen ? null : i)}
              style={{ cursor: expandable ? 'pointer' : 'default' }}
            >
              <span class="pp-rank">{i + 1}</span>
              <span class="pp-where">
                <code>
                  {l.file}:{l.line}
                </code>
                {l.category !== 'user' && <span class="pp-tag">{CATEGORY_LABEL[l.category]}</span>}
                <small>
                  in <code>{l.fn}</code>
                  {expandable && !isOpen ? ' · show code' : ''}
                </small>
              </span>
              <span class="pp-amount">
                <b>{pct(share(l.selfMs, cpuMs))}</b>
                <small>{ms(l.selfMs)}</small>
              </span>
              <span class="pp-meter" style={{ width: `${(l.selfMs / max) * 100}%` }} />
            </button>
            {isOpen && l.snippet && (
              <pre class="pp-snippet">
                {l.snippet.code.map((code, j) => {
                  const n = l.snippet!.start + j;
                  return (
                    <div key={n} class={n === l.line ? 'is-hot' : ''}>
                      <span>{n}</span>
                      {code}
                    </div>
                  );
                })}
              </pre>
            )}
            {isOpen && l.hint && (
              <p class="pp-hint">
                <b>Hint:</b> {l.hint}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Functions({ fns, cpuMs }: { fns: FunctionStat[]; cpuMs: number }) {
  const [by, setBy] = useState<'self' | 'total'>('self');
  const rows = [...fns].sort((x, y) =>
    by === 'self' ? y.selfMs - x.selfMs : y.totalMs - x.totalMs,
  );
  const sortButton = (key: 'self' | 'total', label: string) => (
    <button type="button" onClick={() => setBy(key)} aria-pressed={by === key}>
      {label}
      {by === key ? ' ↓' : ''}
    </button>
  );
  return (
    <div class="pp-table-wrap">
      <table class="pp-table">
        <thead>
          <tr>
            <th>Function</th>
            <th class="num">{sortButton('self', 'Self')}</th>
            <th class="num">{sortButton('total', 'Total')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={`${f.url}:${f.line}:${f.name}`}>
              <td>
                <span class="pp-dot" style={{ background: CATEGORY_COLOR[f.category] }} />
                <code class="pp-fn">{f.name.length > 80 ? `${f.name.slice(0, 77)}…` : f.name}</code>
                <small class="pp-loc">
                  {f.file ? `${f.file}:${f.line}` : CATEGORY_LABEL[f.category]}
                </small>
              </td>
              <td class="num">
                {ms(f.selfMs)}
                <small class="pp-loc">{pct(share(f.selfMs, cpuMs))}</small>
              </td>
              <td class="num">{ms(f.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
