import assert from 'node:assert/strict';
import test from 'node:test';

import { initSettingsView } from './settingsView.js';

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    value: '', disabled: false, hidden: false, textContent: '', innerHTML: '', title: '',
    style: {}, dataset: {},
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: name => classes.has(name),
    },
    setAttribute() {},
    focus() { this.focused = true; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    querySelectorAll: () => [],
    async trigger(type, values = {}) {
      const event = { currentTarget: this, target: this, preventDefault() {}, ...values };
      for (const listener of listeners.get(type) || []) await listener(event);
    },
  };
}

function createSettingsHarness({ customConfig, failures, discoveredVoices, previewResult, designResult, activateResults, persons, songTagConfig, songTagStatus, onSectionChange, authController, onSourceLogin, onSourceLogout } = {}) {
  const selectors = [
    '#app', '#settings-panel', '#settings-nav', '#settings-content',
    '#single-source-settings', '#multi-source-settings', '#source-mode-note',
    '#settings-source-accounts', '#settings-source-account-status',
    '#boot-llm-base-url', '#boot-llm-api-key', '#boot-llm-model', '#boot-source', '#boot-primary',
    '#boot-warn', '#boot-go', '#boot-close', '#sb-meta-llm', '#sb-meta-source',
    '#sb-meta-source-primary', '#sb-cog', '#nav-settings', '#boot-tts-providers',
    '#boot-location-input', '#boot-location-save', '#boot-location-auto',
    '#boot-location-clear', '#tts-custom-endpoint-list', '#tts-custom-editor-title', '#tts-custom-editor-state',
    '#tts-pool-source', '#tts-pool-status', '#tts-custom-name', '#tts-custom-endpoint-add',
    '#tts-custom-endpoint-remove', '#tts-custom-remove-confirm', '#tts-custom-remove-text',
    '#tts-custom-remove-yes', '#tts-custom-remove-no', '#tts-custom-protocol', '#tts-custom-url', '#tts-custom-key', '#tts-custom-model',
    '#tts-custom-models-list', '#tts-custom-models-btn', '#tts-custom-voices-btn', '#tts-free-agree',
    '#tts-endpoint-failures', '#tts-endpoint-failures-summary', '#tts-endpoint-failures-list', '#tts-endpoint-failures-refresh',
    '#tts-custom-save', '#tts-custom-manual', '#tts-custom-manual-add',
    '#tts-custom-voice-toolbar', '#tts-custom-voice-filter', '#tts-custom-select-all',
    '#tts-custom-remove-selected', '#tts-custom-voice-count',
    '#tts-custom-voice-editor', '#tts-custom-save-endpoint', '#tts-custom-dirty', '#tts-custom-candidates', '#tts-custom-candidate-title',
    '#tts-custom-candidate-filter', '#tts-custom-candidate-select-all', '#tts-custom-candidate-add',
    '#tts-custom-candidate-close', '#tts-custom-candidate-count', '#tts-custom-candidate-list', '#tts-custom-status', '#tts-custom-note',
    '#tts-custom-design-toggle', '#tts-custom-design', '#tts-custom-design-close', '#tts-custom-design-person', '#tts-custom-design-draft',
    '#tts-custom-design-description', '#tts-custom-design-chars', '#tts-custom-design-preview', '#tts-custom-design-name',
    '#tts-custom-design-count', '#tts-custom-design-cost', '#tts-custom-design-run',
    '#tts-recipe', '#tts-recipe-json', '#tts-recipe-voice',
    '#song-tag-url', '#song-tag-key', '#song-tag-model', '#song-tag-auto', '#song-tag-save',
    '#song-tag-coverage', '#song-tag-backfill', '#song-tag-status',
  ];
  const nodes = new Map(selectors.map(selector => [selector, element()]));
  nodes.get('#settings-panel').hidden = true;
  // 分类导航与页面列表：真实 DOM 里是静态节点，测试里用注入的子元素断言切换。
  const pageIds = ['general', 'appearance', 'memory', 'connection', 'usage', 'voice'];
  const navItems = Object.fromEntries(pageIds.map(id => {
    const item = element();
    item.dataset.settingsPage = id;
    return [id, item];
  }));
  const pages = Object.fromEntries(pageIds.map(id => {
    const page = element();
    page.dataset.settingsPage = id;
    return [id, page];
  }));
  nodes.get('#settings-nav').querySelectorAll = () => Object.values(navItems);
  nodes.get('#settings-content').querySelectorAll = () => Object.values(pages);
  const modes = ['single', 'multi'].map(value => Object.assign(element(), { value }));
  const documentLike = { querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: selector => selector === '[name="playback-source-mode"]' ? modes : [], activeElement: nodes.get('#sb-cog') };
  const snapshot = {
    current: { llm: { ready: true, baseUrl: 'https://llm.example', model: 'model', apiKeySet: true }, source: 'qq', primarySource: 'qq' },
    options: { source: [{ id: 'qq', name: 'QQ 音乐', ready: true }], tts: [] },
  };
  const listeners = new Set();
  const customServer = fakeCustomTtsServer(customConfig);
  const customConfigCalls = [];
  const failureCalls = [];
  const saveCalls = [];
  const previewCalls = [];
  const controller = {
    getSnapshot: () => snapshot,
    async load() { for (const listener of listeners) listener(snapshot); return snapshot; },
    async save(input) { saveCalls.push(input); for (const listener of listeners) listener(snapshot); return { ok: true, current: snapshot.current }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async loadCustomTtsConfig() { return customServer.view(); },
    async saveCustomTtsConfig(payload) {
      customConfigCalls.push(payload);
      return customServer.save(payload);
    },
    async removeCustomTtsEndpoint(endpointId) {
      customConfigCalls.push(['remove', endpointId]);
      return customServer.remove(endpointId);
    },
    async discoverCustomModels(endpointId) { customConfigCalls.push(['models', endpointId]); return ['tts-1', 'tts-2']; },
    async loadTtsFailures(endpointId) {
      failureCalls.push(endpointId);
      if (failures instanceof Error) throw failures;
      return (failures || {})[endpointId] || [];
    },
    async saveTtsFallback(patch) {
      customConfigCalls.push(['fallback', patch]);
      return customServer.view({ fallback: { freeVoicesEnabled: Boolean(patch.freeVoicesEnabled), fallbackEnabled: false, fallbackTarget: null } });
    },
    async discoverCustomVoices(endpointId) { customConfigCalls.push(['voices', endpointId]); return discoveredVoices || [{ id: 'nova-cn', name: '新星' }]; },
    async listPersons() { customConfigCalls.push(['persons']); return persons || [{ id: 'xm', displayName: '小满' }]; },
    async draftVoiceDescription(personId) { customConfigCalls.push(['draft', personId]); return { description: '二十岁出头的女声，清亮、语速偏慢' }; },
    async designCustomVoices(request) {
      customConfigCalls.push(['design', request]);
      return designResult || { candidates: [{ generatedId: 'gen_a', previewUrl: '/tts/gen_a.mp3' }, { generatedId: 'gen_b', previewUrl: '/tts/gen_b.mp3' }] };
    },
    async activateDesignedVoice(request) {
      customConfigCalls.push(['activate', request]);
      const result = (activateResults || {})[request.generatedId] || { voiceId: `voc_${request.generatedId}` };
      if (result.error) throw new Error(result.error);
      return result;
    },
    async previewCustomVoice(request) {
      previewCalls.push(request);
      return previewResult || { url: '/tts/preview.mp3' };
    },
    async loadSongTagConfig() {
      return songTagConfig || { auto: true };
    },
    async saveSongTagConfig(payload) {
      customConfigCalls.push(['song-tag', payload]);
      return { ...payload, hasKey: Boolean(payload.apiKey), source: 'config' };
    },
    async loadSongTagStatus() {
      return songTagStatus || {
        ok: true, auto: true, candidatePool: 270,
        activeModel: { providerId: 'p1', model: 'deepseek/deepseek-flash' },
        coverage: { tagged: 3, placeholders: 5, untagged: 262, pct: 1 },
      };
    },
    async runSongTagBackfill(input) {
      customConfigCalls.push(['song-tag-backfill', input]);
      return { ok: true, enqueued: 100, candidatePool: 270, skipped: 170, eligible: 100 };
    },
  };
  const audioFactory = createAudioFactory();
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const pageCalls = [];
  const view = initSettingsView({
    controller, storage, documentLike, createAudio: audioFactory, onSectionChange,
    authController, onSourceLogin, onSourceLogout,
    onPageEnter: () => pageCalls.push('enter'),
    onPageLeave: () => pageCalls.push('leave'),
  });
  return { view, nodes, storage, navItems, pages, customConfigCalls, failureCalls, previewCalls, audioFactory, pageCalls, saveCalls, modes };
}

test('source mode is exclusive, account notifications preserve the unsaved source draft', async () => {
  let emit;
  const logins = [];
  const authController = { subscribe(listener) { emit = listener; return () => {}; },
    async refresh() { return { qq: { loggedIn: false }, ncm: { loggedIn: false } }; } };
  const h = createSettingsHarness({ authController, onSourceLogin: source => logins.push(source) });
  h.view.open();
  assert.equal(h.nodes.get('#single-source-settings').hidden, true);
  assert.equal(h.nodes.get('#multi-source-settings').hidden, false);
  const single = h.modes[0];
  single.checked = true;
  await single.trigger('change');
  assert.equal(h.nodes.get('#single-source-settings').hidden, false);
  assert.equal(h.nodes.get('#multi-source-settings').hidden, true);
  emit({ qq: { loggedIn: true, nickname: 'fixture' } });
  assert.match(h.nodes.get('#settings-source-accounts').innerHTML, /已登录 · fixture/);
  assert.equal(h.nodes.get('#multi-source-settings').hidden, true);
  const login = { dataset: { sourceLogin: 'qq' } };
  await h.nodes.get('#settings-source-accounts').trigger('click', {
    target: childTarget({ '[data-source-login]': login }),
  });
  assert.deepEqual(logins, ['qq']);
  await h.nodes.get('#boot-go').trigger('click');
  assert.equal(h.saveCalls[0].playbackSourceMode, 'single');
  assert.equal('source' in h.saveCalls[0], false, 'legacy catalog selector is not saved by UI');
  h.view.destroy();
});

/** 在左列接口列表里点某一项（事件委托，与真实 DOM 同一路径）。 */
async function pickEndpoint(harness, endpointId) {
  await harness.nodes.get('#tts-custom-endpoint-list').trigger('click', {
    target: childTarget({ '[data-endpoint-id]': { dataset: { endpointId } } }),
  });
}

/** 事件委托用的子元素：closest 按预置映射命中，属性可注入。 */
function childTarget(matches = {}, props = {}) {
  return {
    value: '', checked: false, ...props,
    closest(selector) { return matches[selector] || null; },
  };
}

/** 模拟服务端的多接口配置：按 id 新增/更新接口（key 留空保留）、整体替换声音池、删除接口带走声音。 */
function fakeCustomTtsServer(initial) {
  const state = structuredClone(initial || {
    endpoints: [{ id: 'custom', name: 'OpenAI 兼容', protocol: 'openai', baseUrl: 'https://tts.example/v1', model: 'tts-1', hasKey: true, configured: true }],
    voices: [{ profileId: 'vp_cx_1', endpointId: 'custom', sourceVoiceId: 'alloy-cn', displayName: '中文合金' }],
  });
  const view = extra => structuredClone({ ...state, ...extra });
  return {
    view,
    save({ endpoint, voices } = {}) {
      let savedEndpointId = null;
      if (endpoint) {
        const existing = state.endpoints.find(item => item.id === endpoint.id);
        const { apiKey, ...fields } = endpoint;
        if (existing) {
          Object.assign(existing, fields, { hasKey: existing.hasKey || Boolean(apiKey) });
          savedEndpointId = existing.id;
        } else {
          savedEndpointId = endpoint.id || `custom-${fields.name || fields.protocol}`;
          state.endpoints.push({ ...fields, id: savedEndpointId, hasKey: Boolean(apiKey), configured: Boolean(apiKey && fields.baseUrl) });
        }
      }
      if (voices) state.voices = voices.map(voice => ({ profileId: `vp_${voice.endpointId}_${voice.sourceVoiceId}`, ...voice }));
      return view({ savedEndpointId });
    },
    remove(endpointId) {
      const before = state.voices.length;
      state.endpoints = state.endpoints.filter(item => item.id !== endpointId);
      state.voices = state.voices.filter(voice => voice.endpointId !== endpointId);
      return view({ removedVoices: before - state.voices.length });
    },
  };
}

const TWO_ENDPOINTS = {
  endpoints: [
    { id: 'custom', name: 'MiniMax', protocol: 'minimax', baseUrl: 'https://api.minimax.cn', model: 'speech-2.8-hd', hasKey: true, configured: true,
      voiceDesign: { maxCandidates: 1, costNote: 'MiniMax 按次计费' } },
    { id: 'custom-breeze', name: 'Breeze', protocol: 'breeze', baseUrl: 'https://api.breeze.blue', model: 'breeze-tts-2', hasKey: true, configured: true,
      voiceDesign: { maxCandidates: 3, costNote: 'Breeze 按字计费' } },
  ],
  voices: [
    { profileId: 'vp_cx_d54f990d', endpointId: 'custom', sourceVoiceId: 'female-shaonv', displayName: '少女音色' },
    { profileId: 'vp_cx_5116b16b', endpointId: 'custom-breeze', sourceVoiceId: 'voc_p36', displayName: '邻家暖心', model: 'breeze-tts-2' },
  ],
};

function createAudioFactory() {
  const created = [];
  const factory = () => {
    const listeners = new Map();
    const audio = {
      play: async () => { audio.playCalls = (audio.playCalls || 0) + 1; },
      pause: () => { audio.pauseCalls = (audio.pauseCalls || 0) + 1; },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      emit(type) { for (const listener of listeners.get(type) || []) listener(); },
    };
    created.push(audio);
    return audio;
  };
  factory.created = created;
  return factory;
}

test('start 只载入配置不展开设置页；open/close 切换面板与壳层标记', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  const panel = harness.nodes.get('#settings-panel');
  const app = harness.nodes.get('#app');
  assert.equal(panel.hidden, true, '启动不得自动打开设置页');
  assert.equal(harness.view.isOpen(), false);
  harness.view.open();
  assert.equal(panel.hidden, false);
  assert.equal(harness.view.isOpen(), true);
  assert.equal(app.classList.contains('settings-open'), true);
  assert.equal(harness.view.close(), true);
  assert.equal(panel.hidden, true);
  assert.equal(app.classList.contains('settings-open'), false);
  harness.view.destroy();
});

