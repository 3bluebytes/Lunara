// 页头「陪伴」旁的原因按钮。Run: node --test pwa/features/listening/companionEffect.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { companionEffectCopy, createCompanionEffect } from './companionEffect.js';

function fixture(responses) {
  const handlers = new Map();
  const attrs = {};
  const button = { hidden: true, textContent: '', title: '', disabled: false,
    setAttribute: (key, value) => { attrs[key] = value; },
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const calls = [];
  const queue = [...responses];
  const effect = createCompanionEffect({
    apiClient: { get: async path => { calls.push(path); const next = queue.shift(); if (next instanceof Error) throw next; return next; } },
    documentLike: { querySelector: selector => (selector === '#companion-effect' ? button : null) },
    nameOf: id => (id === 'lunara' ? 'Lunara' : ''),
    restoreQuiet: async () => { calls.push('restore'); },
    openSettings: () => calls.push('settings'),
    openPerson: id => calls.push(`person:${id}`),
  }).init();
  return { effect, button, attrs, calls, click: () => handlers.get('click')() };
}
const base = { ok: true, sessionId: 'room', speakerId: 'lunara', modeId: 'conversational', temperament: 'balanced', level: 'lively', limitedBy: null };

test('没有需要解释的原因、没有听歌来源或模式自己选的，都不显示', () => {
  assert.equal(companionEffectCopy(base), null);
  assert.equal(companionEffectCopy({ ...base, level: 'silent', limitedBy: 'mode' }), null);
  assert.equal(companionEffectCopy({ ...base, sessionId: null, limitedBy: 'ambient-off' }), null);
  assert.equal(companionEffectCopy(null), null);
});

test('「安静点」：显示原因，点一下恢复，恢复后按服务端新状态收起', async () => {
  const f = fixture([{ ...base, level: 'silent', limitedBy: 'listener-quiet' }, base]);
  await f.effect.refresh();
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.textContent, '这次已安静');
  assert.match(f.attrs['aria-label'], /恢复主动说话/);
  await f.click();
  assert.deepEqual(f.calls, ['/api/presence/effective', 'restore', '/api/presence/effective']);
  assert.equal(f.button.hidden, true);
});

test('全局关闭去设置，话少的伙伴去她的人物页，都不代替用户改开关', async () => {
  const f = fixture([{ ...base, level: 'silent', limitedBy: 'ambient-off' }, { ...base, temperament: 'quiet', level: 'quiet', limitedBy: 'temperament' }]);
  await f.effect.refresh();
  assert.equal(f.button.textContent, '主动说话已关');
  await f.click();
  await f.effect.refresh();
  assert.equal(f.button.textContent, 'Lunara话少');
  await f.click();
  assert.deepEqual(f.calls.filter(call => !call.startsWith('/')), ['settings', 'person:lunara']);
});

test('启动参数停用时只说明、不可点；读取失败时隐藏', async () => {
  const f = fixture([{ ...base, level: 'silent', limitedBy: 'unavailable' }, new Error('offline')]);
  await f.effect.refresh();
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.disabled, true);
  await f.effect.refresh();
  assert.equal(f.button.hidden, true);
});
