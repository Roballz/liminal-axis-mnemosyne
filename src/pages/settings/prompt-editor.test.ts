import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { transpileModule } from 'typescript';
import { ref } from 'vue';
import { JAILBREAK_PROMPT } from '@/memory/prompts';

// 运行设置页的真实编辑器函数,不装载无关的整页宿主依赖。
const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8');
const editorSource = source.slice(source.indexOf('function isCustom('), source.indexOf('/* —— 向量记忆:'));
function editor(saved: string) {
  const apiSettings = { prompts: { jailbreak: saved, summary: '不能改变的摘要模板' } };
  const editingPrompt = ref(null), promptDraft = ref('');
  const functions = new Function('apiSettings', 'editingPrompt', 'promptDraft',
    transpileModule(editorSource, {}).outputText + '\nreturn { openPrompt, closePrompt, savePrompt, resetPrompt, isCustom };')
    (apiSettings, editingPrompt, promptDraft);
  return { ...functions, apiSettings, promptDraft };
}
const meta = { key: 'jailbreak', builtin: JAILBREAK_PROMPT };

it('设置页内置破限引用新版核心,恢复默认需点完成才清除这一项覆盖值', () => {
  expect(source).toMatch(/key: 'jailbreak',[\s\S]*?builtin: JAILBREAK_PROMPT/);
  expect(source).toContain('@click="resetPrompt"'); expect(source).toContain('@click="savePrompt"');
  const e = editor('原有自定义'); e.openPrompt(meta);
  expect(e.promptDraft.value).toBe('原有自定义');
  e.resetPrompt(); expect(e.promptDraft.value).toBe(JAILBREAK_PROMPT);
  expect(e.apiSettings.prompts.jailbreak).toBe('原有自定义');
  e.closePrompt(); e.openPrompt(meta); expect(e.promptDraft.value).toBe('原有自定义');
  e.resetPrompt(); e.savePrompt(); expect(e.apiSettings.prompts.jailbreak).toBe('');
  expect(e.apiSettings.prompts.summary).toBe('不能改变的摘要模板');
  e.openPrompt(meta); expect(e.promptDraft.value).toBe(JAILBREAK_PROMPT); expect(e.isCustom('jailbreak')).toBe(false);
});

it('默认模板直接完成仍存空串;用户修改则原样保存,取消不覆盖', () => {
  const e = editor(''); e.openPrompt(meta); e.savePrompt();
  expect(e.apiSettings.prompts.jailbreak).toBe('');
  e.openPrompt(meta); e.promptDraft.value = '  我的定制  '; e.savePrompt();
  expect(e.apiSettings.prompts.jailbreak).toBe('  我的定制  ');
  e.openPrompt(meta); e.promptDraft.value = '未保存修改'; e.closePrompt();
  expect(e.apiSettings.prompts.jailbreak).toBe('  我的定制  ');
});
