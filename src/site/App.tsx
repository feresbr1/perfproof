import { useEffect, useRef, useState } from 'preact/hooks';
import type { Analysis } from '../core/analyze';
import { benchText, textReport, type BenchResult } from '../core/report';
import { compare, summarize } from '../core/stats';
import { Report } from '../viewer/Report';
import { VIEWER_CSS } from '../viewer/styles';
import demoReport from './demo-report.json';
import demoBench from './demo-bench.json';
import { loadFiles } from './load';

export const REPO = 'https://github.com/feresbr1/perfproof';
const RUN = 'npx github:feresbr1/perfproof';
const DEMO = demoReport as unknown as Analysis;

const style = document.createElement('style');
style.textContent = VIEWER_CSS;
document.head.appendChild(style);

function useRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => {
      setHash(location.hash || '#/');
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const route = useRoute();
  const path = route.replace(/^#/, '').split('?')[0]!;
  let page;
  if (path === '/demo') page = <DemoPage />;
  else if (path === '/view') page = <ViewPage />;
  else page = <Landing />;

  useEffect(() => {
    document.title =
      path === '/demo'
        ? 'Demo report · perfproof'
        : path === '/view'
          ? 'Open a profile · perfproof'
          : 'perfproof: find the slow line, prove the fix';
  }, [path]);

  return (
    <div class="pp">
      <a class="sr-only skip" href="#main">
        Skip to content
      </a>
      <header class="site">
        <div class="wrap bar">
          <a class="logo" href="#/">
            <Logo />
            perfproof
          </a>
          <nav aria-label="Site">
            <a href="#/demo" aria-current={path === '/demo' ? 'page' : undefined}>
              Demo
            </a>
            <a href="#/view" aria-current={path === '/view' ? 'page' : undefined}>
              Open a profile
            </a>
            <a href={REPO}>GitHub</a>
          </nav>
        </div>
      </header>
      <main id="main">{page}</main>
      <footer class="site">
        <div class="wrap">
          MIT licensed · <a href={REPO}>Source on GitHub</a> · <a href={`${REPO}/issues`}>Issues</a>{' '}
          · Profiles you open here never leave your browser.
        </div>
      </footer>
    </div>
  );
}

function Logo() {
  return (
    <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <rect x="5" y="21" width="22" height="5" rx="1.5" fill="var(--bg)" />
      <rect x="5" y="14.5" width="15" height="5" rx="1.5" fill="#ff6a33" />
      <rect x="21.5" y="14.5" width="5.5" height="5" rx="1.5" fill="#8b5cf6" />
      <rect x="5" y="8" width="9" height="5" rx="1.5" fill="#e5470f" />
    </svg>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div class="copy">
      <code>{text}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            /* clipboard blocked; the text is selectable */
          }
        }}
        aria-label={`Copy: ${text}`}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function demoBenchText(): string {
  const before = demoBench.before as BenchResult;
  const after = demoBench.after as BenchResult;
  const cur = { ...after, summary: summarize(after.runs) };
  const base = { ...before, summary: summarize(before.runs) };
  return benchText(cur, { name: 'before', result: base, cmp: compare(before.runs, after.runs) });
}