test('设置页只在“关闭 → 打开”时通知壳层，重复打开或未打开就关闭都不打扰导航', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  // 未打开就关闭（后台状态回调走这条路）：不得把用户从别的页面拽走
  assert.equal(harness.view.close(), true);
  assert.deepEqual(harness.pageCalls, []);
  harness.view.open();
  assert.deepEqual(harness.pageCalls, ['enter']);
  // 壳层已经切到设置页时再次调用 open（导航层回调）：只重渲染，不反向导航
  harness.view.open();
  assert.deepEqual(harness.pageCalls, ['enter']);
  harness.view.close();
  assert.deepEqual(harness.pageCalls, ['enter', 'leave']);
  assert.equal(harness.nodes.get('#sb-cog').focused, true, '关闭后焦点回到当初的入口');
  harness.view.close();
  assert.deepEqual(harness.pageCalls, ['enter', 'leave']);
  harness.view.destroy();
});

test('打开面板默认落在「模型与连接」，点导航可切页且互斥显示', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  harness.view.open();
  assert.equal(harness.pages.connection.hidden, false, '默认页是模型与连接');
  assert.equal(harness.pages.general.hidden, true);
  assert.equal(harness.navItems.connection.classList.contains('active'), true);
  const nav = harness.nodes.get('#settings-nav');
  await nav.trigger('click', { target: childTarget({ '[data-settings-page]': harness.navItems.general }) });
  assert.equal(harness.pages.general.hidden, false);
  assert.equal(harness.pages.connection.hidden, true);
  assert.equal(harness.navItems.general.classList.contains('active'), true);
  assert.equal(harness.navItems.connection.classList.contains('active'), false);
  // 未知页回落到 connection，不留空屏
  harness.view.setPage('nope');
  assert.equal(harness.pages.connection.hidden, false);
  harness.view.destroy();
});

