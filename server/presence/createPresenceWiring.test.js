// presence 生产装配的心跳模式（add-companion-heartbeat 4.4）：真实 PlaybackRuntimeHost + 观察者 + 心跳，
// 注入时钟与定时器；runtime.handleAmbientTurn 换成替身（ambient turn 本身在 VirtualPersonRuntime.ambient.test.js）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { PlaybackEventType as P } from '../playback/playbackRuntimeTypes.js';
import { ambientBudgetExhausted, createPresenceWiring } from './createPresenceWiring.js';

const NOON = Date.UTC(2026, 9, 18, 4, 0); // 12:00 Asia/Shanghai
const track = songId => ({ songId, programId: 'p', requestId: 'r', title: `T${songId}`, artist: 'x',
  url: `/${songId}.mp3`, duration: 200, source: 'qq', virtualPersonId: 'lunara' });

function harness({ env = {}, clients = 1, prefs = {}, ambient = async () => ({ action: 'quiet' }), usageLedger = null, room = null,
  rooms = [], notes = [], ambientRecommendations = null } = {}) {
  const published = [];
  const tools = new Map();
  let nowMs = NOON;
  const host = new PlaybackRuntimeHost({ now: () => nowMs });
  const timers = [];
  const prefsStore = new Map(Object.entries(prefs));
  const state = { getPref: key => prefsStore.get(key) ?? null,
    setPref: (key, value) => prefsStore.set(key, typeof value === 'string' ? value : JSON.stringify(value)) };
  const clientListeners = new Set();
  const presenceListeners = new Set();
  const clientHub = { clientCount: clients, onClientsChanged: listener => { clientListeners.add(listener); return () => clientListeners.delete(listener); },
    onPresenceChanged: listener => { presenceListeners.add(listener); return () => presenceListeners.delete(listener); },
    presenceSummary: () => ({ connected: 0, visible: 0, typing: false }) };
  const wakes = [], userTurnListeners = [], traces = [];
  const conversationStore = { ...(room ? { getSession: id => (id === room.sessionId ? room : null), lastUserTurnAt: () => null } : {}),
    listRooms: () => rooms, notes: { listVisible: () => notes, pendingFollowups: () => [] } };
  const runtime = {
    conversationStore,
    handleAmbientTurn: input => { wakes.push(input); return ambient(input); },
    onUserTurn: listener => userTurnListeners.push(listener),
    presenceActivity: () => ({ busy: false, lastUserTurnAtMs: null }),
  };
  const virtualPerson = { runtime, conversationStore, presentationService: {}, ambientRecommendations,
    toolRegistry: { register: (name, tool) => tools.set(name, tool) },
    registry: { get: id => ({ id, metadata: {} }) } };
  const presence = createPresenceWiring({ playbackRuntime: host, state, virtualPerson,
    sessionTrace: { recordScoped: (sessionId, event) => traces.push({ sessionId, ...event }) },
    queueService: { publishSnapshot() {} }, clientHub, usageLedger, env, publish: message => published.push(message), logger: { warn() {} },
    getActivity: sessionId => runtime.presenceActivity(sessionId), now: () => nowMs, timeZone: 'Asia/Shanghai',
    heartbeatOptions: { random: () => 0.5,
      setTimer: (fn, ms) => { const timer = { fn, at: nowMs + ms, cleared: false }; timers.push(timer); return timer; },
      clearTimer: timer => { if (timer) timer.cleared = true; } } });
  const submit = event => host.submit(event).then(result => { assert.equal(result.accepted, true, `${event.type}: ${result.reason}`); return result; });
  const commit = () => submit({ type: P.PROGRAM_COMMITTED, eventId: 'commit', delivery: 'replace_now', source: 'user',
    listeningSessionId: 'room', tracks: [track('a'), track('b'), track('c')] });
  const start = () => { const s = host.snapshot(); return submit({ type: P.TRACK_STARTED, eventId: `start-${s.version}`,
    runtimeVersion: s.version, songId: s.currentSongId, programId: s.txn.programId, correlationId: s.txn.correlationId,
    queueItemId: s.txn.queueItemId, listeningSessionId: s.activeListeningSessionId, outputGeneration: s.outputGeneration, positionSeconds: 0 }); };
  // 推进到最早的未取消定时器并触发它。
  const fireNext = () => {
    const timer = timers.filter(t => !t.cleared).sort((a, b) => a.at - b.at)[0];
    assert.ok(timer, 'expected an armed timer');
    timer.cleared = true;
    nowMs = Math.max(nowMs, timer.at);
    timer.fn();
  };
  const setClients = count => { clientHub.clientCount = count; for (const listener of clientListeners) listener(count); };
  const setPresence = summary => { for (const listener of presenceListeners) listener(summary); };
  return { presence, host, wakes, traces, prefsStore, userTurnListeners, commit, start, fireNext, setClients, setPresence, published, tools,
    now: () => nowMs, setNow: ms => { nowMs = ms; } };
}

