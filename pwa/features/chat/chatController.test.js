import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatController } from './chatController.js';

function createFixture() {
  const children = [];
  const insertedCards = [];
  let attachedCards = null;
  const bubble = {
    querySelector: selector => selector === '.chat-tracks' ? attachedCards : null,
    insertBefore: node => {
      attachedCards = node;
      insertedCards.push(node);
    },
  };
  const chatList = {
    appendChild: node => children.push(node),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  let listHtml = '';
  Object.defineProperty(chatList, 'innerHTML', {
    get: () => listHtml,
    set: value => {
      listHtml = value;
      if (value === '') children.length = 0;
    },
  });
  const documentLike = {
    createElement: () => ({
      className: '', innerHTML: '', dataset: {},
      querySelectorAll: () => [],
    }),
    querySelectorAll: selector => selector === '.chat-msg.assistant .chat-bubble' && children.length
      ? [bubble]
      : [],
  };
  const locks = [];
  const controller = createChatController({
    chatList,
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike,
    requestFrame: fn => fn(),
    clock: () => new Date('2026-05-24T20:08:00'),
    onLockChange: (locked, hint) => locks.push([locked, hint]),
  });
  return { controller, children, locks, insertedCards, chatList };
}

test('server transcript replaces browser markup in sequence order with speaker attribution', () => {
  const { controller, children } = createFixture();
  const count = controller.replaceTranscript([
    { turnId: 'a2', sequence: 2, role: 'assistant', speakerVirtualPersonId: 'radiohost-night', text: '我接着说。', createdAt: Date.parse('2026-05-24T20:09:00') },
    { turnId: 'u1', sequence: 1, role: 'user', speakerVirtualPersonId: null, text: '还记得刚才吗？', createdAt: Date.parse('2026-05-24T20:08:00') },
    { turnId: 'internal', sequence: 3, role: 'tool', text: 'hidden' },
  ]);
  assert.equal(count, 2);
  // 日期分隔（参考稿：今晚 / 18:14）作为独立节点插在第一条消息前。
  assert.equal(children.length, 3);
  assert.equal(children[0].className, 'chat-date-divider');
  assert.equal(children[0].textContent, '今晚 / 20:08');
  assert.equal(children[1].className, 'chat-msg user');
  assert.equal(children[2].dataset.speakerId, 'radiohost-night');
  assert.match(children[2].innerHTML, /radiohost-night/);
  assert.doesNotMatch(children.map(item => item.innerHTML).join(''), />hidden</);
});

test('long assistant turns render editorial while identical user turns keep the bubble', () => {
  const fixture = createFixture();
  const long = '这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱。副歌那句「那些年错过的大雨」在录音室里是一遍过的，尾音有一点沙，反而更像人。我把它放在今晚第一位，连着听，情绪是往下走的，不用急着换心情，先从这首开始就好。';
  fixture.controller.replaceTranscript([
    { turnId: 'a1', role: 'assistant', sequence: 1, text: long },
    { turnId: 'u1', role: 'user', sequence: 2, text: long },
  ], { scroll: false });
  const html = fixture.children.map(node => node.innerHTML).join('');
  assert.match(html, /chat-editorial/, 'assistant long turn uses editorial layout');
  assert.equal((html.match(/chat-bubble/g) || []).length, 1, 'only the user turn keeps a bubble');
});

test('an invited turn names the inviter from groupFloor; the inviter turn has no reply label', () => {
  const { controller, children } = createFixture();
  controller.replaceTranscript([
    { turnId: 'a1', sequence: 1, role: 'assistant', speakerVirtualPersonId: 'lunara', text: '这个让 Mio 来。',
      groupFloor: { role: 'inviter', targetPersonId: 'mio', reasonKind: 'persona_self_description' } },
    { turnId: 'a2', sequence: 2, role: 'assistant', speakerVirtualPersonId: 'mio', text: '你每次都挑现场版。',
      groupFloor: { role: 'invited', fromPersonId: 'lunara', replyToTurnId: 'a1', declined: false } },
  ]);
  const messages = children.filter(item => item.className === 'chat-msg assistant');
  assert.doesNotMatch(messages[0].innerHTML, /chat-speaker-reply/);
  assert.match(messages[1].innerHTML, /<span class="chat-speaker-reply">回复 lunara<\/span>/);
});

test('“主持这一首” appears only when the yielded member committed its own music', () => {
  const { controller, children } = createFixture();
  const invited = extra => ({ role: 'invited', fromPersonId: 'lunara', replyToTurnId: 'a1', declined: false, ...extra });
  controller.replaceTranscript([
    { turnId: 'a2', sequence: 2, role: 'assistant', speakerVirtualPersonId: 'mio', text: '放这首。',
      groupFloor: invited({ musicAuthority: 'transferred', committedMusic: true }) },
    { turnId: 'a3', sequence: 3, role: 'assistant', speakerVirtualPersonId: 'mio', text: '还是你挑。',
      groupFloor: invited({ musicAuthority: 'returned', committedMusic: false, declined: true }) },
    { turnId: 'a4', sequence: 4, role: 'assistant', speakerVirtualPersonId: 'mio', text: '我先聊聊。',
      groupFloor: invited({ musicAuthority: 'transferred', committedMusic: false }) },
  ]);
  const html = children.filter(item => item.className === 'chat-msg assistant').map(item => item.innerHTML);
  assert.match(html[0], />主持这一首</);
  assert.doesNotMatch(html[1], /主持这一首/);
  assert.doesNotMatch(html[2], /主持这一首/);
});

test('被邀请的一轮在说话人行下面显示邀请者的 ask；没有 ask 或不是被邀请时不显示', () => {
  const { controller, children } = createFixture();
  controller.replaceTranscript([
    { turnId: 'a1', sequence: 1, role: 'assistant', speakerVirtualPersonId: 'lunara', text: 'Mio，你呢？',
      groupFloor: { role: 'inviter', targetPersonId: 'mio', reasonKind: 'neutral', ask: '说说<你>晚上做什么' } },
    { turnId: 'a2', sequence: 2, role: 'assistant', speakerVirtualPersonId: 'mio', text: '我听现场录音。',
      groupFloor: { role: 'invited', fromPersonId: 'lunara', replyToTurnId: 'a1', declined: false, ask: '说说<你>晚上做什么' } },
    { turnId: 'a3', sequence: 3, role: 'assistant', speakerVirtualPersonId: 'mio', text: '嗯。',
      groupFloor: { role: 'invited', fromPersonId: 'lunara', replyToTurnId: 'a1', declined: false } },
  ]);
  const html = children.filter(item => item.className === 'chat-msg assistant').map(item => item.innerHTML);
  assert.doesNotMatch(html[0], /chat-floor-ask/);
  assert.match(html[1], /<div class="chat-floor-ask">lunara 想听你说：说说&lt;你&gt;晚上做什么<\/div>/);
  assert.doesNotMatch(html[2], /chat-floor-ask/);
});

// ── 主持建议（add-group-companion-dialogue 3.2–3.4） ──
function hostFixture(onConfirmHost) {
  const children = [];
  const buttons = [];
  const makeButton = () => {
    const button = { dataset: {}, attributes: {}, textContent: '', listeners: [],
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      addEventListener(type, handler) { this.listeners.push(handler); },
      click() { return Promise.all(this.listeners.map(handler => handler())); } };
    button.parentElement = { querySelector: () => button.note };
    button.note = { textContent: '' };
    return button;
  };
  const documentLike = {
    createElement: () => {
      const element = { className: '', dataset: {}, _html: '' };
      Object.defineProperty(element, 'innerHTML', { get: () => element._html, set: value => {
        element._html = value;
        const match = /data-host-suggestion="([^"]+)" data-host-name="([^"]+)"/.exec(value);
        element.button = match ? Object.assign(makeButton(), { dataset: { hostSuggestion: match[1], hostName: match[2] } }) : null;
        if (element.button) buttons.push(element.button);
      } });
      element.querySelectorAll = selector => selector === '.chat-host-confirm' && element.button ? [element.button] : [];
      return element;
    },
  };
  const chatList = { appendChild: node => children.push(node), querySelector: () => null, querySelectorAll: () => [], innerHTML: '' };
  const controller = createChatController({ chatList, chatScroll: {}, documentLike, requestFrame: fn => fn(),
    clock: () => new Date('2026-05-24T20:08:00'), getSpeakerName: id => ({ mio: 'Mio', lunara: 'Lunara' })[id] || id, onConfirmHost });
  return { controller, children, buttons };
}

const SUGGESTING_TURN = { turnId: 'a1', sequence: 1, role: 'assistant', speakerVirtualPersonId: 'lunara', text: '以后让 Mio 来？',
  hostSuggestion: { toPersonId: 'mio', reasonKind: 'listener_request', evidenceRefs: ['turn:u1'], reason: '你说想多听她挑的歌', status: 'pending' } };

test('a pending host suggestion survives a transcript reload with a named confirm button', () => {
  const { controller, children, buttons } = hostFixture(async () => {});
  controller.replaceTranscript([SUGGESTING_TURN], { scroll: false, room: { activeVirtualPersonId: 'lunara', memberIds: ['lunara', 'mio'] } });
  const html = children.at(-1).innerHTML;
  assert.match(html, /data-state="pending"/);
  assert.match(html, /建议以后由 Mio 主持/);
  assert.match(html, /你说想多听她挑的歌/);
  assert.match(html, /aria-label="确认以后由 Mio 主持这个聊天"/);
  assert.equal(buttons.length, 1);
});

test('the suggestion state follows the authoritative room: applied once Mio hosts, unavailable after she leaves', () => {
  const applied = hostFixture(async () => {});
  applied.controller.replaceTranscript([SUGGESTING_TURN], { scroll: false, room: { activeVirtualPersonId: 'mio', memberIds: ['lunara', 'mio'] } });
  assert.match(applied.children.at(-1).innerHTML, /data-state="applied"[\s\S]*Mio 现在主持这个聊天/);
  assert.equal(applied.buttons.length, 0);
  const gone = hostFixture(async () => {});
  gone.controller.replaceTranscript([SUGGESTING_TURN], { scroll: false, room: { activeVirtualPersonId: 'lunara', memberIds: ['lunara'] } });
  assert.match(gone.children.at(-1).innerHTML, /data-state="unavailable"/);
  assert.equal(gone.buttons.length, 0);
});

test('confirming calls the activation callback once; a failure restores the button with a retry message', async () => {
  const calls = [];
  let fail = true;
  const { controller, buttons } = hostFixture(async personId => { calls.push(personId); if (fail) throw new Error('HTTP 500 internal'); });
  controller.replaceTranscript([SUGGESTING_TURN], { scroll: false, room: { activeVirtualPersonId: 'lunara', memberIds: ['lunara', 'mio'] } });
  const [button] = buttons;
  await button.click();
  assert.deepEqual(calls, ['mio']);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.textContent, '再试一次：让 Mio 主持');
  assert.match(button.note.textContent, /没能设好，当前伙伴没有变/);
  assert.doesNotMatch(button.note.textContent, /500|internal/);
  fail = false;
  await button.click();
  assert.deepEqual(calls, ['mio', 'mio']);
  assert.match(button.note.textContent, /Mio 现在主持这个聊天/);
});

