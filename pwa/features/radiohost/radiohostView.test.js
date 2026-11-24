import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createAppState } from '../../core/appState.js';
import { FREE_VOICE_DISCLOSURE } from '../settings/freeVoiceSettings.js';
import { createRadiohostController } from './radiohostController.js';
import { createRadiohostView, suggestNameFromPreset, validateRadiohostDraft } from './radiohostView.js';

function element() {
  const listeners = new Map();
  return {
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    count(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}

function domElement({ value = '', query = {} } = {}) {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  return {
    dataset: {},
    value,
    disabled: false,
    open: false,
    innerHTML: '',
    textContent: '',
    style: { display: 'none' },
    parentElement: { hidden: false },
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    querySelectorAll(selector) { return query[selector] || []; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    async trigger(type, overrides = {}) {
      const event = {
        target: this,
        currentTarget: this,
        preventDefault() { this.defaultPrevented = true; },
        ...overrides,
      };
      return Promise.all([...(listeners.get(type) || [])].map(listener => listener(event)));
    },
  };
}

const defaultPost = async () => ({ ok: true, person: { id: 'radiohost-new', displayName: '夜航', kind: 'radiohost' } });

function createHarness({ post = defaultPost, presetsFail = false, previewResult = { ok: true, url: '/tts/preview.wav' }, voices = null } = {}) {
  const voiceList = voices || [{ id: 'voice-a', displayName: '晚风女声', description: '轻柔', styleTags: ['gentle'] }];
  const voiceButton = domElement();
  voiceButton.dataset.vpId = voiceList[0].id;
  const voiceGrid = domElement({ query: { '[data-vp-id]': [voiceButton], '.cast-voice': [voiceButton] } });
  const presetButton = domElement();
  presetButton.dataset.presetId = 'late_night_companion';
  const presetGrid = domElement({ query: { '[data-preset-id]': [presetButton], '.cast-persona': [presetButton] } });
  const ids = [
    '#radiohost-cast-new', '#people-list-create', '#cast-form', '#cast-close', '#cast-overlay', '#cast-voice-count',
    '#cast-persona-grid', '#cast-persona-count',
    '#cast-voice-grid', '#cast-persona', '#cast-name', '#cast-msg', '#cast-go',
    '#cast-name-hint', '#cast-preview', '#cast-preview-audio', '#cast-expand-persona', '#cast-undo-expand',
    '#radiohost-created-dialog', '#radiohost-created-name', '#radiohost-created-chat', '#radiohost-created-listen', '#radiohost-created-done',
  ];
  const nodes = new Map(ids.map(id => [id, domElement()]));
  nodes.get('#cast-undo-expand').hidden = true;
  nodes.set('#cast-voice-grid', voiceGrid);
  nodes.set('#cast-persona-grid', presetGrid);
  nodes.get('#cast-overlay').style.display = 'none';
  const runtime = {
    activeListeningSessionId: 'conversation:primary',
    queue: [{ queueItemId: 'current-occurrence', songId: 'song-a', url: '/audio/a' }],
    currentIndex: 0,
    currentSongId: 'song-a',
    txn: { queueItemId: 'current-occurrence', correlationId: 'txn-a' },
  };
  const store = createAppState({
    sessionId: 'conversation:primary',
    activeRadiohost: { id: 'lunara', displayName: 'Lunara', kind: 'root' },
    runtimeState: runtime,
  });
  const calls = [];
  const apiClient = {
    get: async path => {
      calls.push(['GET', path]);
      if (path === '/api/station/voices') return { ok: true, voices: voiceList };
      if (path === '/api/persona-presets') {
        if (presetsFail) throw new Error('人设服务不可用');
        return { ok: true, presets: [{
          id: 'late_night_companion', displayName: '深夜陪伴', summary: '安静沉稳，留白温和',
          character: '安静克制', templateText: '## 我是谁\n安静温和的深夜伙伴。', nameCandidates: ['林墨', '沐言'],
        }] };
      }
      if (path.startsWith('/api/virtual-persons?')) return {
        ok: true,
        persons: [{ id: 'lunara', displayName: 'Lunara', kind: 'root' }, { id: 'radiohost-new', displayName: '夜航', kind: 'radiohost' }],
        session: { activeVirtualPersonId: 'lunara' },
      };
      throw new Error(`unexpected GET ${path}`);
    },
    post: (path, body) => {
      calls.push(['POST', path, body]);
      if (path === '/api/tts/preview') return Promise.resolve(previewResult);
      return post(path, body);
    },
  };
  const controller = createRadiohostController({ store, apiClient });
  const followups = { chat: [], listen: [] };
  let loaded = 0;
  const view = createRadiohostView({
    controller,
    store,
    documentLike: { querySelector: selector => nodes.get(selector) || null },
    autoLoad: false,
    onLoaded: () => { loaded += 1; },
    onCreateChat: person => followups.chat.push(person),
    onListenWith: person => followups.listen.push(person),
    // 确定性随机：名字候选的挑选否则会随 Math.random 抖动，使断言不稳定。
    random: () => 0,
  });
  return { view, nodes, voiceButton, presetButton, calls, store, runtime, followups, loaded: () => loaded };
}

test('名字来自人设的名字候选，而不是音色', () => {
  const preset = { id: 'p1', displayName: '深夜陪伴', nameCandidates: ['林墨', '沐言'] };
  assert.equal(suggestNameFromPreset(preset, () => 0), '林墨');
  assert.equal(suggestNameFromPreset(preset, () => 0.99), '沐言');
  // 无候选时退回人设名，而不是从音色猜。
  assert.equal(suggestNameFromPreset({ id: 'p2', displayName: '音乐偏执', nameCandidates: [] }, () => 0), '音乐偏执');
});

test('无标签音色不再被用来推导名字（旧实现会退化成通用名）', () => {
  // 旧 suggestRadiohostName 对 zf_002 这类无标签音色会返回通用名；现在名字只来自人设。
  const preset = { id: 'p1', displayName: '冷感理性', nameCandidates: ['陆行'] };
  assert.equal(suggestNameFromPreset(preset, () => 0), '陆行');
});

test('未启用或未同意的晓晓不能当成一把可用声音', () => {
  const personaPreset = { id: 'late_night_companion' };
  const pending = {
    id: 'vp_cx_a0c168ef',
    displayName: '晓晓',
    sourceProvider: 'free-edge',
    unavailable: true,
  };
  assert.equal(validateRadiohostDraft({
    voiceProfile: pending,
    personaPreset,
    displayName: '夜航',
    personaDocument: '温柔坚定',
  }).valid, false);
  assert.equal(validateRadiohostDraft({
    voiceProfile: { ...pending, unavailable: false },
    personaPreset,
    displayName: '夜航',
    personaDocument: '温柔坚定',
    fallback: { freeVoicesEnabled: true, consentAt: null },
  }).valid, false);
  assert.equal(validateRadiohostDraft({
    voiceProfile: { ...pending, unavailable: false },
    personaPreset,
    displayName: '夜航',
    personaDocument: '温柔坚定',
    fallback: { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' },
  }).valid, true);
});

test('声音、名字与性格设定文本必填，预设模板为可选灵感', () => {
  const voiceProfile = { id: 'voice-a', unavailable: false };
  const personaPreset = { id: 'late_night_companion' };
  assert.match(validateRadiohostDraft({ voiceProfile, displayName: '夜航' }).error, /性格与设定/);
  assert.equal(validateRadiohostDraft({ personaPreset, displayName: '夜航', personaDocument: '安静温和' }).error, '请选择一把声音。');
  assert.equal(validateRadiohostDraft({ voiceProfile, displayName: '夜航', personaDocument: '纯手写自定义性格' }).valid, true);
  assert.equal(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '夜航', personaDocument: '基于模板修改' }).valid, true);
});

test('无预设时 personaPresetId 为 null，全文按原文保留', () => {
  const draft = validateRadiohostDraft({
    voiceProfile: { id: 'v', unavailable: false }, displayName: '夜航', personaDocument: '## 我是谁\n热爱爵士的调酒师',
  });
  assert.equal(draft.valid, true);
  assert.equal(draft.personaPresetId, null);
  assert.equal(draft.personaDocument, '## 我是谁\n热爱爵士的调酒师');
});

test('名字与性格设定的边界校验（上限 4000 字）', () => {
  const voiceProfile = { id: 'voice-a', unavailable: false };
  const personaPreset = { id: 'p' };
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '  ', personaDocument: '有效设定' }).error, /名字/);
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '伙伴', personaDocument: '\u0000' }).error, /控制字符/);
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: 'x'.repeat(81), personaDocument: '有效设定' }).error, /80/);
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '伙伴', personaDocument: 'x'.repeat(4001) }).error, /4000/);
  assert.equal(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: ' 夜航 ', personaDocument: '温柔\n踏实' }).personaDocument, '温柔\n踏实');
});

