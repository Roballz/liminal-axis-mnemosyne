import type { Transaction } from './db';
import { check, type Block, type CapturedView, type MemoryRevision, type Revision, type Snapshot, type SourceRef } from './model';
import { localSummaryFallback, ownSummarySources, summaryDependencies } from './summary-applicability';

/** Transaction-local source projection. Shared baselines are indexed once; a
 * legacy L0 never copies the whole prefix just to inspect its own turn. */
export function summaryApplicabilityReader(tx: Transaction, views: readonly Pick<CapturedView, 'snapshot' | 'refs' | 'sources'>[] = []) {
    type IndexedBlock = { refs: SourceRef[]; positions: Map<string, number> };
    type Basis = { position(message: string): number | undefined; at(index: number): SourceRef | undefined; all(): SourceRef[] };
    const bases = new Map<string, Promise<Basis | undefined>>();
    const blocks = new Map<string, Promise<IndexedBlock | undefined>>();
    const roles = new Map<string, Promise<Revision['role'] | undefined>>();
    const indexed = (refs: SourceRef[]): IndexedBlock => ({ refs, positions: new Map(refs.map((ref, i) => [ref.message, i])) });
    const spansOf = (parts: IndexedBlock[], expected: number): Basis => {
        let length = 0;
        const spans = parts.map(block => { const offset = length; length += block.refs.length; return { block, offset }; });
        check(length === expected, '历史清单计数错误');
        return {
            position(message) {
                for (const span of spans) {
                    const index = span.block.positions.get(message);
                    if (index !== undefined) return span.offset + index;
                }
            },
            at(index) {
                if (index < 0 || index >= length) return undefined;
                let low = 0, high = spans.length - 1;
                while (low < high) {
                    const middle = Math.ceil((low + high) / 2);
                    if (spans[middle].offset <= index) low = middle;
                    else high = middle - 1;
                }
                const span = spans[low];
                return span.block.refs[index - span.offset];
            },
            all: () => parts.flatMap(block => block.refs),
        };
    };
    const block = (id: string) => {
        if (!blocks.has(id)) blocks.set(id, tx.get<Block>('manifest_blocks', id).then(row => row && indexed(row.entries)));
        return blocks.get(id)!;
    };
    const basis = (id: string) => {
        if (!bases.has(id)) bases.set(id, (async () => {
            const captured = views.find(view => view.snapshot.id === id && view.refs.length === view.snapshot.length);
            if (captured) return spansOf([indexed(captured.refs)], captured.refs.length);
            const snapshot = await tx.get<Snapshot>('history_snapshots', id);
            if (!snapshot) return undefined;
            const parts = await Promise.all(snapshot.blocks.map(block));
            check(parts.every((part): part is IndexedBlock => !!part), '缺少历史清单块');
            return spansOf(parts, snapshot.length);
        })());
        return bases.get(id)!;
    };
    const role = (id: string) => {
        if (!roles.has(id)) {
            const source = views.find(view => view.sources.has(id))?.sources.get(id);
            roles.set(id, source ? Promise.resolve(source.role) : tx.get<Revision>('source_revisions', id).then(row => row?.role));
        }
        return roles.get(id)!;
    };
    const sources = async (memory: MemoryRevision): Promise<SourceRef[]> => {
        check(!memory.sourceRecovery, '旧核心包缺少这条摘要的生成来源，请先核对并确认当前摘要');
        if (summaryDependencies(memory).length) return [];
        if (memory.coverage.length) return memory.coverage;
        if (memory.inputRefs.length && !localSummaryFallback(memory)) return memory.inputRefs;
        const saved = await basis(memory.basis);
        check(saved, '摘要基线缺失');
        if (memory.level !== 0 || !memory.anchor) return saved.all();
        const index = saved.position(memory.anchor);
        if (index === undefined) return [];
        const anchor = saved.at(index)!, previous = saved.at(index - 1);
        const previousUser = previous && await role(previous.revision) === 'user' ? previous.message : undefined;
        return ownSummarySources(memory, previous ? [previous, anchor] : [anchor], previousUser).slice();
    };
    const hasAnchor = async (memory: MemoryRevision) => !memory.anchor || (await basis(memory.basis))?.position(memory.anchor) !== undefined;
    return { sources, hasAnchor };
}