test('heartbeat mode end to end: the session opening nudges a wake, the turn runs and the result is accounted', async () => {
  const h = harness({ ambient: async () => ({ action: 'speak', delivery: 'text-only' }) });
  await h.commit();
  await h.start();
  assert.deepEqual(h.presence.heartbeat.pending(), { sessionId: 'room', personId: 'lunara', dueAtMs: NOON + 30_000,
    reason: 'session_open' }, '开场把心跳提前到事件后 30 秒');
  h.fireNext();
  await h.presence.settled();
  const [input] = h.wakes;
  assert.equal(input.sessionId, 'room');
  assert.equal(input.personId, 'lunara');
  assert.equal(input.wake.reason, 'session_open');
  assert.equal(input.isCurrent(), true);
  const status = h.presence.status();
  assert.equal(status.phase, 'heartbeat', '不再装 P1 的 speaker');
  assert.deepEqual(status.ambient, { enabled: true, today: { wakes: 1, spoken: 1, quiet: 0, lines: 1 }, lastResult: 'spoke' });
  assert.equal(status.level, undefined, '心跳模式不报告降档');
  assert.equal(h.presence.observer.entry('room').lastVoiceAtMs, NOON + 30_000, '她的人声账本记下这一句');
  assert.equal(h.presence.heartbeat.pending().reason, 'heartbeat', '接着按心跳上弦');
  assert.equal(JSON.stringify(h.traces).includes('Ta'), false, 'trace 不落歌名');
});

test('turning the switch off disarms, aborts the in-flight ambient turn and is persisted; on re-arms', async () => {
  const h = harness({ ambient: input => new Promise(resolve => {
    input.wake.signal.addEventListener('abort', () => resolve({ action: 'silent', reason: 'interrupted' }));
  }) });
  await h.commit();
  await h.start();
  h.fireNext();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.wakes.length, 1);
  assert.deepEqual(h.presence.setPreferences({ ambientEnabled: false }), { ambientEnabled: false, greetingEnabled: true, available: true });
  assert.equal(h.wakes[0].wake.signal.aborted, true, '关闭立即中止正在生成的 ambient');
  await h.presence.settled();
  assert.equal(h.presence.heartbeat.pending(), null);
  assert.deepEqual(JSON.parse(h.prefsStore.get('presence_prefs_v1')), { version: 1, ambientEnabled: false, greetingEnabled: true });
  assert.equal(h.presence.status().ambient.enabled, false);
  assert.equal(h.presence.status().ambient.lastResult, 'quiet', '被中止只算安静，不算开口');
  h.presence.setPreferences({ ambientEnabled: true });
  assert.equal(h.presence.heartbeat.pending()?.sessionId, 'room');
});

test('the heartbeat only arms while a client is connected', async () => {
  const h = harness({ clients: 0 });
  await h.commit();
  await h.start();
  assert.equal(h.presence.heartbeat.pending(), null);
  h.setClients(1);
  assert.equal(h.presence.heartbeat.pending()?.sessionId, 'room');
  h.setClients(0);
  assert.equal(h.presence.heartbeat.pending(), null, '关掉 app 立即撤弦');
});

test('PRESENCE_AUTO=0 wins: no subscription, no heartbeat, the switch reports unavailable', async () => {
  const h = harness({ env: { PRESENCE_AUTO: '0' }, prefs: { presence_prefs_v1: JSON.stringify({ version: 1, ambientEnabled: true }) } });
  await h.commit();
  await h.start();
  assert.equal(h.presence.heartbeat, null);
  assert.deepEqual(h.presence.preferences(), { ambientEnabled: true, greetingEnabled: true, available: false });
  assert.equal(h.presence.status().enabled, false);
  assert.equal(h.wakes.length, 0);
});

test('a user turn reaches the observer and the heartbeat: earlier nudges are dropped', async () => {
  const h = harness();
  await h.commit();
  await h.start();
  assert.equal(h.presence.heartbeat.pending().reason, 'session_open');
  for (const listener of h.userTurnListeners) listener('room');
  assert.equal(h.presence.heartbeat.pending().reason, 'heartbeat');
});

