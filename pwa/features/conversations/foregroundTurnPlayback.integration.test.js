import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaybackRuntimeHost } from '../../../server/playback/PlaybackRuntimeHost.js';
import { createPlaybackRuntimeState } from '../../../server/playback/PlaybackRuntime.js';
import { reduceServerMessage, createAppState } from '../../core/appState.js';
import { createConversationController } from './conversationController.js';
import { createNarrationCoordinator } from '../playback/narrationCoordinator.js';
import { createPlaybackController } from '../playback/playbackController.js';
import { createPlaybackRuntimeClient } from '../playback/playbackRuntimeClient.js';
import { createAudioTextSync } from '../playback/audioTextSync.js';
import { createChatController, createTurnVoicePlayer } from '../chat/chatController.js';
import { createRuntimePlaybackCallbacks } from '../../runtimePlaybackCallbacks.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.ended = false;
    this.duration = 30;
    this.currentTime = 1;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  pause() { this.paused = true; }
  async play() { this.paused = false; this.ended = false; }
  emit(type) {
    if (type === 'ended') this.ended = true;
    for (const listener of this.listeners.get(type) || []) listener({ type, currentTarget: this });
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// 写好文字，再合成声音：两步走完才有 PLAY_TRACK_NARRATION。
async function writeAndVoice(host, { ttsUrl, contentHash, text, ...identity }) {
  const written = await host.submit({ ...identity, type: 'TRACK_NARRATION_READY', text });
  assert.equal(written.accepted, true, written.reason);
  return host.submit({ ...identity, type: 'TRACK_NARRATION_ASSET_READY', eventId: `${identity.eventId}:asset`, ttsUrl, contentHash });
}

test('runtime track starts without releasing the conversation turn; narration waits for onAfterSend', async t => {
  const store = createAppState({ sessionId: 'conversation:primary' });
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const narrator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  let activeTurnId = null;
  let resolveChat;
  const room = { sessionId: 'conversation:primary', title: 'Lunara', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' };
  const conversationsApi = {
    get: async path => path === '/api/conversations?archived=true'
      ? { conversations: [room] }
      : { sessionId: room.sessionId, turns: [] },
    chat: () => new Promise(resolve => { resolveChat = resolve; }),
  };
  const conversation = createConversationController({
    store,
    apiClient: conversationsApi,
    onBeforeSend: ({ requestId }) => { activeTurnId = narrator.beginForegroundTurn(requestId); },
    onAfterSend: ({ requestId }) => {
      if (activeTurnId === requestId) {
        narrator.endForegroundTurn(requestId);
        activeTurnId = null;
      }
    },
  });
  await conversation.refresh();
  const chatPromise = conversation.send('给我放一首歌');
  await settle();
  assert.ok(activeTurnId);

  let client;
  const host = new PlaybackRuntimeHost({
    commandSink: command => client.execute(command),
    initialState: createPlaybackRuntimeState({ narrationPolicy: {
      settlingDelayMs: 0, maxStartOffsetMs: 20_000, minRemainingMs: 15_000,
    } }),
  });
  host.subscribe(state => reduceServerMessage(store, { type: 'runtime-state', state }));
  const presentedTracks = [];
  const clientCallbacks = createRuntimePlaybackCallbacks({
    playbackView: { callbacks: {
      onTrack: item => presentedTracks.push(item),
      onNarration() {},
      onStatus() {},
      onChanged() {},
    } },
    narrationAudio: narration,
    musicAudio: music,
  });
  client = createPlaybackRuntimeClient({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: narrator,
    locationHref: 'http://localhost/',
    apiClient: { post: (_path, event) => host.submit(event) },
    callbacks: clientCallbacks,
  }).init();
  t.after(() => { client.destroy(); narrator.destroy(); });

  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'chat-turn-program', delivery: 'replace_now', source: 'user',
    tracks: [{
      songId: 'next-song', programId: 'program', requestId: 'request', title: '下一首', artist: '歌手',
      url: '/next-song.mp3', duration: 30,
      narration: { status: 'preparing', assetStatus: 'missing', generationRevision: 1,
        text: '接下来是歌手的《下一首》。', context: {} },
    }],
  });

  assert.equal(music.src, '/next-song.mp3');
  assert.equal(music.paused, false);
  assert.equal(presentedTracks.length, 1);
  assert.deepEqual(narrator.getSnapshot().foregroundTurns, [activeTurnId]);
  music.emit('playing');
  await settle();
  const activation = host.snapshot();
  const narrationReady = await writeAndVoice(host, {
    eventId: 'chat-turn-voice-ready',
    queueItemId: activation.txn.queueItemId,
    generationRevision: activation.txn.narrationGenerationRevision,
    listeningSessionId: activation.activeListeningSessionId,
    outputGeneration: activation.outputGeneration,
    text: '接下来是歌手的《下一首》。', ttsUrl: '/next-song-tts.mp3',
  });
  await settle();
  assert.equal(narrationReady.accepted, true);
  assert.equal(narration.src, '', 'runtime narration stays queued behind the foreground turn');
  assert.equal(narrator.getSnapshot().queued[0]?.lane, 'runtime');
  assert.deepEqual(narrator.getSnapshot().foregroundTurns, [activeTurnId]);

  resolveChat({ ok: true });
  await chatPromise;
  for (let attempt = 0; attempt < 8 && narration.src !== '/next-song-tts.mp3'; attempt += 1) await settle();
  assert.equal(activeTurnId, null, 'conversation onAfterSend releases the foreground lane');
  assert.deepEqual(narrator.getSnapshot().foregroundTurns, []);
  assert.equal(narration.src, '/next-song-tts.mp3');
});

