/** Adds table work to the existing summary request; never calls an LLM itself. */
import type { STMessage } from '@/st/context';
import { statuses } from './canonical';
import { activeLibrary } from './db';
import {
    readTables,
    summaryTablesPrompt,
    parseSummaryTables,
    assertTablePlan,
    type SummaryTablePlan,
    type TableInput,
} from './tables';
import { type CapturedView, check } from './model';
export const TABLE_OUTPUT_KEY = 'mnemosyne_tables_v2';
export interface SummaryTables {
    inputs: TableInput[];
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
    const inputs = (await readTables(lib, view.branch)).map((input) => ({
        ...input,
        rows: input.rows.filter((r) => r.sources.every((id) => validity.get(id) === 'valid')),
    }));
    const prompt = summaryTablesPrompt(inputs);
    return prompt.system ? { inputs, branch: view.branch.id, ...prompt } : null;
}
export function parseSummaryTableResult(value: unknown, request: SummaryTables | null) {
    return request ? parseSummaryTables(value, request.inputs, request.branch) : null;
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
