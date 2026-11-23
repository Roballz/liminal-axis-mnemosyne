// A Chinese character outside the BMP can occupy two UTF-16 units.
const LINE_CHARS = 24;

function firstChars(text: string, count: number): string {
  return Array.from(text.slice(0, count * 2)).slice(0, count).join('');
}

function lastChars(text: string, count: number): string {
  return Array.from(text.slice(-count * 2)).slice(-count).join('');
}

export function summaryPreview(text: string, query: string): string[] {
  const singleLine = text.trim().replace(/\s+/gu, ' ');
  if (!singleLine) return [];
  const head = firstChars(singleLine, LINE_CHARS);
  if (head.length === singleLine.length) return [head];
  const rest = singleLine.slice(head.length);
  const tail = lastChars(rest, LINE_CHARS);
  const clipped = rest.length > tail.length;

  // In search results, expose a match that would otherwise disappear between the two lines.
  const needle = query.toLowerCase();
  if (needle && !head.toLowerCase().includes(needle) && !tail.toLowerCase().includes(needle)) {
    const hit = singleLine.toLowerCase().indexOf(needle);
    if (hit >= 0) {
      const before = lastChars(singleLine.slice(0, hit), 5);
      const start = hit - before.length;
      const excerpt = firstChars(singleLine.slice(start), LINE_CHARS);
      return [head + '…', (start ? '…' : '') + excerpt + (start + excerpt.length < singleLine.length ? '…' : '')];
    }
  }
  return clipped ? [head + '…', '…' + tail] : [head, tail];
}
