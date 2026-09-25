/** Versioned metadata; never appended to embedding/BM25 document text. */
export interface SummaryTags {
  version: 1;
  /** Omitted = old/unknown, [] = explicitly nobody identified. */
  participants?: string[];
  planIds: string[];
  eventIds: string[];
  public?: { reason: string };
}
export interface EventHint {
  id: string;
  title: string;
  status: string;
  latest?: string;
}
export interface RecallContext {
  participants: string[];
  planIds: string[];
  eventIds: string[];
}
export const shortText = (v: unknown, max: number) => typeof v === 'string' ? Array.from(v.trim().replace(/\s+/g, ' ')).slice(0, max).join('') : '';
export function textList(v: unknown, max = 50): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string').map(s => shortText(s, 200)).filter(Boolean))].slice(0, max) : [];
}
export function normalizeTags(value: unknown): SummaryTags | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, any>;
  const tags: SummaryTags = { version: 1, planIds: textList(v.planIds), eventIds: textList(v.eventIds) };
  if (Array.isArray(v.participants)) tags.participants = textList(v.participants).map(s => shortText(s, 60));
  if (v.public && typeof v.public === 'object') {
    const reason = shortText(v.public.reason, 200);
    if (reason) tags.public = { reason };
  }
  return tags;
}
/** Models may link only supplied identities; publication is exclusively manual. */
export function generatedTags(value: unknown, plans: { id: string }[], events: EventHint[], previous?: SummaryTags): SummaryTags | undefined {
  const tags = normalizeTags(value);
  if (!tags) return previous;
  tags.planIds = tags.planIds.map(id => resolvePlanRef(id, plans)).filter((id): id is string => !!id);
  tags.eventIds = tags.eventIds.filter(id => events.some(e => e.id === id));
  delete tags.public;
  if (previous?.public) tags.public = previous.public;
  return tags;
}
export function resolvePlanRef(id: string, plans: { id: string }[]): string | undefined {
  if (plans.some(p => p.id === id)) return id;
  const index = /^p(\d+)$/i.exec(id);
  return index ? plans[Number(index[1]) - 1]?.id : undefined;
}
export function planTitle(plan: { title?: string; content: string }): string {
  return shortText(plan.content, 50);
}
export const nameKey = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase();

export function validTags(value: unknown): value is SummaryTags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SummaryTags;
  const n = normalizeTags(v);
  if (!n || v.version !== 1 || Object.keys(v).some(k => !['version', 'participants', 'planIds', 'eventIds', 'public'].includes(k))) return false;
  for (const key of ['participants', 'planIds', 'eventIds'] as const)
    if (JSON.stringify(v[key]) !== JSON.stringify(n[key])) return false;
  return v.public === undefined || (!!n.public && typeof v.public.reason === 'string' && v.public.reason === n.public.reason && Object.keys(v.public).length === 1);
}
