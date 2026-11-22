import { ref, shallowRef } from 'vue';
/** Explicit manual edits only; regeneration and background synchronization do not emit this. */
export const summaryEditSignal = ref(0);
export let editedSummaryFloor: number | undefined;
export function notifySummaryEdit(floor?: number) { editedSummaryFloor = floor; summaryEditSignal.value++; }

/** Paired native body-edit notifications; no text leaves the bridge. */
export const bodyEditSignal = shallowRef<{ id: number; floor?: number; allowUnarchived?: boolean; phase: 'started' | 'settled' | 'cancelled' } | null>(null);
let bodyEditId = 0;
export function beginBodyEdit(floor?: number) {
    const id = ++bodyEditId;
    bodyEditSignal.value = { id, floor, phase: 'started' };
    return id;
}
export function settleBodyEdit(id: number, allowUnarchived = false) { bodyEditSignal.value = { id, allowUnarchived, phase: 'settled' }; }
export function cancelBodyEdit() { bodyEditSignal.value = { id: ++bodyEditId, phase: 'cancelled' }; }
