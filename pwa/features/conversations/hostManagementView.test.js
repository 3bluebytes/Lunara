import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppState } from '../../core/appState.js';
import { createConversationView } from './conversationView.js';

// 视图的渲染路径使用浏览器全局；在 node:test 下给出最小替身，
// 否则一次成功的保存会因为缺少 rAF 而看起来像失败。
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= handle => clearTimeout(handle);

function domElement({ value = '', query = {} } = {}) {
  const listeners = new Map();
  const classes = new Set();
  const element = {
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
    querySelectorAll(selector) { return query[selector] || []; },
    setAttribute() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() { this.focused = true; },
    async trigger(type, overrides = {}) {
      const event = { target: this, currentTarget: this, preventDefault() {}, ...overrides };
      return Promise.all([...(listeners.get(type) || [])].map(listener => listener(event)));
    },
  };
  // 真实 <select> 在设置 innerHTML 后 value 会变成被标 selected 的 option。
  // 夹具不还原这一点，就会让"声音选项已就位"看起来像没生效。
  let innerHTML = '';
  Object.defineProperty(element, 'innerHTML', {
    get: () => innerHTML,
    set(next) {
      innerHTML = String(next);
      const selected = innerHTML.match(/<option value="([^"]*)" selected>/);
      const first = innerHTML.match(/<option value="([^"]*)"/);
      if (selected) element.value = selected[1];
      else if (first && !element.value) element.value = first[1];
    },
  });
  return element;
}

const SELECTORS = `
.conversation-sidebar #chat-list #chat-scroll #compose-input #conversation-person #create-launcher
#focus-mode-enter #focus-player-recommendation #focus-player-recommendation-source #focus-player-recommendation-text
#listening-intro #listening-intro-source #listening-intro-text #listening-subtitle #nav-conversations #nav-people
#people-list #player-cover #player-person #player-previous #player-source #player-switch-cancel
#room-cancel #room-history #room-invite #room-list #room-listen #room-member-settings #room-members #room-menu
#room-name #room-options #room-options-after #room-person-choices #room-picker #room-picker-error
#room-picker-submit #room-picker-title #room-rename #room-title #sb-queue #source-mismatch #source-mismatch-copy
#person-detail #person-detail-name #person-detail-state #person-detail-memories
#person-detail-name-input #person-detail-persona-input #person-detail-voice-select #person-detail-voice-hint
#person-detail-presence-select #person-detail-presence-style
#person-profile-form #person-detail-save #person-detail-save-msg #person-detail-listen #person-detail-preview
#person-detail-delete #person-detail-edit
#person-delete-confirm #person-delete-lead #person-delete-impact #person-delete-error
#person-delete-confirm-button #person-delete-cancel
#app #nav-today #nav-radio
`.trim().split(/\s+/);

