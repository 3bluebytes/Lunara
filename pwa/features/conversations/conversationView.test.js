import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createAppState } from '../../core/appState.js';
import { createConversationView, validateRoomTitle } from './conversationView.js';

// render 在换会话后把滚动位置交给 rAF；Node 里没有它，和 hostManagementView.test 用同一手法。
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);

function domElement({ value = '', query = {} } = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    value,
    disabled: false,
    hidden: false,
    inert: false,
    open: false,
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    parentElement: { hidden: false },
    dataset: {},
    style: {},
    classList: {
      toggle(name, force) { if (force === false) classes.delete(name); else if (force === true || !classes.has(name)) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name),
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    querySelector(selector) { return query[selector] || null; },
    querySelectorAll(selector) { return query[selector] || []; },
    getBoundingClientRect() { return { top: 10, bottom: 40, left: 0, right: 200, width: 200, height: 30 }; },
    setAttribute() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() { this.focused = true; },
    async trigger(type, overrides = {}) {
      const event = { target: this, currentTarget: this, preventDefault() {}, ...overrides };
      return Promise.all([...(listeners.get(type) || [])].map(listener => listener(event)));
    },
  };
}

function createHarness({ sidebarPresentation = null, rooms: roomsOverride, runtimeState: runtimeOverride = null, turns = [], shellSidebar = '', chat = { pending: false, composing: [] }, persons = [
  { id: 'lunara', displayName: 'Lunara', kind: 'root' },
  { id: 'radiohost-a', displayName: '夜航', kind: 'radiohost' },
] } = {}) {
  const checkedPeople = [{ value: 'lunara' }, { value: 'radiohost-a' }];
  const selectors = [
    '#nav-today', '#today-panel', '#app', '#listening-panel', '#main-content',
    '#nav-conversations', '#nav-create', '#create-launcher', '#create-room-option', '#radiohost-cast-new', '#nav-account', '#nav-people', '.conversation-sidebar', '#sidebar-close', '#people-list', '#people-list-heading', '#people-list-create',
    '#nav-settings', '#settings-panel',
    '#room-menu', '#room-picker-title', '#room-picker-submit', '#room-name', '#room-picker-error',
    '#room-person-choices', '#room-picker', '#room-picker-form', '#compose-input', '#chat-scroll',
    '#room-listen', '#room-settings', '#room-options', '#room-rename', '#room-options-after', '#room-member-settings', '#room-model-select', '#room-model-effort',
    // 会话列表与管理入口
    '#room-list', '.room-search-label', '#room-list-heading', '#room-archived', '#room-list-create',
    '#sb-undo-toast', '#sb-undo-toast-text', '#sb-undo-toast-undo', '#sb-undo-toast-view', '#sb-undo-toast-close',
    '#room-rename-dialog', '#room-rename-form', '#room-rename-input', '#room-rename-error',
    '#room-delete-confirm', '#room-delete-lead', '#room-delete-error', '#room-delete-cancel', '#room-delete-confirm-button',
    // 听歌列的旁白块：真的有过串词才出现。
    '#listening-narration', '#listening-narration-label', '#listening-intro', '#listening-intro-text', '#listening-intro-source',
    '#listening-hero',
    // 听歌列渲染需要锚点：没有它们，render 只会在选中真实聊天时半途中断。
    '#room-title', '#room-members', '#chat-list', '#room-cancel', '#room-history',
    '#room-invite', '#player-cover', '#player-person', '#player-source', '#player-switch-cancel',
    '#room-composing', '#room-composing-text',
  ];
  const nodes = new Map(selectors.map(selector => [selector, domElement()]));
  // 旁白块里的发丝线：只在真有串词（有出处）时出现，要有节点才能断言。
  nodes.set('#listening-intro', domElement({ query: { '.listening-narration-rule': domElement() } }));
  nodes.set('#room-person-choices', domElement({ query: { 'input:checked': checkedPeople } }));
  const menuItems = new Map(['pin', 'rename', 'unread', 'archive', 'delete'].map(action => {
    const item = domElement();
    item.dataset.menuAction = action;
    return [action, item];
  }));
  const menu = domElement({ query: Object.fromEntries([...menuItems.entries()].flatMap(([action, item]) => [
    [`[data-menu-action="${action}"]`, item], [`[data-menu-action="${action}"]:not([hidden])`, item],
  ])) });
  nodes.set('#room-row-menu', menu);
  nodes.set('#room-row-menu-pin', domElement());
  nodes.set('#room-row-menu-unread', domElement());
  nodes.set('#room-row-menu-archive', domElement());
  const rootRuntime = {
    activeListeningSessionId: 'conversation:primary',
    queue: [{ queueItemId: 'current-1', songId: 'song-1' }],
    currentIndex: 0,
    currentSongId: 'song-1',
    txn: { queueItemId: 'current-1', correlationId: 'txn-1' },
    suspendedSessions: {},
  };
  const store = createAppState({ sessionId: 'conversation:primary', virtualPersons: persons, runtimeState: runtimeOverride || rootRuntime });
  let room = { sessionId: 'conversation:primary', title: 'Lunara', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' };
  const createCalls = [];
  const apiCalls = [];
  const playbackCalls = [];
  const controllerCalls = [];
  let nextSession = 0;
  const localView = () => ({ draft: '', scroll: null, turns, loaded: true, unread: false, hasOlder: false });
  const controller = {
    snapshot: () => {
      const sessionId = store.getState().sessionId;
      const list = roomsOverride || [room];
      return {
        rooms: list,
        room: roomsOverride ? (list.find(item => item.sessionId === sessionId) || null) : room,
        sessionId,
        local: localView(),
        pending: chat.pending,
        composing: chat.composing,
      };
    },
    stateFor: () => ({ draft: '', scroll: null, turns, loaded: true, unread: false, hasOlder: false }),
    person: id => persons.find(person => person.id === id) || null,
    roomName: value => value?.title || '新聊天',
    saveView() {},
    updateRoomById: async (sid, input) => { controllerCalls.push(['update', sid, input]); },
    deleteRoomById: async sid => { controllerCalls.push(['delete', sid]); },
    select: async sid => { controllerCalls.push(['select', sid]); },
    create: async input => {
      createCalls.push(input);
      room = { ...input, sessionId: `conversation:new-${++nextSession}`, activeVirtualPersonId: input.memberIds[0] };
      store.update({ sessionId: room.sessionId }, { type: 'conversation.selected' });
      return room;
    },
    subscribe: () => () => {},
  };
  const apiClient = { post: async (path, body) => { apiCalls.push([path, body]); return { ok: true }; } };
  const playbackRuntimeClient = { listenWith: async (sessionId, delivery) => playbackCalls.push([sessionId, delivery]) };
  const documentLike = {
    body: { classList: { remove() {}, toggle() {}, contains: () => false } },
    documentElement: {},
    defaultView: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      getComputedStyle: () => ({ getPropertyValue: token => (token === '--shell-sidebar' ? shellSidebar : '') }),
    },
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const viewStore = { getState: store.getState, subscribe: () => () => {} };
  const settingsOpenCalls = [], settingsCloseCalls = [], errors = [], lockCalls = [], pendingCalls = [];
  const view = createConversationView({
    controller, store: viewStore, apiClient, playbackRuntimeClient, documentLike, sidebarPresentation,
    chatController: { replaceTranscript() {} }, chatInputView: { setLocked: (locked, message, options = {}) => lockCalls.push([locked, message, ...(options.source ? [{ source: options.source }] : [])]),
      setPending: (pending, message) => pendingCalls.push([pending, message]) },
    onSettingsOpen: () => settingsOpenCalls.push('open'),
    onSettingsClose: () => settingsCloseCalls.push('close'),
    onError: error => errors.push(error),
  }).init();
  return { view, nodes, menu, menuItems, controller, persons, rootRuntime, store, createCalls, apiClient, apiCalls, playbackCalls, controllerCalls, settingsOpenCalls, settingsCloseCalls, errors, lockCalls, pendingCalls };
}

test('a new turn follows the bottom even after the reader scrolled up; re-render keeps place', async () => {
  const turns = [{ turnId: 'u1', role: 'user', text: '第一句', sequence: 1, createdAt: 1 }];
  const h = createHarness({ turns });
  const scroll = h.nodes.get('#chat-scroll');
  scroll.scrollHeight = 1000; scroll.clientHeight = 300; scroll.scrollTop = 120;
  h.view.render();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(scroll.scrollTop, 1000, 'first render follows the newest turn');

  scroll.scrollTop = 120;
  h.view.render();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(scroll.scrollTop, 120, 'a plain re-render does not steal the reader position');

  turns.push({ turnId: 'a1', role: 'assistant', text: '新的回答', sequence: 2, createdAt: 2 });
  h.view.render();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(scroll.scrollTop, 1000, 'new content pulls the pane back to the bottom');
  h.view.destroy();
});

test('D host identity appears once in the heading; group and pinned rows retain identity dots', () => {
  const rooms = [
    {sessionId:'solo',title:'独处',memberIds:['lunara'],activeVirtualPersonId:'lunara'},
    {sessionId:'group',title:'一起',memberIds:['lunara','radiohost-a'],activeVirtualPersonId:'radiohost-a'},
    {sessionId:'pinned',title:'置顶',memberIds:['radiohost-a'],activeVirtualPersonId:'radiohost-a',pinnedAt:1},
  ];
  const h = createHarness({rooms});
  h.view.render();
  const html = h.nodes.get('#room-list').innerHTML;
  const solo = html.slice(html.indexOf('data-room="solo"'), html.indexOf('</button>', html.indexOf('data-room="solo"')));
  assert.doesNotMatch(solo, /identity-dot/);
  assert.match(html, /data-group="host:lunara"[\s\S]*?data-person-id="lunara"/);
  assert.match(html.slice(html.indexOf('data-room="group"')), /data-person-id="radiohost-a"/);
  assert.match(html.slice(html.indexOf('data-room="pinned"')), /data-person-id="radiohost-a"/);
  assert.equal(h.playbackCalls.length,0);
  h.view.destroy();
});

test('room title validation trims input and rejects empty, oversized, or control characters', () => {
  assert.deepEqual(validateRoomTitle('  夜里的 R&B  '), { valid: true, title: '夜里的 R&B' });
  assert.match(validateRoomTitle('  ').error, /填写/);
  assert.match(validateRoomTitle('x'.repeat(81)).error, /80/);
  assert.match(validateRoomTitle('夜\u0000航').error, /控制字符/);
});

test('one create entry opens a chooser and routes chat creation through its own form', async () => {
  const harness = createHarness();
  await harness.nodes.get('#nav-create').trigger('click');
  assert.equal(harness.nodes.get('#create-launcher').open, true);

  await harness.nodes.get('#create-room-option').trigger('click');
  assert.equal(harness.nodes.get('#create-launcher').open, false);
  assert.equal(harness.nodes.get('#room-picker').open, true);
  assert.equal(harness.nodes.get('#room-picker-title').textContent, '创建聊天');
  assert.equal(harness.createCalls.length, 0);
});

test('the chat heading + creates a chat; adding a person belongs to the people list', async () => {
  const harness = createHarness();
  // 聊天标题旁的 ＋ 直接进「新建聊天」，不再弹「创建聊天 / 认识新伙伴」二选一。
  await harness.nodes.get('#room-list-create').trigger('click');
  assert.equal(harness.nodes.get('#create-launcher').open, false);
  assert.equal(harness.nodes.get('#room-picker').open, true);
  assert.equal(harness.nodes.get('#room-picker-title').textContent, '创建聊天');
  assert.equal(harness.nodes.get('#room-picker-submit').textContent, '开始聊天');

  // 人物页有自己的标题与新增入口；回到聊天页两者互斥。
  await harness.nodes.get('#nav-people').trigger('click');
  assert.equal(harness.nodes.get('#people-list-heading').hidden, false);
  assert.equal(harness.nodes.get('#people-list').hidden, false);
  await harness.nodes.get('#nav-conversations').trigger('click');
  assert.equal(harness.nodes.get('#people-list-heading').hidden, true);

  // 两个入口都不碰播放与建会话：建会话只发生在表单提交之后。
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.playbackCalls.length, 0);
});

