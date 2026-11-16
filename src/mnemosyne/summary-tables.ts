/** Adds table work to the existing summary request; never calls an LLM itself. */
import type { STMessage } from '@/st/context';
import { statuses } from './canonical';
import { activeLibrary, type Library } from './db';
import {
    readTables,
    allowedTableSources,
    summaryTablesPrompt,
    parseSummaryTables,
    assertTablePlan,
    type SummaryTablePlan,
    type TableInput,
} from './tables';
import { type Branch, type CapturedView, type TableCommit, type TableDef, check } from './model';
export const TABLE_OUTPUT_KEY = 'mnemosyne_tables_v2';
/** Host sidecars outlive permanent table deletion, including its old receipts.
 * Ignore a whole completed/obsolete plan; never rewrite its receipt fingerprint
 * or use this read-only preflight as authorization to partially apply a batch. */
export async function pendingSummaryTablePlans(lib: Library, branch: Branch, plans: SummaryTablePlan[]) {
    if (!plans.length) return new Set<SummaryTablePlan>();
    return lib.transaction(['branches', 'table_receipts', 'custom_table_defs', 'table_history'], 'readonly', async tx => {
        const receipts = new Set((await tx.all('table_receipts', 'branch', branch.id)).map(r => r.id));
        const received = (plan: SummaryTablePlan, id: string) => receipts.has(`${plan.operation}:${id}`);
        const incomplete = plans.filter(plan => !plan.tables.every(item => received(plan, item.id)));
        if (!incomplete.length) return new Set<SummaryTablePlan>();
        const live = await tx.get<Branch>('branches', branch.id);
        if (!live || live.story !== branch.story) return new Set(incomplete);
        const ids = [...new Set(incomplete.flatMap(plan => plan.tables.filter(item => !received(plan, item.id)).map(item => item.id)))];
        const defs = await Promise.all(ids.map(id => tx.get<TableDef>('custom_table_defs', id)));
        const retired = new Set(ids.filter((_, i) => !defs[i]));
        const deleted = new Set(ids.filter((_, i) => defs[i]?.deleted &&
            defs[i]!.branch === branch.id && defs[i]!.story === branch.story));
        // A rollback also makes projection tombstones. Only an explicit deleted
        // after-image in the active history proves an old intentional soft delete.
        // Share one ancestry walk across all pending floors/tables; never scan rows.
        const visited = new Set<string>();
        let head = live.tableHead;
        while (deleted.size && head && !visited.has(head)) {
            visited.add(head);
            const commit = await tx.get<TableCommit>('table_history', head);
            if (!commit || commit.branch !== branch.id || commit.story !== branch.story) break;
            for (const def of commit.defs) if (deleted.delete(def.id) && def.deleted &&
                def.branch === branch.id && def.story === branch.story) retired.add(def.id);
            if (commit.checkpoint) break;
            head = commit.parent ?? undefined;
        }
        return new Set(incomplete.filter(plan => plan.branch !== branch.id ||
            plan.tables.some(item => !received(plan, item.id) && !retired.has(item.id))));
    });
}
export interface SummaryTables {
    inputs: TableInput[];
    tableHead?: string;
    branch: string;
    system: string;
    user: string;
}
export async function prepareSummaryTables(
    view: CapturedView | null | undefined,
    chat: STMessage[],
    floors: number[],
): Promise<SummaryTables | null> {
    if (!view) return null;
    // Current-state tables do not have a historical replay log. Historical resummary must not read future rows or rewrite current state.
    const last = chat.findLastIndex((m) => !m.is_user && !m.extra?.bbs_omit && (!m.is_system || m.extra?.bbs_hidden));
    if (!floors.includes(last)) return null;
    const lib = await activeLibrary();
    const validity = await statuses(lib, view);
    const tables = await readTables(lib, view.branch);
    const allowed = await allowedTableSources(lib, view, tables, validity);
    const inputs = tables.map((input) => ({
        ...input,
        rows: input.rows.filter((r) => r.sources.every((id) => allowed.has(id))),
    }));
    const prompt = summaryTablesPrompt(inputs);
    return prompt.system ? { inputs, tableHead: view.branch.tableHead, branch: view.branch.id, ...prompt } : null;
}
export function parseSummaryTableResult(value: unknown, request: SummaryTables | null) {
    const plan = request ? parseSummaryTables(value, request.inputs, request.branch) : null;
    if (plan && request?.tableHead) plan.tableHead = request.tableHead;
    return plan;
}
export async function validateSummaryTableResult(plan: SummaryTablePlan | null) {
    if (plan)
        await (await activeLibrary()).transaction(['custom_table_defs'], 'readonly', (tx) => assertTablePlan(tx, plan));
}
export function attachTableResult(chat: STMessage[], floor: number, plan: SummaryTablePlan | null) {
    if (!plan) {
        // Regenerating a historical summary supersedes its old, uncommitted operation.
        // Committed table history remains in canonical receipts; no table rows are rolled back.
        if (chat[floor].extra) delete chat[floor].extra![TABLE_OUTPUT_KEY];
        return;
    }
    const leaf = chat[floor].extra?.bbs_leaf;
    check(leaf, '填表结果缺少同次摘要');
    chat[floor].extra![TABLE_OUTPUT_KEY] = { version: 2, leaf: leaf.id, text: leaf.text, plan };
}
