import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { FREE_VOICE_DISCLOSURE, createFreeVoiceQuickEnable, enableFreeVoices } from './freeVoiceSettings.js';

function mount(saveTtsFallback) {
  const { document } = parseHTML('<div id="host"></div>');
  const host = document.querySelector('#host');
  host.append(createFreeVoiceQuickEnable({ documentLike: document, saveTtsFallback }));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { document, settle };
}

test('enableFreeVoices 只提交带 consent 的开启补丁', async () => {
  const patches = [];
  await enableFreeVoices(async patch => {
    patches.push(patch);
    return { fallback: { freeVoicesEnabled: true } };
  });
  assert.deepEqual(patches, [{ freeVoicesEnabled: true, consent: true }]);
});

test('快捷入口先展示固定说明；取消不调用开启', async () => {
  const patches = [];
  const { document } = mount(async patch => { patches.push(patch); });
  const prompt = document.querySelector('[data-free-voice-prompt]');
  assert.equal(prompt.hidden, true);
  document.querySelector('[data-free-voice-enable]').click();
  assert.equal(prompt.hidden, false);
  assert.equal(document.querySelector('[data-free-voice-disclosure]').textContent, FREE_VOICE_DISCLOSURE);
  assert.match(FREE_VOICE_DISCLOSURE, /发送给微软/);
  document.querySelector('[data-free-voice-cancel]').click();
  assert.equal(prompt.hidden, true);
  assert.deepEqual(patches, []);
});

test('同意后才调用开启；失败时留下具体原因', async () => {
  const patches = [];
  const { document, settle } = mount(async () => { throw new Error('微软接口暂时拒绝'); });
  document.querySelector('[data-free-voice-enable]').click();
  document.querySelector('[data-free-voice-agree]').click();
  await settle();
  assert.deepEqual(patches, []);
  assert.match(document.querySelector('[data-free-voice-status]').textContent, /微软接口暂时拒绝/);
  assert.equal(document.documentElement.textContent.includes('操作没有完成'), false);

  const second = mount(async patch => { patches.push(patch); return { ok: true }; });
  second.document.querySelector('[data-free-voice-enable]').click();
  assert.deepEqual(patches, []);
  second.document.querySelector('[data-free-voice-agree]').click();
  await second.settle();
  assert.deepEqual(patches, [{ freeVoicesEnabled: true, consent: true }]);
});
