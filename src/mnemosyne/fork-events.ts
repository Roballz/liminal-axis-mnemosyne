import type { Transaction } from './db';
import type { EventCard } from './events';
import { row, type Branch, type CapturedView, type EventRevision, type Membership, type Progress } from './model';

/** Copy validated history; replacement is only for explicitly previewed, untouched imports. */
export async function inheritForkEvents(tx: Transaction, parent: CapturedView, branch: Branch, cards: EventCard[],
    mapIds: (ids: string[]) => Promise<string[]>, replacements = new Map<string, string>()) {
    for (const card of cards) {
        if (card.blocked || card.needsReview) continue;
        const target = replacements.get(card.chain.id);
        const chain = { ...card.chain, ...row('ev'), ...(target ? { id: target } : {}), branch: branch.id,
            inheritance: { version: 1 as const, branch: parent.branch.id, event: card.chain.id,
                epoch: branch.epoch, archived: !!card.chain.archived, key: card.inheritanceKey! } };
        if (target) {
            for (const store of ['event_revisions', 'event_memberships', 'event_progress'] as const)
                for (const record of await tx.all(store, 'owner', target)) await tx.delete(store, record.id);
        }
        const base = { branch: branch.id, owner: chain.id, snapshot: branch.head };
        await tx.put('event_chains', chain);
        const copyRevision = async (meta: EventRevision, epoch = meta.epoch) =>
            tx.add('event_revisions', { ...meta, ...row('er'), ...base, epoch, cutoff: Math.min(meta.cutoff, parent.cutoff),
                refs: await mapIds(meta.refs),
                ...(meta.summarized ? { summarized: await mapIds(meta.summarized) } : {}),
                ...(meta.latestProgress ? { latestProgress: { ...meta.latestProgress,
                    memory: (await mapIds([meta.latestProgress.memory]))[0] } } : {}) } as EventRevision);
        // Keep eligible versions and link/unlink history so a child can fork earlier again.
        // Every reference is remapped; no child event points back to a mutable parent event.
        for (const revision of card.history?.revisions ?? []) await copyRevision(revision);
        for (const member of card.history?.memberships ?? [])
            await tx.add('event_memberships', { ...member, ...row('link'), ...base, memory: (await mapIds([member.memory]))[0] } as Membership);
        for (const progress of card.history?.progress ?? [])
            await tx.add('event_progress', { ...progress, ...row('ep'), ...base, memories: await mapIds(progress.memories) } as Progress);
        await copyRevision(card.meta, branch.epoch);
        for (const member of card.members)
            await tx.add('event_memberships', { ...member, ...row('link'), ...base, epoch: branch.epoch,
                cutoff: Math.min(member.cutoff, parent.cutoff), memory: (await mapIds([member.memory]))[0] } as Membership);
        for (const progress of card.progress)
            if (!card.history?.progress.some(p => p.id === progress.id))
                await tx.add('event_progress', { ...progress, ...row('ep'), ...base, epoch: branch.epoch,
                    cutoff: Math.min(progress.cutoff, parent.cutoff), memories: await mapIds(progress.memories) } as Progress);
    }
}
