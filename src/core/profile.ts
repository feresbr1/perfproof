/** The V8 CPU profile format written by `node --cpu-prof` and Chrome DevTools. */
export interface CallFrame {
  functionName: string;
  scriptId?: string | number;
  url: string;
  /** 0-based */
  lineNumber: number;
  /** 0-based */
  columnNumber?: number;
}

export interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
  /** 1-based source lines that were on top of the stack when sampled. */
  positionTicks?: { line: number; ticks: number }[];
}

export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** One profile plus where it came from (a process id, a file name). */
export interface NamedProfile {
  name: string;
  profile: CpuProfile;
}

export class ProfileError extends Error {
  override name = 'ProfileError';
}

/**
 * Parse and validate a `.cpuprofile`. Also accepts the `{ profile: {...} }` wrapper some tools write
 * and Chrome's `Profiler.stop` result.
 */
export function parseCpuProfile(text: string): CpuProfile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProfileError('This is not JSON, so it cannot be a .cpuprofile file.');
  }
  return toCpuProfile(data);
}

export function toCpuProfile(data: unknown): CpuProfile {
  if (isObject(data) && isObject(data.profile) && Array.isArray(data.profile.nodes)) {
    data = data.profile;
  }
  if (Array.isArray(data) || (isObject(data) && Array.isArray(data.traceEvents))) {
    throw new ProfileError(
      'This looks like a Chrome Performance trace, not a CPU profile. In DevTools, record with the "JavaScript Profiler" panel or run Node with --cpu-prof, then load the .cpuprofile file.',
    );
  }
  if (!isObject(data) || !Array.isArray(data.nodes) || data.nodes.length === 0) {
    throw new ProfileError('No call tree found. A .cpuprofile file has a "nodes" array.');
  }
  for (const node of data.nodes as unknown[]) {
    if (
      !isObject(node) ||
      typeof node.id !== 'number' ||
      !isObject(node.callFrame) ||
      typeof node.callFrame.functionName !== 'string'
    ) {
      throw new ProfileError('The "nodes" array has an entry without an id and callFrame.');
    }
  }
  const profile = data as unknown as CpuProfile;
  if (typeof profile.startTime !== 'number' || typeof profile.endTime !== 'number') {
    throw new ProfileError('The profile has no startTime/endTime.');
  }
  if (
    profile.samples &&
    profile.timeDeltas &&
    profile.samples.length !== profile.timeDeltas.length
  ) {
    throw new ProfileError('The samples and timeDeltas arrays have different lengths.');
  }
  return profile;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Microseconds of self time per node id. Uses the sample timeline when present (so uneven sampling
 * intervals are weighted correctly) and falls back to hitCount for profiles without it.
 */
export function selfTimes(profile: CpuProfile): Map<number, number> {
  const out = new Map<number, number>();
  const { samples, timeDeltas } = profile;
  if (samples && timeDeltas && samples.length > 0) {
    const n = samples.length;
    // timeDeltas[i] is the gap before sample i; the time a sample stands for is the gap after it.
    let sum = 0;
    for (let i = 1; i < n; i++) sum += Math.max(0, timeDeltas[i]!);
    const average = n > 1 ? sum / (n - 1) : profile.endTime - profile.startTime;
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? Math.max(0, timeDeltas[i + 1]!) : average;
      const id = samples[i]!;
      out.set(id, (out.get(id) ?? 0) + next);
    }
    return out;
  }
  const hits = profile.nodes.reduce((s, node) => s + (node.hitCount ?? 0), 0);
  const per = hits > 0 ? (profile.endTime - profile.startTime) / hits : 0;
  for (const node of profile.nodes) {
    if (node.hitCount) out.set(node.id, node.hitCount * per);
  }
  return out;
}