test('a mode change after the wake makes the turn stale for commit and delivery', async () => {
  let captured = null;
  const h = harness({ ambient: async input => { captured = input; return { action: 'quiet' }; } });
  await h.commit();
  await h.start();
  h.fireNext();
  await h.presence.settled();
  assert.equal(captured.isCurrent(), true);
  const s = h.host.snapshot();
  await h.host.submit({ type: P.COMPANION_MODE_CHANGED, eventId: 'mode', listeningSessionId: 'room', requestId: 'm1',
    modeId: 'occasional', expectedRevision: s.modeRevision, runtimeVersion: s.version });
  assert.notEqual(h.host.snapshot().modeRevision, s.modeRevision);
  assert.equal(captured.isCurrent(), false);
});

test('the ambient LLM budget check reads today\'s ambient_turn usage against its cap', () => {
  const ledger = { caps: { ambient_turn: 1000 }, used: 0, tokensToday(taskId) { assert.equal(taskId, 'ambient_turn'); return this.used; } };
  const exhausted = ambientBudgetExhausted({ ledger });
  assert.equal(exhausted(), false);
  ledger.used = 1000;
  assert.equal(exhausted(), true);
  assert.equal(ambientBudgetExhausted({ ledger: { caps: {}, tokensToday: () => 1e9 } })(), false, '没设上限不拦');
  assert.equal(ambientBudgetExhausted(null)(), false);
});

test('group rooms: the voice holder speaks first; members with nothing on their mind are not asked; the room is untouched', async () => {
  for (const [host, expected] of [
    // 主持人自己点的歌：主持人出声。
    ['lunara', [['lunara', 'holder']]],
    // 听歌人那一轮由非主持人（lunara）提交的歌在放：出声权临时在她手上，设置里的主持人不变。
    ['xiaoman', [['lunara', 'holder']]],
  ]) {
    const room = Object.freeze({ sessionId: 'room', memberIds: Object.freeze(['xiaoman', 'lunara']), activeVirtualPersonId: host });
    const h = harness({ room, ambient: async () => ({ action: 'quiet' }) });
    await h.commit();
    await h.start();
    assert.equal(h.presence.heartbeat.pending().personId, 'lunara', host);
    h.fireNext();
    await h.presence.settled();
    assert.deepEqual(h.wakes.map(input => [input.personId, input.wake.role]), expected, host);
    assert.equal(room.activeVirtualPersonId, host);
    assert.deepEqual(h.presence.status().ambient.today, { wakes: 1, spoken: 0, quiet: 1, lines: 0 }, '一拍只记一次');
  }
});

// ── 接收信号（add-companion-expression-and-reception 3.3） ──
test('set_presence_preference quiet: needs the user\'s words, disarms this listening, is visible and restorable', async () => {
  const h = harness();
  await h.commit();
  await h.start();
  const tool = h.tools.get('set_presence_preference');
  assert.ok(tool, 'presence 装配注册了这个 typed tool');
  const ctx = { userText: '先安静点吧，我在看书', userTurnId: 'u1', sessionId: 'room' };
  const guessed = tool.handler({ preference: 'quiet', sourceQuote: '别吵' }, ctx);
  assert.equal(guessed.code, 'PRESENCE_SOURCE_REQUIRED');
  assert.ok(h.presence.heartbeat.pending(), '没有原话依据，照常上弦');

  const set = tool.handler({ preference: 'quiet', sourceQuote: '先安静点吧' }, ctx);
  assert.equal(set.code, 'PRESENCE_QUIET_SET');
  assert.equal(h.presence.heartbeat.pending(), null, '本次一起听撤弦');
  assert.equal(h.presence.status().listenerQuietSessionId, 'room');
  assert.deepEqual(h.published.at(-1), { type: 'presence-listener-quiet', payload: { sessionId: 'room', quiet: true } });

  assert.deepEqual(h.presence.restoreListenerQuiet('room'), { restored: true, listenerQuietSessionId: null });
  assert.deepEqual(h.published.at(-1), { type: 'presence-listener-quiet', payload: { sessionId: 'room', quiet: false } });
  assert.equal(h.presence.heartbeat.pending()?.sessionId, 'room', '一键恢复后重新上弦');
});

