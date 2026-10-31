import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLyricText } from './lyricText.js';

test('readable multilingual and untimed lyrics keep their original text', () => {
  for (const text of ['[00:01.20]中文 / 日本語 / café / 밤', 'Moon River', 'abcdef', 'you/me', 'a+b=c', '纯音乐，请欣赏', '[ar:测试]\n[00:01]text',
    'This is a long untimed English lyric with ordinary words and spaces that must stay readable']) {
    assert.equal(normalizeLyricText(text), text);
  }
  assert.equal(normalizeLyricText('\ufeff[00:01]text'), '[00:01]text');
  assert.equal(normalizeLyricText(null), '');
  assert.equal(normalizeLyricText({ error: 'private' }), '');
});

test('only strict Base64 LRC is decoded, exactly once', () => {
  const text = '[00:01.00]测试译词\n[00:02]café';
  const encoded = Buffer.from(text).toString('base64');
  assert.equal(normalizeLyricText(encoded), text);
  assert.equal(normalizeLyricText(encoded.replace(/(.{20})/g, '$1\n')), text);
  assert.equal(normalizeLyricText(Buffer.from(encoded).toString('base64')), '');
  assert.equal(normalizeLyricText(encoded.slice(0, -1) + '!'), '');
});

test('binary, encrypted and SDK-corrupted fields fail closed', () => {
  for (const text of ['� ��y�_w�N��', '[00:00]bad�text', 'x\u0000y', 'x\u001by',
    'a1b2c3d4'.repeat(20), Buffer.from('a1b2c3d4'.repeat(20), 'hex').toString('utf8'),
    Buffer.from([0xff, 0x00, 0x11]).toString('base64')]) {
    assert.equal(normalizeLyricText(text), '', JSON.stringify(text));
  }
});