test('人物列表标题旁的 ＋ 是新增伙伴的常驻入口，只打开面板、不创建任何人', async () => {
  const harness = createHarness();
  harness.view.init();
  await harness.nodes.get('#people-list-create').trigger('click');
  assert.equal(harness.nodes.get('#cast-overlay').style.display, 'flex');
  assert.equal(harness.calls.filter(([method]) => method === 'POST').length, 0);
});

test('Radiohost creation rejects invalid values, serializes modal submits and keeps failures side-effect free', async () => {
  let rejectCreate;
  const harness = createHarness({ post: () => new Promise((_, reject) => { rejectCreate = reject; }) });
  await harness.view.openCast();
  // 两个维度都必须选定：只选声音不足以保存。
  await harness.presetButton.trigger('click');
  await harness.voiceButton.trigger('click');

  harness.nodes.get('#cast-name').value = '   ';
  harness.nodes.get('#cast-persona').value = '温柔、克制';
  assert.equal(await harness.view.createSelectedRadiohost(), false);
  assert.equal(harness.calls.filter(([method, path]) => method === 'POST' && path === '/api/virtual-persons').length, 0);

  harness.nodes.get('#cast-name').value = '夜航';
  const submit = harness.view.createSelectedRadiohost();
  await Promise.resolve();
  assert.equal(harness.nodes.get('#cast-go').disabled, true);
  assert.equal(await harness.view.createSelectedRadiohost(), false);
  harness.view.closeCast();
  assert.equal(harness.nodes.get('#cast-overlay').style.display, 'flex');
  rejectCreate(new Error('保存失败'));
  assert.equal(await submit, false);
  assert.equal(harness.nodes.get('#cast-msg').textContent, '保存失败');
  assert.equal(harness.nodes.get('#cast-overlay').style.display, 'flex');
  assert.equal(harness.nodes.get('#cast-go').disabled, false);
  assert.deepEqual(harness.calls.filter(([method]) => method === 'POST').map(([, path]) => path), ['/api/virtual-persons']);
  assert.deepEqual(harness.store.getState().runtimeState, harness.runtime);
  assert.equal(harness.store.getState().activeRadiohost.id, 'lunara');
  assert.equal(harness.calls.some(([, path]) => path?.includes('/activate') || path === '/api/conversations' || path === '/api/next'), false);
  assert.equal(harness.followups.chat.length + harness.followups.listen.length, 0);
  assert.equal(harness.loaded(), 0);
});

