import { expect, it } from 'vitest';
import { summaryPreview } from './preview';

it('长总结截取开头与结尾各 24 个字符，完整保留跨两个编码单元的汉字', () => {
  const head = '头'.repeat(23) + '𠮷';
  const tail = '𠮷' + '尾'.repeat(23);
  expect(summaryPreview(head + '中段内容。' + tail, '')).toEqual([head + '…', '…' + tail]);
});

it('短总结不重复预览，已有换行与空白折成行内空格', () => {
  expect(summaryPreview('  \n ', '')).toEqual([]);
  expect(summaryPreview(' 单句。\n\n 次句。 ', '')).toEqual(['单句。 次句。']);
  const line = '甲'.repeat(24);
  expect(summaryPreview(line + line, '')).toEqual([line, line]);
});

it('按楼号搜索仍显示首尾，搜索到中间的词时显示命中附近的内容', () => {
  const edge = '甲'.repeat(24);
  const text = edge + '乙'.repeat(40) + '简报' + '丙'.repeat(40) + edge;
  expect(summaryPreview(text, '#300')).toEqual([edge + '…', '…' + edge]);
  const [first, second] = summaryPreview(text, '简报');
  expect(first).toBe(edge + '…');
  expect(second).toContain('简报');
  expect([...second.replace(/…/g, '')]).toHaveLength(24);
});
