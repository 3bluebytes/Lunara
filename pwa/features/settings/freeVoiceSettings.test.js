import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createFreeVoiceSettings, FREE_VOICE_DISCLOSURE } from './freeVoiceSettings.js';

// 直接用 index.html 里的真实片段（自定义接口卡里的免费声音小节 + 代读卡），保证 id 与可访问名称和页面一致。
const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const freeBlock = page.match(/<section class="tts-free-block"[\s\S]*?<\/section>/)?.[0];
const fallbackCard = page.match(/<section class="settings-card" aria-label="主声音失败时代读">[\s\S]*?<\/section>/)?.[0];
const card = freeBlock && fallbackCard ? freeBlock + fallbackCard : null;

function fixture({ fail = null, initial = null } = {}) {
  assert.ok(card, 'index.html 里有免费声音小节和代读卡');
  const { document } = parseHTML(`<html><body>${card}</body></html>`);
  const patches = [];
  const configs = [];
  let server = initial || { freeVoicesEnabled: false, consentAt: null, fallbackEnabled: false, fallbackTarget: null };
  const controller = {
    async saveTtsFallback(patch) {
      patches.push(patch);
      if (fail) throw new Error(fail);
      if (patch.freeVoicesEnabled === true) {
        server = { ...server, freeVoicesEnabled: true, consentAt: 'now', fallbackEnabled: true, fallbackTarget: server.fallbackTarget || { providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural' } };
      } else {
        server = { ...server, ...patch };
      }
      return { endpoints: [{ id: 'custom-qwen', name: '千问' }], voices: pool, fallback: server };
    },
  };
  const pool = [
    { endpointId: 'custom-qwen', sourceVoiceId: 'Cherry', displayName: '芊悦', profileId: 'vp_cx_0000abcd' },
    { endpointId: 'free-edge', sourceVoiceId: 'zh-CN-YunxiNeural', displayName: '云希', profileId: 'vp_cx_0000ef01' },
  ];
  const settings = createFreeVoiceSettings({ controller, documentLike: document, onConfig: config => configs.push(config)});
  const $ = selector => document.querySelector(selector);
  const change = (selector, apply) => { apply($(selector)); $(selector).dispatchEvent(new document.defaultView.Event('change')); };
  const click = selector => $(selector).dispatchEvent(new document.defaultView.Event('click'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { settings, document, $, change, click, settle, patches, configs, pool };
}

test('勾选免费声音先展开固定说明，不发请求；同意后才带 consent 开启', async () => {
  const h = fixture();
  assert.equal(h.$('#tts-free-consent').hidden, true);
  h.change('#tts-free-toggle', node => { node.checked = true; });
  assert.equal(h.$('#tts-free-toggle').checked, false, '复选框不直接打开');
  assert.equal(h.$('#tts-free-consent').hidden, false);
  assert.equal(h.$('#tts-free-disclosure').textContent, FREE_VOICE_DISCLOSURE);
  assert.match(FREE_VOICE_DISCLOSURE, /非官方/);
  assert.match(FREE_VOICE_DISCLOSURE, /发送给微软/);
  assert.deepEqual(h.patches, []);
  h.click('#tts-free-agree');
  await h.settle();
  assert.deepEqual(h.patches, [{ freeVoicesEnabled: true, consent: true }]);
  assert.equal(h.$('#tts-free-toggle').checked, true);
  assert.equal(h.$('#tts-free-consent').hidden, true);
  assert.match(h.$('#tts-free-status').textContent, /来源接口」已切到免费声音/);
  assert.equal(h.configs.length, 1, '保存后的配置交回声音池');
});

test('取消说明不开启；关闭随时生效', async () => {
  const h = fixture();
  h.change('#tts-free-toggle', node => { node.checked = true; });
  h.click('#tts-free-cancel');
  assert.equal(h.$('#tts-free-consent').hidden, true);
  assert.deepEqual(h.patches, []);
  h.change('#tts-free-toggle', node => { node.checked = true; });
  h.click('#tts-free-agree');
  await h.settle();
  h.change('#tts-free-toggle', node => { node.checked = false; });
  await h.settle();
  assert.deepEqual(h.patches, [{ freeVoicesEnabled: true, consent: true }, { freeVoicesEnabled: false }]);
  assert.match(h.$('#tts-fallback-note').textContent, /免费声音已关闭：现在不会代读/);
});

test('代读目标：免费声音（含声音池里的 Edge 声音）在前，声音池其他声音按 profileId 选', async () => {
  const initial = { freeVoicesEnabled: true, consentAt: 'then', fallbackEnabled: true, fallbackTarget: { providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural' } };
  const h = fixture({ initial });
  h.settings.apply({ endpoints: [{ id: 'custom-qwen', name: '千问' }], voices: h.pool, fallback: initial });
  const select = h.$('#tts-fallback-target');
  assert.deepEqual([...select.options].map(option => option.textContent), ['选择代读声音…', '晓晓 · 免费声音', '云希 · 免费声音', '芊悦 · 千问']);
  assert.equal([...select.options].find(option => option.selected)?.textContent, '晓晓 · 免费声音');
  h.change('#tts-fallback-target', node => { node.options[3].selected = true; });
  await h.settle();
  assert.deepEqual(h.patches.at(-1), { fallbackTarget: { profileId: 'vp_cx_0000abcd' } });
  h.change('#tts-fallback-target', node => { for (const option of node.options) option.selected = false; node.options[2].selected = true; });
  await h.settle();
  assert.deepEqual(h.patches.at(-1), { fallbackTarget: { providerId: 'free-edge', voiceId: 'zh-CN-YunxiNeural' } });
});

test('说明里按 Esc 只收起说明（不关设置面板），焦点回到开关', () => {
  const h = fixture();
  h.change('#tts-free-toggle', node => { node.checked = true; });
  const event = new h.document.defaultView.Event('keydown', { cancelable: true });
  event.key = 'Escape';
  h.$('#tts-free-consent').dispatchEvent(event);
  assert.equal(h.$('#tts-free-consent').hidden, true);
  assert.equal(event.defaultPrevented, true, '设置面板据 defaultPrevented 跳过关闭');
  assert.deepEqual(h.patches, []);
});

test('免费声音关闭时目标只剩声音池；代读关闭时下拉禁用', async () => {
  const h = fixture();
  h.settings.apply({ voices: h.pool, fallback: { freeVoicesEnabled: false, fallbackEnabled: false, fallbackTarget: null } });
  const select = h.$('#tts-fallback-target');
  assert.deepEqual([...select.options].map(option => option.textContent).slice(1), ['芊悦 · custom-qwen']);
  assert.equal(select.disabled, true);
  h.change('#tts-fallback-toggle', node => { node.checked = true; });
  await h.settle();
  assert.deepEqual(h.patches.at(-1), { fallbackEnabled: true });
});

test('保存失败如实显示原因，开关回到服务端状态', async () => {
  const h = fixture({ fail: '开启免费声音前需要先阅读说明并确认。' });
  h.change('#tts-free-toggle', node => { node.checked = true; });
  h.click('#tts-free-agree');
  await h.settle();
  assert.match(h.$('#tts-free-status').textContent, /没有保存：开启免费声音前需要/);
  assert.equal(h.$('#tts-free-toggle').checked, false);
});

test('免费声音小节在声音池卡里、紧挨发现结果之前；代读卡在声音池之后', () => {
  const customCard = page.match(/<section class="settings-card" aria-label="声音池">[\s\S]*?<section class="settings-card" aria-label="主声音失败时代读">/)?.[0] || '';
  const free = customCard.indexOf('id="tts-free-block"');
  const candidates = customCard.indexOf('id="tts-custom-candidates"');
  assert.ok(free > 0 && candidates > free, '免费声音小节在发现结果之前');
  assert.ok(customCard.indexOf('id="tts-custom-voice-editor"') > candidates, '声音池在发现结果之后、代读卡之前');
});

test('开关结果写在免费声音小节，代读结果写在代读卡', async () => {
  const h = fixture();
  h.change('#tts-free-toggle', node => { node.checked = true; });
  h.click('#tts-free-agree');
  await h.settle();
  assert.match(h.$('#tts-free-status').textContent, /发现结果/);
  h.change('#tts-fallback-toggle', node => { node.checked = false; });
  await h.settle();
  assert.match(h.$('#tts-fallback-status').textContent, /已关闭代读/);
});

test('卡片控件都有可访问名称', () => {
  const h = fixture();
  for (const id of ['#tts-free-toggle', '#tts-fallback-toggle']) {
    assert.ok(h.$(id).closest('label')?.textContent.trim(), `${id} 有标签`);
  }
  assert.ok(h.$('#tts-fallback-target').getAttribute('aria-label'));
  assert.equal(h.$('#tts-free-consent').getAttribute('role'), 'region');
  assert.ok(h.$('#tts-free-consent').getAttribute('aria-label'));
});
