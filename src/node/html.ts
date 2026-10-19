import type { Analysis } from '../core/analyze';

declare const __VIEWER_JS__: string | undefined;

const BACKSLASH = String.fromCharCode(92);

/**
 * JSON that is safe inside an inline <script>: "<" (so "</script>" cannot close the tag) and the
 * two JS line terminators are written as \u escapes.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, `${BACKSLASH}u003c`)
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), `${BACKSLASH}u2028`)
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), `${BACKSLASH}u2029`);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** A single self-contained HTML file: the report and an interactive flame graph, no network. */
export function analysisToHtml(analysis: Analysis, viewerJs?: string): string {
  const js = viewerJs ?? (typeof __VIEWER_JS__ === 'string' ? __VIEWER_JS__ : '');
  const title = analysis.command ? `perfproof · ${analysis.command}` : 'perfproof profile';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="app"></div>
<script id="perfproof-data" type="application/json">${scriptSafeJson(analysis)}</script>
<script>${js.replace(/<\/script/gi, `<${BACKSLASH}/script`)}</script>
</body>
</html>
`;
}