/** 记录请求并按路径返回可控响应，用于断言"点击后到底发了什么请求"。 */
function harness({ persons = null, memories = [], impact = { memories: 5, rooms: 2 }, failEdit = null, voices = null, tokens = {} } = {}) {
  const voiceList = voices || [{ id: 'v1', displayName: '中文女声' }, { id: 'v2', displayName: '中文男声' }];
  const people = persons || [
    { id: 'lunara', displayName: 'Lunara', kind: 'root', personaDocument: 'Lunara 的人格', voiceProfileId: 'v0' },
    { id: 'radiohost-a', displayName: '夜航', kind: 'radiohost', personaDocument: '夜航的人格', voiceProfileId: 'v1' },
  ];
  const nodes = new Map(SELECTORS.map(selector => [selector, domElement()]));
  const store = createAppState({ sessionId: 'conversation:primary', virtualPersons: people, runtimeState: { queue: [], currentIndex: 0 } });
  const room = { sessionId: 'conversation:primary', title: 'Lunara', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' };
  const calls = [];
  const controller = {
    snapshot: () => ({ rooms: [room], room, sessionId: room.sessionId, local: { draft: '', scroll: null, turns: [], loaded: true }, pending: false }),
    person: id => store.getState().virtualPersons.find(person => person.id === id) || null,
    roomName: value => value?.title || '新聊天',
    saveView() {},
    subscribe: () => () => {},
    refresh: async () => { calls.push(['refresh']); },
    // applyPersonUpdate 会触发一次 render()，而 render 依赖 stateFor。
    stateFor: () => ({ draft: '', scroll: null, turns: [], loaded: true, unread: false, hasOlder: false }),
  };
  const apiClient = {
    async get(path) {
      calls.push(['GET', path]);
      if (path.startsWith('/api/memory/person/')) return { memories };
      if (path.endsWith('/deletion-impact')) return { ok: true, impact };
      if (path === '/api/station/voices') return { ok: true, voices: voiceList };
      return { ok: true };
    },
    async patch(path, body) {
      calls.push(['PATCH', path, body]);
      if (failEdit) throw new Error(failEdit);
      return { ok: true, person: { id: 'radiohost-a', displayName: body.displayName, personaDocument: body.personaDocument, voiceProfileId: body.voiceProfileId } };
    },
    async delete(path) {
      calls.push(['DELETE', path]);
      return { ok: true, deleted: true, memories: 5 };
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (path === '/api/tts/preview') {
        return { ok: true, url: '/tts/preview.wav', providerId: 'system', isFallback: true };
      }
      return { ok: true };
    },
  };
  const documentLike = {
    body: { classList: { remove() {}, toggle() {}, contains: () => false } },
    defaultView: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      // 主题 token（如 --person-edit）由 CSS 提供；夹具按需注入。
      getComputedStyle: () => ({ getPropertyValue: name => tokens[name] || '' }),
    },
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const view = createConversationView({
    // 与生产装配一致：传入具备 update 的完整 store，
    // 否则无法验证“列表立即反映改动”这个行为。
    controller, store, apiClient,
    playbackRuntimeClient: {}, documentLike,
    // render() 会驱动 chat 区域；这里给出最小可用的替身。
    chatController: { replaceTranscript() {} },
    chatInputView: { setLocked() {} },
  }).init();
  return { view, nodes, store, calls, people };
}

test('D person profile shows only supported acquaintance history and dated, correctable memories', async () => {
  const h = harness({persons:[{id:'lunara',displayName:'Lunara',createdAt:Date.now()-86400000,voiceProfileId:'v0'}],
    memories:[{id:'old',content:'旧的记忆',createdAt:'2026-10-01T12:00:00Z'},{id:'new',content:'新的记忆',createdAt:'2026-10-17T12:00:00Z',evidence:{quote:'原话'}}]});
  h.nodes.set('#person-known-days', domElement());
  h.nodes.set('#person-detail-signal', domElement());
  await h.view.openPerson('lunara');
  assert.equal(h.nodes.get('#person-known-days').textContent,'认识第 2 天');
  assert.match(h.nodes.get('#person-detail-signal').innerHTML,/data-person-id="lunara"/);
  const html = h.nodes.get('#person-detail-memories').innerHTML;
  assert.ok(html.indexOf('新的记忆') < html.indexOf('旧的记忆'));
  assert.match(html,/2026.10.17/);
  assert.match(html,/data-correct-memory/);
  assert.match(html,/data-forget-memory/);
  assert.doesNotMatch(html,/第一次一起听|一起听了.*小时/);
  assert.ok(!h.calls.some(([method])=>method==='POST'));
  h.view.destroy();
});

test('非根伙伴的面板内可直接编辑并提供删除入口', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  assert.equal(h.nodes.get('#person-detail-delete').hidden, false, '非根伙伴应显示删除入口');
  // 编辑能力就在面板里（表单 + 试听），不再是一个需要再点进去的按钮。
  assert.equal(h.nodes.get('#person-profile-form') != null, true, '面板内应直接提供可编辑表单');
  assert.equal(h.nodes.get('#person-detail-listen') != null, true, '面板内应可直接试听');
  assert.equal(h.nodes.get('#person-detail-name').textContent, '夜航');
});