test('Radiohost create success only opens saved-person choices; chat follow-up stays explicit', async () => {
  const harness = createHarness();
  await harness.view.init().openCast();
  await harness.presetButton.trigger('click');
  await harness.voiceButton.trigger('click');
  harness.nodes.get('#cast-name').value = '夜航';
  harness.nodes.get('#cast-persona').value = '温柔、克制';

  assert.equal(await harness.view.createSelectedRadiohost(), true);
  assert.equal(harness.nodes.get('#cast-overlay').style.display, 'none');
  assert.equal(harness.nodes.get('#radiohost-created-dialog').open, true);
  assert.equal(harness.nodes.get('#radiohost-created-name').textContent, '夜航');
  assert.equal(harness.followups.chat.length + harness.followups.listen.length, 0);
  assert.deepEqual(harness.store.getState().runtimeState, harness.runtime);
  assert.equal(harness.store.getState().activeRadiohost.id, 'lunara');
  assert.deepEqual(harness.calls.filter(([method]) => method === 'POST').map(([, path]) => path), ['/api/virtual-persons']);
  assert.equal(harness.loaded(), 0);

  await harness.nodes.get('#radiohost-created-chat').trigger('click');
  assert.equal(harness.followups.chat.length, 1);
  assert.equal(harness.followups.chat[0].id, 'radiohost-new');
  assert.equal(harness.followups.listen.length, 0);
  assert.equal(harness.nodes.get('#radiohost-created-dialog').open, false);
});

