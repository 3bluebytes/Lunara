import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppState } from '../../core/appState.js';
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
    '#cast-name-hint', '#cast-preview', '#cast-preview-audio',
    '#radiohost-created-dialog', '#radiohost-created-name', '#radiohost-created-chat', '#radiohost-created-listen', '#radiohost-created-done',
  ];
  const nodes = new Map(ids.map(id => [id, domElement()]));
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
          id: 'late_night_companion', displayName: '深夜陪伴', summary: '安静、克制、话少但到位',
          character: '安静克制', nameCandidates: ['林墨', '沐言'],
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

test('两个维度都必须选定，缺少时指明缺什么而不是静默补齐', () => {
  const voiceProfile = { id: 'voice-a' };
  const personaPreset = { id: 'late_night_companion' };
  assert.equal(validateRadiohostDraft({ voiceProfile, displayName: '夜航' }).error, '请选择一个性格。');
  assert.equal(validateRadiohostDraft({ personaPreset, displayName: '夜航' }).error, '请选择一把声音。');
  assert.equal(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '夜航' }).valid, true);
});

test('补充说明是可选的，人格由性格本身提供', () => {
  const draft = validateRadiohostDraft({
    voiceProfile: { id: 'v' }, personaPreset: { id: 'p' }, displayName: '夜航', personaHint: '',
  });
  assert.equal(draft.valid, true, '补充说明不应是必填');
  assert.equal(draft.personaHint, '');
});

test('名字与补充说明的边界校验', () => {
  const voiceProfile = { id: 'voice-a' };
  const personaPreset = { id: 'p' };
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '  ' }).error, /名字/);
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '伙伴', personaHint: '\u0000' }).error, /控制字符/);
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: 'x'.repeat(81) }).error, /80/);
  assert.match(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: '伙伴', personaHint: 'x'.repeat(1001) }).error, /1000/);
  assert.equal(validateRadiohostDraft({ voiceProfile, personaPreset, displayName: ' 夜航 ', personaHint: '温柔\n克制' }).personaHint, '温柔\n克制');
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

test('创建载荷同时带人设与声音，两个维度都提交', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.presetButton.trigger('click');
  await h.voiceButton.trigger('click');
  assert.equal(await h.view.createSelectedRadiohost(), true);
  const payload = h.calls.find(([method, path]) => method === 'POST' && path === '/api/virtual-persons')?.[2];
  assert.equal(payload.personaPresetId, 'late_night_companion');
  assert.equal(payload.voiceProfileId, 'voice-a');
  assert.equal(payload.displayName, '林墨');
});

test('缺少性格时不发起创建请求', async () => {
  const h = createHarness();
  await h.view.openCast();
  await h.voiceButton.trigger('click');
  assert.equal(await h.view.createSelectedRadiohost(), false);
  assert.equal(h.calls.some(([method, path]) => method === 'POST' && path === '/api/virtual-persons'), false);
  assert.match(h.nodes.get('#cast-msg').textContent, /性格/);
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

test('人设加载失败不阻断声音选择（两个维度彼此独立）', async () => {
  const h = createHarness({ presetsFail: true });
  await h.view.openCast();
  // 声音仍可用
  await h.voiceButton.trigger('click');
  assert.equal(h.view.getSelection().voice.id, 'voice-a', '人设失败不应让声音也不可用');
  assert.match(h.nodes.get('#cast-persona-grid').innerHTML, /加载失败/);
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
