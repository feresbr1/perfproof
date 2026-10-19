import type { CpuProfile, ProfileNode } from '../src/core/profile';

export interface Spec {
  name: string;
  url?: string;
  line?: number;
  column?: number;
  /** Samples landing on this node, each 1 ms long. */
  samples?: number;
  ticks?: Record<number, number>;
  children?: Spec[];
}

/** Build a CPU profile from a call tree where every sample lasts exactly 1 ms. */
export function makeProfile(tree: Spec[]): CpuProfile {
  const nodes: ProfileNode[] = [];
  const samples: number[] = [];
  let id = 0;
  const add = (spec: Spec): number => {
    const node: ProfileNode = {
      id: ++id,
      callFrame: {
        functionName: spec.name,
        url: spec.url ?? '',
        lineNumber: (spec.line ?? 1) - 1,
        columnNumber: spec.column ?? 0,
        scriptId: '1',
      },
      hitCount: spec.samples ?? 0,
      children: [],
    };
    if (spec.ticks) {
      node.positionTicks = Object.entries(spec.ticks).map(([line, ticks]) => ({
        line: Number(line),
        ticks,
      }));
    }
    nodes.push(node);
    for (let i = 0; i < (spec.samples ?? 0); i++) samples.push(node.id);
    node.children = (spec.children ?? []).map(add);
    return node.id;
  };
  add({ name: '(root)', children: tree });
  // timeDeltas[0] is ignored by selfTimes; every later gap is 1 ms.
  const timeDeltas = samples.map(() => 1000);
  return { nodes, startTime: 0, endTime: samples.length * 1000, samples, timeDeltas };
}