test('the bottom account entry expands the sidebar without changing conversation or playback', async () => {
  const harness = createHarness();
  await harness.nodes.get('#nav-account').trigger('click');
  assert.equal(harness.nodes.get('.conversation-sidebar').classList.contains('expanded'), true);
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.playbackCalls.length, 0);
});

test('expanded sidebar has a direct close control', async () => {
  const harness = createHarness();
  await harness.nodes.get('#nav-account').trigger('click');
  assert.equal(harness.nodes.get('.conversation-sidebar').classList.contains('expanded'), true);
  await harness.nodes.get('#sidebar-close').trigger('click');
  assert.equal(harness.nodes.get('.conversation-sidebar').classList.contains('expanded'), false);
});

test('a pinned sidebar stays expanded through navigation, repeat clicks and closing', async () => {
  const h = createHarness({ shellSidebar: 'pinned' });
  const sidebar = h.nodes.get('.conversation-sidebar');
  sidebar.classList.add('expanded');
  await h.nodes.get('#nav-conversations').trigger('click');
  await h.nodes.get('#nav-conversations').trigger('click');
  assert.equal(sidebar.classList.contains('expanded'), true, '再点一次当前页不收起');
  await h.nodes.get('#nav-today').trigger('click');
  assert.equal(sidebar.classList.contains('expanded'), true, '切页不收起');
  await h.nodes.get('#sidebar-close').trigger('click');
  assert.equal(sidebar.classList.contains('expanded'), true, '歌曲整理借用的关闭入口不收起常驻侧栏');
});

