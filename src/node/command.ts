import { spawn } from 'node:child_process';

export interface Spawned {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  wallMs: number;
  /** The last few KB of output, kept when output is hidden so failures can still be explained. */
  tail: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** inherit: show the command's output; hide: discard it (but keep a tail for errors). */
  output: 'inherit' | 'hide';
}

const isWindows = process.platform === 'win32';

/** Render argv as one shell command line (for display, and for cmd.exe on Windows). */
export function commandLine(argv: string[]): string {
  return argv.map(quote).join(' ');
}

function quote(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"'&|<>^()%!;$`*?[\]{}~#]/.test(arg)) return arg;
  if (isWindows) return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command and time it. Windows needs a shell to find `npm`, `npx` and other .cmd shims; a
 * single argument containing spaces is treated as a shell command line everywhere.
 */
export function runCommand(argv: string[], opts: SpawnOptions): Promise<Spawned> {
  const asShellLine = argv.length === 1 && /\s/.test(argv[0]!);
  const useShell = isWindows || asShellLine;
  const [file, args] = useShell
    ? [asShellLine ? argv[0]! : commandLine(argv), [] as string[]]
    : [argv[0]!, argv.slice(1)];
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let tail = '';
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000);
    };
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: useShell,
      stdio: opts.output === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new Error(`Command not found: ${argv[0]}`));
      else reject(err);
    });
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal, wallMs: performance.now() - start, tail });
    });
  });
}