test('Radiohost view init is idempotent and destroy releases static DOM listeners', () => {
  const cast = element();
  const close = element();
  const overlay = element();
  const nodes = new Map([
    ['#radiohost-cast-new', cast],
    ['#cast-close', close],
    ['#cast-overlay', overlay],
  ]);
  const view = createRadiohostView({
    controller: {
      getSnapshot: () => ({ persons: [], radiohosts: [], voices: [], activeRadiohost: null, currentRadiohostId: null }),
    },
    store: { getState: () => ({ activeRadiohost: null }) },
    documentLike: { querySelector: selector => nodes.get(selector) || null },
    schedule: () => 9,
    cancelSchedule: () => {},
  });

  view.init();
  view.init();
  assert.equal(cast.count('click'), 1);
  assert.equal(close.count('click'), 1);
  assert.equal(overlay.count('click'), 1);
  view.destroy();
  assert.equal(cast.count('click'), 0);
  assert.equal(close.count('click'), 0);
  assert.equal(overlay.count('click'), 0);
});

test('选择声音不会填充名字或人格（旧实现会由音色反推）', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  assert.equal(h.nodes.get('#cast-name').value, '', '声音只决定怎么念，不该推导名字');
  assert.equal(h.nodes.get('#cast-persona').value, '');
  assert.equal(h.view.getSelection().voice.id, 'voice-a');
});

test('选择性格时填入名字候选，并在提示里列出候选', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.presetButton.trigger('click');
  assert.equal(h.nodes.get('#cast-name').value, '林墨', '名字来自人设的名字候选');
  assert.match(h.nodes.get('#cast-name-hint').textContent, /林墨/);
  assert.match(h.nodes.get('#cast-name-hint').textContent, /沐言/);
  assert.equal(h.view.getSelection().preset.id, 'late_night_companion');
});

test('选择性格不覆盖用户已改过的名字', async () => {
  const h = createHarness();
  // 必须 init()：userEdited 标记由 input 监听器打上，而监听器在 init 时注册。
  h.view.init();
  await h.view.openCast();
  h.nodes.get('#cast-name').value = '我自己起的';
  await h.nodes.get('#cast-name').trigger('input');
  await h.presetButton.trigger('click');
  assert.equal(h.nodes.get('#cast-name').value, '我自己起的', '用户输入优先');
});

test('两个维度可任意顺序选择，互不覆盖', async () => {
  const h = createHarness();
  await h.view.openCast();
  // 先声音后人设
  await h.voiceButton.trigger('click');
  await h.presetButton.trigger('click');
  assert.equal(h.view.getSelection().voice.id, 'voice-a', '选人设不得清掉已选声音');
  assert.equal(h.view.getSelection().preset.id, 'late_night_companion');

  // 先人设后声音（换一个实例避免选中态残留）
  const h2 = createHarness();
  await h2.view.openCast();
  await h2.presetButton.trigger('click');
  await h2.voiceButton.trigger('click');
  assert.equal(h2.view.getSelection().preset.id, 'late_night_companion', '选声音不得清掉已选人设');
  assert.equal(h2.nodes.get('#cast-name').value, '林墨');
});