test('the moonlight presentation can collapse a workspace without closing it or touching playback', async () => {
  let expanded = false, icon;
  const h = createHarness({ shellSidebar: 'collapsible', sidebarPresentation: {
    navigate(next) { const close = expanded && icon === next; expanded = !close; icon = next; return !close; },
    collapse({ explicit = false } = {}) { if (explicit) expanded = false; return true; },
  } });
  h.nodes.get('#compose-input').value = '草稿不丢';
  await h.nodes.get('#nav-today').trigger('click');
  assert.equal(expanded, true);
  assert.equal(h.nodes.get('#room-list').hidden, false);
  assert.equal(h.nodes.get('#today-panel').hidden, false);
  await h.nodes.get('#nav-today').trigger('click');
  assert.equal(expanded, false);
  assert.equal(h.nodes.get('#today-panel').hidden, false);
  await h.nodes.get('#nav-settings').trigger('click');
  assert.equal(expanded, true);
  await h.nodes.get('#sidebar-close').trigger('click');
  assert.equal(expanded, false);
  assert.equal(h.nodes.get('#settings-panel').hidden, false);
  assert.equal(h.nodes.get('#compose-input').value, '草稿不丢');
  assert.deepEqual(h.store.getState().runtimeState, h.rootRuntime);
  assert.equal(h.playbackCalls.length, 0);
  assert.deepEqual(h.errors, []);
});

test('creating a chat from a saved radiohost opens a separate validated form and preserves listening', async () => {
  const harness = createHarness();
  harness.view.openCreateRoomForPerson(harness.persons[1]);

  assert.equal(harness.nodes.get('#room-name').required, true);
  assert.match(harness.nodes.get('#room-person-choices').innerHTML, /value="radiohost-a" checked/);
  assert.match(harness.nodes.get('#room-person-choices').innerHTML, /value="lunara" checked/);
  harness.nodes.get('#room-name').value = '   ';
  await harness.nodes.get('#room-picker-form').trigger('submit');
  assert.equal(harness.createCalls.length, 0);
  assert.match(harness.nodes.get('#room-picker-error').textContent, /填写/);

  harness.nodes.get('#room-name').value = '  夜航的房间  ';
  await harness.nodes.get('#room-picker-form').trigger('submit');
  assert.deepEqual(harness.createCalls, [{ title: '夜航的房间', memberIds: ['lunara', 'radiohost-a'] }]);
  assert.equal(harness.apiCalls.length, 0);
  assert.equal(harness.playbackCalls.length, 0);
  assert.deepEqual(harness.store.getState().runtimeState, harness.rootRuntime);
  assert.equal(harness.nodes.get('#room-picker').open, false, harness.nodes.get('#room-picker-error').textContent);
});

test('the separate create-and-listen path sends playback intent only after explicit form submit', async () => {
  const harness = createHarness();
  harness.view.openCreateRoomForPerson(harness.persons[1], { listenAfterCreate: true });
  assert.equal(harness.apiCalls.length, 0);
  assert.equal(harness.playbackCalls.length, 0);
  assert.equal(harness.nodes.get('#room-picker-submit').textContent, '创建并一起听');

  harness.nodes.get('#room-name').value = '夜航的房间';
  await harness.nodes.get('#room-picker-form').trigger('submit');
  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.nodes.get('#room-picker-error').textContent, '');
  assert.deepEqual(harness.apiCalls, [[
    '/api/next', { sessionId: 'conversation:new-1', delivery: 'append' },
  ]]);
  assert.deepEqual(harness.playbackCalls, [['conversation:new-1', 'now']]);
});


