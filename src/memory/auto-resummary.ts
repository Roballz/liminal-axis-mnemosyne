import type { MemSummary } from './types';

type SummarySource = Pick<MemSummary, 'id' | 'text' | 'createdAt' | 'timeStart' | 'timeEnd'>;
export interface AutoSummaryLeaf extends SummarySource { floor: number }
interface Coverage {
  floorLo: number;
  floorHi: number;
  firstAi: number;
  lastAi: number;
  contiguous: boolean;
}
export interface AutoSummaryRoot extends SummarySource, Coverage { level: number }

/** Build one chronological root sequence, retaining other levels and broken ranges as barriers.
 * AI ordinals include unanswered summary slots, but exclude user/system/omitted messages.
 * Each node's coverage is memoized; no ancestor repeatedly expands all descendant leaves. */
export function collectAutoSummaryRoots(
  leaves: readonly AutoSummaryLeaf[],
  summaries: readonly MemSummary[],
  aiFloors: readonly number[],
): AutoSummaryRoot[] {
  interface Node { source: SummarySource; level: number; children: readonly string[]; terminal?: [number, number] }
  const nodes = new Map<string, Node>();
  const referenced = new Set<string>();
  for (const leaf of leaves) nodes.set(leaf.id, { source: leaf, level: 0, children: [], terminal: [leaf.floor, leaf.floor] });
  for (const s of summaries) {
    nodes.set(s.id, { source: s, level: s.level, children: s.childIds ?? [],
      terminal: s.imported ? [s.importedFloorStart ?? 0, s.importedFloorEnd ?? s.importedFloorStart ?? 0] : undefined });
    for (const id of s.childIds ?? []) referenced.add(id);
  }

  const rank = new Map(aiFloors.map((floor, index) => [floor, index]));
  const lowerBound = (floor: number): number => {
    let lo = 0, hi = aiFloors.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (aiFloors[mid] < floor) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const unknown: Coverage = { floorLo: -1, floorHi: -1, firstAi: -1, lastAi: -1, contiguous: false };
  const memo = new Map<string, Coverage>();
  const coverage = (node: Node): Coverage => {
    const cached = memo.get(node.source.id);
    if (cached) return cached;
    memo.set(node.source.id, unknown); // Missing children and cycles never become automatic inputs.
    let result: Coverage;
    if (node.terminal) {
      const [floorLo, floorHi] = node.terminal;
      const firstAi = node.level === 0 ? rank.get(floorLo) ?? -1 : lowerBound(floorLo);
      const lastAi = node.level === 0 ? firstAi : lowerBound(floorHi + 1) - 1;
      result = { floorLo, floorHi, firstAi, lastAi,
        contiguous: Number.isInteger(floorLo) && Number.isInteger(floorHi) && floorLo >= 0 &&
          floorHi >= floorLo && floorHi <= (aiFloors.at(-1) ?? -1) && firstAi >= 0 && lastAi >= firstAi };
    } else {
      const children = node.children.map(id => {
        const child = nodes.get(id);
        return child ? coverage(child) : unknown;
      }).sort((a, b) => a.firstAi - b.firstAi);
      let floorLo = Infinity, floorHi = -1, firstAi = Infinity, lastAi = -1;
      let contiguous = children.length > 0;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        contiguous &&= child.contiguous && (i === 0 || child.firstAi === children[i - 1].lastAi + 1);
        if (child.firstAi < 0) continue;
        floorLo = Math.min(floorLo, child.floorLo); floorHi = Math.max(floorHi, child.floorHi);
        firstAi = Math.min(firstAi, child.firstAi); lastAi = Math.max(lastAi, child.lastAi);
      }
      result = firstAi === Infinity ? unknown : { floorLo, floorHi, firstAi, lastAi, contiguous };
    }
    memo.set(node.source.id, result);
    return result;
  };

  const roots: AutoSummaryRoot[] = [];
  for (const [id, node] of nodes) {
    if (!referenced.has(id)) roots.push({ ...node.source, level: node.level, ...coverage(node) });
  }
  const key = (root: AutoSummaryRoot) => root.firstAi < 0 ? Infinity : root.firstAi;
  roots.sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id));
  // Legacy cross-gap summaries can overlap preserved roots. Neither side is an automatic candidate.
  let furthest: AutoSummaryRoot | undefined;
  for (const root of roots) {
    if (root.firstAi < 0) continue;
    if (furthest && root.firstAi <= furthest.lastAi) root.contiguous = furthest.contiguous = false;
    if (!furthest || root.lastAi > furthest.lastAi) furthest = root;
  }
  return roots;
}

/** Find the oldest complete run without combining short runs across another level or a missing AI floor. */
export function selectAutoSummaryBatch(
  roots: readonly AutoSummaryRoot[], level: number, threshold: number, keepRecent = 0,
): AutoSummaryRoot[] {
  if (!Number.isInteger(threshold) || threshold < 2) return [];
  let end = roots.length;
  if (level === 0 && keepRecent > 0) {
    let remaining = Math.floor(keepRecent);
    for (let i = roots.length - 1; i >= 0 && remaining > 0; i--) {
      if (roots[i].level === 0) { end = i; remaining -= 1; }
    }
    if (remaining > 0) return [];
  }
  let start = 0, count = 0, previousEnd = -1;
  for (let i = 0; i < end; i++) {
    const root = roots[i];
    if (root.level !== level || !root.contiguous) { count = 0; continue; }
    if (!count || root.firstAi !== previousEnd + 1) { start = i; count = 0; }
    count += 1;
    previousEnd = root.lastAi;
    if (count === threshold) return roots.slice(start, i + 1);
  }
  return [];
}