test('创建载荷直传编辑框全文 personaDocument 与声音；选模板时附带 personaPresetId', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.presetButton.trigger('click');
  await h.voiceButton.trigger('click');
  assert.equal(h.nodes.get('#cast-persona').value, '## 我是谁\n安静温和的深夜伙伴。');
  assert.equal(await h.view.createSelectedRadiohost(), true);
  const payload = h.calls.find(([method, path]) => method === 'POST' && path === '/api/virtual-persons')?.[2];
  assert.equal(payload.personaPresetId, 'late_night_companion');
  assert.equal(payload.personaDocument, '## 我是谁\n安静温和的深夜伙伴。');
  assert.equal(payload.voiceProfileId, 'voice-a');
  assert.equal(payload.displayName, '林墨');
});

test('缺少性格与设定文本时不发起创建请求', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  h.nodes.get('#cast-name').value = '夜航';
  assert.equal(await h.view.createSelectedRadiohost(), false);
  assert.equal(h.calls.some(([method, path]) => method === 'POST' && path === '/api/virtual-persons'), false);
  assert.match(h.nodes.get('#cast-msg').textContent, /性格与设定/);
});

test('缺少声音时不发起创建请求', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.presetButton.trigger('click');
  assert.equal(await h.view.createSelectedRadiohost(), false);
  assert.match(h.nodes.get('#cast-msg').textContent, /声音/);
});

test('试听走真实合成端点并播放返回的音频', async () => {
  const h = createHarness({ previewResult: { ok: true, url: '/tts/preview-abc.wav' } });
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  await h.view.previewVoice();
  const call = h.calls.find(([method, path]) => method === 'POST' && path === '/api/tts/preview');
  assert.ok(call, '必须调用真实合成端点');
  assert.equal(call[2].voiceProfileId, 'voice-a');
  assert.equal(h.nodes.get('#cast-preview-audio').src, '/tts/preview-abc.wav');
  assert.equal(h.nodes.get('#cast-preview-audio').hidden, false);
});

test('未选声音时试听按钮不可用', async () => {
  const h = createHarness();
  await h.view.openCast();
  assert.equal(h.nodes.get('#cast-preview').disabled, true);
  await h.voiceButton.trigger('click');
  assert.equal(h.nodes.get('#cast-preview').disabled, false);
});

test('试听没有返回音频时明确失败，不恢复旧模型下载提示', async () => {
  const h = createHarness({ previewResult: { ok: true } });
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  await h.view.previewVoice();
  assert.match(h.nodes.get('#cast-msg').textContent, /没有返回音频/);
  assert.equal(h.nodes.get('#cast-preview-audio').hidden, true);
});

test('试听失败显式提示，不静默无响应', async () => {
  const h = createHarness({ previewResult: { ok: false, error: '这把声音当前不可用' } });
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  await h.view.previewVoice();
  assert.match(h.nodes.get('#cast-msg').textContent, /不可用/);
});

test('模板加载失败既不阻断声音选择，也不阻断纯手写自定义创建', async () => {
  const h = createHarness({ presetsFail: true });
  h.view.init();
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  assert.equal(h.view.getSelection().voice.id, 'voice-a', '模板失败不应让声音不可用');
  assert.match(h.nodes.get('#cast-persona-grid').innerHTML, /加载失败/);

  h.nodes.get('#cast-name').value = '阿烈';
  await h.nodes.get('#cast-name').trigger('input');
  h.nodes.get('#cast-persona').value = '热爱后摇的独立电台人';
  await h.nodes.get('#cast-persona').trigger('input');
  assert.equal(await h.view.createSelectedRadiohost(), true);
  const payload = h.calls.find(([method, path]) => method === 'POST' && path === '/api/virtual-persons')?.[2];
  assert.equal(payload.personaPresetId, undefined);
  assert.equal(payload.personaDocument, '热爱后摇的独立电台人');
});

test('重新打开创建面板时清空上一次的选择', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.presetButton.trigger('click');
  await h.voiceButton.trigger('click');
  h.view.closeCast();
  await h.view.openCast();
  assert.equal(h.view.getSelection().preset, null);
  assert.equal(h.view.getSelection().voice, null);
  assert.equal(h.nodes.get('#cast-name').value, '');
  assert.equal(h.nodes.get('#cast-go').disabled, true);
});

