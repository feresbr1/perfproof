// Entry point of the flamegraph.html files the CLI writes: reads the embedded report and renders it.
import { render } from 'preact';
import type { Analysis } from '../core/analyze';
import { Report } from './Report';
import { VIEWER_CSS } from './styles';

const style = document.createElement('style');
style.textContent = `${VIEWER_CSS}
html, body { margin: 0; }
body { background: #fbfaf7; }
@media (prefers-color-scheme: dark) { body { background: #12110f; } }
.pp-page { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; min-height: 100vh; }
.pp-brand { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; font-size: 14px; color: var(--muted); }
.pp-brand b { color: var(--ink); font-size: 17px; letter-spacing: -.01em; }
.pp-brand a { color: inherit; }`;
document.head.appendChild(style);

const data = document.getElementById('perfproof-data')?.textContent ?? 'null';
const analysis = JSON.parse(data) as Analysis | null;
const app = document.getElementById('app')!;
app.className = 'pp';

render(
  <div class="pp-page">
    <header class="pp-brand">
      <b>perfproof</b>
      <span>
        {analysis?.createdAt ? new Date(analysis.createdAt).toLocaleString() : ''} ·{' '}
        <a href="https://github.com/feresbr1/perfproof">github.com/feresbr1/perfproof</a>
      </span>
    </header>
    {analysis ? <Report analysis={analysis} /> : <p>This file has no profile data.</p>}
  </div>,
  app,
);
