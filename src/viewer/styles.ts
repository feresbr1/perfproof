/** Styles for the report viewer, shared by the website and the standalone flamegraph.html. */
export const VIEWER_CSS = `
.pp {
  --bg: #fbfaf7; --panel: #ffffff; --ink: #17140f; --muted: #6b665c; --line: #e6e1d6;
  --soft: #f3f0e8; --hot: #e5470f; --hot-soft: #fde6dc; --ok: #0f8a5f; --warn: #b7791f;
  --c-user: #e5470f; --c-deps: #8b5cf6; --c-node: #0e7490; --c-native: #78716c;
  --c-gc: #ca8a04; --c-program: #a8a29e; --c-wait: #cbd5e1; --c-idle: #e2e8f0;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--ink); background: var(--bg); font: 15px/1.5 var(--sans);
}
@media (prefers-color-scheme: dark) {
  .pp:not([data-theme='light']) {
    --bg: #12110f; --panel: #1b1a17; --ink: #f2efe8; --muted: #a39e93; --line: #2f2c27;
    --soft: #23211d; --hot: #ff6a33; --hot-soft: #3a1f14; --ok: #34d399; --warn: #fbbf24;
    --c-native: #a8a29e; --c-program: #57534e; --c-wait: #334155; --c-idle: #1e293b;
  }
}
.pp[data-theme='dark'] {
  --bg: #12110f; --panel: #1b1a17; --ink: #f2efe8; --muted: #a39e93; --line: #2f2c27;
  --soft: #23211d; --hot: #ff6a33; --hot-soft: #3a1f14; --ok: #34d399; --warn: #fbbf24;
  --c-native: #a8a29e; --c-program: #57534e; --c-wait: #334155; --c-idle: #1e293b;
}
.pp * { box-sizing: border-box; }
.pp-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pp code, .pp pre, .pp .mono { font-family: var(--mono); font-variant-ligatures: none; }
.pp-report { display: grid; gap: 20px; }
.pp-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; min-width: 0; }
.pp-card h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
.pp-head { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: baseline; }
.pp-cmd { font-family: var(--mono); font-size: 15px; word-break: break-all; flex: 1 1 100%; margin: 0; font-weight: 600; }
.pp-stat { display: flex; flex-direction: column; }
.pp-stat b { font-size: 26px; letter-spacing: -.02em; font-weight: 700; font-variant-numeric: tabular-nums; }
.pp-stat span { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.pp-stack { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--soft); }
.pp-stack > div { height: 100%; min-width: 2px; }
.pp-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; font-size: 13px; }
.pp-legend span { display: inline-flex; align-items: center; gap: 6px; }
.pp-legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.pp-legend em { font-style: normal; color: var(--muted); font-variant-numeric: tabular-nums; }
.pp-lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.pp-line { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.pp-line > button { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; padding: 10px 12px; position: relative; }
.pp-line > button:focus-visible { outline: 2px solid var(--hot); outline-offset: -2px; }
.pp-line > button:hover { background: var(--soft); }
.pp-rank { font-family: var(--mono); color: var(--muted); font-size: 13px; text-align: right; }
.pp-where { min-width: 0; }
.pp-where code { font-size: 14px; font-weight: 600; word-break: break-all; }
.pp-where small { display: block; color: var(--muted); font-size: 12.5px; }
.pp-amount { text-align: right; font-variant-numeric: tabular-nums; font-size: 14px; white-space: nowrap; }
.pp-amount b { display: block; font-size: 16px; }
.pp-amount small { color: var(--muted); }
.pp-meter { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--hot); border-radius: 0 2px 2px 0; }
.pp-snippet { margin: 0; padding: 10px 0; background: var(--soft); border-top: 1px solid var(--line); overflow-x: auto; font-size: 13px; line-height: 1.6; }
.pp-snippet div { padding: 0 14px; white-space: pre; }
.pp-snippet .is-hot { background: var(--hot-soft); box-shadow: inset 3px 0 0 var(--hot); }
.pp-snippet span { color: var(--muted); user-select: none; display: inline-block; min-width: 3.2em; }
.pp-hint { margin: 0; padding: 10px 14px; font-size: 13.5px; border-top: 1px dashed var(--line); }
.pp-hint b { color: var(--hot); }
.pp-tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px; background: var(--soft); color: var(--muted); margin-left: 6px; vertical-align: 1px; font-family: var(--sans); font-weight: 500; }
.pp-table-wrap { overflow-x: auto; }
.pp-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.pp-table th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.pp-table td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.pp-table td.num, .pp-table th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pp-table code { font-size: 13px; word-break: break-all; }
.pp-table button { all: unset; cursor: pointer; color: inherit; }
.pp-table button:focus-visible { outline: 2px solid var(--hot); }
.pp-loc { display: block; color: var(--muted); font-size: 12px; font-family: var(--mono); word-break: break-all; margin-left: 16px; }
.pp-table td.num .pp-loc { margin-left: 0; }
.pp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
.pp-notes { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.pp-flame-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.pp-flame-bar input { flex: 1 1 200px; font: inherit; font-size: 14px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
.pp-flame-bar input:focus { outline: 2px solid var(--hot); outline-offset: -1px; }
.pp-btn { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
.pp-btn:hover { background: var(--soft); }
.pp-btn:focus-visible { outline: 2px solid var(--hot); }
.pp-crumbs { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 8px; min-height: 20px; }
.pp-crumbs button { all: unset; cursor: pointer; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
.pp-flame { position: relative; overflow: hidden; border-radius: 8px; background: var(--soft); }
.pp-flame button { all: unset; box-sizing: border-box; position: absolute; height: 21px; font: 11.5px/21px var(--mono); padding: 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; cursor: pointer; border-right: 1px solid var(--soft); border-bottom: 1px solid var(--soft); }
.pp-flame button:hover, .pp-flame button:focus-visible { filter: brightness(1.15); outline: 2px solid var(--ink); outline-offset: -2px; z-index: 1; }
.pp-flame button.is-dim { opacity: .25; }
.pp-flame button.is-light { color: #111; }
.pp-detail { margin-top: 10px; font-size: 13.5px; min-height: 42px; color: var(--muted); }
.pp-detail code { color: var(--ink); }
.pp-detail b { color: var(--ink); font-variant-numeric: tabular-nums; }
.pp-empty { color: var(--muted); font-size: 14px; }
@media (max-width: 640px) {
  .pp-card { padding: 14px; border-radius: 12px; }
  .pp-stat b { font-size: 21px; }
  .pp-line > button { grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; }
}
`;