test('原生声音不可用时，声音卡片如实标注本地代播', async () => {
  const h = createHarness({
    voices: [{ id: 'voice-a', displayName: '晚风女声', description: '轻柔', styleTags: ['gentle'], isFallback: true }],
  });
  await h.view.openCast();
  const html = h.nodes.get('#cast-voice-grid').innerHTML;
  // 不标注就等于把回落呈现为原生声线——用户在试听前无从分辨。
  assert.match(html, /音色已变化/, '换声的声音必须带标注');
  assert.match(html, /tag-fallback/);
});

test('不回落的声音卡片不带代播标注', async () => {
  const h = createHarness();
  await h.view.openCast();
  assert.doesNotMatch(h.nodes.get('#cast-voice-grid').innerHTML, /音色已变化/);
});

function castDocument() {
  const { document } = parseHTML(`<div>
    <div id="cast-overlay" style="display:none"></div>
    <form id="cast-form"><button id="cast-go" type="submit" disabled>保存伙伴</button></form>
    <div id="cast-persona-grid"></div>
    <span id="cast-persona-count"></span>
    <div id="cast-voice-grid"></div>
    <span id="cast-voice-count"></span>
    <p id="cast-msg"></p>
    <input id="cast-name" />
    <textarea id="cast-persona"></textarea>
    <button id="cast-expand-persona" type="button">AI 扩写完善</button>
    <button id="cast-undo-expand" type="button" hidden>撤回扩写</button>
    <p id="cast-name-hint"></p>
    <button id="cast-preview" type="button"></button>
    <audio id="cast-preview-audio"></audio>
    <button id="cast-close" type="button"></button>
    <dialog id="radiohost-created-dialog"><strong id="radiohost-created-name"></strong>
      <button id="radiohost-created-chat" type="button"></button>
      <button id="radiohost-created-listen" type="button"></button>
      <button id="radiohost-created-done" type="button"></button>
    </dialog>
  </div>`);
  return document;
}

