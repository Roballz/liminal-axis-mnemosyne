import type { TableDef, TableRow } from './model';

const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });
const exactOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Display/serialization order only; never rewrite keys or persisted history. */
export function sortTableRows(def: Pick<TableDef, 'columns'>, rows: readonly TableRow[]): TableRow[] {
    const key = def.columns[0]?.id;
    return rows.map(record => {
        const value = key ? record.values[key] : undefined;
        const raw = value === undefined ? '' : String(value);
        return { record, value, raw, name: raw.trim() };
    }).sort((a, b) => {
        if (!a.name || !b.name) return Number(!a.name) - Number(!b.name) || exactOrder(a.record.id, b.record.id);
        const order = typeof a.value === 'number' && typeof b.value === 'number'
            ? a.value - b.value : names.compare(a.name, b.name);
        return order || exactOrder(a.raw, b.raw) || exactOrder(a.record.id, b.record.id);
    }).map(item => item.record);
}