test('页面内的「查看使用统计」链接走同一套切页路径', async () => {
  const sections = [];
  const harness = createSettingsHarness({ onSectionChange: id => sections.push(id) });
  await harness.view.start();
  harness.view.open();
  const link = element();
  link.dataset.settingsPageLink = 'usage';
  await harness.nodes.get('#settings-content').trigger('click', {
    target: childTarget({ '[data-settings-page-link]': link }),
  });
  assert.equal(harness.pages.usage.hidden, false, '链接切到使用统计页');
  assert.equal(harness.pages.connection.hidden, true);
  assert.equal(harness.navItems.usage.classList.contains('active'), true);
  assert.equal(sections.at(-1), 'usage');
  harness.view.destroy();
});

test('记忆分类仅在设置可见时通知，离开设置停用，重开恢复分类', async () => {
  const sections = [];
  const harness = createSettingsHarness({ onSectionChange: id => sections.push(id) });
  await harness.view.start();
  harness.view.setPage('memory');
  assert.deepEqual(sections, [], '隐藏时选分类不加载');
  harness.view.open();
  assert.equal(harness.pages.memory.hidden, false);
  assert.equal(sections.at(-1), 'memory');
  harness.view.setPage('general');
  assert.equal(sections.at(-1), 'general');
  harness.view.setPage('memory');
  harness.view.close();
  assert.equal(sections.at(-1), null);
  harness.view.open();
  assert.equal(sections.at(-1), 'memory');
  assert.equal(harness.pages.connection.hidden, true);
  harness.view.destroy();
});

test('保存设置后收起面板并记录 bootDone', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  harness.view.open();
  await harness.nodes.get('#boot-go').trigger('click');
  assert.equal(harness.storage.getItem('lunara.bootDone'), '1');
  assert.equal(harness.nodes.get('#settings-panel').hidden, true);
  assert.equal(harness.view.isOpen(), false);
  harness.view.destroy();
});

test('custom tts card：打开即载入配置，保存走同一端点且不带旧 key', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  // 载入：左列标出当前接口，右侧标题写明正在编辑谁、已保存
  assert.match(harness.nodes.get('#tts-custom-endpoint-list').innerHTML, /data-endpoint-id="custom" aria-current="true"/);
  assert.equal(harness.nodes.get('#tts-custom-editor-title').textContent, '编辑「OpenAI 兼容」');
  assert.equal(harness.nodes.get('#tts-custom-editor-state').textContent, '已保存');
  assert.equal(harness.nodes.get('#tts-pool-source').value, 'custom', '声音池来源默认是当前接口');
  assert.equal(harness.nodes.get('#tts-custom-url').value, 'https://tts.example/v1');
  assert.equal(harness.nodes.get('#tts-custom-model').value, 'tts-1');
  assert.match(harness.nodes.get('#tts-custom-key').placeholder, /留空保持不变/);
  assert.match(harness.nodes.get('#tts-custom-voice-editor').innerHTML, /alloy-cn/, '已保留声音必须出现在编辑器');
  // 改 model 后保存：payload 不含 apiKey（key 输入留空 = 保持不变）
  harness.nodes.get('#tts-custom-model').value = 'tts-2';
  await harness.nodes.get('#tts-custom-model').trigger('input');
  assert.equal(harness.nodes.get('#tts-custom-editor-state').textContent, '有未保存的修改');
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  const payload = harness.customConfigCalls.at(-1);
  assert.equal(payload.endpoint.id, 'custom');
  assert.equal(payload.endpoint.model, 'tts-2');
  assert.equal(payload.endpoint.baseUrl, 'https://tts.example/v1');
  assert.equal(payload.endpoint.apiKey, '');
  assert.match(harness.nodes.get('#tts-custom-status').textContent, /已保存接口/);
  assert.equal(harness.nodes.get('#tts-custom-editor-state').textContent, '已保存');
  harness.view.destroy();
});

test('免费声音：关闭时不在来源下拉；开启后出现并自动选中，获取结果标明来源且不带 model', async () => {
  const harness = createSettingsHarness({ discoveredVoices: [{ id: 'zh-CN-YunxiNeural', name: '云希' }] });
  await harness.view.start();
  await harness.view.open();
  assert.doesNotMatch(harness.nodes.get('#tts-pool-source').innerHTML, /free-edge/, '没开免费声音不能选它');
  await harness.nodes.get('#tts-free-agree').trigger('click');
  await flushAsync();
  assert.match(harness.nodes.get('#tts-pool-source').innerHTML, /value="free-edge">免费声音（Edge）/);
  assert.equal(harness.nodes.get('#tts-pool-source').value, 'free-edge', '刚开启时来源直接切到免费声音');
  const before = harness.customConfigCalls.length;
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.deepEqual(harness.customConfigCalls.slice(before), [['voices', 'free-edge']], '不先保存当前接口');
  assert.match(harness.nodes.get('#tts-custom-candidate-title').textContent, /免费声音（Edge）$/, '不分组的来源不显示计数');
  assert.match(harness.nodes.get('#tts-custom-candidate-list').innerHTML, /zh-CN-YunxiNeural/);
  assert.doesNotMatch(harness.nodes.get('#tts-custom-candidate-list').innerHTML, /tts-1/, '免费声音不记录接口 model');
  harness.view.destroy();
});

