// 仅匹配完整的供应商占位说明，不从缺歌词或歌曲名推断“纯音乐”。
export function isInstrumentalNotice(text) {
  return /^(?:此歌曲为没有填词的)?纯音乐[，,]\s*请(?:您)?欣赏[。.!！]?$/.test(String(text ?? '').trim());
}

export function parseLrc(raw) {
  if (!raw) return [];
  const result = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const timestamps = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!timestamps.length) continue;
    const text = line.replace(/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim();
    if (!text) continue;
    for (const timestamp of timestamps) {
      const minutes = Number.parseInt(timestamp[1], 10);
      const seconds = Number.parseInt(timestamp[2], 10);
      const milliseconds = timestamp[3]
        ? Number.parseInt(timestamp[3].padEnd(3, '0'), 10)
        : 0;
      result.push({ time: minutes * 60 + seconds + milliseconds / 1000, text });
    }
  }
  return result.sort((left, right) => left.time - right.time);
}

export function pairLyrics(original, translated) {
  const translationByTime = new Map(
    translated.map(line => [line.time.toFixed(2), line.text]),
  );
  return original.map(line => ({
    ...line,
    tr: translationByTime.get(line.time.toFixed(2)) || '',
  }));
}