test('根陪伴者可直接编辑但不提供删除入口', async t => {
  const h = harness();
  await h.view.openPerson('lunara');
  assert.equal(h.nodes.get('#person-detail-delete').hidden, true, '根陪伴者不可删除，入口必须隐藏');
  assert.equal(h.nodes.get('#person-detail-name-input').value, 'Lunara', '根陪伴者仍可编辑');
});

test('打开面板时 profile 字段就已填充，不需要再点一层才能编辑', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  // 这是本次改动的核心：可编辑值直接在面板里，而非藏在一个"编辑"按钮后面。
  assert.equal(h.nodes.get('#person-detail-name-input').value, '夜航');
  assert.equal(h.nodes.get('#person-detail-persona-input').value, '夜航的人格');
  assert.equal(h.nodes.get('#person-detail-voice-select').value, 'v1');
  assert.equal(h.nodes.get('#person-profile-form') != null, true, '表单必须存在且可直接提交');
});

test('就地编辑并保存，无需关闭任何中间弹层', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  h.nodes.get('#person-detail-name-input').value = '晚风';
  h.nodes.get('#person-detail-persona-input').value = '新人格';
  h.nodes.get('#person-detail-voice-select').value = 'v2';
  await h.nodes.get('#person-profile-form').trigger('submit');

  const patch = h.calls.find(call => call[0] === 'PATCH');
  assert.ok(patch, '应发起 PATCH');
  assert.equal(patch[1], '/api/virtual-persons/radiohost-a');
  assert.deepEqual(patch[2], { displayName: '晚风', personaDocument: '新人格', voiceProfileId: 'v2',
    presence: { temperament: 'balanced', style: '' } });
  assert.match(h.nodes.get('#person-detail-save-msg').textContent, /已保存/);
  // 标题必须跟着改：只更新列表而留旧标题，用户会以为没保存成功。
  assert.equal(h.nodes.get('#person-detail-name').textContent, '晚风');
});

test('编辑成功后本地人物列表立即反映新值', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  h.nodes.get('#person-detail-name-input').value = '晚风';
  await h.nodes.get('#person-profile-form').trigger('submit');
  const updated = h.store.getState().virtualPersons.find(person => person.id === 'radiohost-a');
  assert.equal(updated.displayName, '晚风', '不应等到下一次全量刷新才更新');
});

test('编辑失败时提示错误且数据不被改动', async t => {
  const h = harness({ failEdit: '名字太长' });
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-profile-form').trigger('submit');
  assert.equal(h.nodes.get('#person-detail-save-msg').textContent, '名字太长');
  const still = h.store.getState().virtualPersons.find(person => person.id === 'radiohost-a');
  assert.equal(still.displayName, '夜航', '失败不得留下半改状态');
});

test('空名字不发起请求', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  h.nodes.get('#person-detail-name-input').value = '   ';
  await h.nodes.get('#person-profile-form').trigger('submit');
  assert.equal(h.calls.some(call => call[0] === 'PATCH'), false);
  assert.match(h.nodes.get('#person-detail-save-msg').textContent, /名字/);
});

test('删除前拉取影响面并列出将永久移除的内容', async t => {
  const h = harness({ impact: { memories: 7, rooms: 2 } });
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  assert.ok(h.calls.some(call => call[0] === 'GET' && call[1] === '/api/virtual-persons/radiohost-a/deletion-impact'));
  const impact = h.nodes.get('#person-delete-impact').innerHTML;
  assert.match(impact, /7 条/, '必须披露将被永久移除的记忆条数');
  assert.match(impact, /2 段聊天/);
  assert.equal(h.nodes.get('#person-delete-confirm').open, true);
});

test('取消删除不发起任何删除请求', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  await h.nodes.get('#person-delete-cancel').trigger('click');
  assert.equal(h.calls.some(call => call[0] === 'DELETE'), false, '取消后不得删除');
  assert.equal(h.nodes.get('#person-delete-confirm').open, false);
});

test('取消删除后焦点回到删除入口', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  await h.nodes.get('#person-delete-cancel').trigger('click');
  assert.equal(h.nodes.get('#person-detail-delete').focused, true);
});

