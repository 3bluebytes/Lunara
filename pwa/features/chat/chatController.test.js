import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatController, createTurnVoicePlayer } from './chatController.js';

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

test('long assistant turns use unified chat-bubble layout alongside user turns', () => {
  const fixture = createFixture();
  const long = '这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱。副歌那句「那些年错过的大雨」在录音室里是一遍过的，尾音有一点沙，反而更像人。我把它放在今晚第一位，连着听，情绪是往下走的，不用急着换心情，先从这首开始就好。';
  fixture.controller.replaceTranscript([
    { turnId: 'a1', role: 'assistant', sequence: 1, text: long },
    { turnId: 'u1', role: 'user', sequence: 2, text: long },
  ], { scroll: false });
  const html = fixture.children.map(node => node.innerHTML).join('');
  assert.doesNotMatch(html, /chat-editorial/, 'assistant long turn no longer uses editorial split');
  assert.equal((html.match(/chat-bubble/g) || []).length, 2, 'assistant and user turns both render inside chat-bubble');
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

test('已落账用户消息的分叉动作使用自然中文文案「存为新聊天继续」', () => {
  const children = [];
  const chatList = { appendChild: node => children.push(node), querySelector: () => null, querySelectorAll: () => [], innerHTML: '' };
  const controller = createChatController({
    chatList,
    chatScroll: {},
    documentLike: { createElement: () => ({ className: '', innerHTML: '', dataset: {}, querySelectorAll: () => [] }) },
    requestFrame: fn => fn(),
    onForkMessage: () => {},
  });
  controller.replaceTranscript([
    { turnId: 'turn_u1', sequence: 1, role: 'user', text: '换一首安静的' },
  ], { scroll: false });
  const userHtml = children.find(node => node.className === 'chat-msg user')?.innerHTML || '';
  assert.match(userHtml, /data-msg-action="fork">存为新聊天继续<\/button>/);
  assert.doesNotMatch(userHtml, /Fork|从这里分叉/);
});

test('气泡语音按钮点击触发回调并阻止向消息条冒泡，syncPlayingTurn 切换播放与重听态', () => {
  const buttons = [];
  const children = [];
  let toggleCalls = [];
  let toggledActions = 0;
  const chatList = {
    appendChild: node => children.push(node),
    querySelector: () => null,
    querySelectorAll: selector => selector === '.chat-voice-btn' ? buttons : [],
    innerHTML: '',
  };
  const controller = createChatController({
    chatList,
    chatScroll: {},
    documentLike: {
      createElement: () => {
        const el = {
          className: '',
          innerHTML: '',
          dataset: {},
          classList: { toggle: () => { toggledActions += 1; } },
          querySelectorAll(sel) {
            if (sel === '.chat-voice-btn') {
              const btn = {
                dataset: { voiceTurn: 'turn_v1', voiceState: 'ready', hasAudio: '1' },
                textContent: '▶ 重听',
                attributes: {},
                parentElement: { querySelector: () => ({ textContent: '' }) },
                setAttribute(k, v) { this.attributes[k] = v; },
                getAttribute(k) { return this.attributes[k]; },
                addEventListener(type, fn) { if (type === 'click') this.onClick = fn; },
              };
              buttons.push(btn);
              return [btn];
            }
            return [];
          },
          addEventListener() {},
        };
        return el;
      },
    },
    requestFrame: fn => fn(),
    onToggleTurnVoice: payload => toggleCalls.push(payload.turnId),
  });
  controller.replaceTranscript([{
    turnId: 'turn_v1',
    sequence: 1,
    role: 'assistant',
    text: '夜风很舒服。',
    voice: { canSynthesize: true, audioUrl: '/tts/v1.wav' },
  }], { scroll: false });

  let stopped = 0;
  buttons[0].onClick({ stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1);
  assert.equal(toggledActions, 0);
  assert.deepEqual(toggleCalls, ['turn_v1']);

  controller.syncPlayingTurn('turn_v1');
  assert.equal(buttons[0].dataset.voiceState, 'playing');
  assert.equal(buttons[0].textContent, '■ 停止');
  controller.syncPlayingTurn(null);
  assert.equal(buttons[0].dataset.voiceState, 'ready');
  assert.equal(buttons[0].textContent, '▶ 重听');
});

test('气泡语音按钮从生成中切换为已就绪、播放中、停止后回到重听，绝不卡死在正在合成', () => {
  const buttons = [];
  let loading = false;
  let playingTurnId = null;
  const chatList = {
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: selector => selector === '.chat-voice-btn' ? buttons : [],
    innerHTML: '',
  };
  const controller = createChatController({
    chatList,
    chatScroll: {},
    documentLike: {
      createElement: () => {
        const note = { textContent: '' };
        const el = {
          className: '',
          innerHTML: '',
          dataset: {},
          querySelectorAll(sel) {
            if (sel === '.chat-voice-btn') {
              const btn = {
                dataset: { voiceTurn: 'turn_v2', voiceState: loading ? 'loading' : 'idle', hasAudio: '0' },
                textContent: loading ? '正在合成…' : '生成语音',
                attributes: { ...(loading ? { 'aria-busy': 'true' } : {}) },
                parentElement: { querySelector: () => note },
                setAttribute(k, v) { this.attributes[k] = v; },
                getAttribute(k) { return this.attributes[k]; },
                addEventListener() {},
              };
              btn._note = note;
              buttons.length = 0;
              buttons.push(btn);
              return [btn];
            }
            return [];
          },
          addEventListener() {},
        };
        return el;
      },
    },
    requestFrame: fn => fn(),
    getPlayingTurnId: () => playingTurnId,
    isTurnVoiceLoading: id => loading && id === 'turn_v2',
  });

  controller.replaceTranscript([{
    turnId: 'turn_v2',
    sequence: 1,
    role: 'assistant',
    text: '四点了。',
    voice: { canSynthesize: true, audioUrl: null },
  }], { scroll: false });

  // 1) 进入合成中（即使发生 replaceTranscript 重绘也保持正在合成）
  loading = true;
  controller.updateTurnVoiceButton('turn_v2', { loading: true, noteText: '' });
  assert.equal(buttons[0].dataset.voiceState, 'loading');
  assert.equal(buttons[0].textContent, '正在合成…');
  controller.replaceTranscript([{
    turnId: 'turn_v2',
    sequence: 1,
    role: 'assistant',
    text: '四点了。',
    voice: { canSynthesize: true, audioUrl: null },
  }], { scroll: false });
  assert.equal(buttons[0].textContent, '正在合成…');

  // 2) 合成成功：必须立刻离开 loading 进入 ready（▶ 重听），再进入 playing（■ 停止），结束回到 ready（▶ 重听）
  loading = false;
  controller.updateTurnVoiceButton('turn_v2', { loading: false, hasAudio: true, noteText: '' });
  assert.equal(buttons[0].dataset.voiceState, 'ready');
  assert.equal(buttons[0].attributes['aria-busy'], 'false');
  assert.equal(buttons[0].textContent, '▶ 重听');

  playingTurnId = 'turn_v2';
  controller.syncPlayingTurn('turn_v2');
  assert.equal(buttons[0].dataset.voiceState, 'playing');
  assert.equal(buttons[0].textContent, '■ 停止');

  playingTurnId = null;
  controller.syncPlayingTurn(null);
  assert.equal(buttons[0].dataset.voiceState, 'ready');
  assert.equal(buttons[0].textContent, '▶ 重听');

  // 3) 首次合成失败回退回 idle（生成语音）并显示失败原因
  buttons[0].dataset.hasAudio = '0';
  controller.updateTurnVoiceButton('turn_v2', { loading: false, noteText: '这次语音合成没有成功，稍后再试一次。' });
  assert.equal(buttons[0].dataset.voiceState, 'idle');
  assert.equal(buttons[0].textContent, '生成语音');
  assert.equal(buttons[0]._note.textContent, '这次语音合成没有成功，稍后再试一次。');
});

function beatControllerFixture({ onToggleTurnVoice = null, getPlayingTurnId = () => null, isTurnVoiceLoading = () => false } = {}) {
  const children = [];
  const timers = [];
  let clock = 1_000;
  let nextTimerId = 1;
  const makeNode = (tagName = 'div') => {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tagName,
      className: '',
      _html: '',
      dataset: {},
      attributes: {},
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, force) => {
          if (force === true) classes.add(name);
          else if (force === false) classes.delete(name);
          else if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        },
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      trigger(type, event = {}) {
        for (const fn of listeners.get(type) || []) fn({ stopPropagation() {}, ...event });
      },
      querySelector(sel) {
        if (sel === '.chat-beat-group' && /chat-beat-group/.test(this._html)) {
          if (!this._group) {
            this._group = makeNode('div');
            this._group.className = 'chat-beat-group';
          }
          return this._group;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.chat-voice-btn') return this._voiceBtns || [];
        if (sel === '.chat-beat-bubble') return this._beatBubbles || [];
        return [];
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: value => {
        el._html = value;
        el._voiceBtns = [];
        el._beatBubbles = [];
        const voiceMatch = /data-voice-turn="([^"]+)"[^>]*data-voice-state="([^"]+)"[^>]*data-has-audio="([^"]+)"[^>]*>([^<]+)</.exec(value);
        if (voiceMatch) {
          const note = { textContent: '' };
          const btn = {
            dataset: { voiceTurn: voiceMatch[1], voiceState: voiceMatch[2], hasAudio: voiceMatch[3] },
            textContent: voiceMatch[4],
            attributes: {},
            parentElement: { querySelector: () => note },
            _note: note,
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k] ?? null; },
            addEventListener(type, fn) { if (type === 'click') this.onClick = fn; },
          };
          el._voiceBtns.push(btn);
        }
        for (const m of value.matchAll(/data-beat-index="(\d+)"/g)) {
          const b = makeNode('div');
          b.dataset.beatIndex = m[1];
          el._beatBubbles.push(b);
        }
      },
    });
    return el;
  };
  const chatList = {
    appendChild: node => children.push(node),
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === '.chat-voice-btn') return children.flatMap(c => c._voiceBtns || []);
      return [];
    },
    innerHTML: '',
  };
  Object.defineProperty(chatList, 'innerHTML', {
    get: () => '',
    set: value => { if (value === '') children.length = 0; },
  });
  const controller = createChatController({
    chatList,
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike: { createElement: () => makeNode('div') },
    requestFrame: fn => fn(),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { id: nextTimerId++, fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: t => { if (t) t.cleared = true; },
    onToggleTurnVoice,
    getPlayingTurnId,
    isTurnVoiceLoading,
  });
  return {
    controller,
    children,
    timers,
    advanceTime: ms => { clock += ms; },
  };
}

