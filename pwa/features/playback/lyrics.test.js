import assert from 'node:assert/strict';
import test from 'node:test';
import { isInstrumentalNotice, pairLyrics, parseLrc } from './lyrics.js';

test('instrumental notices match whole provider placeholders, never a lyric phrase or missing lyrics', () => {
  for (const text of ['此歌曲为没有填词的纯音乐，请您欣赏', '纯音乐，请欣赏', '纯音乐，请您欣赏。']) {
    assert.equal(isInstrumentalNotice(text), true, text);
  }
  for (const text of ['', '我听着纯音乐，请欣赏这场雨', '纯音乐', 'Instrumental Love', '作曲：纯音乐']) {
    assert.equal(isInstrumentalNotice(text), false, text);
  }
});

test('parseLrc accepts multiple timestamps and millisecond separators', () => {
  assert.deepEqual(parseLrc('[00:01.50][00:03:250] hello\n[01:02] world'), [
    { time: 1.5, text: 'hello' },
    { time: 3.25, text: 'hello' },
    { time: 62, text: 'world' },
  ]);
});

test('pairLyrics adds matching translations without dropping original timing', () => {
  assert.deepEqual(pairLyrics(
    [{ time: 1.5, text: 'hello' }, { time: 2, text: 'world' }],
    [{ time: 1.5, text: '你好' }],
  ), [
    { time: 1.5, text: 'hello', tr: '你好' },
    { time: 2, text: 'world', tr: '' },
  ]);
});