test('turns without a host suggestion render exactly as before', () => {
  const plain = hostFixture(async () => {});
  plain.controller.replaceTranscript([{ ...SUGGESTING_TURN, hostSuggestion: undefined }], { scroll: false, room: { activeVirtualPersonId: 'lunara', memberIds: ['lunara', 'mio'] } });
  assert.doesNotMatch(plain.children.at(-1).innerHTML, /chat-host-suggestion/);
});

function recommendationFixture(onAcceptRecommendation, now = 50) {
  const children = [];
  const buttons = [];
  const documentLike = {
    createElement: () => {
      const element = { className: '', dataset: {}, _html: '' };
      Object.defineProperty(element, 'innerHTML', { get: () => element._html, set: value => {
        element._html = value;
        const match = /data-recommendation-turn="([^"]+)"/.exec(value);
        element.button = match ? { dataset: { recommendationTurn: match[1] }, attributes: {}, listeners: [], textContent: '放这首',
          note: { textContent: '' }, parentElement: null,
          setAttribute(name, v) { this.attributes[name] = String(v); }, getAttribute(name) { return this.attributes[name] ?? null; },
          addEventListener(type, handler) { this.listeners.push(handler); },
          click() { return Promise.all(this.listeners.map(handler => handler())); } } : null;
        if (element.button) {
          element.button.parentElement = { dataset: {}, querySelector: () => element.button.note };
          element.button.getAttribute = function getAttribute(name) {
            if (name in this.attributes) return this.attributes[name];
            const attr = new RegExp(`${name}="([^"]*)"`).exec(value);
            return attr ? attr[1] : null;
          };
          buttons.push(element.button);
        }
      } });
      element.querySelectorAll = selector => (selector === '.chat-recommendation-accept' && element.button ? [element.button] : []);
      return element;
    },
  };
  const chatList = { appendChild: node => children.push(node), querySelector: () => null, querySelectorAll: () => [], innerHTML: '' };
  const controller = createChatController({ chatList, chatScroll: {}, documentLike, requestFrame: fn => fn(),
    clock: () => new Date('2026-05-24T20:08:00'), now: () => now, getSpeakerName: id => ({ lunara: 'Lunara' })[id] || id,
    onAcceptRecommendation });
  return { controller, children, buttons };
}
const RECOMMENDING_TURN = { turnId: 'presence:w', sequence: 1, role: 'assistant', speakerVirtualPersonId: 'lunara',
  presentation: 'presence', text: '这首完了想放《晚风》给你听。',
  musicRecommendation: { provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏', recommendedBy: 'lunara', status: 'pending', expiresAt: 100 } };

test('推荐卡片：一起听的当前来源里可以「放这首」，键盘可达、有可读名称，不说「正在播放」', () => {
  const { controller, children, buttons } = recommendationFixture(async () => ({}));
  controller.replaceTranscript([RECOMMENDING_TURN], { scroll: false, listening: true });
  const html = children.at(-1).innerHTML;
  assert.match(html, /class="chat-recommendation" data-state="pending"/);
  assert.match(html, /《晚风》/);
  assert.match(html, /<button type="button"[^>]*aria-label="把《晚风》排到这首之后"[^>]*>放这首<\/button>/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /正在播放/);
  assert.equal(buttons.length, 1);
});

test('推荐卡片：不是当前听歌来源时按钮不可用并说明原因；过期、已安排、放不了各有说法', () => {
  const notSource = recommendationFixture(async () => ({}));
  notSource.controller.replaceTranscript([RECOMMENDING_TURN], { scroll: false, listening: false });
  const html = notSource.children.at(-1).innerHTML;
  assert.match(html, /data-state="not-source"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /到这个聊天一起听时才能放/);
  const expired = recommendationFixture(async () => ({}), 200);
  expired.controller.replaceTranscript([RECOMMENDING_TURN], { scroll: false, listening: true });
  assert.match(expired.children.at(-1).innerHTML, /data-state="expired"[\s\S]*推荐已过期/);
  assert.equal(expired.buttons.length, 0);
  for (const [status, copy] of [['queued', '已排到这首之后'], ['unavailable', '这首现在放不了']]) {
    const h = recommendationFixture(async () => ({}));
    h.controller.replaceTranscript([{ ...RECOMMENDING_TURN, musicRecommendation: { ...RECOMMENDING_TURN.musicRecommendation, status } }],
      { scroll: false, listening: true });
    assert.match(h.children.at(-1).innerHTML, new RegExp(`data-state="${status}"[\\s\\S]*${copy}`));
    assert.equal(h.buttons.length, 0);
  }
});

test('推荐卡片：点「放这首」提交中标 aria-busy，成功写已安排；忙时可再试，失败不暴露内部错误', async () => {
  const calls = [];
  let next = { ok: false, code: 'RECOMMENDATION_ACCEPT_RETRY', retryable: true, recommendation: { status: 'pending' } };
  const { controller, buttons } = recommendationFixture(async turnId => { calls.push(turnId);
    if (next instanceof Error) throw next; return next; });
  controller.replaceTranscript([RECOMMENDING_TURN], { scroll: false, listening: true });
  const [button] = buttons;
  await button.click();
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.textContent, '再试一次');
  assert.match(button.note.textContent, /没排上/);
  next = new Error('HTTP 500 internal');
  await button.click();
  assert.doesNotMatch(button.note.textContent, /500|internal/);
  next = { ok: true, code: 'RECOMMENDATION_QUEUED', recommendation: { status: 'queued' } };
  await button.click();
  assert.deepEqual(calls, ['presence:w', 'presence:w', 'presence:w']);
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.match(button.note.textContent, /已排到这首之后/);
  assert.doesNotMatch(button.note.textContent, /正在播放/);
});

test('推荐卡片：不可用的按钮点了不提交', async () => {
  const calls = [];
  const { controller, buttons } = recommendationFixture(async turnId => { calls.push(turnId); return {}; });
  controller.replaceTranscript([RECOMMENDING_TURN], { scroll: false, listening: false });
  await buttons[0].click();
  assert.deepEqual(calls, []);
  assert.match(buttons[0].note.textContent, /到这个聊天一起听时才能放/);
});
