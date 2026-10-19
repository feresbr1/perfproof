import { share, type Analysis, type LineStat } from './analyze';
import { bar, ms, pct, pValue, times } from './format';
import { CATEGORY_LABEL } from './paths';
import type { Comparison, Summary } from './stats';

export interface ReportOptions {
  /** How many hot lines / functions to list (default 8). */
  top?: number;
  /** Folder with the saved run (printed at the end). */
  savedTo?: string;
}

/** Plain-text report, written for humans and coding agents alike: short, ranked, with evidence. */
export function textReport(a: Analysis, opts: ReportOptions = {}): string {
  const top = opts.top ?? 8;
  const out: string[] = [];
  const head = ['perfproof'];
  if (a.command) head.push(a.command);
  out.push(head.join(' · '));
  const facts: string[] = [];
  if (a.wallMs !== undefined) facts.push(`wall ${ms(a.wallMs)}`);
  facts.push(`CPU ${ms(a.cpuMs)}`);
  facts.push(a.processes.length === 1 ? '1 process' : `${a.processes.length} processes`);
  if (a.exitCode !== undefined && a.exitCode !== null && a.exitCode !== 0) {
    facts.push(`exit code ${a.exitCode}`);
  }
  out.push(facts.join(' · '), '');

  out.push('Where the CPU time goes');
  for (const c of a.categories.filter((c) => c.category !== 'idle' && c.category !== 'wait')) {
    const s = share(c.ms, a.cpuMs);
    if (s < 0.5) continue;
    out.push(
      `  ${CATEGORY_LABEL[c.category].padEnd(30)} ${pct(s).padStart(6)}  ${bar(s / 100)}  ${ms(c.ms)}`,
    );
  }
  out.push('');

  const lines = a.lines.slice(0, top);
  if (lines.length) {
    out.push('Hot lines (self time)');
    lines.forEach((l, i) => {
      out.push(
        `  ${String(i + 1).padStart(2)}. ${l.file}:${l.line}  ${l.fn}  ${ms(l.selfMs)}  ${pct(share(l.selfMs, a.cpuMs))}${l.category === 'user' ? '' : `  [${CATEGORY_LABEL[l.category]}]`}`,
      );
      if (l.snippet) out.push(...snippetLines(l, '      '));
      if (l.hint) out.push(`      hint: ${l.hint}`);
    });
    out.push('');
  }

  const fns = a.functions.slice(0, top);
  if (fns.length) {
    out.push('Hot functions (self · total)');
    for (const f of fns) {
      const where = f.file ? `${f.file}:${f.line}` : CATEGORY_LABEL[f.category];
      out.push(
        `  ${pct(share(f.selfMs, a.cpuMs)).padStart(6)}  ${ms(f.selfMs).padStart(9)} · ${ms(f.totalMs).padStart(9)}  ${f.name}  ${where}`,
      );
    }
    out.push('');
  }

  if (a.processes.length > 1) {
    out.push('Processes');
    for (const p of [...a.processes].sort((x, y) => y.cpuMs - x.cpuMs)) {
      const wait = p.waitMs > 1 ? `, waited ${ms(p.waitMs)} on children` : '';
      out.push(`  ${p.name.padEnd(13)} ${ms(p.cpuMs).padStart(9)} CPU  ${p.label}${wait}`);
    }
    out.push('');
  }

  if (a.hints.length) {
    out.push('Notes');
    for (const h of a.hints) out.push(`  - ${h}`);
    out.push('');
  }
  if (opts.savedTo)
    out.push(`Saved ${opts.savedTo} (report.md, report.json, flamegraph.html, *.cpuprofile)`);
  return out.join('\n').trimEnd() + '\n';
}

function snippetLines(l: LineStat, indent: string): string[] {
  if (!l.snippet) return [];
  const width = String(l.snippet.start + l.snippet.code.length - 1).length;
  return l.snippet.code.map((code, i) => {
    const n = l.snippet!.start + i;
    const mark = n === l.line ? '>' : ' ';
    return `${indent}${mark} ${String(n).padStart(width)} | ${code}`.trimEnd();
  });
}

