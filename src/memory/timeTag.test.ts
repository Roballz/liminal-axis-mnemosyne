import { afterEach, expect, test } from 'vitest';
import { apiSettings } from '@/api/settings';
import { cleanBody, parseTimeRange } from './timeTag';
const saved = { start: apiSettings.bodyStartTag, end: apiSettings.bodyEndTag, strip: [...apiSettings.customStripTags] };
afterEach(() => { apiSettings.bodyStartTag = saved.start; apiSettings.bodyEndTag = saved.end; apiSettings.customStripTags = saved.strip; });
const time = '2086年04月23日·🌸·星期二·10:49·薄云晴·16°C·{拍摄日}';
function custom() { apiSettings.bodyStartTag = 'globalTime'; apiSettings.bodyEndTag = 'endTime'; }
test('custom crop preserves complete values, attributes, case and multiline content without time parsing', () => {
  custom(); apiSettings.customStripTags = ['smalltalk'];
  const body = `<GLOBALTIME\n source="clock">${time}</GLOBALTIME >\n正文<smalltalk>秘密小剧场</smalltalk>\n<endTime>2086/04/23 10:55</endTime >`;
  expect(cleanBody(`前缀${body}尾部`)).toBe(body.replace('<smalltalk>秘密小剧场</smalltalk>', ''));
  expect(parseTimeRange(body)).toEqual(parseTimeRange('正文'));
});
test('custom crop chooses last complete start and first following complete end', () => {
  custom();
  expect(cleanBody('<globalTime>旧</globalTime>旧文<endTime>旧末</endTime>噪声<globalTime>新</globalTime>正文<endTime>新末</endTime>尾<endTime>重复</endTime>'))
    .toBe('<globalTime>新</globalTime>正文<endTime>新末</endTime>');
});
test.each([
  ['前<globalTime>开始</globalTime>正文尾', '<globalTime>开始</globalTime>正文尾'],
  ['前正文<endTime>结束</endTime>尾', '前正文<endTime>结束</endTime>'],
  ['前正文尾', '前正文尾'],
  ['前<globalTime />正文</globalTime>尾', '前<globalTime />正文</globalTime>尾'],
  ['前<globalTime / >正文</globalTime>尾', '前<globalTime / >正文</globalTime>尾'],
  ['<endTime>结束</endTime>正文<globalTime>开始</globalTime>', '<endTime>结束</endTime>正文<globalTime>开始</globalTime>'],
  ['前<globalTime>未闭合正文<endTime>未闭合尾', '前<globalTime>未闭合正文<endTime>未闭合尾'],
  ['前<globalTime-extra>开始</globalTime-extra>正文<endTime-extra>结束</endTime-extra>尾', '前<globalTime-extra>开始</globalTime-extra>正文<endTime-extra>结束</endTime-extra>尾'],
])('missing, reversed, incomplete or prefix tags preserve uncertain material: %s', (input, output) => {
  custom(); expect(cleanBody(input)).toBe(output);
});
test('identical custom boundary names do not crop; Unicode names are exact', () => {
  apiSettings.bodyStartTag = apiSettings.bodyEndTag = 'clock';
  const same = '前<clock>一</clock>正文<clock>二</clock>尾'; expect(cleanBody(same)).toBe(same);
  apiSettings.bodyStartTag = '起始'; apiSettings.bodyEndTag = '结束';
  expect(cleanBody('前<起始>一</起始>正文<结束>二</结束>尾')).toBe('<起始>一</起始>正文<结束>二</结束>');
});
test('default legacy crop and inline labels remain unchanged, including one-sided markers', () => {
  apiSettings.bodyStartTag = 'bbs_start'; apiSettings.bodyEndTag = 'bbs_end';
  expect(cleanBody('前<bbs_start>旧</bbs_start>旧<bbs_start>新</bbs_start>正文<bbs_end>末</bbs_end>尾')).toBe('(起始时间:新)正文(结束时间:末)');
  expect(cleanBody('前<bbs_start>未闭合正文')).toBe('<bbs_start>未闭合正文');
  apiSettings.bodyStartTag = ''; apiSettings.bodyEndTag = 'bad.*';
  expect(cleanBody('前<bbs_start>一</bbs_start>正文<bbs_end>二</bbs_end>尾')).toBe('(起始时间:一)正文(结束时间:二)');
});
test('fully stripped input stays empty', () => {
  custom(); apiSettings.customStripTags = ['smalltalk'];
  expect(cleanBody('<smalltalk>不要泄漏</smalltalk>')).toBe('');
});