test('分组的发现结果：标题与提示分开计数「我的 / 热门」，个人声音带标记，入池不带分组字段', async () => {
  const harness = createSettingsHarness({
    discoveredVoices: [
      { id: 'voc_mine', name: '我的克隆', group: 'personal' },
      { id: 'voc_a', name: '幽兰影', group: 'trending' },
      { id: 'voc_b', name: '月下织梦人', group: 'trending' },
    ],
  });
  await harness.view.start();
  await harness.view.open();
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.match(harness.nodes.get('#tts-custom-candidate-title').textContent, /· 我的 1 · 热门 2$/);
  assert.match(harness.nodes.get('#tts-pool-status').textContent, /取到 3 个声音（我的 1 · 热门 2）/);
  const list = harness.nodes.get('#tts-custom-candidate-list').innerHTML;
  assert.match(list, /我的克隆 <span class="tts-custom-design-tag">我的<\/span>/);
  assert.doesNotMatch(list.split('幽兰影')[1].split('</div>')[0], /tts-custom-design-tag/, '热门声音不带标记');
  await harness.nodes.get('#tts-custom-candidate-list').trigger('change', { target: childTarget({ '[data-candidate-select]': { dataset: { candidateSelect: 'custom::voc_mine' } } }, { checked: true }) });
  await harness.nodes.get('#tts-custom-candidate-add').trigger('click');
  await harness.nodes.get('#tts-custom-save').trigger('click');
  await flushAsync();
  const saved = harness.customConfigCalls.at(-1).voices.find(voice => voice.sourceVoiceId === 'voc_mine');
  assert.ok(saved, '勾选的声音进了声音池');
  assert.equal('group' in saved, false);
  harness.view.destroy();
});

test('custom tts card：拉取的声音先进发现结果，勾选后才加入声音池（记下接口与 model）', async () => {
  const harness = createSettingsHarness({
    discoveredVoices: [{ id: 'alloy-cn', name: '中文合金' }, { id: 'nova-cn', name: '新星' }, { id: 'echo-cn', name: '回声' }],
  });
  await harness.view.start();
  await harness.view.open();
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.deepEqual(harness.customConfigCalls.at(-1), ['voices', 'custom'], '发现带上当前接口 id');
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  const panel = harness.nodes.get('#tts-custom-candidates');
  const list = harness.nodes.get('#tts-custom-candidate-list');
  assert.doesNotMatch(editor.innerHTML, /nova-cn|echo-cn/, '拉取不能直接混进声音池');
  assert.equal(panel.hidden, false);
  assert.match(harness.nodes.get('#tts-custom-candidate-title').textContent, /OpenAI 兼容/);
  assert.match(list.innerHTML, /nova-cn/);
  assert.match(list.innerHTML, /echo-cn/);
  assert.doesNotMatch(list.innerHTML, /alloy-cn/, '已在声音池的不再列出');
  assert.match(harness.nodes.get('#tts-pool-status').textContent, /取到 3 个.*1 个已在声音池/);
  const add = harness.nodes.get('#tts-custom-candidate-add');
  assert.equal(add.disabled, true, '没勾选时不能加入');

  await list.trigger('change', { target: childTarget({ '[data-candidate-select]': { dataset: { candidateSelect: 'custom::nova-cn' } } }, { checked: true }) });
  assert.match(add.textContent, /加入声音池（1）/);
  await add.trigger('click');
  assert.match(editor.innerHTML, /nova-cn/);
  assert.doesNotMatch(editor.innerHTML, /echo-cn/, '未勾选的留在发现结果');
  assert.doesNotMatch(list.innerHTML, /nova-cn/, '加入后从发现结果移走');
  assert.match(list.innerHTML, /echo-cn/);
  assert.match(harness.nodes.get('#tts-pool-status').textContent, /加入声音池 1 个/);

  harness.nodes.get('#tts-custom-manual').value = 'manual-voice';
  await harness.nodes.get('#tts-custom-manual-add').trigger('click');
  assert.match(editor.innerHTML, /manual-voice/, '手动填写是有意的单个加入，直接进声音池草稿');
  await harness.nodes.get('#tts-custom-save').trigger('click');
  const poolSave = harness.customConfigCalls.filter(call => call.voices).at(-1);
  assert.equal('endpoint' in poolSave, false, '保存声音池不顺带保存接口表单');
  const { voices } = poolSave;
  assert.deepEqual(voices.map(voice => [voice.endpointId, voice.sourceVoiceId, voice.model ?? null]), [
    ['custom', 'alloy-cn', null], ['custom', 'nova-cn', 'tts-1'], ['custom', 'manual-voice', 'tts-1'],
  ]);
  harness.view.destroy();
});

test('custom tts card：发现结果可筛选、全选、试听与收起；再次拉取替换上一批', async () => {
  const harness = createSettingsHarness({
    discoveredVoices: [{ id: 'nova-cn', name: '新星' }, { id: 'echo-cn', name: '回声' }, { id: 'sky-en', name: 'Sky' }],
  });
  await harness.view.start();
  await harness.view.open();
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  const list = harness.nodes.get('#tts-custom-candidate-list');
  const filter = harness.nodes.get('#tts-custom-candidate-filter');
  filter.value = '-cn';
  await filter.trigger('input');
  assert.doesNotMatch(list.innerHTML, /sky-en/);
  const selectAll = harness.nodes.get('#tts-custom-candidate-select-all');
  selectAll.checked = true;
  await selectAll.trigger('change');
  assert.match(harness.nodes.get('#tts-custom-candidate-count').textContent, /已选 2 \/ 共 3 个/);

  await list.trigger('click', { target: childTarget({ '[data-preview]': { dataset: { preview: 'custom::echo-cn' } } }) });
  assert.deepEqual(harness.previewCalls.at(-1), { endpointId: 'custom', voiceId: 'echo-cn', model: 'tts-1' }, '发现结果也能先试听');

  await harness.nodes.get('#tts-custom-candidate-add').trigger('click');
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  assert.match(editor.innerHTML, /nova-cn/);
  assert.match(editor.innerHTML, /echo-cn/);
  assert.doesNotMatch(editor.innerHTML, /sky-en/);

  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.match(list.innerHTML, /sky-en/, '再次拉取替换为新一批（已加入的不再列出）');
  assert.doesNotMatch(list.innerHTML, /nova-cn/);
  await harness.nodes.get('#tts-custom-candidate-close').trigger('click');
  assert.equal(harness.nodes.get('#tts-custom-candidates').hidden, true);
  assert.match(editor.innerHTML, /nova-cn/, '收起发现结果不影响声音池');
  harness.view.destroy();
});

test('custom tts card：声音池改动未保存时，池下方的保存按钮与提示一直提醒；保存后消失', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  const save = harness.nodes.get('#tts-custom-save');
  const dirty = harness.nodes.get('#tts-custom-dirty');
  assert.equal(dirty.hidden, true, '刚载入没有未保存改动');
  assert.equal(save.classList.contains('dirty'), false);
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  await editor.trigger('click', { target: childTarget({ '[data-remove]': { dataset: { remove: 'custom-breeze::voc_p36' } } }) });
  assert.equal(dirty.hidden, false);
  assert.match(dirty.textContent, /未保存/);
  assert.equal(save.classList.contains('dirty'), true);
  // 改名同样算改动；改回原样则不算
  await editor.trigger('input', { target: childTarget({ '[data-rename]': { dataset: { rename: 'custom::female-shaonv' } } }, { value: '小满的声音' }) });
  assert.match(dirty.textContent, /2 处/);
  await save.trigger('click');
  assert.equal(dirty.hidden, true, '保存后提示消失');
  assert.equal(save.classList.contains('dirty'), false);
  harness.view.destroy();
});

test('custom tts card：「保存接口」只保存连接信息，不提交声音池草稿', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  await editor.trigger('click', { target: childTarget({ '[data-remove]': { dataset: { remove: 'custom-breeze::voc_p36' } } }) });
  harness.nodes.get('#tts-custom-model').value = 'speech-02-hd';
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  const payload = harness.customConfigCalls.at(-1);
  assert.equal(payload.endpoint.id, 'custom');
  assert.equal(payload.endpoint.model, 'speech-02-hd');
  assert.equal('voices' in payload, false, '接口保存不动声音池');
  assert.match(harness.nodes.get('#tts-custom-status').textContent, /已保存接口「MiniMax」/);
  assert.equal(harness.nodes.get('#tts-custom-dirty').hidden, false, '声音池草稿改动仍保留、仍提示未保存');
  assert.doesNotMatch(editor.innerHTML, /voc_p36/);
  harness.view.destroy();
});