test('switching the listening source ends the quiet; asking more shortens only the heartbeat interval', async () => {
  const h = harness();
  await h.commit();
  await h.start();
  const tool = h.tools.get('set_presence_preference');
  tool.handler({ preference: 'quiet', sourceQuote: '安静点' }, { userText: '安静点', userTurnId: 'u1', sessionId: 'room' });
  assert.equal(h.presence.reception.isQuiet('room'), true);
  h.presence.reception.noteSource('other-room');
  assert.equal(h.presence.status().listenerQuietSessionId, null, '换来源就恢复');

  const before = h.presence.reception.cadenceFactor('room');
  const more = tool.handler({ preference: 'more', sourceQuote: '多跟我聊聊' }, { userText: '一起听的时候多跟我聊聊', userTurnId: 'u2', sessionId: 'room' });
  assert.equal(more.code, 'PRESENCE_MORE_NOTED');
  tool.handler({ preference: 'more', sourceQuote: '多跟我聊聊' }, { userText: '一起听的时候多跟我聊聊', userTurnId: 'u2', sessionId: 'room' });
  assert.equal(h.presence.reception.signals().length, 1, '同一回合只记一次');
  assert.ok(h.presence.reception.cadenceFactor('room') < before);
});

test('a reply within 5 minutes after her delivered line becomes a reception signal; a reply without a line does not', async () => {
  const h = harness({ ambient: async () => ({ action: 'speak', delivery: 'text-only' }) });
  await h.commit();
  await h.start();
  for (const listener of h.userTurnListeners) listener('room');
  assert.equal(h.presence.reception.signals().length, 0, '她还没说话，你开口不是信号');
  h.fireNext();
  await h.presence.settled();
  for (const listener of h.userTurnListeners) listener('room');
  assert.deepEqual(h.presence.reception.signals().map(s => s.kind), ['replied']);
});

// ── 回来了（add-app-open-greeting） ──
test('returning after the night wakes the host of the most recent room once, text only; typing aborts it', async () => {
  const rooms = [{ sessionId: 'chat', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: NOON - 10 * 3_600_000, archivedAt: null }];
  let release;
  const h = harness({ rooms, prefs: { app_open_greeting_v1: JSON.stringify({ version: 1, lastVisibleAt: NOON - 10 * 3_600_000, greeted: {} }) },
    ambient: input => new Promise(resolve => {
      release = resolve;
      input.wake.signal.addEventListener('abort', () => resolve({ action: 'silent', reason: 'interrupted' }));
    }) });
  h.setPresence({ connected: 1, visible: 1, typing: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.wakes.length, 1);
  const [input] = h.wakes;
  assert.equal(input.sessionId, 'chat');
  assert.equal(input.personId, 'lunara');
  assert.equal(input.wake.reason, 'app_open');
  assert.equal(input.isCurrent(), true);
  h.setPresence({ connected: 1, visible: 1, typing: true });
  assert.equal(input.wake.signal.aborted, true, '开始打字就作废');
  assert.equal(input.isCurrent(), false);
  await h.presence.settled();
  assert.ok(h.traces.some(t => t.type === 'app_open_result' && t.sessionId === 'chat'));
  release?.({ action: 'quiet' });
});

test('the greeting switch is independent: off means no wake on return, the listening heartbeat is unaffected', async () => {
  const rooms = [{ sessionId: 'chat', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: 1, archivedAt: null }];
  const h = harness({ rooms, prefs: { app_open_greeting_v1: JSON.stringify({ version: 1, lastVisibleAt: NOON - 10 * 3_600_000, greeted: {} }) } });
  h.presence.setPreferences({ greetingEnabled: false });
  h.setPresence({ connected: 1, visible: 1, typing: false });
  await h.presence.settled();
  assert.equal(h.wakes.length, 0);
  assert.ok(h.traces.some(t => t.type === 'app_open_skipped' && t.reason === 'disabled'));
  await h.commit();
  await h.start();
  assert.equal(h.presence.heartbeat.pending()?.reason, 'session_open', '一起听的心跳照常');
});

test('ambient 推荐：闸门用同一个「安静点」判断；换了听歌来源时上一个来源的 pending 推荐过期', async () => {
  const expired = [];
  let quietCheck = null;
  const ambientRecommendations = { expireSession: sessionId => expired.push(sessionId),
    setListenerQuiet: fn => { quietCheck = fn; } };
  const h = harness({ ambientRecommendations });
  assert.equal(typeof quietCheck, 'function');
  h.presence.reception.noteSource('room');
  assert.equal(quietCheck('room'), h.presence.reception.isQuiet('room'));
  await h.commit();
  const before = expired.length;
  await h.host.submit({ type: P.PROGRAM_COMMITTED, eventId: 'commit-2', delivery: 'replace_now', source: 'user',
    listeningSessionId: 'other-room', tracks: [track('d')] });
  assert.deepEqual(expired.slice(before), ['room'], '只让换走的那个来源的推荐过期');
});
