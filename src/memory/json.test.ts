import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './json';

const result = { summary: 'The confirmed facts.' };
const json = JSON.stringify(result);
const record = 'F1 | source 1 | confirmed fact\nCoverage: F1 | confirmed facts';

describe('extractJsonObject with visible audit records', () => {
  it.each([
    `${json}`,
    `<thinking>\n${record}\n</thinking>\n${json}`,
    `<think>\n${record}\n</think>\n${json}`,
    `${record}\n</thinking>\n${json}`,
    `<THINKING>\n${record}\n</THINKING>\n${json}`,
    `<thinking>\n${record}\n{"summary":"not the final result"}\n</thinking>\n${json}`,
    `${record}\n{"summary":"not the final result"}\n</thinking>\n${json}`,
    `<think><think>内层检查</think>{"summary":"外层草稿"}</think>${json}`,
  ])('only parses the final result: %s', raw => {
    expect(extractJsonObject(raw)).toEqual(result);
  });

  it('keeps batch results unchanged and does not persist the audit', () => {
    const batch = {
      floors: [{ n: 1, summary: 'The first floor.', timeStart: '2030/1/1 10:00', timeEnd: '2030/1/1 10:05' }],
    };
    expect(extractJsonObject(`<thinking>${record}</thinking>${JSON.stringify(batch)}`)).toEqual(batch);
  });

  it.each([
    `<thinking>${record}</thinking>`,
    `${record}</thinking>`,
    '<thinking>{"summary":"an unfinished audit, not a final answer"}',
    '<think>{"summary":"an unfinished audit, not a final answer"}',
    `<thinking>${record}</thinking><thinking>{"summary":"a second unfinished audit"}`,
    `<thinking>${record}</thinking>{"summary":`,
  ])('does not accept audit-only or truncated output: %s', raw => {
    expect(extractJsonObject(raw)).toBeNull();
  });
});

describe('extractJsonObject stops at the end of the answer', () => {
  it.each([
    '}误加}，不输出',
    '好像字数超了，应该改成 {"summary":"后记里的示例"}',
    '\n<thinking>重新检查 {"summary":"草稿"}',
    '\n<think>重新检查</think>\n```json\n{"summary":"第二轮"}\n```',
  ])('ignores trailing text: %s', tail => {
    expect(extractJsonObject(json + tail)).toEqual(result);
    expect(extractJsonObject(`检查完毕。</thinking>\n\`\`\`json\n${json}${tail}\n\`\`\``)).toEqual(result);
  });

  it('reads a fenced answer after prose containing a brace placeholder', () => {
    const raw = ['把 {占位符} 替换成摘要。', '```json', json + '}误加}', '```'].join('\n');
    expect(extractJsonObject(raw)).toEqual(result);
  });

  it('keeps nested fields, escaped dialogue and literal delimiters inside strings', () => {
    const batch = {
      floors: [{ n: 1, summary: '她说："看 }，还有 { 和反斜杠 \\"。' }],
      customTables: [{ add: [{ note: '保留 ```、</thinking> 和 <think>字样</think>。', path: 'C:\\' }] }],
    };
    expect(extractJsonObject(JSON.stringify(batch) + '}误加}')).toEqual(batch);
  });

  it('keeps the existing quote and trailing comma repairs with a noisy suffix', () => {
    expect(extractJsonObject('{“summary”:“一个}符号”,}再写}')).toEqual({ summary: '一个}符号' });
    expect(extractJsonObject('{"summary":"He said "look } here" today."}再写}'))
      .toEqual({ summary: 'He said "look } here" today.' });
  });

  it('skips a prefilled draft and rejects incomplete or malformed outer objects', () => {
    expect(extractJsonObject(`{"summary":"检查草稿"}</thinking>${json}}误加}`)).toEqual(result);
    expect(extractJsonObject('{"floors":[{"summary":"只有内层闭合"}]')).toBeNull();
    expect(extractJsonObject('{"floors":[{"summary":"括号错配"}}')).toBeNull();
    expect(extractJsonObject('{"summary":"正文还没有闭合 }')).toBeNull();
  });
});