test('today replaces the main content while preserving chat input and playback', async () => {
  const h = createHarness();
  h.nodes.get('#compose-input').value = '保留这个草稿';
  const before = structuredClone(h.store.getState().runtimeState);
  await h.nodes.get('#nav-today').trigger('click');
  assert.equal(h.nodes.get('#today-panel').hidden, false);
  assert.equal(h.nodes.get('#main-content').hidden, true);
  assert.equal(h.nodes.get('#listening-panel').hidden, true);
  assert.equal(h.nodes.get('.conversation-sidebar').classList.contains('expanded'), false);
  await h.nodes.get('#today-panel').trigger('click', { target: { closest: () => ({ dataset: { action: 'back-to-chat' } }) } });
  assert.equal(h.nodes.get('#today-panel').hidden, true);
  assert.equal(h.nodes.get('#main-content').hidden, false);
  assert.equal(h.nodes.get('#listening-panel').hidden, false);
  assert.equal(h.nodes.get('#compose-input').value, '保留这个草稿');
  assert.equal(h.nodes.get('#compose-input').focused, true);
  assert.deepEqual(h.store.getState().runtimeState, before);
  assert.deepEqual(h.playbackCalls, []);
});

test('settings is a sibling page of today, so any other nav target switches away from it', async () => {
  const h = createHarness();
  h.nodes.get('#compose-input').value = '保留聊天草稿';
  const before = structuredClone(h.store.getState().runtimeState);
  await h.nodes.get('#nav-settings').trigger('click');
  assert.equal(h.nodes.get('#settings-panel').hidden, false);
  assert.equal(h.nodes.get('#main-content').hidden, true);
  assert.equal(h.nodes.get('#listening-panel').hidden, true);
  assert.equal(h.nodes.get('#app').classList.contains('settings-open'), true);
  assert.deepEqual(h.settingsOpenCalls, ['open'], '进入设置页要展开面板内容');
  // 设置不能压在别的页面上：点聊天就真的离开设置页
  await h.nodes.get('#nav-conversations').trigger('click');
  assert.equal(h.nodes.get('#settings-panel').hidden, true);
  assert.equal(h.nodes.get('#app').classList.contains('settings-open'), false);
  assert.equal(h.nodes.get('#main-content').hidden, false);
  assert.equal(h.nodes.get('#listening-panel').hidden, false);
  // 从设置切到今日：一样互斥，同一时刻只有一个页面
  await h.nodes.get('#nav-settings').trigger('click');
  await h.nodes.get('#nav-today').trigger('click');
  assert.equal(h.nodes.get('#settings-panel').hidden, true);
  assert.equal(h.nodes.get('#today-panel').hidden, false);
  assert.equal(h.nodes.get('#compose-input').value, '保留聊天草稿');
  assert.deepEqual(h.store.getState().runtimeState, before);
  assert.deepEqual(h.playbackCalls, []);
});

test('shell notifies memory settings on every actual settings departure, including browse', async () => {
  const h = createHarness();
  h.view.openSettings();
  await h.nodes.get('#nav-today').trigger('click');
  assert.deepEqual(h.settingsCloseCalls, ['close']);
  h.view.openSettings();
  await h.view.browse(h.controller.snapshot().rooms[0].sessionId);
  assert.deepEqual(h.settingsCloseCalls, ['close', 'close']);
  h.view.render();
  assert.equal(h.settingsCloseCalls.length, 2, '普通 render 不重复通知');
});

test('closing the settings page returns to chat without touching chat or playback', async () => {
  const h = createHarness();
  const before = structuredClone(h.store.getState().runtimeState);
  h.view.openSettings();
  assert.equal(h.nodes.get('#settings-panel').hidden, false);
  h.view.closeSettings();
  assert.equal(h.nodes.get('#settings-panel').hidden, true);
  assert.equal(h.nodes.get('#nav-settings').classList.contains('active'), false);
  assert.equal(h.nodes.get('#main-content').hidden, false);
  assert.equal(h.nodes.get('#listening-panel').hidden, false);
  assert.deepEqual(h.store.getState().runtimeState, before);
  assert.deepEqual(h.playbackCalls, []);
});

test('notes and return-to-chat preserve draft and playback', async () => {
  const h = createHarness();
  h.nodes.get('#compose-input').value = '保留聊天草稿';
  const before = structuredClone(h.store.getState().runtimeState);
  await h.nodes.get('#nav-today').trigger('click');
  assert.equal(h.nodes.get('#today-panel').hidden, false);
  assert.equal(h.nodes.get('#today-panel').focused, true);
  await h.nodes.get('#today-panel').trigger('click', { target: { closest: () => ({ dataset: { action: 'back-to-chat' } }) } });
  assert.equal(h.nodes.get('#main-content').hidden, false);
  assert.equal(h.nodes.get('#compose-input').focused, true);
  assert.equal(h.nodes.get('#compose-input').value, '保留聊天草稿');
  assert.deepEqual(h.store.getState().runtimeState, before);
  assert.deepEqual(h.apiCalls, []);
  assert.deepEqual(h.playbackCalls, []);
});

test('shell controls and player mixer are mounted exactly once', () => {
  const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
  for (const id of [
    'episode-mixer', 'mixer-voice', 'mixer-bed', 'room-model-select', 'room-model-effort',
    'room-list', 'room-search', 'sidebar-close', 'sb-undo-toast', 'sb-undo-toast-undo',
    'room-row-menu', 'room-rename-form', 'room-delete-confirm',
    'llm-active-model-settings', 'llm-providers-settings', 'usage-settings', 'settings-source-accounts', 'boot-primary',
    'single-source-settings', 'multi-source-settings',
  ]) assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} must be mounted exactly once`);
  // 版本号只做缓存击穿：断言文件已链接且带 ?v= 参数，不写死具体数值，
  // 否则每次 bump 都会绊倒这个与布局无关的测试。
  for (const href of ['/features/settings/llmProvidersSettings.css', '/features/settings/usageSettings.css']) {
    assert.ok(html.includes(`href="${href}?v=`), `${href} must stay linked with a cache-busting version`);
  }
  // 混音滑杆的 min/max 由 syncMixer 运行时设置，标记里不写死。
  assert.match(html, /id="mixer-bed"[^>]*aria-labelledby="mixer-bed-label"/);
  assert.match(html, /id="player-line" aria-label="当前歌词"/);
  assert.equal((html.match(/<audio id="audio"/g) || []).length, 1);
  assert.equal((html.match(/<audio id="audioMusic"/g) || []).length, 1);
});

