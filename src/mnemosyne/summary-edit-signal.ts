import { ref } from 'vue';
/** Explicit manual edits only; regeneration and background synchronization do not emit this. */
export const summaryEditSignal = ref(0);
export function notifySummaryEdit() { summaryEditSignal.value++; }