function Landing() {
  const profileText = textReport(DEMO, { top: 2 }).split('\nHot functions')[0]!.trimEnd();
  const cmp = compare(demoBench.before.runs, demoBench.after.runs);
  return (
    <>
      <section class="hero wrap">
        <div class="hero-copy">
          <p class="kicker">CPU profiler + benchmark for Node.js</p>
          <h1>
            Find the slow line.
            <br />
            <span>Prove the fix.</span>
          </h1>
          <p class="lede">
            <code>perfproof run -- npm test</code> profiles every Node.js process a command starts
            and answers with the exact lines that burn CPU, with code and a flame graph.{' '}
            <code>perfproof bench</code> then tells you whether your change made it faster, with a
            real statistical test instead of a hunch.
          </p>
          <Copy text={`${RUN} run -- node your-script.js`} />
          <div class="cta">
            <a class="btn primary" href="#/demo">
              See a real report
            </a>
            <a class="btn" href="#/view">
              Open a .cpuprofile
            </a>
          </div>
          <p class="small">Node.js 22.15+ · no install, no account, no native addons · MIT</p>
        </div>
        <figure class="term" aria-label="Example output of perfproof run">
          <div class="term-bar">
            <i />
            <i />
            <i />
            <span>perfproof run -- node report.js</span>
          </div>
          <pre>{profileText}</pre>
        </figure>
      </section>

      <section class="wrap loop" aria-labelledby="loop-title">
        <h2 id="loop-title">The loop: measure, fix, prove</h2>
        <ol class="steps">
          <li>
            <b>1 · Measure</b>
            <p>
              Run your script, test suite or build through <code>perfproof run</code>. It switches
              on V8's sampling profiler in every Node.js process (npm, workers, child processes) and
              ranks the hot lines.
            </p>
            <code class="cmd">perfproof run -- npm run build</code>
          </li>
          <li>
            <b>2 · Fix the top line</b>
            <p>
              Each hot line comes with its source and, for common culprits (linear scans in loops,
              regexes rebuilt per call, sync I/O, copying spreads), a hint about why it is slow.
            </p>
            <code class="cmd">perfproof bench --save before -- npm run build</code>
          </li>
          <li>
            <b>3 · Prove it</b>
            <p>
              Benchmark again against the saved baseline. Welch's t-test separates a real speed-up
              from run-to-run noise, so "it feels faster" becomes a number.
            </p>
            <code class="cmd">perfproof bench --compare before -- npm run build</code>
          </li>
        </ol>
        <figure class="term small-term" aria-label="Example output of perfproof bench --compare">
          <pre>{demoBenchText()}</pre>
        </figure>
        <p class="caption">
          Real output for <a href={`${REPO}/tree/main/examples/log-report`}>examples/log-report</a>,
          measured on a Windows laptop. <code>report.fast.js</code> is <code>report.js</code> with
          the two hot lines above fixed (a <code>Set</code> instead of <code>includes</code>, the
          regex built once): {cmp.speedup.toFixed(1)}× faster, same output.
        </p>
      </section>

      <section class="wrap agents" aria-labelledby="agents-title">
        <div>
          <h2 id="agents-title">Give your coding agent a profiler</h2>
          <p>
            Ask an agent to "make this faster" and it usually guesses. perfproof's text report is
            short and ranked, so an agent can read it, fix the hottest line, and back its claim with
            a benchmark verdict. Install the skill and it follows that loop on its own:
          </p>
          <Copy text="npx skills add feresbr1/perfproof" />
          <p class="small">
            Works with Claude Code, Codex, Cursor, Gemini CLI and other agents that read{' '}
            <code>SKILL.md</code> files. Or run <code>{RUN} guide</code> and paste the workflow into
            your agent's instructions.
          </p>
        </div>
        <ul class="facts">
          <li>
            <b>Whole command trees.</b> <code>npm test</code> spawns npm, a runner and workers; each
            writes a profile and perfproof merges them.
          </li>
          <li>
            <b>Exact lines.</b> perfproof turns off V8's on-stack replacement while profiling, which
            otherwise blames a hot loop's time on the line that called the function.
          </li>
          <li>
            <b>Text, Markdown, JSON, HTML.</b> Paste the Markdown into a PR, feed the JSON to a
            script, open the flame graph in a browser.
          </li>
          <li>
            <b>Nothing to install.</b> One dependency-free file, run with npx. Runs are kept in a
            self-ignoring <code>.perfproof/</code> folder.
          </li>
        </ul>
      </section>
    </>
  );
}

function DemoPage() {
  return (
    <div class="wrap page">
      <div class="page-head">
        <h1>Demo report</h1>
        <p>
          A real profile of{' '}
          <a href={`${REPO}/blob/main/examples/log-report/report.js`}>report.js</a>, a small
          access-log summariser, recorded with <code>perfproof run -- node report.js</code>. The CLI
          writes this same page as <code>flamegraph.html</code> next to every run.{' '}
          <a href="./demo/log-report.cpuprofile" download>
            Download the raw .cpuprofile
          </a>{' '}
          to try the viewer.
        </p>
      </div>
      <Report analysis={DEMO} />
    </div>
  );
}

function ViewPage() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const open = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setBusy(true);
    setError(null);
    // Let the "Reading…" state paint before parsing a large file.
    await new Promise((r) => setTimeout(r, 30));
    try {
      setAnalysis(await loadFiles(files));
      setNames(files.map((f) => f.name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (analysis) {
    return (
      <div class="wrap page">
        <div class="page-head row">
          <div>
            <h1>Profile</h1>
            <p class="mono small">{names.join(', ')}</p>
          </div>
          <button type="button" class="btn" onClick={() => setAnalysis(null)}>
            Open another
          </button>
        </div>
        <Report analysis={analysis} />
      </div>
    );
  }

  return (
    <div class="wrap page">
      <div class="page-head">
        <h1>Open a profile</h1>
        <p>
          Drop one or more <code>.cpuprofile</code> files (from <code>node --cpu-prof</code>, Chrome
          DevTools or perfproof itself) or a perfproof <code>report.json</code>. Files are read in
          your browser and never uploaded.
        </p>
      </div>
      <div
        class={`drop ${over ? 'is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void open(e.dataTransfer?.files ?? null);
        }}
        data-testid="drop"
      >
        <p class="drop-title">{busy ? 'Reading…' : 'Drop .cpuprofile files here'}</p>
        <p>or</p>
        <button
          type="button"
          class="btn primary"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          Choose files
        </button>
        <label class="sr-only" for="file">
          Choose .cpuprofile or report.json files
        </label>
        <input
          ref={input}
          id="file"
          type="file"
          accept=".cpuprofile,.json,application/json"
          multiple
          hidden
          onChange={(e) => {
            void open(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <p class="small">
          No profile at hand?{' '}
          <a href="./demo/log-report.cpuprofile" download>
            Download a sample
          </a>{' '}
          or record one: <code>node --cpu-prof app.js</code>
        </p>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