test('roleplay multi-beat turn reveals beat 0 then subsequent beats by pauseAfterMs, fast-forwards on click/user-msg/room-switch, and skips animation on history load', () => {
  const f = beatControllerFixture();
  const rpRoom = { sessionId: 'room-rp', memberIds: ['lunara'], interactionMode: 'roleplay' };
  const historyTurn = {
    turnId: 'turn_hist_1',
    sequence: 1,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, say: '历史第一拍', pauseAfterMs: 500 },
      { index: 1, say: '历史第二拍', pauseAfterMs: 0 },
    ],
  };

  // 1) 初次读取历史消息直接全量展示，不触发定时器
  const histArray = [historyTurn];
  Object.defineProperty(histArray, '__fromHistoryLoad', { value: true, configurable: true });
  f.controller.replaceTranscript(histArray, { scroll: false, room: rpRoom });
  assert.equal(f.timers.length, 0);
  const histHtml = f.children.at(-1).innerHTML;
  assert.equal((histHtml.match(/data-beat-index="/g) || []).length, 2);

  // 2) 实时新到达的多拍 turn 先展示第 0 拍，再按 pauseAfterMs 逐拍揭示
  const liveTurn = {
    turnId: 'turn_live_1',
    sequence: 2,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, action: '（轻笑）', say: '先看这一句。', pauseAfterMs: 480 },
      { index: 1, say: '第二句接着来。', pauseAfterMs: 720 },
      { index: 2, say: '最后一句。', pauseAfterMs: 0 },
    ],
  };
  Object.defineProperty(liveTurn, '__liveArrival', { value: true, configurable: true });
  f.controller.replaceTranscript([historyTurn, liveTurn], { scroll: false, room: rpRoom });
  assert.equal((f.children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 1);
  assert.equal(f.timers.at(-1).ms, 480);

  f.advanceTime(480);
  f.timers.at(-1).fn();
  assert.equal((f.children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 2);
  assert.equal(f.timers.at(-1).ms, 720);

  // 点击快进立即显示全量 3 拍并清除定时器
  f.children.at(-1).trigger('click');
  assert.equal((f.children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 3);
  assert.equal(f.timers.at(-1).cleared, true);

  // 3) 另一条正在逐拍揭示时有新用户消息或切换房间，立即快进并清理 timer
  const liveTurn2 = {
    turnId: 'turn_live_2',
    sequence: 3,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, say: '第0拍', pauseAfterMs: 600 },
      { index: 1, say: '第1拍', pauseAfterMs: 0 },
    ],
  };
  f.controller.appendWithDivider(liveTurn2, { scroll: false, room: rpRoom });
  const msg2 = f.children.at(-1);
  assert.equal((msg2.innerHTML.match(/data-beat-index="/g) || []).length, 1);
  const t2 = f.timers.at(-1);
  f.controller.appendWithDivider({ turnId: 'turn_u_next', sequence: 4, role: 'user', text: '我回来了' }, { scroll: false, room: rpRoom });
  assert.equal(t2.cleared, true);
  assert.equal((msg2.innerHTML.match(/data-beat-index="/g) || []).length, 2);

  // 切换房间清理 timer
  const liveTurn3 = {
    turnId: 'turn_live_3',
    sequence: 5,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, say: '又第0拍', pauseAfterMs: 550 },
      { index: 1, say: '又第1拍', pauseAfterMs: 0 },
    ],
  };
  f.controller.appendWithDivider(liveTurn3, { scroll: false, room: rpRoom });
  const t3 = f.timers.at(-1);
  f.controller.replaceTranscript([], { scroll: false, room: { sessionId: 'other-room', memberIds: ['lunara'], interactionMode: 'radio' } });
  assert.equal(t3.cleared, true);
  f.controller.destroy();
});

test('createTurnVoicePlayer synthesizes per-beat audio once, enqueues sequentially with pauseAfterMs and Turn Ducking Lease, stops mid-group, and replays cached audio without re-synthesizing', async () => {
  const { createNarrationCoordinator } = await import('../playback/narrationCoordinator.js');
  const listeners = new Map();
  const audio = {
    src: '',
    paused: true,
    ended: false,
    playCalls: [],
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    pause() { this.paused = true; },
    play() { this.paused = false; this.playCalls.push(this.src); return Promise.resolve(); },
    emit(type) { for (const fn of listeners.get(type) || []) fn({ type, currentTarget: this }); },
  };
  const delayTimers = [];
  const coordinator = createNarrationCoordinator({
    audio,
    locationHref: 'http://localhost/',
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; delayTimers.push(t); return t; },
    clearTimer: t => { if (t) t.cleared = true; },
  }).init();

  const turn = {
    turnId: 'turn_rp_voice',
    sequence: 1,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, action: '（轻声）', say: '第一拍。', pauseAfterMs: 520 },
      { index: 1, say: '第二拍。', pauseAfterMs: 680 },
      { index: 2, say: '第三拍。', pauseAfterMs: 0 },
    ],
    voice: { canSynthesize: true, status: 'missing', url: null, audioUrl: null },
  };

  let synthCalls = 0;
  let touchCalls = 0;
  let chatCtrl;
  const voicePlayer = createTurnVoicePlayer({
    getTurn: id => (id === turn.turnId ? turn : null),
    synthesizeTurnSpeech: async () => {
      synthCalls += 1;
      turn.beats[0].audioUrl = '/tts/b0.wav';
      turn.beats[1].audioUrl = '/tts/b1.wav';
      turn.beats[2].audioUrl = '/tts/b2.wav';
      turn.voice = { canSynthesize: true, status: 'ready', url: '/tts/b0.wav', audioUrl: '/tts/b0.wav' };
      return { audioUrl: '/tts/b0.wav', beats: turn.beats };
    },
    touchTurnSpeech: async () => { touchCalls += 1; return { exists: true }; },
    getChatController: () => chatCtrl,
    narrationCoordinator: coordinator,
  });

  const f = beatControllerFixture({
    onToggleTurnVoice: payload => voicePlayer.toggleTurnVoice(payload),
    getPlayingTurnId: () => voicePlayer.getPlayingTurnId(),
    isTurnVoiceLoading: id => voicePlayer.isTurnVoiceLoading(id),
  });
  chatCtrl = f.controller;
  const rpRoom = { sessionId: 'room-rp', memberIds: ['lunara'], interactionMode: 'roleplay' };
  const arr = [turn];
  Object.defineProperty(arr, '__fromHistoryLoad', { value: true, configurable: true });
  f.controller.replaceTranscript(arr, { scroll: false, room: rpRoom });

  const settle = () => new Promise(resolve => setImmediate(resolve));
  const msgEl = f.children[0];
  const btn = msgEl.querySelectorAll('.chat-voice-btn')[0];

  // 1) 点击生成语音：依次排入 3 拍并播第 0 拍，button 切为 ■ 停止，第 0 拍高亮
  await voicePlayer.toggleTurnVoice({ turnId: 'turn_rp_voice' });
  await settle();
  assert.equal(synthCalls, 1);
  assert.equal(touchCalls, 0);
  assert.deepEqual(audio.playCalls, ['/tts/b0.wav']);
  assert.equal(btn.dataset.voiceState, 'playing');
  assert.equal(btn.textContent, '■ 停止');
  assert.equal(msgEl.querySelectorAll('.chat-beat-bubble')[0].classList.contains('is-speaking'), true);

  // 第 0 拍结束进入 520ms 停顿：按钮保持 ■ 停止，不提前跳回 ▶ 重听
  audio.emit('ended');
  await settle();
  assert.equal(btn.dataset.voiceState, 'playing');
  assert.equal(btn.textContent, '■ 停止');
  assert.equal(delayTimers.at(-1).ms, 520);
  assert.equal(msgEl.querySelectorAll('.chat-beat-bubble')[0].classList.contains('is-speaking'), false);

  // 点击停止：取消整组剩余排队的拍并清掉 delay 定时器
  await voicePlayer.toggleTurnVoice({ turnId: 'turn_rp_voice' });
  assert.equal(delayTimers.at(-1).cleared, true);
  assert.equal(btn.dataset.voiceState, 'ready');
  assert.equal(btn.textContent, '▶ 重听');
  assert.equal(coordinator.getSnapshot().queued.length, 0);

  // 2) 再次点击 ▶ 重听：走缓存直接重播，不重复请求后端合成
  await voicePlayer.toggleTurnVoice({ turnId: 'turn_rp_voice' });
  await settle();
  assert.equal(synthCalls, 1, '已缓存时不得再次调用 synthesizeTurnSpeech');
  assert.equal(touchCalls, 1);
  assert.equal(audio.playCalls.at(-1), '/tts/b0.wav');
  audio.emit('ended');
  await settle();
  delayTimers.at(-1).fn();
  await settle();
  assert.equal(audio.playCalls.at(-1), '/tts/b1.wav');
  assert.equal(msgEl.querySelectorAll('.chat-beat-bubble')[1].classList.contains('is-speaking'), true);
  audio.emit('ended');
  await settle();
  assert.equal(delayTimers.at(-1).ms, 680);
  delayTimers.at(-1).fn();
  await settle();
  assert.equal(audio.playCalls.at(-1), '/tts/b2.wav');
  assert.equal(msgEl.querySelectorAll('.chat-beat-bubble')[2].classList.contains('is-speaking'), true);
  audio.emit('ended');
  await settle();
  assert.equal(btn.dataset.voiceState, 'ready');
  assert.equal(btn.textContent, '▶ 重听');
  assert.equal(msgEl.querySelectorAll('.chat-beat-bubble')[2].classList.contains('is-speaking'), false);

  voicePlayer.destroy();
  coordinator.destroy();
  f.controller.destroy();
});

test('[P0-1] silent ellipsis and marker-only beats do not cause cache-miss re-synthesis on replay', async () => {
  const { createNarrationCoordinator } = await import('../playback/narrationCoordinator.js');
  const listeners = new Map();
  const audio = {
    src: '',
    paused: true,
    ended: false,
    playCalls: [],
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    pause() { this.paused = true; },
    play() { this.paused = false; this.playCalls.push(this.src); return Promise.resolve(); },
  };
  const coordinator = createNarrationCoordinator({ audio, locationHref: 'http://localhost/' }).init();

  // Case 1: projected voice.beats[0].canSynthesize=false, plus local fallback stripping `{叹气}` on beat 1.
  const turn = {
    turnId: 'turn_silent_replay',
    sequence: 1,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, action: '看着你', say: '……', pauseAfterMs: 300 },
      { index: 1, say: '……', spoken: '{叹气}', pauseAfterMs: 400 },
      { index: 2, say: '今晚的风很软。', pauseAfterMs: 0, audioUrl: '/tts/real-b2.wav' },
    ],
    voice: {
      canSynthesize: true,
      status: 'ready',
      url: '/tts/real-b2.wav',
      audioUrl: '/tts/real-b2.wav',
      beats: [
        { index: 0, canSynthesize: false, status: 'none', audioUrl: null },
        // intentionally omit beat 1 from projection to exercise local `{...}` + sanitizeSpeechForTts fallback
        { index: 2, canSynthesize: true, status: 'ready', audioUrl: '/tts/real-b2.wav' },
      ],
    },
  };

  let synthCalls = 0;
  let touchCalls = 0;
  let chatCtrl;
  const voicePlayer = createTurnVoicePlayer({
    getTurn: id => (id === turn.turnId ? turn : null),
    synthesizeTurnSpeech: async () => { synthCalls += 1; return {}; },
    touchTurnSpeech: async () => { touchCalls += 1; return { exists: true }; },
    getChatController: () => chatCtrl,
    narrationCoordinator: coordinator,
  });
  const f = beatControllerFixture({
    onToggleTurnVoice: payload => voicePlayer.toggleTurnVoice(payload),
    getPlayingTurnId: () => voicePlayer.getPlayingTurnId(),
    isTurnVoiceLoading: id => voicePlayer.isTurnVoiceLoading(id),
  });
  chatCtrl = f.controller;
  const arr = [turn];
  Object.defineProperty(arr, '__fromHistoryLoad', { value: true, configurable: true });
  f.controller.replaceTranscript(arr, { scroll: false, room: { sessionId: 'rp', memberIds: ['lunara'], interactionMode: 'roleplay' } });

  await voicePlayer.toggleTurnVoice({ turnId: 'turn_silent_replay' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(touchCalls, 1);
  assert.equal(synthCalls, 0, '静默拍不得被误判为缺音频而重打 /speech');
  assert.deepEqual(audio.playCalls, ['/tts/real-b2.wav']);

  voicePlayer.destroy();
  coordinator.destroy();
  f.controller.destroy();
});

test('[P2-1] turnVoicePlayer falls back to idle (生成语音) when touch cache misses and re-synthesis fails', async () => {
  const { createNarrationCoordinator } = await import('../playback/narrationCoordinator.js');
  const audio = {
    src: '',
    paused: true,
    addEventListener() {},
    removeEventListener() {},
    pause() { this.paused = true; },
    play() { return Promise.resolve(); },
  };
  const coordinator = createNarrationCoordinator({ audio, locationHref: 'http://localhost/' }).init();
  const turn = {
    turnId: 'turn_cache_miss_fail',
    sequence: 1,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    text: '这句原来的语音过期了。',
    voice: { canSynthesize: true, status: 'ready', url: '/tts/stale.wav', audioUrl: '/tts/stale.wav' },
  };

  let chatCtrl;
  const voicePlayer = createTurnVoicePlayer({
    getTurn: id => (id === turn.turnId ? turn : null),
    touchTurnSpeech: async () => {
      turn.voice = { ...turn.voice, url: null, audioUrl: null, status: 'missing' };
      return { exists: false };
    },
    synthesizeTurnSpeech: async () => {
      throw new Error('语音合成暂不可用');
    },
    getChatController: () => chatCtrl,
    narrationCoordinator: coordinator,
  });
  const f = beatControllerFixture({
    onToggleTurnVoice: payload => voicePlayer.toggleTurnVoice(payload),
    getPlayingTurnId: () => voicePlayer.getPlayingTurnId(),
    isTurnVoiceLoading: id => voicePlayer.isTurnVoiceLoading(id),
  });
  chatCtrl = f.controller;
  const arr = [turn];
  Object.defineProperty(arr, '__fromHistoryLoad', { value: true, configurable: true });
  f.controller.replaceTranscript(arr, { scroll: false });

  const btn = f.children[0].querySelectorAll('.chat-voice-btn')[0];
  assert.equal(btn.textContent, '▶ 重听');
  assert.equal(btn.dataset.hasAudio, '1');

  await voicePlayer.toggleTurnVoice({ turnId: 'turn_cache_miss_fail' });
  assert.equal(btn.dataset.voiceState, 'idle');
  assert.equal(btn.dataset.hasAudio, '0');
  assert.equal(btn.textContent, '生成语音');
  assert.equal(btn.getAttribute('aria-busy'), 'false');
  assert.equal(btn._note.textContent, '语音合成暂不可用');

  voicePlayer.destroy();
  coordinator.destroy();
  f.controller.destroy();
});

test('[P1-4] radio multi-beat live turns align bubble reveal with narration started events across fast pipeline updates and redraws', async () => {
  const { createNarrationCoordinator } = await import('../playback/narrationCoordinator.js');
  const listeners = new Map();
  const audio = {
    src: '',
    paused: true,
    ended: false,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    emit(type) { for (const fn of listeners.get(type) || []) fn({ type, currentTarget: this }); },
  };
  const coordinator = createNarrationCoordinator({ audio, locationHref: 'http://localhost/' }).init();

  const children = [];
  const makeNode = () => {
    const el = {
      className: '',
      _html: '',
      dataset: {},
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: v => { el._html = v; },
    });
    return el;
  };
  const chatList = {
    appendChild: n => children.push(n),
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: '',
  };
  const controller = createChatController({
    chatList,
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike: { createElement: makeNode },
    requestFrame: fn => fn(),
    narrationCoordinator: coordinator,
  });
  const radioRoom = { sessionId: 'room-radio', memberIds: ['lunara'], interactionMode: 'radio' };

  // 1) History load shows all beats immediately without gating
  const histTurn = {
    turnId: 'turn_radio_hist',
    sequence: 1,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, say: '历史拍0', audioUrl: '/tts/h0.wav' },
      { index: 1, say: '历史拍1', audioUrl: '/tts/h1.wav' },
    ],
  };
  const histList = [histTurn];
  Object.defineProperty(histList, '__fromHistoryLoad', { value: true, configurable: true });
  controller.replaceTranscript(histList, { scroll: false, room: radioRoom });
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 2);

  // 2) Live radio pipelined turn: backend pushes beat 0..2 before beat 0 audio finishes -> DOM stays at beat 0
  const turnId = 'turn_radio_live';
  const liveBeat0 = {
    turnId,
    sequence: 2,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [{ index: 0, say: '第一拍', pauseAfterMs: 350, audioUrl: '/tts/l0.wav' }],
    beatProgress: { deliveredCount: 1, totalCount: 3, done: false },
    voice: { canSynthesize: true, status: 'partial', audioUrl: '/tts/l0.wav' },
  };
  Object.defineProperty(liveBeat0, '__liveArrival', { value: true, configurable: true });
  controller.replaceTranscript([histTurn, liveBeat0], { scroll: false, room: radioRoom });
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 1);

  coordinator.enqueue({
    id: 'b0', lane: 'foreground', url: '/tts/l0.wav',
    meta: { sourceTurnId: turnId, beatIndex: 0, beatCount: 3, isLastBeat: false, holdDuckLease: true },
  });
  coordinator.enqueue({
    id: 'b1', lane: 'foreground', url: '/tts/l1.wav',
    meta: { sourceTurnId: turnId, beatIndex: 1, beatCount: 3, isLastBeat: false, holdDuckLease: true },
  });
  coordinator.enqueue({
    id: 'b2', lane: 'foreground', url: '/tts/l2.wav',
    meta: { sourceTurnId: turnId, beatIndex: 2, beatCount: 3, isLastBeat: true, holdDuckLease: false },
  });
  await new Promise(resolve => setImmediate(resolve));

  // Backend finishes all 3 beats and triggers replaceTranscript redraw while beat 0 is still playing
  const liveAll = {
    turnId,
    sequence: 2,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, say: '第一拍', pauseAfterMs: 350, audioUrl: '/tts/l0.wav' },
      { index: 1, say: '第二拍', pauseAfterMs: 350, audioUrl: '/tts/l1.wav' },
      { index: 2, say: '第三拍', pauseAfterMs: 0, audioUrl: '/tts/l2.wav' },
    ],
    beatProgress: { deliveredCount: 3, totalCount: 3, done: true },
    voice: { canSynthesize: true, status: 'ready', audioUrl: '/tts/l0.wav' },
  };
  Object.defineProperty(liveAll, '__liveArrival', { value: true, configurable: true });
  controller.replaceTranscript([histTurn, liveAll], { scroll: false, room: radioRoom });
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 1, '快推完成但只播到第 0 拍时不得瞬间刷出全部气泡');

  // Beat 0 ends -> beat 1 starts -> DOM reveals 2 beats
  audio.emit('ended');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 2);

  // Beat 1 ends -> beat 2 starts -> DOM reveals all 3 beats
  audio.emit('ended');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 3);

  controller.destroy();
  coordinator.destroy();
});