test('custom tts card：多个接口共用一个声音池；切换接口回填表单，不动其他接口的声音', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  const list = harness.nodes.get('#tts-custom-endpoint-list');
  assert.match(list.innerHTML, /MiniMax/);
  assert.match(list.innerHTML, /Breeze/);
  assert.match(list.innerHTML, /1 个声音/, '每项写明它名下已保存的声音数');
  assert.equal(harness.nodes.get('#tts-custom-protocol').value, 'minimax');
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  assert.match(editor.innerHTML, /MiniMax · speech-2\.8-hd/);
  assert.match(editor.innerHTML, /Breeze · breeze-tts-2/);

  await pickEndpoint(harness, 'custom-breeze');
  assert.match(list.innerHTML, /data-endpoint-id="custom-breeze" aria-current="true"/);
  assert.equal(harness.nodes.get('#tts-custom-editor-title').textContent, '编辑「Breeze」');
  assert.equal(harness.nodes.get('#tts-pool-source').value, 'custom-breeze', '声音池来源跟随切换到的已保存接口');
  assert.equal(harness.nodes.get('#tts-custom-protocol').value, 'breeze');
  assert.equal(harness.nodes.get('#tts-custom-url').value, 'https://api.breeze.blue');
  assert.equal(harness.nodes.get('#tts-custom-name').value, 'Breeze');
  assert.equal(harness.nodes.get('#tts-custom-url').placeholder, 'https://api.breeze.blue');
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  const payload = harness.customConfigCalls.at(-1);
  assert.equal(payload.endpoint.id, 'custom-breeze');
  assert.equal(payload.endpoint.protocol, 'breeze');
  assert.equal('voices' in payload, false);
  await harness.nodes.get('#tts-custom-save').trigger('click');
  const pool = harness.customConfigCalls.at(-1);
  assert.equal('endpoint' in pool, false);
  assert.deepEqual(pool.voices.map(voice => voice.endpointId), ['custom', 'custom-breeze'], '保存声音池时整个声音池原样提交');
  harness.view.destroy();
});

test('custom tts card：新增接口不带 id 保存，服务端生成的 id 成为当前接口', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  await harness.nodes.get('#tts-custom-endpoint-add').trigger('click');
  assert.equal(harness.nodes.get('#tts-custom-url').value, '', '新增接口从空表单开始');
  const list = harness.nodes.get('#tts-custom-endpoint-list');
  assert.match(list.innerHTML, /data-new aria-current="true".*未保存/, '新增中的接口单独成项、标明未保存');
  assert.equal(harness.nodes.get('#tts-custom-editor-title').textContent, '接入新接口');
  assert.equal(harness.nodes.get('#tts-custom-editor-state').textContent, '未保存');
  assert.equal(harness.nodes.get('#tts-custom-endpoint-remove').textContent, '放弃新增');
  assert.equal(harness.nodes.get('#tts-custom-endpoint-add').disabled, true, '一次只新增一个');
  harness.nodes.get('#tts-custom-name').value = 'relay';
  await harness.nodes.get('#tts-custom-name').trigger('input');
  assert.match(list.innerHTML, /relay/, '名称边填边出现在左列');
  harness.nodes.get('#tts-custom-protocol').value = 'openai';
  harness.nodes.get('#tts-custom-url').value = 'https://relay.example/v1';
  harness.nodes.get('#tts-custom-key').value = 'sk-relay';
  // 声音池的来源只能是已保存的接口：新增中的接口不会被「获取声音列表」悄悄存下
  assert.equal(harness.nodes.get('#tts-pool-source').value, 'custom');
  const before = harness.customConfigCalls.length;
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.deepEqual(harness.customConfigCalls.slice(before), [['voices', 'custom']], '只从所选来源获取，不保存表单');
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  const saveCall = harness.customConfigCalls.find(call => call.endpoint?.name === 'relay');
  assert.equal('id' in saveCall.endpoint, false, '新增接口由服务端生成 id');
  assert.equal(saveCall.endpoint.apiKey, 'sk-relay');
  assert.match(list.innerHTML, /data-endpoint-id="custom-relay" aria-current="true"/);
  assert.equal(harness.nodes.get('#tts-pool-source').value, 'custom-relay', '保存后声音池来源切到新接口');
  assert.equal(harness.nodes.get('#tts-custom-key').value, '', '保存后清空 key 输入');
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.deepEqual(harness.customConfigCalls.at(-1), ['voices', 'custom-relay'], '发现用新生成的接口 id');
  assert.match(harness.nodes.get('#tts-custom-candidate-list').innerHTML, /data-preview="custom-relay::nova-cn"/, '新接口发现的声音归属新接口');
  assert.match(harness.nodes.get('#tts-custom-candidate-title').textContent, /relay/);
  harness.view.destroy();
});

test('custom tts card：删除接口先页内确认并说明影响，确认后只移除它和它的声音', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  await pickEndpoint(harness, 'custom-breeze');
  await harness.nodes.get('#tts-custom-endpoint-remove').trigger('click');
  const confirmBox = harness.nodes.get('#tts-custom-remove-confirm');
  assert.equal(confirmBox.hidden, false);
  assert.match(harness.nodes.get('#tts-custom-remove-text').textContent, /Breeze.*1 个保留声音.*重新选择/);
  assert.equal(harness.customConfigCalls.some(call => call[0] === 'remove'), false, '确认前不删除');
  await harness.nodes.get('#tts-custom-remove-no').trigger('click');
  assert.equal(confirmBox.hidden, true);

  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.equal(harness.nodes.get('#tts-custom-candidates').hidden, false);
  await harness.nodes.get('#tts-custom-endpoint-remove').trigger('click');
  await harness.nodes.get('#tts-custom-remove-yes').trigger('click');
  await flushAsync();
  assert.deepEqual(harness.customConfigCalls.at(-1), ['remove', 'custom-breeze']);
  assert.equal(confirmBox.hidden, true);
  assert.equal(harness.nodes.get('#tts-custom-editor-title').textContent, '编辑「MiniMax」');
  assert.equal(harness.nodes.get('#tts-pool-source').value, 'custom', '来源接口被删后退回剩下的接口');
  assert.doesNotMatch(harness.nodes.get('#tts-custom-endpoint-list').innerHTML, /Breeze/);
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  assert.doesNotMatch(editor.innerHTML, /voc_p36/);
  assert.match(editor.innerHTML, /female-shaonv/, '其他接口的声音保留');
  assert.match(harness.nodes.get('#tts-custom-status').textContent, /已删除接口「Breeze」及其 1 个保留声音/);
  assert.equal(harness.nodes.get('#tts-custom-candidates').hidden, true, '属于被删接口的发现结果一并清掉');
  harness.view.destroy();
});

test('custom tts card：说明文字与占位按所选协议切换', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  const note = harness.nodes.get('#tts-custom-note');
  assert.match(note.textContent, /audio\/speech/);
  assert.equal(note.hidden, false);
  harness.nodes.get('#tts-custom-protocol').value = 'minimax';
  await harness.nodes.get('#tts-custom-protocol').trigger('change');
  assert.match(note.textContent, /v1\/t2a_v2/);
  assert.match(note.textContent, /v1\/get_voice/);
  assert.equal(harness.nodes.get('#tts-custom-url').placeholder, 'https://api.minimax.cn');
  assert.match(harness.nodes.get('#tts-custom-model').placeholder, /speech-2\.8-hd/);
  harness.nodes.get('#tts-custom-protocol').value = 'breeze';
  await harness.nodes.get('#tts-custom-protocol').trigger('change');
  assert.match(note.textContent, /v1\/text-to-speech/);
  assert.equal(harness.nodes.get('#tts-custom-url').placeholder, 'https://api.breeze.blue');
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  assert.equal(harness.customConfigCalls.at(-1).endpoint.protocol, 'breeze', '保存带上选择器里的协议');
  harness.view.destroy();
});