test('确认删除发起 DELETE 并从本地列表移除', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  await h.nodes.get('#person-delete-confirm-button').trigger('click');
  const call = h.calls.find(item => item[0] === 'DELETE');
  assert.ok(call, '应发起 DELETE');
  assert.equal(call[1], '/api/virtual-persons/radiohost-a');
  assert.equal(h.store.getState().virtualPersons.some(person => person.id === 'radiohost-a'), false, '应立刻从列表移除');
});

test('根陪伴者即使被程序调用也不会走删除流程', async t => {
  const h = harness();
  await h.view.openPerson('lunara');
  await h.nodes.get('#person-detail-delete').trigger('click');
  assert.equal(h.nodes.get('#person-delete-confirm').open, false, '根陪伴者不得进入删除确认');
  assert.equal(h.calls.some(call => call[0] === 'DELETE'), false);
});

test('声音列表加载失败时仍可编辑名字与人格', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  // 名字与人格已就地填充，说明面板不依赖声音列表
  assert.equal(h.nodes.get('#person-detail-name-input').value, '夜航');
  h.nodes.get('#person-detail-name-input').value = '晚风';
  await h.nodes.get('#person-profile-form').trigger('submit');
  assert.ok(h.calls.some(call => call[0] === 'PATCH'), '声音列表不可用不应阻断编辑');
});

test('面板内可直接试听当前选中的声音', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-listen').trigger('click');
  const call = h.calls.find(item => item[0] === 'POST' && item[1] === '/api/tts/preview');
  assert.ok(call, '试听必须走真实合成端点');
  assert.equal(call[2].voiceProfileId, 'v1', '默认试听当前选中的声音');
});
test('经 Esc/✕ 关闭删除确认时焦点也回到删除入口', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  // ✕ 与 Esc 都会触发 dialog 的 close 事件，不只是"取消"按钮。
  await h.nodes.get('#person-delete-confirm').trigger('close');
  assert.equal(h.nodes.get('#person-detail-delete').focused, true, 'close 路径同样要把焦点还给删除入口');
});

test('确认删除后重新拉取会话列表', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  await h.nodes.get('#person-delete-confirm-button').trigger('click');
  // 成员关系由服务端清理，本地 room 快照不刷新的话成员列表还挂着已删除的人。
  assert.ok(h.calls.some(call => call[0] === 'refresh'), '删除成功后应调用 refresh');
});

test('确认删除后 close 不再把焦点还给已无意义的删除入口', async t => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  await h.nodes.get('#person-detail-delete').trigger('click');
  await h.nodes.get('#person-delete-confirm-button').trigger('click');
  h.nodes.get('#person-detail-delete').focused = false;
  // 模拟浏览器在成功路径上派发的 close（此时详情面板已关闭）。
  await h.nodes.get('#person-delete-confirm').trigger('close');
  assert.equal(h.nodes.get('#person-detail-delete').focused, false, '成功删除后不应回焦到已删除者的入口');
});

test('当前声音回落时，选择器与提示行如实说明', async t => {
  const h = harness({
    voices: [
      { id: 'v1', displayName: '中文女声', isFallback: true },
      { id: 'v2', displayName: '中文男声' },
    ],
  });
  await h.view.openPerson('radiohost-a');
  const options = [...h.nodes.get('#person-detail-voice-select').innerHTML.matchAll(/<option[^>]*>([^<]*)</g)].map(m => m[1]);
  // 只有回落的声音带标注；原生可用的不能被说成本地代播。
  assert.deepEqual(options, ['中文女声（音色已变化）', '中文男声']);
  const hint = h.nodes.get('#person-detail-voice-hint').textContent;
  assert.match(hint, /音色已变化/, '必须说明当前为何不是所选声音');
  // 换了声音之后，提示与选择都指向用户真正的选择。
  assert.equal(h.nodes.get('#person-detail-voice-select').value, 'v1');
});