test('[P1-NEW] radio multi-beat turn without active/pending local overlay (background room, HTTP catchup, or concurrent group turn) renders all beats immediately', async () => {
  const { createNarrationCoordinator } = await import('../playback/narrationCoordinator.js');
  const listeners = new Set();
  const audio = {
    src: '',
    paused: true,
    ended: false,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    addEventListener(type, fn) { listeners.add(`${type}:${fn}`); listeners.add(fn); },
    removeEventListener() {},
  };
  const coordinator = createNarrationCoordinator({ audio, locationHref: 'http://localhost/' }).init();
  const children = [];
  const makeNode = () => {
    const el = {
      className: '',
      _html: '',
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: v => { el._html = v; },
    });
    return el;
  };
  const pendingTurns = new Set();
  const controller = createChatController({
    chatList: { appendChild: n => children.push(n), querySelector: () => null, querySelectorAll: () => [], innerHTML: '' },
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike: { createElement: makeNode },
    requestFrame: fn => fn(),
    narrationCoordinator: coordinator,
    hasPendingTurnAudio: turnId => pendingTurns.has(turnId),
  });
  const radioRoom = { sessionId: 'room-radio', memberIds: ['lunara', 'other'], interactionMode: 'radio' };

  // 1) Background arrival / HTTP catchup: has audioUrl in ledger but hasPendingTurnAudio(turnId) === false -> renders all beats immediately
  const bgOrHttpTurn = {
    turnId: 'turn_bg_http',
    sequence: 1,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [
      { index: 0, say: '后台第一拍', pauseAfterMs: 400, audioUrl: '/tts/bg0.wav' },
      { index: 1, say: '后台第二拍', pauseAfterMs: 0, audioUrl: '/tts/bg1.wav' },
    ],
    beatProgress: { deliveredCount: 2, totalCount: 2, done: true },
    voice: { canSynthesize: true, status: 'ready', audioUrl: '/tts/bg0.wav' },
  };
  Object.defineProperty(bgOrHttpTurn, '__liveArrival', { value: true, configurable: true });
  controller.replaceTranscript([bgOrHttpTurn], { scroll: false, room: radioRoom });
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 2);

  // 2) Streaming beat 0 done:false, then beat 1 fails synthesis and finishes done:true while another turn is pending in coordinator
  pendingTurns.add('turn_other_busy');
  const streamBeat0 = {
    turnId: 'turn_fail_last',
    sequence: 2,
    role: 'assistant',
    speakerVirtualPersonId: 'lunara',
    beats: [{ index: 0, say: '群聊首拍有声', pauseAfterMs: 400, audioUrl: '/tts/a0.wav' }],
    beatProgress: { deliveredCount: 1, totalCount: 2, done: false },
  };
  pendingTurns.add('turn_fail_last');
  Object.defineProperty(streamBeat0, '__liveArrival', { value: true, configurable: true });
  controller.replaceTranscript([bgOrHttpTurn, streamBeat0], { scroll: false, room: radioRoom });
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 1);

  // Beat 0 audio finishes and Beat 1 synthesis fails -> beatProgress.done: true with pendingTurns no longer holding turn_fail_last
  pendingTurns.delete('turn_fail_last');
  controller.updateTurn({
    ...streamBeat0,
    beats: [
      { index: 0, say: '群聊首拍有声', pauseAfterMs: 400, audioUrl: '/tts/a0.wav' },
      { index: 1, say: '第二拍合成失败纯字展示', pauseAfterMs: 0 },
    ],
    beatProgress: { deliveredCount: 2, totalCount: 2, done: true },
  }, { room: radioRoom });
  assert.equal((children.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 2);

  controller.destroy();
  coordinator.destroy();
});