test('custom tts card：新增接口按粘贴的地址预选协议，手选后不再覆盖', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  const protocol = harness.nodes.get('#tts-custom-protocol');
  const url = harness.nodes.get('#tts-custom-url');
  const paste = async value => { url.value = value; await url.trigger('input'); };
  await paste('https://api.breeze.blue');
  assert.equal(protocol.value, 'openai', '已保存的接口保留原协议');

  await harness.nodes.get('#tts-custom-endpoint-add').trigger('click');
  await paste('https://api.minimax.cn/v1/t2a_v2');
  assert.equal(protocol.value, 'minimax');
  await paste('https://dashscope.aliyuncs.com');
  assert.equal(protocol.value, 'recipe:qwen-tts');
  assert.equal(harness.nodes.get('#tts-custom-models-btn').hidden, true, '配方接口没有模型列表');
  assert.match(harness.nodes.get('#tts-custom-note').textContent, /试合成/);
  await paste('https://tts.example.com/v1');
  assert.equal(protocol.value, 'recipe:qwen-tts', '认不出的地址不动');

  protocol.value = 'openai';
  await protocol.trigger('change');
  assert.equal(harness.nodes.get('#tts-custom-models-btn').hidden, false);
  await paste('https://api.elevenlabs.io');
  assert.equal(protocol.value, 'openai', '手选过的协议不再被覆盖');
  harness.view.destroy();
});

test('custom tts card：已保存的预设配方接口回显到对应选项，保存仍按 recipe 协议', async () => {
  const harness = createSettingsHarness({
    customConfig: {
      endpoints: [{ id: 'custom-qwen', name: '千问', protocol: 'recipe', presetId: 'qwen-tts', baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-tts-flash', hasKey: true, configured: true }],
      voices: [],
    },
  });
  await harness.view.start();
  await harness.view.open();
  assert.equal(harness.nodes.get('#tts-custom-protocol').value, 'recipe:qwen-tts');
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  await flushAsync();
  const saved = harness.customConfigCalls.at(-1).endpoint;
  assert.equal(saved.protocol, 'recipe');
  assert.equal('recipe' in saved, false, '只改连接信息时不重发配方，服务端保留已保存的那份');
  harness.view.destroy();
});

test('custom tts card：配方没试合成通过时，「保存接口」和「获取声音列表」都不保存这份配方', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  await harness.nodes.get('#tts-custom-endpoint-add').trigger('click');
  const protocol = harness.nodes.get('#tts-custom-protocol');
  protocol.value = 'recipe';
  await protocol.trigger('change');
  harness.nodes.get('#tts-custom-url').value = 'https://tts.example.com';
  const json = harness.nodes.get('#tts-recipe-json');
  json.value = JSON.stringify({ version: 1, synth: { method: 'POST', path: '/v1/speech', body: { text: '{text}' } }, audio: { kind: 'binary' } });
  await json.trigger('input');
  const before = harness.customConfigCalls.length;
  await harness.nodes.get('#tts-custom-save-endpoint').trigger('click');
  await flushAsync();
  assert.equal(harness.customConfigCalls.length, before, '没有保存请求');
  assert.match(harness.nodes.get('#tts-custom-status').textContent, /先在下方「接口格式」里试合成/);
  assert.equal(harness.nodes.get('#tts-custom-editor-state').textContent, '未保存');
  await harness.nodes.get('#tts-custom-voices-btn').trigger('click');
  await flushAsync();
  assert.deepEqual(harness.customConfigCalls.slice(before), [['voices', 'custom']],
    '获取声音列表只读已保存的来源接口，不能绕过门槛把配方存下');
  harness.view.destroy();
});

test('custom tts card：待选行可试听，播放中再点是停止，结束后复原', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  const click = () => editor.trigger('click', { target: childTarget({ '[data-preview]': { dataset: { preview: 'custom::alloy-cn' } } }) });
  await click();
  assert.deepEqual(harness.previewCalls, [{ endpointId: 'custom', voiceId: 'alloy-cn' }]);
  // 试听用已保存的连接信息，不顺带保存接口表单或声音池草稿
  assert.equal(harness.customConfigCalls.some(call => call.endpoint || call.voices), false);
  const audio = harness.audioFactory.created.at(-1);
  assert.equal(audio.playCalls, 1);
  assert.match(editor.innerHTML, /停止/, '播放中的按钮应变为停止');
  // 同一把声音重复试听走会话内缓存，不再发预览请求；播放中再点先停止
  await click();
  assert.equal(harness.previewCalls.length, 1);
  assert.equal(harness.audioFactory.created.length, 1, '停止不新建音频');
  assert.equal(harness.audioFactory.created[0].pauseCalls, 1);
  assert.match(editor.innerHTML, /试听/, '播放中再点是停止');
  // 缓存命中重播：不新发请求，结束后复原
  await click();
  assert.match(editor.innerHTML, /停止/);
  harness.audioFactory.created.at(-1).emit('ended');
  assert.match(editor.innerHTML, /试听/);
  assert.doesNotMatch(editor.innerHTML, /停止/);
  harness.view.destroy();
});

test('custom tts card：试听别的接口的声音带上它的接口与 model，不改写当前表单的接口', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  const before = harness.customConfigCalls.length;
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  await editor.trigger('click', { target: childTarget({ '[data-preview]': { dataset: { preview: 'custom-breeze::voc_p36' } } }) });
  assert.deepEqual(harness.previewCalls, [{ endpointId: 'custom-breeze', voiceId: 'voc_p36', model: 'breeze-tts-2' }]);
  assert.equal(harness.customConfigCalls.length, before, '当前编辑的是 MiniMax，试听 Breeze 声音不保存表单');
  harness.view.destroy();
});

test('custom tts card：试听失败如实报告，不进入播放状态', async () => {
  const harness = createSettingsHarness({ previewResult: { error: '自定义 TTS 接口未配置完整（需要 URL 与 API key）' } });
  await harness.view.start();
  await harness.view.open();
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  await editor.trigger('click', { target: childTarget({ '[data-preview]': { dataset: { preview: 'custom::alloy-cn' } } }) });
  assert.match(harness.nodes.get('#tts-pool-status').textContent, /试听失败：自定义 TTS 接口未配置完整/);
  assert.doesNotMatch(editor.innerHTML, /停止/);
  harness.view.destroy();
});