test('shell CSS preserves actual player height and grouped sidebar rules', () => {
  const css = readFileSync(resolve(import.meta.dirname, 'conversations.css'), 'utf8');
  // 参考稿版式：列是网格行（minmax(0,1fr) + auto 播放条行），不再用内边距预留播放器高度。
  assert.ok(css.includes('#app { display: grid; position: relative; grid-template-columns: var(--room-sidebar-width) minmax(400px, .98fr) minmax(380px, 1.02fr); grid-template-rows: minmax(0, 1fr) auto;'));
  assert.ok(css.includes('#app.settings-open .listening-panel,'));
  assert.ok(css.includes('#room-options[open] { display: flex; flex-direction: column; gap: 16px; }'));
  for (const selector of ['.room-group-heading[aria-expanded="false"] svg', '.room-row-actions', '.room-row-menu', '.sb-undo-toast']) {
    assert.ok(css.includes(selector), selector);
  }
  // 收起态轨道不渲染任何列表内容：人物列表曾在这里降级成头像气泡排，
  // 选中人物后收起侧栏就会留下一排头像，那个紧凑形态已整体删除。
  assert.match(css, /@media \(min-width: 961px\)\s*\{\s*\.conversation-sidebar:not\(\.expanded\) #room-list,\s*\.conversation-sidebar:not\(\.expanded\) #people-list,\s*\.conversation-sidebar:not\(\.expanded\) #sb-undo-toast \{ display: none !important; \}/);
  assert.doesNotMatch(css, /\.conversation-sidebar:not\(\.expanded\) \.person-row/);
  assert.doesNotMatch(css, /\.conversation-sidebar:not\(\.expanded\) \.people-list/);
});

test('room model override loads enabled providers and saves or clears only the browsed session', async () => {
  const h = createHarness({ rooms: [{ sessionId: 'room/a', title: '模型测试', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' }] });
  h.store.update({ sessionId: 'room/a' });
  h.apiClient.get = async path => {
    h.apiCalls.push(['GET', path]);
    return path === '/api/llm/providers'
      ? { providers: [
        { id: 'gateway', name: '网关', enabled: true, models: ['model-a', 'model-b', 'model-off'], disabledModels: ['model-off'] },
        { id: 'disabled', enabled: false, models: ['hidden-model'] },
        { id: 'all-off', name: '全停用', enabled: true, models: ['only-off'], disabledModels: ['only-off'] },
      ] }
      : { override: { providerId: 'gateway', model: 'model-b' } };
  };
  h.apiClient.put = async (...args) => { h.apiCalls.push(['PUT', ...args]); return { ok: true }; };
  const before = structuredClone(h.store.getState().runtimeState);
  await h.nodes.get('#room-settings').trigger('click');
  assert.equal(h.nodes.get('#room-options').open, true);
  const select = h.nodes.get('#room-model-select');
  assert.match(select.innerHTML, /value="gateway::model-b" selected/);
  assert.doesNotMatch(select.innerHTML, /hidden-model/);
  // 停用模型（含"provider 启用但全部模型停用"的情形）不进入会话覆盖选择器。
  assert.doesNotMatch(select.innerHTML, /model-off/);
  assert.doesNotMatch(select.innerHTML, /only-off/);
  assert.doesNotMatch(select.innerHTML, /全停用/);
  select.value = 'gateway::model-a';
  await select.trigger('change');
  select.value = '';
  await select.trigger('change');
  assert.deepEqual(h.apiCalls, [
    ['GET', '/api/llm/providers'], ['GET', '/api/llm/session-model?sessionId=room%2Fa'],
    ['PUT', '/api/llm/session-model', { sessionId: 'room/a', providerId: 'gateway', model: 'model-a' }],
    ['PUT', '/api/llm/session-model', { sessionId: 'room/a' }],
  ]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.controllerCalls, []);
  assert.deepEqual(h.playbackCalls, []);
  assert.deepEqual(h.store.getState().runtimeState, before);
  h.view.destroy();
});

test('room thinking effort lists only declared levels and persists only the browsed session', async () => {
  const h = createHarness({ rooms: [{ sessionId: 'room/a', title: '思考档', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' }] });
  h.store.update({ sessionId: 'room/a' });
  h.apiClient.get = async path => {
    h.apiCalls.push(['GET', path]);
    return path === '/api/llm/providers'
      ? { providers: [
        { id: 'gateway', name: '网关', enabled: true, models: ['model-a', 'model-b'],
          modelInfo: { 'model-b': { reasoningEfforts: ['low', 'high'] } },
          modelDefaults: { 'model-b': { reasoningEffort: 'low' } } },
        { id: 'plain', name: '无档位', enabled: true, models: ['plain-model'] },
      ] }
      : { override: { providerId: 'gateway', model: 'model-b' } };
  };
  h.apiClient.put = async (...args) => { h.apiCalls.push(['PUT', ...args]); return { ok: true }; };
  await h.nodes.get('#room-settings').trigger('click');
  const effort = h.nodes.get('#room-model-effort');
  assert.match(effort.innerHTML, /跟随模型默认（低）/);
  assert.match(effort.innerHTML, /value="high"/);
  assert.doesNotMatch(effort.innerHTML, /value="medium"/, '未声明的档位不出现');

  effort.value = 'high';
  await effort.trigger('change');
  assert.deepEqual(h.apiCalls.at(-1), ['PUT', '/api/llm/session-model', {
    sessionId: 'room/a', providerId: 'gateway', model: 'model-b', reasoningEffort: 'high',
  }]);

  // 换到没有档位声明的模型：旧档位不再提交，选择器只剩「跟随模型默认」。
  const model = h.nodes.get('#room-model-select');
  model.value = 'plain::plain-model';
  await model.trigger('change');
  assert.deepEqual(h.apiCalls.at(-1), ['PUT', '/api/llm/session-model', { sessionId: 'room/a', providerId: 'plain', model: 'plain-model' }]);
  assert.match(h.nodes.get('#room-model-effort').innerHTML, /跟随模型默认/);
  assert.doesNotMatch(h.nodes.get('#room-model-effort').innerHTML, /value="high"/);
  assert.equal(h.nodes.get('#room-model-effort').disabled, false);
  h.view.destroy();
});

const groupedRooms = () => ([
  { sessionId: 'room-solo', title: '随手记', memberIds: ['lunara'], activeVirtualPersonId: 'lunara', lastTurnAt: 40 },
  { sessionId: 'room-a', title: '和 夜航 的聊天', memberIds: ['lunara', 'radiohost-a'], activeVirtualPersonId: 'lunara', lastTurnAt: 90 },
  { sessionId: 'room-pinned', title: '置顶的歌单', memberIds: ['lunara', 'radiohost-a'], activeVirtualPersonId: 'lunara', lastTurnAt: 5, pinnedAt: 3 },
  { sessionId: 'room-group', title: '周三夜聊', memberIds: ['lunara', 'radiohost-a', 'radiohost-b'], activeVirtualPersonId: 'lunara', lastTurnAt: 70 },
]);

test('expanded list projects pinned, host and group-chat sections with row actions', () => {
  const h = createHarness({
    rooms: groupedRooms(),
    persons: [
      { id: 'lunara', displayName: 'Lunara' },
      { id: 'radiohost-a', displayName: '夜航' },
      { id: 'radiohost-b', displayName: 'HOSHI' },
    ],
  });
  h.view.render();
  const html = h.nodes.get('#room-list').innerHTML;
  // 人数按成员计：只有 Lunara 自己的房间归 Lunara 组，其余（含双人）都进群聊。
  const positions = ['置顶', 'Lunara', '群聊'].map(label => html.indexOf(`>${label}<`));
  assert.ok(positions.every(index => index >= 0), `分组标题缺失：${html}`);
  assert.ok(positions.every((index, i) => i === 0 || index > positions[i - 1]), '分组未按置顶→主持→群聊排序');
  // 每行都有归档与更多入口；行本体保留 data-room。
  assert.equal((html.match(/data-room-archive=/g) || []).length, 4);
  assert.equal((html.match(/data-room-more=/g) || []).length, 4);
  assert.match(html, /data-room="room-pinned"/);
  // 服务端未读标记会点亮圆点。
  h.nodes.get('#room-list').innerHTML = '';
});

test('row archive archives immediately and offers a revocable toast with view fallback', async () => {
  const h = createHarness({ rooms: groupedRooms() });
  h.view.render();
  await h.nodes.get('#room-list').trigger('click', {
    target: { closest: selector => selector === '[data-room-archive]' ? { dataset: { roomArchive: 'room-a' } } : null },
  });
  assert.deepEqual(h.controllerCalls, [['update', 'room-a', { archived: true }]]);
  assert.equal(h.nodes.get('#sb-undo-toast').hidden, false);
  assert.match(h.nodes.get('#sb-undo-toast-text').textContent, /已归档「和 夜航 的聊天」/);

  await h.nodes.get('#sb-undo-toast-undo').trigger('click');
  assert.deepEqual(h.controllerCalls.at(-1), ['update', 'room-a', { archived: false }]);
  assert.equal(h.nodes.get('#sb-undo-toast').hidden, true);

  // 查看：切换到已归档列表。
  await h.nodes.get('#sb-undo-toast-view').trigger('click');
  assert.equal(h.nodes.get('#room-archived').textContent, '返回聊天');
});

test('row menu opens with per-room state and never offers forking or new-tab entries', async () => {
  const h = createHarness({
    rooms: [...groupedRooms(), { sessionId: 'room-old', title: '旧聊天', memberIds: ['lunara'], archivedAt: 12 }],
  });
  h.view.render();
  const moreTrigger = { dataset: { roomMore: 'room-pinned' }, focused: false, focus() { this.focused = true; } };
  await h.nodes.get('#room-list').trigger('click', {
    target: { closest: selector => selector === '[data-room-more]' ? moreTrigger : null },
  });
  assert.equal(h.nodes.get('#room-row-menu').hidden, false);
  assert.equal(h.nodes.get('#room-row-menu-pin').textContent, '取消置顶');
  assert.equal(h.nodes.get('#room-row-menu-unread').textContent, '标为未读');

  // 置顶切换、未读切换、删除入口都走 controller，不经关键词猜测。
  await h.nodes.get('#room-row-menu').trigger('click', {
    target: { closest: selector => selector === '[data-menu-action]' ? h.menuItems.get('pin') : null },
  });
  assert.deepEqual(h.controllerCalls.at(-1), ['update', 'room-pinned', { pinned: false }]);
  assert.equal(h.nodes.get('#room-row-menu').hidden, true);
  assert.equal(moreTrigger.focused, true, '关闭后焦点回到触发入口');

  // 菜单骨架（index.html）不包含分叉与新标签页，只有五个动作。
  const indexHtml = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
  const menuBlock = indexHtml.match(/<div class="room-row-menu"[\s\S]*?<\/div>\s*<\/aside>|<div class="room-row-menu"[\s\S]*?<\/div>(?=\s*<\/aside>|\s*<main)/)?.[0]
    || indexHtml.slice(indexHtml.indexOf('id="room-row-menu"'), indexHtml.indexOf('id="room-row-menu"') + 1600);
  for (const action of ['pin', 'rename', 'unread', 'archive', 'delete']) {
    assert.match(menuBlock, new RegExp(`data-menu-action="${action}"`), action);
  }
  assert.doesNotMatch(menuBlock, /分叉|新标签页/);

  // 已归档会话的菜单只留恢复与删除。
  await h.nodes.get('#room-list').trigger('click', {
    target: { closest: selector => selector === '[data-room-more]' ? { dataset: { roomMore: 'room-old' } } : null },
  });
  assert.equal(h.menuItems.get('pin').hidden, true);
  assert.equal(h.menuItems.get('rename').hidden, true);
  assert.equal(h.menuItems.get('unread').hidden, true);
  assert.equal(h.nodes.get('#room-row-menu-archive').textContent, '取消归档');
});

test('menu rename validates and saves through the row menu dialog', async () => {
  const h = createHarness({ rooms: groupedRooms() });
  h.view.render();
  await h.nodes.get('#room-list').trigger('click', {
    target: { closest: selector => selector === '[data-room-more]' ? { dataset: { roomMore: 'room-solo' } } : null },
  });
  await h.nodes.get('#room-row-menu').trigger('click', {
    target: { closest: selector => selector === '[data-menu-action]' ? h.menuItems.get('rename') : null },
  });
  assert.equal(h.nodes.get('#room-rename-dialog').open, true);
  assert.equal(h.nodes.get('#room-rename-input').value, '随手记');

  h.nodes.get('#room-rename-input').value = '   ';
  await h.nodes.get('#room-rename-form').trigger('submit');
  assert.deepEqual(h.controllerCalls, [], '空名称不提交');
  assert.match(h.nodes.get('#room-rename-error').textContent, /填写/);

  h.nodes.get('#room-rename-input').value = '深夜随手记';
  await h.nodes.get('#room-rename-form').trigger('submit');
  assert.deepEqual(h.controllerCalls, [['update', 'room-solo', { title: '深夜随手记' }]]);
  assert.equal(h.nodes.get('#room-rename-dialog').open, false);
});

test('delete requires confirmation, reports guard failures and closes only on success', async () => {
  const h = createHarness({ rooms: groupedRooms() });
  h.view.render();
  await h.nodes.get('#room-list').trigger('click', {
    target: { closest: selector => selector === '[data-room-more]' ? { dataset: { roomMore: 'room-group' } } : null },
  });
  await h.nodes.get('#room-row-menu').trigger('click', {
    target: { closest: selector => selector === '[data-menu-action]' ? h.menuItems.get('delete') : null },
  });
  assert.equal(h.nodes.get('#room-delete-confirm').open, true);
  assert.match(h.nodes.get('#room-delete-lead').textContent, /周三夜聊/);

  // 服务端守卫失败时弹层保持打开并展示原因。
  h.controller.deleteRoomById = async () => { throw new Error('这个聊天正在一起听，先切到别的聊天再删除。'); };
  await h.nodes.get('#room-delete-confirm-button').trigger('click');
  assert.match(h.nodes.get('#room-delete-error').textContent, /正在一起听/);
  assert.equal(h.nodes.get('#room-delete-confirm').open, true);

  // 同一弹层内重试成功后关闭。
  h.controller.deleteRoomById = async sid => { h.controllerCalls.push(['delete', sid]); };
  await h.nodes.get('#room-delete-confirm-button').trigger('click');
  assert.deepEqual(h.controllerCalls, [['delete', 'room-group']]);
  assert.equal(h.nodes.get('#room-delete-confirm').open, false);

  // 取消路径：再次打开后取消，不触发删除。
  await h.nodes.get('#room-list').trigger('click', {
    target: { closest: selector => selector === '[data-room-more]' ? { dataset: { roomMore: 'room-group' } } : null },
  });
  await h.nodes.get('#room-row-menu').trigger('click', {
    target: { closest: selector => selector === '[data-menu-action]' ? h.menuItems.get('delete') : null },
  });
  await h.nodes.get('#room-delete-cancel').trigger('click');
  assert.deepEqual(h.controllerCalls, [['delete', 'room-group']]);
  assert.equal(h.nodes.get('#room-delete-confirm').open, false);
});

test('browsing a conversation with a server unread flag clears the flag once', async () => {
  const h = createHarness({
    rooms: [{ sessionId: 'room-a', title: '和 夜航 的聊天', memberIds: ['lunara', 'radiohost-a'], activeVirtualPersonId: 'lunara', unreadAt: 9 }],
  });
  await h.view.browse('room-a');
  assert.deepEqual(h.controllerCalls, [['select', 'room-a'], ['update', 'room-a', { unread: false }]]);
});

test('group headings collapse and re-expand their section without touching selection', async () => {
  const h = createHarness({ rooms: groupedRooms() });
  h.view.render();
  const list = h.nodes.get('#room-list');
  assert.match(list.innerHTML, /data-room="room-solo"/);
  assert.match(list.innerHTML, /aria-expanded="true"/);

  const toggle = key => ({ target: { closest: selector => selector === '[data-group-toggle]' ? { dataset: { groupToggle: key } } : null } });
  // 折叠 Lunara 单人组：组内行消失，其余组不受影响。
  await list.trigger('click', toggle('host:lunara'));
  assert.doesNotMatch(list.innerHTML, /data-room="room-solo"/);
  assert.match(list.innerHTML, /aria-expanded="false"/);
  assert.match(list.innerHTML, /data-room="room-pinned"/, '置顶组不受影响');
  assert.match(list.innerHTML, /data-room="room-group"/, '群聊组不受影响');

  // 再点展开：行恢复且选中态不变。
  await list.trigger('click', toggle('host:lunara'));
  assert.match(list.innerHTML, /data-room="room-solo"/);
  assert.match(list.innerHTML, /aria-expanded="true"/);

  // 折叠状态在列表因订阅刷新重渲染后保持。
  await list.trigger('click', toggle('group-chat'));
  await h.nodes.get('#nav-today').trigger('click');
  await h.nodes.get('#nav-settings').trigger('click');
  await h.nodes.get('#nav-conversations').trigger('click');
  h.view.render();
  assert.doesNotMatch(list.innerHTML, /data-room="room-group"/, '跨帐本/设置导航并重渲染后仍保持折叠');
  assert.deepEqual(h.controllerCalls, []);
  assert.deepEqual(h.apiCalls, []);
  assert.deepEqual(h.playbackCalls, []);
  assert.deepEqual(h.errors, []);
  h.view.destroy();
});

test('a playing track without narration keeps one line, and no invented provenance', () => {
  const h = createHarness();
  h.view.render();
  // 陪伴模式设成「只听歌」或「偶尔介绍」时，播放中的歌本来就可能整首没有串词；
  // 这不是「还没有播放记录」，也不该被署上《歌名》推歌手记这种不存在的出处。
  assert.equal(h.nodes.get('#listening-narration').hidden, false);
  assert.equal(h.nodes.get('#listening-intro').hidden, false);
  assert.equal(h.nodes.get('#listening-intro-text').textContent, '这首留白，剩下的交给耳朵。');
  assert.doesNotMatch(h.nodes.get('#listening-intro-text').textContent, /播放记录/);
  assert.equal(h.nodes.get('#listening-intro-source').hidden, true);
  assert.equal(h.nodes.get('#listening-intro-source').textContent, '');
  assert.equal(h.nodes.get('#listening-intro').querySelector('.listening-narration-rule').hidden, true);
  h.view.destroy();
});

test('a delivered track intro fills the narration block with its own attribution', () => {
  const h = createHarness({
    turns: [{ turnId: 'intro:current-1', role: 'assistant', presentation: 'track_intro',
      queueItemId: 'current-1', text: '前奏进来时鼓点还没落。', speakerVirtualPersonId: 'lunara' }],
  });
  h.view.render();
  assert.equal(h.nodes.get('#listening-narration').hidden, false);
  assert.equal(h.nodes.get('#listening-intro').hidden, false);
  assert.equal(h.nodes.get('#listening-intro-text').textContent, '前奏进来时鼓点还没落。');
  assert.equal(h.nodes.get('#listening-intro-source').textContent, 'Lunara · 《当前歌曲》推歌手记');
  assert.equal(h.nodes.get('#listening-intro-source').hidden, false);
  assert.equal(h.nodes.get('#listening-intro').querySelector('.listening-narration-rule').hidden, false);
  h.view.destroy();
});

test('with nothing playing the narration block is an opening line, not a history claim', () => {
  const h = createHarness({
    runtimeState: { activeListeningSessionId: 'conversation:primary', queue: [], currentIndex: -1,
      currentSongId: null, suspendedSessions: {} },
  });
  h.view.render();
  assert.equal(h.nodes.get('#listening-narration').hidden, false);
  assert.match(h.nodes.get('#listening-intro-text').textContent, /还没有在放的歌/);
  assert.doesNotMatch(h.nodes.get('#listening-intro-text').textContent, /播放记录/);
  // 开场白不是生成出来的串词，同样不该有《歌名》推歌手记这样的出处。
  assert.equal(h.nodes.get('#listening-intro-source').hidden, true);
  h.view.destroy();
});

test('waiting for a reply shows one indicator: who is typing merges into the locked compose hint', () => {
  const waiting = createHarness({ chat: { pending: true, composing: ['lunara'] } });
  waiting.view.render();
  assert.equal(waiting.nodes.get('#room-composing').hidden, true, '等回复时不再另起一行「正在输入」');
  assert.deepEqual(waiting.lockCalls.at(-1), [false, '', { source: 'room' }], '等待时输入框保持可编辑，允许插话');
  assert.deepEqual(waiting.pendingCalls.at(-1), [true, 'Lunara 正在输入…']);
  waiting.view.destroy();

  const silent = createHarness({ chat: { pending: true, composing: [] } });
  silent.view.render();
  assert.deepEqual(silent.lockCalls.at(-1), [false, '', { source: 'room' }]);
  assert.equal(silent.pendingCalls.at(-1)[0], true);
  silent.view.destroy();

  // 伙伴主动开口（没有在等你的回复）：只有这一行提示，输入框不锁。
  const proactive = createHarness({ chat: { pending: false, composing: ['lunara'] } });
  proactive.view.render();
  assert.equal(proactive.nodes.get('#room-composing').hidden, false);
  assert.equal(proactive.nodes.get('#room-composing-text').textContent, 'Lunara 正在输入…');
  assert.equal(proactive.lockCalls.at(-1)[0], false);
  proactive.view.destroy();
});

test('room preview shows the reply text, not the quote block that carries the context', () => {
  const rooms = [{ sessionId: 'solo', title: '独处', memberIds: ['lunara'], activeVirtualPersonId: 'lunara', lastTurnAt: 2 }];
  const turns = [{ turnId: 'u1', role: 'user', sequence: 1, createdAt: 2,
    text: '> 引用 Lunara：三小时过去了\n\n我是在想下一首放什么' }];
  const h = createHarness({ rooms, turns });
  h.view.render();
  const html = h.nodes.get('#room-list').innerHTML;
  assert.match(html, /room-row-preview">我是在想下一首放什么</);
  assert.doesNotMatch(html, /room-row-preview">> 引用/);
  h.view.destroy();
});

test('a quote-only message previews the quoted line instead of an empty row', () => {
  const rooms = [{ sessionId: 'solo', title: '独处', memberIds: ['lunara'], activeVirtualPersonId: 'lunara', lastTurnAt: 2 }];
  const turns = [{ turnId: 'u1', role: 'user', sequence: 1, createdAt: 2, text: '> 引用 Lunara：三小时过去了\n\n' }];
  const h = createHarness({ rooms, turns });
  h.view.render();
  assert.match(h.nodes.get('#room-list').innerHTML, /room-row-preview">引用 Lunara：三小时过去了</);
  h.view.destroy();
});
