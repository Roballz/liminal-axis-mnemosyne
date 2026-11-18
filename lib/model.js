export const DEFAULT_ATTR = 'data-nvwa-ui';
export const unique = values => [...new Set(values.filter(Boolean))];
export const lines = text => unique(text.split(/\r?\n/).map(s => s.trim()));
export const blankBook = () => ({
    version: 1, revision: 1, folders: [], people: [], ignoreAttrs: [], ignoreNames: [],
    startTag: 'globalTime', endTag: 'endTime', tags: [],
});
export const blankFolder = name => ({ name, tag: 'div', attr: DEFAULT_ATTR, names: [], pattern: '', person: '' });
export const validToken = value => /^[A-Za-z][\w:-]*$/.test(value);
export function tagPage(tags, page, now = Date.now()) {
    const score = t => t.score * 0.5 ** (Math.max(0,now-t.last) / (30*86400000));
    const ordered = [...tags].sort((a,b) => score(b)-score(a) || b.last-a.last);
    const pages = Math.max(1, Math.ceil(ordered.length / 10));
    return ordered.slice((page % pages) * 10, (page % pages + 1) * 10).map(t => t.name);
}
export function touchTags(tags, names, now = Date.now()) {
    const result = new Map(tags.map(t => [t.name, t]));
    for (const name of unique(names)) {
        const last = result.get(name);
        const decay = last ? 0.5 ** (Math.max(0, now - last.last) / (30 * 86400000)) : 0;
        result.set(name, { name, score: 1 + (last?.score || 0) * decay, last: now });
    }
    return [...result.values()];
}
// Two independent 32-bit accumulators. Used to validate a locator, never as a global message ID.
export function digest(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const n = text.charCodeAt(i);
        a = Math.imul(a ^ n, 16777619);
        b = Math.imul(b, 33) ^ n;
    }
    return (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36);
}
export function identity(msg) {
    return msg?.send_date == null ? '' : JSON.stringify([msg.send_date, msg.name || '', Boolean(msg.is_user)]);
}
export function matchSource(row, msg) {
    if (!msg) return false;
    return row.identity ? row.identity === identity(msg) : row.hash === digest(String(msg.mes ?? ''));
}
export function actionFor(scan, zero) {
    if (scan.rows.length) return 'blocks';
    return zero && scan.unmarkedDiv ? 'zero' : '';
}
