import { ref, shallowRef } from 'vue';
/** Explicit manual edits only; regeneration and background synchronization do not emit this. */
export const summaryEditSignal = ref(0);
export function notifySummaryEdit() { summaryEditSignal.value++; }

/** Paired native body-edit notifications; no text leaves the bridge. */
export const bodyEditSignal = shallowRef<{ id: number; phase: 'started' | 'settled' | 'cancelled' } | null>(null);
let bodyEditId = 0;
export function beginBodyEdit() {
    const id = ++bodyEditId;
    bodyEditSignal.value = { id, phase: 'started' };
    return id;
}
export function settleBodyEdit(id: number) { bodyEditSignal.value = { id, phase: 'settled' }; }
export function cancelBodyEdit() { bodyEditSignal.value = { id: ++bodyEditId, phase: 'cancelled' }; }