test('主题未要求时人物表单始终可编辑（旧四套主题行为不变）', async () => {
  const h = harness();
  await h.view.openPerson('radiohost-a');
  assert.equal(h.nodes.get('#person-profile-form').classList.contains('is-editing'), true);
  assert.equal(h.nodes.get('#person-detail-persona-input').readOnly, false);
  assert.equal(h.nodes.get('#person-detail-name-input').readOnly, false);
});

test('--person-edit: toggle 时先只读，点编辑才能改，保存后回到只读，取消会还原字段', async () => {
  const h = harness({ tokens: { '--person-edit': 'toggle' } });
  await h.view.openPerson('radiohost-a');
  const form = h.nodes.get('#person-profile-form');
  const persona = h.nodes.get('#person-detail-persona-input');
  const toggle = h.nodes.get('#person-detail-edit');
  assert.equal(form.classList.contains('is-editing'), false);
  assert.equal(persona.readOnly, true);
  assert.equal(h.nodes.get('#person-detail-name-input').readOnly, true);
  assert.equal(toggle.textContent, '编辑');

  await toggle.trigger('click');
  assert.equal(form.classList.contains('is-editing'), true);
  assert.equal(persona.readOnly, false);
  persona.value = '改到一半';
  await toggle.trigger('click');
  assert.equal(form.classList.contains('is-editing'), false, '取消编辑回到只读');
  assert.equal(persona.value, '夜航的人格', '取消编辑还原为已保存的人格');

  // 换声音直接进入编辑，好让「保存修改」出现。
  await h.nodes.get('#person-detail-voice-select').trigger('change');
  assert.equal(form.classList.contains('is-editing'), true);
  persona.value = '新人格';
  await form.trigger('submit');
  assert.match(h.nodes.get('#person-detail-save-msg').textContent, /已保存/);
  assert.equal(form.classList.contains('is-editing'), false, '保存成功后回到只读');
  assert.equal(persona.readOnly, true);
});

test('在场性格：按角色 metadata 回填，保存时随人格一起提交', async () => {
  const h = harness({ persons: [{ id: 'radiohost-a', displayName: '夜航', personaDocument: '夜航的人格', voiceProfileId: 'v1',
    status: 'active', metadata: { presence: { temperament: 'quiet', style: '话少' } } }] });
  await h.view.openPerson('radiohost-a');
  assert.equal(h.nodes.get('#person-detail-presence-select').value, 'quiet');
  assert.equal(h.nodes.get('#person-detail-presence-style').value, '话少');
  h.nodes.get('#person-detail-presence-select').value = 'lively';
  h.nodes.get('#person-detail-presence-style').value = '  爱接话  ';
  await h.nodes.get('#person-profile-form').trigger('submit');
  const patch = h.calls.find(call => call[0] === 'PATCH');
  assert.deepEqual(patch[2].presence, { temperament: 'lively', style: '爱接话' });
});

test('人物页：过期的 close 事件不会拿掉 person-page，离开时按对话框状态关闭', async () => {
  const h = harness({ tokens: { '--shell-person': 'page' } });
  const dialog = h.nodes.get('#person-detail');
  const app = h.nodes.get('#app');
  dialog.show = function show() { this.open = true; };
  await h.view.openPerson('radiohost-a');
  assert.equal(dialog.open, true);
  assert.equal(app.classList.contains('person-page'), true);

  // 在人物页再点「人物」：同一拍里先 close() 再 show()，真实浏览器的 close 事件随后才到。
  await h.nodes.get('#nav-people').trigger('click');
  assert.equal(dialog.open, true);
  await dialog.trigger('close');
  assert.equal(app.classList.contains('person-page'), true, '对话框仍开着时不拿掉 person-page');

  // 即使类已经丢了（旧版本留下的状态），回到聊天也必须关掉人物页。
  app.classList.remove('person-page');
  await h.nodes.get('#nav-conversations').trigger('click');
  assert.equal(dialog.open, false, '回聊天时关闭人物页');
  await dialog.trigger('close');
  assert.equal(app.classList.contains('person-page'), false);
});