/** Markdown report: paste into a PR description, an issue, or an agent's final answer. */
export function markdownReport(a: Analysis, opts: ReportOptions = {}): string {
  const top = opts.top ?? 10;
  const out: string[] = [];
  out.push(`## perfproof profile${a.command ? `: \`${a.command}\`` : ''}`, '');
  const facts: string[] = [];
  if (a.wallMs !== undefined) facts.push(`**Wall:** ${ms(a.wallMs)}`);
  facts.push(`**CPU:** ${ms(a.cpuMs)}`);
  facts.push(`**Processes:** ${a.processes.length}`);
  out.push(facts.join(' · '), '');

  out.push('| Category | Share | Time |', '| --- | ---: | ---: |');
  for (const c of a.categories.filter((c) => c.category !== 'idle' && c.category !== 'wait')) {
    if (share(c.ms, a.cpuMs) < 0.5) continue;
    out.push(`| ${CATEGORY_LABEL[c.category]} | ${pct(share(c.ms, a.cpuMs))} | ${ms(c.ms)} |`);
  }
  out.push('');

  const lines = a.lines.slice(0, top);
  if (lines.length) {
    out.push(
      '### Hot lines',
      '',
      '| # | Line | Function | Self | Share |',
      '| ---: | --- | --- | ---: | ---: |',
    );
    lines.forEach((l, i) => {
      out.push(
        `| ${i + 1} | \`${md(l.file)}:${l.line}\` | \`${md(l.fn)}\` | ${ms(l.selfMs)} | ${pct(share(l.selfMs, a.cpuMs))} |`,
      );
    });
    out.push('');
    const first = lines.find((l) => l.snippet);
    if (first?.snippet) {
      out.push(`Hottest line in context (\`${first.file}:${first.line}\`):`, '', '```js');
      out.push(...snippetLines(first, ''));
      out.push('```', '');
      if (first.hint) out.push(`> ${first.hint}`, '');
    }
  }

  const fns = a.functions.slice(0, top);
  if (fns.length) {
    out.push(
      '### Hot functions',
      '',
      '| Function | Location | Self | Total |',
      '| --- | --- | ---: | ---: |',
    );
    for (const f of fns) {
      out.push(
        `| \`${md(f.name)}\` | ${f.file ? `\`${md(f.file)}:${f.line}\`` : CATEGORY_LABEL[f.category]} | ${ms(f.selfMs)} | ${ms(f.totalMs)} |`,
      );
    }
    out.push('');
  }
  if (a.hints.length) {
    for (const h of a.hints) out.push(`- ${h}`);
    out.push('');
  }
  out.push('<sub>Generated by [perfproof](https://github.com/feresbr1/perfproof).</sub>');
  return out.join('\n') + '\n';
}

function md(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/`/g, "'");
}

// --- bench ---------------------------------------------------------------------------------------

export interface BenchResult {
  command: string;
  runs: number[];
  summary: Summary;
  failures: number;
  node?: string;
  createdAt?: string;
}

export function benchText(
  result: BenchResult,
  base?: { name: string; result: BenchResult; cmp: Comparison },
): string {
  const s = result.summary;
  const out: string[] = [];
  out.push(`perfproof bench · ${result.command}`);
  out.push(
    `  ${s.n} runs: ${ms(s.mean)} ± ${ms(s.ci95)} (95% CI) · median ${ms(s.median)} · min ${ms(s.min)} · max ${ms(s.max)} · sd ${ms(s.sd)}`,
  );
  if (s.mean > 0 && s.sd / s.mean > 0.1) {
    out.push('  note: runs vary by more than 10%; close other programs or add more runs (-n).');
  }
  if (base) {
    const b = base.result.summary;
    out.push(`  baseline "${base.name}": ${ms(b.mean)} ± ${ms(b.ci95)} (${b.n} runs)`);
    out.push('', `  ${verdictLine(base.cmp)}`);
  }
  return out.join('\n') + '\n';
}

export function verdictLine(cmp: Comparison): string {
  const change = `${cmp.change > 0 ? '+' : ''}${(cmp.change * 100).toFixed(1)}%`;
  if (cmp.verdict === 'faster') {
    return `FASTER: ${times(cmp.speedup)} faster than the baseline (${change} time, ${pValue(cmp.p)})`;
  }
  if (cmp.verdict === 'slower') {
    return `SLOWER: takes ${times(1 / cmp.speedup)} as long as the baseline (${change} time, ${pValue(cmp.p)})`;
  }
  return `NO SIGNIFICANT DIFFERENCE (${change}, ${pValue(cmp.p)}). Treat it as noise.`;
}

export function benchMarkdown(
  result: BenchResult,
  base?: { name: string; result: BenchResult; cmp: Comparison },
): string {
  const s = result.summary;
  const rows = ['| | Mean | 95% CI | Median | Runs |', '| --- | ---: | ---: | ---: | ---: |'];
  if (base) {
    const b = base.result.summary;
    rows.push(
      `| Baseline (${base.name}) | ${ms(b.mean)} | ± ${ms(b.ci95)} | ${ms(b.median)} | ${b.n} |`,
    );
  }
  rows.push(`| Current | ${ms(s.mean)} | ± ${ms(s.ci95)} | ${ms(s.median)} | ${s.n} |`);
  const out = [`## perfproof bench: \`${result.command}\``, '', ...rows, ''];
  if (base) out.push(`**${verdictLine(base.cmp)}** (Welch's t-test)`, '');
  return out.join('\n');
}
