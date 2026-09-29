import type { StoredDelta } from './types';
import { PLAN_TEXT_MAX_CHARS } from './limits';

/** Counts only: distinguishes absent model output from filtered operations without retaining raw replies. */
export function describePlanWrite(raw: unknown, saved: StoredDelta['plans']): string {
  if (raw == null) return '模型未返回计划／悬念指令，本楼未新增或更新';
  if (typeof raw !== 'object' || Array.isArray(raw)) return '模型返回的 plans 格式无效，未写入';
  const input = raw as Record<string, unknown>;
  const keys = ['add', 'update', 'resolve'] as const;
  const malformed = keys.filter(key => input[key] != null && !Array.isArray(input[key]));
  const returned = keys.reduce((n, key) => n + (Array.isArray(input[key]) ? input[key].length : 0), 0);
  const accepted = keys.reduce((n, key) => n + (saved?.[key]?.length ?? 0), 0);
  const parts = returned || malformed.length
    ? [`已写入：新增 ${saved?.add?.length ?? 0}、更新 ${saved?.update?.length ?? 0}、了结 ${saved?.resolve?.length ?? 0}`]
    : ['模型返回空指令，本楼未新增或更新'];
  if (returned > accepted) parts.push(`过滤 ${returned - accepted} 项（缺少内容、无有效更新字段或计划编号无效）`);
  if (malformed.length) parts.push(`${malformed.join('/')} 格式错误，应为数组`);
  const clipped = ['add', 'update'].flatMap(key => Array.isArray(input[key]) ? input[key] : [])
    .some(item => item && typeof item === 'object' && ['content', 'currentProgress', 'remaining'].some(key =>
      typeof item[key] === 'string' && Array.from(item[key].trim().replace(/\s+/g, ' ')).length > PLAN_TEXT_MAX_CHARS));
  if (clipped) parts.push(`超长有效字段截取前 ${PLAN_TEXT_MAX_CHARS} 字，不因此拒绝整条`);
  return parts.join('；');
}
