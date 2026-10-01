import { test, expect } from 'vitest';
import { ref, effectScope } from 'vue';
import { useTableBackfillRange, type BackfillChoice } from './table-backfill-range';
function setup() {
    const scope = effectScope(), total = ref(10);
    const choices = ref<BackfillChoice[]>([
        { id: 'a', name: '表A', last: 5, selected: false },
        { id: 'b', name: '表B', last: 2, selected: false },
        { id: 'new', name: '新表', last: -1, selected: false },
    ]);
    const range = scope.run(() => useTableBackfillRange(choices, total))!;
    range.reset(); return { scope, total, choices, ...range };
}
test('one table starts at last confirmed +1; multiple tables use earliest next-needed floor', () => {
    const r = setup();
    try {
        expect(r.valid.value).toBe(false);
        r.choices.value[0].selected = true;
        expect(r.start.value).toBe(6); expect(r.end.value).toBe(9); expect(r.valid.value).toBe(true);
        r.choices.value[1].selected = true; expect(r.start.value).toBe(3);
        r.choices.value[2].selected = true; expect(r.start.value).toBe(0);
        r.choices.value[2].selected = false; expect(r.start.value).toBe(3);
    } finally { r.scope.stop(); }
});
test('manual start survives selection changes; explicit automatic and reopen restore defaults', () => {
    const r = setup();
    try {
        r.choices.value[0].selected = true;
        r.start.value = 1; r.markEdited(); r.end.value = 7;
        r.choices.value[1].selected = true;
        expect(r.start.value).toBe(1); expect(r.end.value).toBe(7);
        r.automatic(); expect(r.start.value).toBe(3); expect(r.end.value).toBe(7);
        r.start.value = 2; r.markEdited(); r.reset();
        expect(r.start.value).toBe(3); expect(r.end.value).toBe(9); expect(r.startEdited.value).toBe(false);
    } finally { r.scope.stop(); }
});
test('fully confirmed and empty chats have no valid automatic request, while deliberate refill is editable', () => {
    const r = setup();
    try {
        r.choices.value[0].last = 9; r.choices.value[0].selected = true;
        expect(r.start.value).toBe(10); expect(r.caughtUp.value).toBe(true); expect(r.valid.value).toBe(false);
        r.start.value = 8; r.markEdited(); expect(r.caughtUp.value).toBe(false); expect(r.valid.value).toBe(true);
        r.total.value = 0; r.reset(); expect(r.valid.value).toBe(false);
        r.total.value = 10; r.reset(); r.start.value = 1.5; r.markEdited(); expect(r.valid.value).toBe(false);
        r.start.value = 0; r.end.value = 10; expect(r.valid.value).toBe(false);
    } finally { r.scope.stop(); }
});