test('radio pipelined multi-beat turn merges in-place, renders grouped bubbles, and holds one continuous Turn Ducking Lease across inter-beat gaps', async t => {
  const delayTimers = [];
  const store = createAppState({
    sessionId: 'room-radio',
    virtualPersons: [{ id: 'lunara', displayName: 'Lunara' }],
    queue: [{ kind: 'track', song_id: 's1', queueItemId: 'q1', title: '夜曲', artist: 'A', url: '/s1.mp3' }],
    cursor: 0,
    runtimeState: { activeListeningSessionId: 'room-radio', currentSongId: 's1', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 's1' }] },
  });
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.src = '/s1.mp3';
  await music.play();

  const gains = [];
  const narrator = createNarrationCoordinator({
    audio: narration,
    locationHref: 'http://localhost/',
    setTimer: (fn, ms) => { const entry = { fn, ms, cleared: false }; delayTimers.push(entry); return entry; },
    clearTimer: entry => { if (entry) entry.cleared = true; },
  }).init();
  const playback = createPlaybackController({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: narrator,
    apiClient: { post: async () => ({ ok: true }) },
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: v => { gains.push(v); return true; } },
  }).init();

  const conversation = createConversationController({
    store,
    apiClient: {
      get: async path => path.startsWith('/api/conversations?')
        ? { conversations: [{ sessionId: 'room-radio', memberIds: ['lunara'], activeVirtualPersonId: 'lunara', interactionMode: 'radio' }] }
        : { sessionId: 'room-radio', turns: [] },
      post: async () => ({ ok: true }),
    },
  });
  await conversation.refresh();

  const chatNodes = [];
  const chatList = {
    appendChild: node => chatNodes.push(node),
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: '',
  };
  const chat = createChatController({
    chatList,
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike: { createElement: () => ({ className: '', innerHTML: '', dataset: {}, querySelectorAll: () => [] }) },
    requestFrame: fn => fn(),
  });
  t.after(() => { chat.destroy(); playback.destroy(); narrator.destroy(); });

  // 第 1 拍就绪立即下发气泡并开口压低音乐
  conversation.consume({
    sessionId: 'room-radio',
    message: {
      sourceTurnId: 'turn_radio_beats',
      virtualPersonId: 'lunara',
      say: '先听我把话说完。',
      beats: [{ index: 0, say: '先听我把话说完。', pauseAfterMs: 450, audioUrl: '/tts/r0.wav' }],
      beatProgress: { deliveredCount: 1, totalCount: 2, done: false },
    },
  });
  chat.replaceTranscript(conversation.snapshot().local.turns, { scroll: false, room: conversation.snapshot().room });
  playback.playOverlayNarrations([{
    url: '/tts/r0.wav',
    sourceTurnId: 'turn_radio_beats',
    beatIndex: 0,
    beatCount: 2,
    isLastBeat: false,
    delayBeforeMs: 0,
    turnDuckLeaseId: 'turn_radio_beats',
    holdDuckLease: true,
  }]);
  await settle();
  assert.deepEqual(gains, [0.2]);
  const radioMsg = chatNodes.find(n => n.className === 'chat-msg assistant');
  assert.ok(radioMsg);
  assert.match(radioMsg.innerHTML, /class="chat-beat-group" data-turn-id="turn_radio_beats" data-beat-pending="1"/);

  // 第 1 拍结束时等待第 2 拍，保持压低
  narration.emit('ended');
  await settle();
  assert.deepEqual(gains, [0.2]);

  // 第 2 拍（末拍）到达并原地合并更新气泡与播报
  conversation.consume({
    sessionId: 'room-radio',
    message: {
      sourceTurnId: 'turn_radio_beats',
      virtualPersonId: 'lunara',
      say: '先听我把话说完。\n这首刚好适合现在。',
      beats: [
        { index: 0, say: '先听我把话说完。', pauseAfterMs: 450, audioUrl: '/tts/r0.wav' },
        { index: 1, say: '这首刚好适合现在。', pauseAfterMs: 0, audioUrl: '/tts/r1.wav' },
      ],
      beatProgress: { deliveredCount: 2, totalCount: 2, done: true },
    },
  });
  const updatedTurn = conversation.snapshot().local.turns.find(item => item.turnId === 'turn_radio_beats');
  chat.updateTurn(updatedTurn, { room: conversation.snapshot().room });
  assert.equal(conversation.snapshot().local.turns.length, 1, '原地合并，不重复新增 turn');
  assert.doesNotMatch(radioMsg.innerHTML, /data-beat-pending/);
  assert.equal((radioMsg.innerHTML.match(/data-beat-index="/g) || []).length, 2);

  playback.playOverlayNarrations([{
    url: '/tts/r1.mp3',
    sourceTurnId: 'turn_radio_beats',
    beatIndex: 1,
    beatCount: 2,
    isLastBeat: true,
    delayBeforeMs: 450,
    turnDuckLeaseId: 'turn_radio_beats',
    holdDuckLease: false,
  }]);
  await settle();
  assert.equal(delayTimers.at(-1).ms, 450);
  delayTimers.at(-1).fn();
  await settle();
  assert.equal(narration.src, '/tts/r1.mp3');
  assert.deepEqual(gains, [0.2]);

  narration.emit('ended');
  await settle();
  assert.deepEqual(gains, [0.2, 1], '整轮末拍播完后统一恢复音乐音量');
});

test('roleplay multi-beat turn coordinates silent reveal, per-beat synthesis, sequential playback with Turn Ducking Lease, active beat highlight, and cached replay', async t => {
  const delayTimers = [];
  const revealTimers = [];
  const store = createAppState({
    sessionId: 'room-rp',
    virtualPersons: [{ id: 'lunara', displayName: 'Lunara' }],
    queue: [{ kind: 'track', song_id: 's1', queueItemId: 'q1', title: '夜曲', artist: 'A', url: '/s1.mp3' }],
    cursor: 0,
    runtimeState: { activeListeningSessionId: 'room-rp', currentSongId: 's1', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 's1' }] },
  });
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.src = '/s1.mp3';
  await music.play();

  const gains = [];
  const narrator = createNarrationCoordinator({
    audio: narration,
    locationHref: 'http://localhost/',
    setTimer: (fn, ms) => { const entry = { fn, ms, cleared: false }; delayTimers.push(entry); return entry; },
    clearTimer: entry => { if (entry) entry.cleared = true; },
  }).init();
  const playback = createPlaybackController({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: narrator,
    apiClient: { post: async () => ({ ok: true }) },
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: v => { gains.push(v); return true; } },
  }).init();

  let synthCount = 0;
  const conversation = createConversationController({
    store,
    apiClient: {
      get: async path => path.startsWith('/api/conversations?')
        ? { conversations: [{ sessionId: 'room-rp', memberIds: ['lunara'], activeVirtualPersonId: 'lunara', interactionMode: 'roleplay' }] }
        : { sessionId: 'room-rp', turns: [] },
      post: async path => {
        if (path.endsWith('/speech')) {
          synthCount += 1;
          return {
            ok: true,
            audioUrl: '/tts/rp0.wav',
            durationMs: 2000,
            beats: [
              { index: 0, audioUrl: '/tts/rp0.wav', hash: 'h0', durationMs: 900, pauseAfterMs: 550 },
              { index: 1, audioUrl: '/tts/rp1.wav', hash: 'h1', durationMs: 1100, pauseAfterMs: 0 },
            ],
          };
        }
        if (path.endsWith('/touch')) return { ok: true, exists: true, touched: true };
        return { ok: true };
      },
    },
  });
  await conversation.refresh();

  const children = [];
  const makeNode = () => {
    const classes = new Set();
    const el = {
      className: '',
      _html: '',
      dataset: {},
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
      },
      addEventListener() {},
      querySelector(sel) {
        const beatMatch = /data-beat-index="(\d+)"/.exec(sel);
        if (beatMatch) return el._beats.find(b => b.dataset.beatIndex === beatMatch[1]) || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.chat-voice-btn') return el._btns;
        if (sel === '.chat-beat-bubble') return el._beats;
        return [];
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: v => {
        el._html = v;
        el._btns = [];
        el._beats = [];
        const vm = /data-voice-turn="([^"]+)"[^>]*data-voice-state="([^"]+)"[^>]*data-has-audio="([^"]+)"[^>]*>([^<]+)</.exec(v);
        if (vm) {
          const note = { textContent: '' };
          el._btns.push({
            dataset: { voiceTurn: vm[1], voiceState: vm[2], hasAudio: vm[3] },
            textContent: vm[4],
            attributes: {},
            parentElement: { querySelector: () => note },
            setAttribute(k, val) { this.attributes[k] = String(val); },
            getAttribute(k) { return this.attributes[k] ?? null; },
            addEventListener() {},
          });
        }
        for (const m of v.matchAll(/data-beat-index="(\d+)"/g)) {
          const b = makeNode();
          b.dataset.beatIndex = m[1];
          el._beats.push(b);
        }
      },
    });
    return el;
  };
  const chatList = {
    appendChild: n => children.push(n),
    querySelector: () => null,
    querySelectorAll: sel => sel === '.chat-voice-btn' ? children.flatMap(c => c._btns || []) : [],
    innerHTML: '',
  };
  let chat;
  const voicePlayer = createTurnVoicePlayer({
    getTurn: id => conversation.snapshot().local.turns.find(item => item.turnId === id) || null,
    synthesizeTurnSpeech: id => conversation.synthesizeTurnSpeech(id),
    touchTurnSpeech: id => conversation.touchTurnSpeech(id),
    getChatController: () => chat,
    narrationCoordinator: narrator,
  });
  chat = createChatController({
    chatList,
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike: { createElement: makeNode },
    requestFrame: fn => fn(),
    setTimer: (fn, ms) => { const e = { fn, ms, cleared: false }; revealTimers.push(e); return e; },
    clearTimer: e => { if (e) e.cleared = true; },
    onToggleTurnVoice: p => voicePlayer.toggleTurnVoice(p),
    getPlayingTurnId: () => voicePlayer.getPlayingTurnId(),
    isTurnVoiceLoading: id => voicePlayer.isTurnVoiceLoading(id),
  });
  const sync = createAudioTextSync({
    audio: narration,
    coordinator: narrator,
    getTargetsForTask: () => [],
    getBeatBubbleForTask: (_task, { turnId, beatIndex }) => {
      const msg = children.find(c => c.dataset.turnId === turnId);
      return msg?.querySelector(`.chat-beat-bubble[data-beat-index="${beatIndex}"]`) || null;
    },
    onActiveBeatChange: ({ turnId, beatIndex }) => chat.syncPlayingBeat(turnId, beatIndex),
    matchMedia: () => ({ matches: true }),
  });
  t.after(() => { sync.destroy(); voicePlayer.destroy(); chat.destroy(); playback.destroy(); narrator.destroy(); });

  conversation.consume({
    sessionId: 'room-rp',
    message: {
      sourceTurnId: 'turn_rp_full',
      virtualPersonId: 'lunara',
      say: '（轻声）先听这句。\n再听下一句。',
      beats: [
        { index: 0, action: '（轻声）', say: '先听这句。', pauseAfterMs: 550 },
        { index: 1, say: '再听下一句。', pauseAfterMs: 0 },
      ],
      voice: { canSynthesize: true, status: 'missing', url: null, audioUrl: null },
    },
  });
  chat.replaceTranscript(conversation.snapshot().local.turns, { scroll: false, room: conversation.snapshot().room });
  const rpMsg = children.find(n => n.className === 'chat-msg assistant');
  assert.ok(rpMsg);
  // 初始只展示第 0 拍，无自动合成
  assert.equal(synthCount, 0);
  assert.equal((rpMsg.innerHTML.match(/data-beat-index="/g) || []).length, 1);
  assert.equal(revealTimers[0].ms, 550);
  revealTimers[0].fn();
  assert.equal((rpMsg.innerHTML.match(/data-beat-index="/g) || []).length, 2);

  // 点击单一语音按钮按拍序合成并连播，全程持有 Turn Ducking Lease
  await voicePlayer.toggleTurnVoice({ turnId: 'turn_rp_full' });
  await settle();
  assert.equal(synthCount, 1);
  assert.equal(narration.src, '/tts/rp0.wav');
  assert.deepEqual(gains, [0.2]);
  assert.equal(rpMsg.querySelector('.chat-beat-bubble[data-beat-index="0"]').classList.contains('is-speaking'), true);

  narration.emit('ended');
  await settle();
  assert.deepEqual(gains, [0.2], '拍间 pauseAfterMs 停顿期间保持音乐压低');
  assert.equal(delayTimers.at(-1).ms, 550);
  delayTimers.at(-1).fn();
  await settle();
  assert.equal(narration.src, '/tts/rp1.wav');
  assert.equal(rpMsg.querySelector('.chat-beat-bubble[data-beat-index="1"]').classList.contains('is-speaking'), true);

  narration.emit('ended');
  await settle();
  assert.deepEqual(gains, [0.2, 1], '末拍播完后恢复音乐音量');
  assert.equal(rpMsg.querySelectorAll('.chat-voice-btn')[0].textContent, '▶ 重听');

  // 再次点击重听直接走缓存，不重复合成
  await voicePlayer.toggleTurnVoice({ turnId: 'turn_rp_full' });
  await settle();
  assert.equal(synthCount, 1);
  assert.equal(narration.src, '/tts/rp0.wav');
});

test('app.js wires getActiveSessionId and optional-chained notifyRoomFocus into clientPresence', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const appJs = await readFile(resolve(here, '../../app.js'), 'utf8');
  assert.match(appJs, /getActiveSessionId:\s*\(\)\s*=>\s*appStore\.getState\(\)\.sessionId/);
  assert.match(appJs, /clientPresence\.notifyRoomFocus\?\.\(/);
});

test('[P1-4][P0-2] radio multi-beat gating, freshOverlayTurnIds DOM rebind during last beat, and sealTurnDuckLease work end-to-end', async t => {
  const store = createAppState({
    sessionId: 'room-radio',
    virtualPersons: [{ id: 'lunara', displayName: 'Lunara' }],
    queue: [{ kind: 'track', song_id: 's1', queueItemId: 'q1', title: '夜曲', artist: 'A', url: '/s1.mp3' }],
    cursor: 0,
    runtimeState: { activeListeningSessionId: 'room-radio', currentSongId: 's1', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 's1' }] },
  });
  const narration = new FakeAudio();
  narration.duration = 10;
  narration.currentTime = 0;
  const music = new FakeAudio();
  music.src = '/s1.mp3';
  await music.play();

  const gains = [];
  const narrator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  const playback = createPlaybackController({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: narrator,
    apiClient: { post: async () => ({ ok: true }) },
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: v => { gains.push(v); return true; } },
  }).init();
  const conversation = createConversationController({
    store,
    apiClient: {
      get: async path => path.startsWith('/api/conversations?')
        ? { conversations: [{ sessionId: 'room-radio', memberIds: ['lunara'], activeVirtualPersonId: 'lunara', interactionMode: 'radio' }] }
        : { sessionId: 'room-radio', turns: [] },
      post: async () => ({ ok: true }),
    },
  });
  await conversation.refresh();

  const chatNodes = [];
  const makeLeaf = (cls, text) => {
    const children = [];
    const el = {
      className: cls,
      textContent: text,
      isConnected: true,
      dataset: {},
      classList: { contains: c => c === cls },
      replaceChildren(...els) {
        children.length = 0;
        children.push(...els);
        this.rendered = children.map(c => ({ cls: c.className, text: c.textContent }));
      },
    };
    return el;
  };
  const makeMsgNode = () => {
    const el = {
      className: '',
      _html: '',
      dataset: {},
      _bubbles: [],
      addEventListener() {},
      querySelector(sel) {
        const m = /data-beat-index="(\d+)"/.exec(sel);
        if (m) return el._bubbles.find(b => b.dataset.beatIndex === m[1]) || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.chat-beat-bubble') return el._bubbles;
        return [];
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: v => {
        for (const old of el._bubbles) {
          for (const leaf of old._leaves) leaf.isConnected = false;
        }
        el._html = v;
        el._bubbles = [];
        for (const match of v.matchAll(/data-beat-index="(\d+)"[^>]*>[\s\S]*?<div class="roleplay-speech">([^<]*)<\/div>/g)) {
          const leaf = makeLeaf('roleplay-speech', match[2]);
          const bubble = {
            dataset: { beatIndex: match[1] },
            classList: { add() {}, remove() {}, contains: () => false },
            _leaves: [leaf],
            querySelectorAll: () => [leaf],
          };
          el._bubbles.push(bubble);
        }
      },
    });
    return el;
  };
  const chatList = {
    appendChild: node => chatNodes.push(node),
    querySelector: () => null,
    querySelectorAll: sel => sel === '.chat-msg' ? chatNodes.filter(n => n.className?.includes('chat-msg')) : [],
  };
  Object.defineProperty(chatList, 'innerHTML', {
    get: () => '',
    set: v => {
      if (v === '') {
        for (const n of chatNodes) {
          for (const b of n._bubbles || []) for (const l of b._leaves) l.isConnected = false;
        }
        chatNodes.length = 0;
      }
    },
  });

  const chat = createChatController({
    chatList,
    chatScroll: { scrollTop: 0, scrollHeight: 10 },
    documentLike: { createElement: makeMsgNode },
    requestFrame: fn => fn(),
    narrationCoordinator: narrator,
  });

  const freshOverlayTurnIds = new Set(['turn_e2e_1']);
  const frameQueue = [];
  const docStub = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) };
  const sync = createAudioTextSync({
    audio: narration,
    coordinator: narrator,
    documentLike: docStub,
    matchMedia: () => ({ matches: false }),
    requestFrame: fn => { frameQueue.push(fn); return frameQueue.length; },
    cancelFrame: () => { frameQueue.length = 0; },
    getTargetsForTask: task => {
      const turnId = task?.meta?.item?.sourceTurnId;
      if (!turnId || !freshOverlayTurnIds.has(turnId)) return [];
      const beatIndex = task.meta.item.beatIndex;
      const msg = chatNodes.find(n => n.dataset?.turnId === turnId);
      const bubble = msg?.querySelector(`.chat-beat-bubble[data-beat-index="${beatIndex}"]`);
      return bubble ? [bubble.querySelectorAll('.roleplay-speech')] : [];
    },
  });
  const unsubFresh = narrator.subscribe(event => {
    const task = event?.task;
    const tid = task?.meta?.sourceTurnId || task?.meta?.item?.sourceTurnId;
    if (!tid || !freshOverlayTurnIds.has(tid)) return;
    const item = task?.meta?.item;
    const isLast = item ? (item.isLastBeat !== false && !item.holdDuckLease) : (task?.meta?.isLastBeat !== false && !task?.meta?.holdDuckLease);
    if (event.type === 'cancelled' || event.type === 'error' || (event.type === 'finished' && isLast)) {
      freshOverlayTurnIds.delete(tid);
    }
  });
  t.after(() => { unsubFresh(); sync.destroy(); chat.destroy(); playback.destroy(); narrator.destroy(); });

  // Beat 0 arrives and starts playing; Beat 1 arrives with holdDuckLease: true, then Beat 2 synthesis fails so server emits done: true
  conversation.consume({
    sessionId: 'room-radio',
    message: {
      sourceTurnId: 'turn_e2e_1',
      virtualPersonId: 'lunara',
      say: '第一拍。',
      beats: [{ index: 0, say: '第一拍。', pauseAfterMs: 0, audioUrl: '/tts/e0.wav' }],
      beatProgress: { deliveredCount: 1, totalCount: 2, done: false },
    },
  });
  chat.replaceTranscript(conversation.snapshot().local.turns, { scroll: false, room: conversation.snapshot().room });
  playback.playOverlayNarrations([{
    url: '/tts/e0.wav', sourceTurnId: 'turn_e2e_1', beatIndex: 0, beatCount: 2, isLastBeat: false, delayBeforeMs: 0, turnDuckLeaseId: 'turn_e2e_1', holdDuckLease: true,
  }]);
  await settle();

  // Beat 1 arrives with holdDuckLease: true AND beatProgress.done: true -> sealTurnDuckLease seals beat 1!
  conversation.consume({
    sessionId: 'room-radio',
    message: {
      sourceTurnId: 'turn_e2e_1',
      virtualPersonId: 'lunara',
      say: '第一拍。\n第二拍也是最后一句。',
      beats: [
        { index: 0, say: '第一拍。', pauseAfterMs: 0, audioUrl: '/tts/e0.wav' },
        { index: 1, say: '第二拍也是最后一句。', pauseAfterMs: 0, audioUrl: '/tts/e1.wav' },
      ],
      beatProgress: { deliveredCount: 2, totalCount: 2, done: true },
    },
  });
  chat.updateTurn(conversation.snapshot().local.turns[0], { room: conversation.snapshot().room });
  assert.equal((chatNodes.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 1, '第0拍未播完前不得揭示第1拍');

  playback.playOverlayNarrations([{
    url: '/tts/e1.wav', sourceTurnId: 'turn_e2e_1', beatIndex: 1, beatCount: 2, isLastBeat: false, delayBeforeMs: 0, turnDuckLeaseId: 'turn_e2e_1', holdDuckLease: true,
  }]);
  playback.sealTurnDuckLease('turn_e2e_1');

  // Beat 0 ends -> Beat 1 starts; freshOverlayTurnIds must stay alive during DOM replaceTranscript!
  narration.emit('ended');
  await settle();
  assert.equal(freshOverlayTurnIds.has('turn_e2e_1'), true, '末拍开始时不得过早删除 freshOverlayTurnIds');
  assert.equal((chatNodes.at(-1).innerHTML.match(/data-beat-index="/g) || []).length, 2);

  // Simulate loadTranscript DOM replacement mid-speech of beat 1
  const reloadedTurn = { ...conversation.snapshot().local.turns[0] };
  Object.defineProperty(reloadedTurn, '__liveArrival', { value: true, configurable: true });
  chat.replaceTranscript([reloadedTurn], { scroll: false, room: conversation.snapshot().room });
  narration.currentTime = 5;
  frameQueue.shift()();
  const newLeaf = chatNodes.at(-1).querySelector('.chat-beat-bubble[data-beat-index="1"]').querySelectorAll('.roleplay-speech')[0];
  assert.ok(newLeaf.rendered && newLeaf.rendered[0].text.length > 0, 'DOM 重绘后 audioTextSync 仍能重绑末拍新节点');

  // Beat 1 ends -> sealed lease releases & freshOverlayTurnIds cleans up
  narration.emit('ended');
  await settle();
  assert.equal(freshOverlayTurnIds.has('turn_e2e_1'), false);
  assert.deepEqual(gains, [0.2, 1]);
  assert.equal(playback.getSnapshot().turnDuckLeaseId, null);
});
