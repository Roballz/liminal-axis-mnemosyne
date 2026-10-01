import { computed, ref, watch, type Ref } from 'vue';
export interface BackfillChoice { id: string; name: string; last: number; selected: boolean }

/** Shared UI range model: selection changes follow the suggestion until the user edits start. */
export function useTableBackfillRange(choices: Ref<BackfillChoice[]>, total: Ref<number>) {
    const start = ref(0), end = ref(-1), startEdited = ref(false);
    const selected = computed(() => choices.value.filter(c => c.selected));
    const suggested = computed(() => selected.value.length
        ? Math.min(total.value, ...selected.value.map(c => Math.max(0, c.last + 1))) : 0);
    watch(suggested, value => { if (!startEdited.value) start.value = value; }, { flush: 'sync' });
    const valid = computed(() => selected.value.length > 0 && Number.isSafeInteger(start.value) &&
        Number.isSafeInteger(end.value) && start.value >= 0 && start.value <= end.value && end.value < total.value);
    const caughtUp = computed(() => selected.value.length > 0 && !startEdited.value && suggested.value >= total.value);
    const automatic = () => { startEdited.value = false; start.value = suggested.value; };
    const reset = () => { end.value = total.value - 1; automatic(); };
    const markEdited = () => { startEdited.value = true; };
    return { start, end, startEdited, selected, suggested, valid, caughtUp, automatic, reset, markEdited };
}
