import { apiSettings } from '@/api/settings';
import { EVENT_OVERVIEW_MAX_CHARS } from './events';
import { EVENT_PROGRESS_MAX_CHARS, EVENT_APPEND_PROMPT_MAX_CHARS } from '@/memory/limits';

/** Editable writing instructions; output constraints stay in the request protocol. */
export const EVENT_OVERVIEW_PROMPT = `把用户所指的整体事项作为一条链，例如同一天约会的早餐、做花灯、逛街、灯会属于用户指定的同一约会整体。
overview 必须不超过${EVENT_OVERVIEW_MAX_CHARS}字（含标点、数字、字母），建议250～450字，内容少时更短。只记录事件的核心变化、关键决定与结果，以及对人物关系或重要转变有实质影响的细节；必要时保留解释这些变化的前因后果。
主动舍弃琐碎小事、逐站行程、重复对话、装饰性动作和无后续影响的细节，不写流水账，不为凑字数扩写。更新时重新提炼整条链的核心，不在旧概要后机械追加。
概要忠于已给材料，不编造动机、未来或结局。输出前核对字数，超出则继续精简为完整语句。progress 仅概括本次新增进展，不超过${EVENT_APPEND_PROMPT_MAX_CHARS}字；无新增进展时为空字符串。`;

export const EVENT_LATEST_PROGRESS_PROMPT = `最新进展 latestProgress.text 不超过${EVENT_PROGRESS_MAX_CHARS}字，提炼整条事件链最近一次真实进展及当前结果，突出发生了什么变化，以及当前还停在哪一步，不重复整篇概要。
latestProgress.memory 选择这次真实进展的来源摘要ID。重复提及、重写概要不算新进展，不能借用本轮时间；没有明确进展时 latestProgress 为 null。
剧情时间由程序从来源摘要单独附加，不占小结字数，无需在 text 中重复填写。忠于材料，不推测未来，不把处理时间当作剧情时间。`;

export const EVENT_OUTPUT_PROTOCOL = `事件任务输出约定：
用户已决定事件边界，绝对不要拆链、合链或另建事件，不修改摘要、人物、物品或表格。只描述本次指定的事件链。
仅输出 JSON：{"title":"标题","status":"open|resolved|dormant","keywords":["关键词"],"overview":"整条事件的精炼当前概要","progress":"仅本次新增内容的一段进展，不超过${EVENT_APPEND_PROMPT_MAX_CHARS}字","latestProgress":{"memory":"实际最近进展的来源摘要ID","text":"${EVENT_PROGRESS_MAX_CHARS}字以内的最新进展小结"}}。
latestProgress 必须为 null 或含 memory、text 的对象；memory 只能选本次材料中的有效摘要ID。时间由程序取该来源的剧情时间。
overview 非空且必须不超过${EVENT_OVERVIEW_MAX_CHARS}字（含标点、数字、字母）；latestProgress.text 上限为${EVENT_PROGRESS_MAX_CHARS}字，无需写剧情时间；progress 不超过${EVENT_APPEND_PROMPT_MAX_CHARS}字，无新增进展时为空字符串。所有字段必须保留，不输出 JSON 以外的文字。`;

export function buildEventInstruction(): string {
  const writing = apiSettings.prompts.eventOverview.trim() || EVENT_OVERVIEW_PROMPT;
  const latest = apiSettings.prompts.eventLatestProgress.trim() || EVENT_LATEST_PROGRESS_PROMPT;
  return `${writing}\n\n${latest}\n\n${EVENT_OUTPUT_PROTOCOL}`;
}