test('custom tts card：筛选（含接口名）、全选与批量移除只作用于待选草稿', async () => {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  const toolbar = harness.nodes.get('#tts-custom-voice-toolbar');
  assert.equal(toolbar.hidden, false, '有待选声音时显示工具栏');
  assert.match(harness.nodes.get('#tts-custom-voice-count').textContent, /共 2 个/);

  // 筛选按接口名也能命中
  const filter = harness.nodes.get('#tts-custom-voice-filter');
  filter.value = 'breeze';
  await filter.trigger('input');
  assert.match(editor.innerHTML, /voc_p36/);
  assert.doesNotMatch(editor.innerHTML, /female-shaonv/);

  // 全选只作用于筛出的行
  const selectAll = harness.nodes.get('#tts-custom-select-all');
  selectAll.checked = true;
  await selectAll.trigger('change');
  assert.match(harness.nodes.get('#tts-custom-voice-count').textContent, /已选 1 \/ 共 2 个/);

  // 清空筛选：勾选保留，重渲染不丢
  filter.value = '';
  await filter.trigger('input');
  assert.match(editor.innerHTML, /checked/, '重渲染后勾选仍在');
  const removeButton = harness.nodes.get('#tts-custom-remove-selected');
  assert.equal(removeButton.disabled, false);
  assert.match(removeButton.textContent, /移除所选（1）/);

  // 批量移除只动勾选的声音；草稿变更要保存才生效
  await removeButton.trigger('click');
  assert.doesNotMatch(editor.innerHTML, /voc_p36/);
  assert.match(editor.innerHTML, /female-shaonv/, '未勾选的声音不受批量移除影响');
  assert.match(harness.nodes.get('#tts-pool-status').textContent, /移除 1 个声音/);
  await harness.nodes.get('#tts-custom-save').trigger('click');
  const payload = harness.customConfigCalls.filter(item => item.voices).at(-1);
  assert.deepEqual(payload.voices.map(voice => voice.sourceVoiceId), ['female-shaonv']);
  harness.view.destroy();
});

test('custom tts card：单行移除走同一入口，清空后工具栏隐藏', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  await editor.trigger('click', { target: childTarget({ '[data-remove]': { dataset: { remove: 'custom::alloy-cn' } } }) });
  assert.match(editor.innerHTML, /还没有保留声音/);
  assert.equal(harness.nodes.get('#tts-custom-voice-toolbar').hidden, true);
  assert.equal(harness.nodes.get('#tts-custom-remove-selected').disabled, true);
  harness.view.destroy();
});

test('custom tts card：改名经事件委托写回草稿并随保存提交', async () => {
  const harness = createSettingsHarness();
  await harness.view.start();
  await harness.view.open();
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  await editor.trigger('input', {
    target: childTarget(
      { '[data-rename]': { dataset: { rename: 'custom::alloy-cn' } } },
      { value: '夜里读信的声音' },
    ),
  });
  await harness.nodes.get('#tts-custom-save').trigger('click');
  const payload = harness.customConfigCalls.at(-1);
  assert.equal(payload.voices[0].displayName, '夜里读信的声音');
  harness.view.destroy();
});

// ---- 歌曲打标卡片（route-song-tagging-through-user-endpoint）----

// 打开面板后载入是异步的（config + status 两次 await）：冲刷微任务/定时器后再断言。
const flushAsync = () => new Promise(resolve => setImmediate(resolve));

test('the song-tag card loads the auto switch and coverage from the registry era', async () => {
  const harness = createSettingsHarness();
  await harness.view.open();
  await flushAsync();
  assert.equal(harness.nodes.get('#song-tag-auto').checked, true);
  const coverage = harness.nodes.get('#song-tag-coverage').textContent;
  assert.match(coverage, /候选池 270 首/);
  assert.match(coverage, /已打标 3/);
  assert.match(coverage, /deepseek\/deepseek-flash/);
  assert.match(coverage, /跟随使用中/);
});

test('saving the song-tag card sends only the auto switch; backfill stays bounded', async () => {
  const harness = createSettingsHarness();
  await harness.view.open();
  await flushAsync();
  harness.nodes.get('#song-tag-auto').checked = false;
  await harness.nodes.get('#song-tag-save').trigger('click');
  await flushAsync();
  const saved = harness.customConfigCalls.find(([kind]) => kind === 'song-tag');
  assert.deepEqual(saved[1], { auto: false }, '打标卡不再携带任何端点字段');
  assert.match(harness.nodes.get('#song-tag-status').textContent, /已保存/);

  await harness.nodes.get('#song-tag-backfill').trigger('click');
  const backfill = harness.customConfigCalls.find(([kind]) => kind === 'song-tag-backfill');
  assert.equal(backfill[1].limit, 100, '手动补全必须有界');
  assert.match(harness.nodes.get('#song-tag-status').textContent, /已入队 100 首/);
});

test('without any active model the card says the free metadata path is what remains', async () => {
  const harness = createSettingsHarness({
    songTagConfig: { auto: false },
    songTagStatus: { ok: true, auto: false, candidatePool: 270, activeModel: null,
      coverage: { tagged: 0, placeholders: 0, untagged: 270, pct: 0 } },
  });
  await harness.view.open();
  await flushAsync();
  const coverage = harness.nodes.get('#song-tag-coverage').textContent;
  assert.match(coverage, /未接入任何模型/);
  assert.match(coverage, /免费字段/);
  assert.equal(harness.nodes.get('#song-tag-auto').checked, false);
});

// ---- 按描述设计声音 ----

async function openBreezeDesign(options = {}) {
  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS, ...options });
  await harness.view.start();
  await harness.view.open();
  await pickEndpoint(harness, 'custom-breeze');
  await harness.nodes.get('#tts-custom-design-toggle').trigger('click');
  await flushAsync();
  return harness;
}

test('设计声音：只对声明了设计能力的接口显示，费用说明与候选数上限跟随接口', async () => {
  const plain = createSettingsHarness();
  await plain.view.start();
  await plain.view.open();
  assert.equal(plain.nodes.get('#tts-custom-design-toggle').hidden, true, 'openai 兼容接口没有设计入口');
  assert.equal(plain.nodes.get('#tts-custom-design').hidden, true);
  plain.view.destroy();

  const harness = createSettingsHarness({ customConfig: TWO_ENDPOINTS });
  await harness.view.start();
  await harness.view.open();
  const toggle = harness.nodes.get('#tts-custom-design-toggle');
  assert.equal(toggle.hidden, false);
  assert.equal(harness.nodes.get('#tts-custom-design').hidden, true, '默认收起');
  await toggle.trigger('click');
  await flushAsync();
  assert.equal(harness.nodes.get('#tts-custom-design').hidden, false);
  assert.match(harness.nodes.get('#tts-custom-design-cost').textContent, /MiniMax 按次计费/);
  assert.equal((harness.nodes.get('#tts-custom-design-count').innerHTML.match(/<option/g) || []).length, 1);
  await pickEndpoint(harness, 'custom-breeze');
  assert.match(harness.nodes.get('#tts-custom-design-cost').textContent, /Breeze 按字计费/);
  assert.equal((harness.nodes.get('#tts-custom-design-count').innerHTML.match(/<option/g) || []).length, 3);
  harness.view.destroy();
});

test('设计声音：从伙伴人设起草只填进描述框，不触发生成', async () => {
  const harness = await openBreezeDesign();
  assert.match(harness.nodes.get('#tts-custom-design-person').innerHTML, /小满/);
  harness.nodes.get('#tts-custom-design-person').value = 'xm';
  await harness.nodes.get('#tts-custom-design-draft').trigger('click');
  await flushAsync();
  assert.equal(harness.nodes.get('#tts-custom-design-description').value, '二十岁出头的女声，清亮、语速偏慢');
  assert.deepEqual(harness.customConfigCalls.filter(call => Array.isArray(call)).map(call => call[0]).filter(kind => kind !== 'persons'), ['draft']);
  assert.match(harness.nodes.get('#tts-custom-status').textContent, /不会发给 TTS 厂商/);
  harness.view.destroy();
});