function createCast({ fail = null, voices = null } = {}) {
  const document = castDocument();
  const posts = [];
  let consented = false;
  const fallback = () => (consented
    ? { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' }
    : { freeVoicesEnabled: false, consentAt: null });
  const voiceList = () => voices || [{
    id: 'vp_cx_a0c168ef',
    displayName: '晓晓',
    description: '免费声音',
    sourceProvider: 'free-edge',
    resolvedProviderId: consented ? 'free-edge' : null,
    unavailable: !consented,
  }];
  const apiClient = {
    get: async path => {
      if (path === '/api/station/voices') return { ok: true, voices: voiceList() };
      if (path === '/api/tts/custom') return { ok: true, config: { fallback: fallback() } };
      if (path.startsWith('/api/virtual-persons')) {
        return {
          ok: true,
          persons: [{ id: 'lunara', displayName: 'Lunara', kind: 'root' }],
          session: { activeVirtualPersonId: 'lunara' },
        };
      }
      if (path === '/api/persona-presets') {
        return { ok: true, presets: [{
          id: 'late_night_companion', displayName: '深夜陪伴', summary: '安静', character: '安静', nameCandidates: ['林墨'],
        }] };
      }
      throw new Error(path);
    },
    post: async (path, body) => {
      posts.push([path, body]);
      if (path === '/api/tts/fallback') {
        if (fail) throw new Error(fail);
        consented = true;
        return { ok: true, config: { fallback: fallback() } };
      }
      if (path === '/api/virtual-persons') {
        return { ok: true, person: { id: 'radiohost-new', displayName: body.displayName || '林墨', kind: 'radiohost' } };
      }
      throw new Error(path);
    },
  };
  const store = createAppState({
    sessionId: 'conversation:primary',
    activeRadiohost: { id: 'lunara', displayName: 'Lunara', kind: 'root' },
  });
  const view = createRadiohostView({
    controller: createRadiohostController({ store, apiClient }),
    store,
    documentLike: document,
    autoLoad: false,
    saveTtsFallback: patch => apiClient.post('/api/tts/fallback', patch),
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { document, view, posts, settle };
}

test('没有可用声音时创建伙伴先看微软说明，同意后晓晓可以保存', async () => {
  const { document, view, posts, settle } = createCast();
  await view.openCast();
  const button = document.querySelector('[data-free-voice-enable]');
  assert.equal(button?.textContent, '使用免费声音');
  assert.equal(document.querySelector('[data-free-voice-prompt]').hidden, true);
  button.click();
  assert.equal(document.querySelector('[data-free-voice-disclosure]').textContent, FREE_VOICE_DISCLOSURE);
  assert.equal(posts.some(([path]) => path === '/api/tts/fallback'), false);
  document.querySelector('[data-free-voice-agree]').click();
  await settle();
  await settle();
  assert.deepEqual(posts[0], ['/api/tts/fallback', { freeVoicesEnabled: true, consent: true }]);
  assert.equal(document.querySelector('[data-free-voice-enable]'), null);
  document.querySelector('[data-preset-id]').click();
  document.querySelector('[data-vp-id]').click();
  assert.equal(await view.createSelectedRadiohost(), true);
  assert.equal(posts.some(([path]) => path === '/api/virtual-persons'), true);
});

test('创建伙伴页取消免费声音时不发出开启请求', async () => {
  const { document, view, posts } = createCast();
  await view.openCast();
  document.querySelector('[data-free-voice-enable]').click();
  document.querySelector('[data-free-voice-cancel]').click();
  assert.equal(document.querySelector('[data-free-voice-prompt]').hidden, true);
  assert.equal(posts.length, 0);
});

test('创建伙伴页已有可用声音时不显示使用免费声音', async () => {
  const { document, view } = createCast({
    voices: [{ id: 'vp_custom', displayName: '自备', sourceProvider: 'custom', unavailable: false }],
  });
  await view.openCast();
  assert.equal(document.querySelector('[data-free-voice-enable]'), null);
  assert.equal(document.querySelector('[data-vp-id]')?.dataset.vpId, 'vp_custom');
});

test('创建伙伴页开启失败时展示具体原因', async () => {
  const { document, view, posts, settle } = createCast({ fail: '微软接口暂时拒绝' });
  await view.openCast();
  document.querySelector('[data-free-voice-enable]').click();
  document.querySelector('[data-free-voice-agree]').click();
  await settle();
  assert.match(document.querySelector('[data-free-voice-status]').textContent, /微软接口暂时拒绝/);
  assert.equal(document.documentElement.textContent.includes('操作没有完成'), false);
  assert.equal(posts.some(([path]) => path === '/api/virtual-persons'), false);
});

test('已选提示包含回落说明，而不只报名字', async () => {
  const h = createHarness({
    voices: [{ id: 'voice-a', displayName: '晚风女声', description: '轻柔', styleTags: ['gentle'], isFallback: true }],
  });
  await h.view.openCast();
  await h.presetButton.trigger('click');
  await h.voiceButton.trigger('click');
  const message = h.nodes.get('#cast-msg').textContent;
  assert.match(message, /晚风女声/);
  assert.match(message, /音色已变化/, '必须说明当前不是所选声音');
});

test('召唤新伙伴弹窗按 Esc 关闭并隔离冒泡，有未存草稿先提示再确认丢弃', async () => {
  const { document, view } = createCast({
    voices: [{ id: 'vp_custom', displayName: '自备', sourceProvider: 'custom', unavailable: false }],
  });
  view.init();
  let openerFocused = 0;
  const opener = { isConnected: true, focus() { openerFocused += 1; } };
  Object.defineProperty(document, 'activeElement', { value: opener, configurable: true });

  await view.openCast();
  const overlay = document.querySelector('#cast-overlay');
  assert.equal(overlay.style.display, 'flex');

  // 触发用户编辑过名字/补充说明
  const personaInput = document.querySelector('#cast-persona');
  personaInput.value = '夜里说话轻一点';
  personaInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

  // 第一次按 Esc 保护未存草稿，不关闭，且阻断向下层冒泡
  let underlyingCalled = false;
  document.addEventListener('keydown', () => { underlyingCalled = true; });
  const makeEsc = () => {
    const ev = new document.defaultView.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'key', { value: 'Escape' });
    return ev;
  };
  personaInput.dispatchEvent(makeEsc());
  assert.equal(overlay.style.display, 'flex');
  assert.equal(underlyingCalled, false);
  assert.match(document.querySelector('#cast-msg').textContent, /未保存|再点|再按/);
  assert.equal(personaInput.value, '夜里说话轻一点');

  // 第二次按 Esc 确认关闭并清空输入、恢复原触发按钮焦点
  personaInput.dispatchEvent(makeEsc());
  assert.equal(overlay.style.display, 'none');
  assert.equal(openerFocused, 1);
  view.destroy();
});

test('点击模板填入正文、再次点击取消选中；用户已手改文本后切换模板需二次点击确认', async () => {
  const { document, view } = createCast({
    voices: [{ id: 'vp_custom', displayName: '自备', sourceProvider: 'custom', unavailable: false }],
  });
  view.init();
  await view.openCast();
  const presetBtn = document.querySelector('[data-preset-id="late_night_companion"]');
  const personaInput = document.querySelector('#cast-persona');
  const nameInput = document.querySelector('#cast-name');

  presetBtn.click();
  assert.equal(view.getSelection().preset.id, 'late_night_companion');
  assert.equal(personaInput.value, '安静');
  assert.equal(nameInput.value, '林墨');

  // 未手改时再次点击同一张模板：取消选中并清空模板文本
  presetBtn.click();
  assert.equal(view.getSelection().preset, null);
  assert.equal(personaInput.value, '');

  // 用户改名后删空：清除 userEdited，再点模板仍能自动回填候选名
  nameInput.value = '手填名';
  nameInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  nameInput.value = '';
  nameInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  presetBtn.click();
  assert.equal(nameInput.value, '林墨');

  // 用户手动修改性格文本后取消选中模板，应保留用户手改文本
  personaInput.value = '我自己写的独特人设';
  personaInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  presetBtn.click();
  assert.equal(view.getSelection().preset, null);
  assert.equal(personaInput.value, '我自己写的独特人设');

  // 再点模板时首次提示确认、不覆盖；二次点击才替换
  presetBtn.click();
  assert.equal(personaInput.value, '我自己写的独特人设');
  assert.match(document.querySelector('#cast-msg').textContent, /再点一次.*替换/);
  presetBtn.click();
  assert.equal(personaInput.value, '安静');
  view.destroy();
});

test('AI 扩写完善：空草稿拦截、成功填入并支持一键撤回、失败保留原草稿', async () => {
  let expandShouldFail = false;
  const h = createHarness({
    post: async (path, body) => {
      if (path === '/api/persona-presets/expand') {
        if (expandShouldFail) throw new Error('模型暂不可用');
        return { ok: true, personaDocument: `## 我是谁\n扩写自：${body.draft}` };
      }
      return defaultPost(path, body);
    },
  });
  h.view.init();
  await h.view.openCast();

  // 空草稿且未选模板时拦截
  assert.equal(await h.view.expandPersona(), false);
  assert.match(h.nodes.get('#cast-msg').textContent, /先写几句想法/);

  const personaInput = h.nodes.get('#cast-persona');
  personaInput.value = '喜欢摇滚的机械师';
  await personaInput.trigger('input');

  // 失败保留原草稿不动
  expandShouldFail = true;
  assert.equal(await h.view.expandPersona(), false);
  assert.equal(personaInput.value, '喜欢摇滚的机械师');
  assert.equal(h.nodes.get('#cast-undo-expand').hidden, true);

  // 成功填入并显示撤回扩写，点撤回恢复原草稿
  expandShouldFail = false;
  assert.equal(await h.view.expandPersona(), true);
  assert.equal(personaInput.value, '## 我是谁\n扩写自：喜欢摇滚的机械师');
  assert.equal(h.nodes.get('#cast-undo-expand').hidden, false);

  assert.equal(h.view.undoExpandPersona(), true);
  assert.equal(personaInput.value, '喜欢摇滚的机械师');
  assert.equal(h.nodes.get('#cast-undo-expand').hidden, true);
  h.view.destroy();
});
