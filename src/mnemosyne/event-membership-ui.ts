import { computed, reactive, shallowRef, watch } from 'vue';
import { getLeaf } from '@/memory/apply';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { activeLibrary, type Library } from './db';
import { dailyState, hostScope, hostVersion, readDailyMembershipContext, refreshDailyTables, dailyCurrent, currentMembershipHints } from './bridge';
import { eventView, type EventCard } from './events';
import { manualEventState } from './manual-events';
import { jobState } from './jobs';
import { check, type CapturedView } from './model';
import { saveMemberships, type MembershipRequest } from './event-memberships';

export interface MembershipRow { id: string; hostId: string; floor: number; text: string; time: string; valid: boolean }
export interface MembershipSession {
    mode: 'single' | 'bulk';
    lib: Library;
    view: CapturedView;
    cards: EventCard[];
    rows: MembershipRow[];
    host: string;
    generation: number;
    scope: string;
    floor?: number;
    target?: string;
}
export const membershipSession = shallowRef<MembershipSession | null>(null);
export const membershipSelected = shallowRef(new Set<string>());
export const membershipPicking = shallowRef(false);
export const membershipRowsByHost = computed(() => new Map((membershipSession.value?.rows ?? []).map(row => [row.hostId, row])));
export function toggleMembershipRow(id: string) {
    if (membershipUi.saving) return;
    const next = new Set(membershipSelected.value);
    next.has(id) ? next.delete(id) : next.add(id);
    membershipSelected.value = next;
}
export const membershipUi = reactive({ loading: false, saving: false, error: '' });
// Shared by all mounted host cards. One exact host check per projection generation, never per card.
export const membershipBadges = computed(() => {
    void dailyState.revision; void dailyState.generation; void dailyState.scope;
    return currentMembershipHints();
});
let ticket = 0, openingScope = '';
export function closeMemberships() {
    if (membershipUi.saving) return;
    ticket++;
    membershipSession.value = null;
    membershipPicking.value = false;
    membershipSelected.value = new Set();
    membershipUi.loading = false;
    membershipUi.error = '';
    manualEventState.busy = false;
}
watch(() => dailyState.scope, () => {
    if ((membershipSession.value?.scope ?? openingScope) === hostScope()) return;
    ticket++;
    membershipSession.value = null;
    membershipPicking.value = false;
    membershipSelected.value = new Set();
    membershipUi.error = '';
    if (!membershipUi.saving) { membershipUi.loading = false; manualEventState.busy = false; }
});
export async function openMemberships(options: { floor?: number; eventId?: string; expectedLeafId?: string; isCurrent?: () => boolean } = {}) {
    if (membershipUi.loading || membershipUi.saving || manualEventState.busy || jobState.busy) return;
    const run = ++ticket, scope = hostScope();
    openingScope = scope;
    const expectedLeafId = options.expectedLeafId ?? (options.floor === undefined ? undefined : getLeaf(getContext()?.chat?.[options.floor])?.id);
    membershipUi.loading = true;
    membershipUi.error = '';
    manualEventState.busy = true;
    try {
        const { view, lib, host, generation } = await readDailyMembershipContext();
        const projection = await eventView(lib, view);
        check(run === ticket && scope === hostScope() && await dailyCurrent(view, host, generation) && lib === await activeLibrary(), '聊天已改变，请重新打开');
        check(run === ticket && scope === hostScope() && host === hostVersion() && generation === dailyState.generation && (options.isCurrent?.() ?? true), '摘要或聊天已改变，请重新打开');
        const positions = new Map(view.refs.map((ref, index) => [ref.message, index]));
        let rows = view.memories.filter(memory => memory.level === 0 && !memory.seed && positions.has(memory.anchor ?? '')).map(memory => ({
            id: memory.id, hostId: memory.hostId, floor: positions.get(memory.anchor!)!, text: memory.content, time: memory.storyTime,
            valid: projection.validity.get(memory.id) === 'valid',
        })).sort((a, b) => b.floor - a.floor);
        check(new Set(rows.map(item => item.floor)).size === rows.length, '逐楼摘要身份不唯一，请先核对档案');
        if (options.floor !== undefined) {
            const leaf = getLeaf(getContext()?.chat?.[options.floor]);
            check(!!expectedLeafId && leaf?.id === expectedLeafId, '摘要已改变，请重新打开');
            rows = rows.filter(item => item.floor === options.floor && item.hostId === expectedLeafId);
            check(rows.length === 1, '本楼没有可对应的摘要，请先生成摘要或刷新');
        }
        if (options.eventId) check(projection.cards.some(card => card.chain.id === options.eventId), '事件已改变，请刷新');
        if (run !== ticket) return;
        membershipSession.value = { mode: options.floor === undefined ? 'bulk' : 'single', lib, view, cards: projection.cards, rows,
            host, generation, scope, floor: options.floor, target: options.eventId };
    } catch (error) {
        if (run === ticket && scope === hostScope()) toast((error as Error).message, 'warning');
        if (run === ticket) manualEventState.busy = false;
    } finally {
        if (run === ticket) membershipUi.loading = false;
    }
}
export async function commitMembershipSelection(request: MembershipRequest) {
    const session = membershipSession.value;
    if (!session || membershipUi.saving) return false;
    const run = ticket;
    membershipUi.saving = true;
    membershipUi.error = '';
    const live = () => membershipSession.value === session && ticket === run && session.scope === hostScope() &&
        session.host === hostVersion() && session.generation === dailyState.generation;
    try {
        check(live() && session.lib === await activeLibrary(), '聊天或摘要已改变，请取消后重新打开');
        check(request.mode === (session.mode === 'single' ? 'replace' : 'add'), '操作模式已改变');
        const rowIds = new Set(session.rows.map(row => row.id));
        check(request.memories.every(id => rowIds.has(id)), '摘要不在本次选择范围');
        const result = await saveMemberships(session.lib, session.view, request, live);
        if (!live()) return false;
        membershipSession.value = null;
        membershipPicking.value = false;
        membershipSelected.value = new Set();
        manualEventState.busy = false;
        toast(`已保存事件关联：新增 ${result.added} 条，移除 ${result.removed} 条${result.already ? `，${result.already} 条已在链中` : ''}`, 'success');
        // Refresh only archive projections; never synchronize/materialize bodies for membership UI.
        try { await refreshDailyTables(); }
        catch { toast('关联已保存，状态刷新未完成；请稍后刷新', 'warning'); }
        return true;
    } catch (error) {
        if (run === ticket) membershipUi.error = (error as Error).message;
        return false;
    } finally {
        membershipUi.saving = false;
        if (!membershipSession.value) manualEventState.busy = false;
    }
}