test('设计声音：候选进发现结果并标"设计"，试听直接播放厂商样音、不再合成', async () => {
  const harness = await openBreezeDesign();
  harness.nodes.get('#tts-custom-design-description').value = '清亮的年轻女声';
  harness.nodes.get('#tts-custom-design-preview').value = '晚上好';
  harness.nodes.get('#tts-custom-design-name').value = '小满';
  harness.nodes.get('#tts-custom-design-count').value = '2';
  await harness.nodes.get('#tts-custom-design-run').trigger('click');
  await flushAsync();
  const design = harness.customConfigCalls.find(call => Array.isArray(call) && call[0] === 'design');
  assert.deepEqual(design[1], { endpointId: 'custom-breeze', description: '清亮的年轻女声', previewText: '晚上好', count: 2 });
  const list = harness.nodes.get('#tts-custom-candidate-list');
  assert.match(list.innerHTML, /设计/);
  assert.match(list.innerHTML, /小满 1/);
  assert.match(list.innerHTML, /gen_b/);
  assert.doesNotMatch(harness.nodes.get('#tts-custom-voice-editor').innerHTML, /gen_a/, '设计候选不直接进声音池');

  await list.trigger('click', { target: childTarget({ '[data-preview]': { dataset: { preview: 'custom-breeze::gen_a' } } }) });
  assert.equal(harness.previewCalls.length, 0, '试听设计候选不再请求合成');
  assert.equal(harness.audioFactory.created.length, 1);
  harness.view.destroy();
});

test('设计声音：加入声音池时先转正，用永久 id；转正失败的留在发现结果并说明原因', async () => {
  const harness = await openBreezeDesign({ activateResults: { gen_b: { error: '账号的私人音色名额已满' } } });
  harness.nodes.get('#tts-custom-design-description').value = '清亮的年轻女声';
  harness.nodes.get('#tts-custom-design-name').value = '小满';
  await harness.nodes.get('#tts-custom-design-run').trigger('click');
  await flushAsync();
  const list = harness.nodes.get('#tts-custom-candidate-list');
  const selectAll = harness.nodes.get('#tts-custom-candidate-select-all');
  selectAll.checked = true;
  await selectAll.trigger('change');
  await harness.nodes.get('#tts-custom-candidate-add').trigger('click');
  await flushAsync();
  const activations = harness.customConfigCalls.filter(call => Array.isArray(call) && call[0] === 'activate').map(call => call[1]);
  assert.deepEqual(activations[0], { endpointId: 'custom-breeze', generatedId: 'gen_a', name: '小满 1', description: '清亮的年轻女声', model: 'breeze-tts-2' });
  const editor = harness.nodes.get('#tts-custom-voice-editor');
  assert.match(editor.innerHTML, /voc_gen_a/);
  assert.doesNotMatch(editor.innerHTML, /gen_b/);
  assert.match(list.innerHTML, /gen_b/, '转正失败的候选留在发现结果');
  assert.doesNotMatch(list.innerHTML, /gen_a/);
  assert.match(harness.nodes.get('#tts-pool-status').textContent, /名额已满/);

  await harness.nodes.get('#tts-custom-save').trigger('click');
  const { voices } = harness.customConfigCalls.filter(call => call.voices).at(-1);
  const added = voices.find(voice => voice.sourceVoiceId === 'voc_gen_a');
  assert.deepEqual(added, { endpointId: 'custom-breeze', sourceVoiceId: 'voc_gen_a', displayName: '小满 1', model: 'breeze-tts-2' }, '保存的声音不带设计临时字段');
  harness.view.destroy();
});

test('语音接口：所选已保存接口显示最近发声失败，摘要点明超时多半卡在排队；新增中的接口不显示', async () => {
  const at = new Date(2026, 9, 28, 14, 3).getTime();
  const harness = createSettingsHarness({
    failures: {
      custom: [
        { at, endpointId: 'custom', reason: 'timeout', phase: 'read', elapsedMs: 30000, queueMs: 24100, requestMs: 1200, readMs: 4700, retryWaitMs: 0, attempts: 1, statuses: [], fallbackEndpointId: null },
        { at, endpointId: 'custom', reason: 'rate-limited', phase: 'request', elapsedMs: 4900, queueMs: 0, requestMs: 900, readMs: 0, retryWaitMs: 4000, attempts: 3, statuses: [429, 429, 429], fallbackEndpointId: 'free-edge' },
        { at, endpointId: 'custom', reason: 'timeout', phase: 'queue', elapsedMs: 30000, queueMs: 30000, requestMs: 0, retryWaitMs: 0, attempts: 0, statuses: [], fallbackEndpointId: null },
      ],
    },
  });
  await harness.view.start();
  await harness.view.open();
  await flushAsync();
  assert.ok(harness.failureCalls.includes('custom'));
  assert.equal(harness.nodes.get('#tts-endpoint-failures').hidden, false);
  const summary = harness.nodes.get('#tts-endpoint-failures-summary').textContent;
  assert.match(summary, /最近 3 次：超时 2、并发超限 1/);
  assert.match(summary, /超时多半卡在排队（1\/2）/);
  const list = harness.nodes.get('#tts-endpoint-failures-list').innerHTML;
  assert.match(list, /10-28 14:03/);
  assert.match(list, /超时 · 卡在排队/);
  assert.match(list, /超时 · 卡在接收音频/);
  assert.match(list, /共 30\.0 秒 · 排队 24\.1 秒 · 等响应 1\.2 秒 · 接收音频 4\.7 秒/);
  assert.match(list, /并发超限 · 等厂商响应 · 已由免费声音（Edge）代读/);
  assert.match(list, /共 4\.9 秒 · 等响应 0\.9 秒 · 重试等待 4\.0 秒 · 尝试 3 次 · HTTP 429×3/);
  assert.match(list, /共 30\.0 秒 · 排队 30\.0 秒/);
  const calls = harness.failureCalls.length;
  await harness.nodes.get('#tts-endpoint-failures-refresh').trigger('click');
  await flushAsync();
  assert.equal(harness.failureCalls.length, calls + 1, '刷新重新读取');
  await harness.nodes.get('#tts-custom-endpoint-add').trigger('click');
  assert.equal(harness.nodes.get('#tts-endpoint-failures').hidden, true, '新增中的接口没有记录可看');
  harness.view.destroy();
});

test('语音接口：超时多半卡在接收音频时，摘要点明厂商已回应、音频没传完', async () => {
  const at = new Date(2026, 9, 28, 2, 6).getTime();
  const row = { at, endpointId: 'custom', reason: 'timeout', phase: 'read', elapsedMs: 30000, queueMs: 0, requestMs: 900, readMs: 29100, retryWaitMs: 0, attempts: 1, statuses: [200], fallbackEndpointId: null };
  const harness = createSettingsHarness({ failures: { custom: [row, { ...row, requestMs: 1500, readMs: 28500 }] } });
  await harness.view.start();
  await harness.view.open();
  await flushAsync();
  const summary = harness.nodes.get('#tts-endpoint-failures-summary').textContent;
  assert.match(summary, /超时多半卡在接收音频（2\/2）/);
  assert.doesNotMatch(summary, /卡在排队/);
  harness.view.destroy();
});

test('语音接口：没有失败记录时如实说明；读取失败显示原因', async () => {
  const empty = createSettingsHarness();
  await empty.view.start();
  await empty.view.open();
  await flushAsync();
  assert.equal(empty.nodes.get('#tts-endpoint-failures-summary').textContent, '还没有失败记录。');
  empty.view.destroy();
  const broken = createSettingsHarness({ failures: new Error('服务不可用') });
  await broken.view.start();
  await broken.view.open();
  await flushAsync();
  assert.match(broken.nodes.get('#tts-endpoint-failures-summary').textContent, /读取失败记录失败：服务不可用/);
  broken.view.destroy();
});
