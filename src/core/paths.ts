export type Category =
  'user' | 'deps' | 'node' | 'native' | 'gc' | 'program' | 'idle' | 'wait' | 'root';

export const CATEGORY_LABEL: Record<Category, string> = {
  user: 'your code',
  deps: 'dependencies',
  node: 'Node.js internals',
  native: 'native / V8 builtins',
  gc: 'garbage collection',
  program: '(program) unattributed native',
  idle: 'idle',
  wait: 'waiting on child processes',
  root: 'root',
};

/** The file name perfproof injects with --require; never reported as user code. */
export const PRELOAD_NAME = 'perfproof-preload.cjs';

export function categorize(functionName: string, url: string): Category {
  switch (functionName) {
    case '(root)':
      return 'root';
    case '(idle)':
      return 'idle';
    case '(program)':
      return 'program';
    case '(garbage collector)':
      return 'gc';
  }
  if (!url) return 'native';
  if (url.startsWith('node:')) {
    if (/child_process$/.test(url) && /^(spawnSync|execFileSync|execSync)$/.test(functionName)) {
      return 'wait';
    }
    return 'node';
  }
  if (url.includes(PRELOAD_NAME)) return 'node';
  if (/[\\/]node_modules[\\/]/.test(url)) return 'deps';
  if (/^(chrome-extension|extensions|v8|wasm|evalmachine)/.test(url)) return 'native';
  return 'user';
}

/** Turn a frame URL into the short path people recognise. */
export function displayPath(url: string, root?: string): string {
  if (!url) return '';
  let path = url;
  if (url.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      path = url.slice('file://'.length);
    }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1); // /C:/x -> C:/x
  } else if (/^https?:\/\//.test(url)) {
    try {
      const u = new URL(url);
      path = u.host + u.pathname;
    } catch {
      /* keep the raw url */
    }
  } else {
    path = url.replace(/\\/g, '/');
  }
  const nm = path.lastIndexOf('/node_modules/');
  if (nm !== -1) return path.slice(nm + 1);
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (path.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return path.slice(r.length + 1);
  }
  return path;
}

/** Local file path for a frame URL, or null when it is not a file. */
export function fileFromUrl(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      let path = decodeURIComponent(new URL(url).pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      return path;
    } catch {
      return null;
    }
  }
  if (/^([A-Za-z]:[\\/]|\/)/.test(url)) return url;
  return null;
}

/** `node_modules/@scope/pkg/...` -> `@scope/pkg` */
export function packageName(path: string): string | null {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path.replace(/\\/g, '/'));
  return m ? m[1]! : null;
}
