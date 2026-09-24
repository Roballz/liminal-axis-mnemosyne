import type { Library, Transaction } from './db';
import { isRoleOnlyPair, sourceRefMatches } from './source-equivalence';
import { check, type Block, type Branch, type CapturedView, type Revision, type Snapshot, type SourceRef, type SourceRoleRepair } from './model';

export interface RoleRepairCandidate {
    floor: number;
    before: SourceRef;
    after: SourceRef;
    excerpt: string;
}
async function historicalRevisionIds(tx: Transaction, branch: string): Promise<Set<string>> {
    const snapshots = await tx.all<Snapshot>('history_snapshots', 'branch', branch);
    const blocks = await Promise.all([...new Set(snapshots.flatMap(s => s.blocks))].map(id => tx.get<Block>('manifest_blocks', id)));
    check(blocks.every(Boolean), '历史清单块缺失');
    return new Set(blocks.flatMap(block => block!.entries.map(ref => ref.revision)));
}
/** Read-only. Host eligibility alone is not proof of the historical author; confirmation is required. */
export async function previewRoleRepairs(lib: Library, view: CapturedView, eligible: SourceRef[]): Promise<RoleRepairCandidate[]> {
    return lib.transaction(['history_snapshots', 'manifest_blocks', 'source_revisions'], 'readonly', async tx => {
        const historical = await historicalRevisionIds(tx, view.branch.id);
        const candidates: RoleRepairCandidate[] = [];
        for (const after of eligible) {
            const floor = view.refs.findIndex(r => r.message === after.message && r.revision === after.revision);
            const source = view.sources.get(after.revision);
            if (floor < 0 || !source || source.role !== 'assistant') continue;
            for (const old of await tx.all<Revision>('source_revisions', 'owner', after.message)) {
                const before = { message: old.owner, revision: old.id };
                if (historical.has(old.id) && isRoleOnlyPair(old, source) && !sourceRefMatches(view.branch, before, after))
                    candidates.push({ floor, before, after, excerpt: Array.from(source.content).slice(0, 100).join('') });
            }
        }
        return candidates;
    });
}
/** Append confirmations in one guarded transaction. Never rewrite originals or broad summary approvals. */
export async function confirmRoleRepairs(lib: Library, view: CapturedView, candidates: RoleRepairCandidate[], guard: () => boolean) {
    check(candidates.length > 0, '没有可确认的隐藏来源修复');
    await lib.transaction(['branches', 'source_revisions', 'history_snapshots', 'manifest_blocks'], 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.head === view.branch.head && branch.view === view.branch.view && branch.epoch === view.branch.epoch, '视图已改变，请重新预览');
        const historical = await historicalRevisionIds(tx, branch.id);
        const pairs: SourceRoleRepair[] = [...(branch.sourceRoleRepairs ?? [])];
        for (const candidate of candidates) {
            const { before, after, floor } = candidate;
            const old = await tx.get<Revision>('source_revisions', before.revision);
            const next = await tx.get<Revision>('source_revisions', after.revision);
            check(old && next && before.message === after.message && old.owner === before.message && next.owner === after.message &&
                old.story === branch.story && historical.has(old.id) && isRoleOnlyPair(old, next) &&
                view.refs[floor]?.message === after.message && view.refs[floor]?.revision === after.revision,
                '来源差异不再符合修复条件，请重新预览');
            if (!pairs.some(p => p.before.revision === before.revision && p.after.revision === after.revision))
                pairs.push({ before, after, confirmedAt: Date.now() });
        }
        check(guard(), '聊天已改变，请重新预览');
        const updated: Branch = { ...branch, sourceRoleRepairSchema: 1, sourceRoleRepairs: pairs, epoch: branch.epoch + 1 };
        await tx.put('branches', updated);
    });
}
