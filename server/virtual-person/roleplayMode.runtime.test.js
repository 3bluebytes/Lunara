import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { AgentLoop } from './AgentLoop.js';
import { AmbientTurnRunner } from './AmbientTurnRunner.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { ConversationStore } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonChatService } from './VirtualPersonChatService.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonService } from './VirtualPersonService.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createTtsAssetLifecycle } from '../tts/ttsAssetLifecycle.js';
import { toPlainText } from '../tts/performance/markers.js';
import { registerVirtualPersonRoutes } from '../http/routes/virtualPersonRoutes.js';

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createRuntimeHarness(modelStub, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-roleplay-rt-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  const conversationStore = new ConversationStore({ dbPath });
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  options.registerTools?.(tools);
  const budgeter = new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const synthCalls = [];
  const publishedSnapshots = [];
  const activities = [];
  const presentationService = new PresentationService({
    synthesize: options.synthesize || (async input => {
      synthCalls.push(input);
      return { url: `/tts/hash_${synthCalls.length}.wav`, hash: `hash_${synthCalls.length}`, durationMs: 1200, source: 'mock' };
    }),
  });
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date('2026-11-23T12:00:00.000Z') }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat: modelStub, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService,
    capabilityResolver: options.capabilityResolver || (() => []),
    retrieveMemories: async () => [],
    getRuntimeState: () => null,
    onActivity: event => activities.push(event),
    logger: { error() {}, warn() {} },
  }).initialize();
  const chatService = new VirtualPersonChatService({
    runtime,
    presentationService,
    conversationStore,
    queueService: { publishSnapshot: payload => publishedSnapshots.push(payload) },
    logger: { error() {}, warn() {} },
  });
  return {
    dir, registry, conversationStore, runtime, chatService, synthCalls, publishedSnapshots, activities, tools,
    close() {
      conversationStore.close();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('AmbientTurnRunner returns silent(roleplay-mode) without calling model in roleplay rooms', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db }).initialize();
  const conversationStore = new ConversationStore({ db }).initialize();
  const room = conversationStore.createRoom({ title: '私语房', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay' });
  let modelCalled = false;
  const runner = new AmbientTurnRunner({
    conversationStore,
    registry,
    agentLoop: { run: async () => { modelCalled = true; return {}; } },
    turnQueue: { enqueue: async () => ({}) },
    controllers: new Map(),
    hostBusy: () => false,
    assembleContext: () => ({}),
  });
  const res = await runner.run({ sessionId: room.sessionId, personId: 'lunara', wake: { id: 'wake-1', kind: 'ambient' } });
  assert.deepEqual(res, { action: 'silent', reason: 'roleplay-mode' });
  assert.equal(modelCalled, false);
  conversationStore.close();
  registry.close();
  db.close();
});

test('VirtualPersonRuntime + ChatService: structured deliver_reply beats, fallback wrap, pipelined radio synthesis/duck lease, and mid-stream cancel', async () => {
  const { REPLY_CAPABILITY, registerDeliverReplyTool } = await import('./replyBeats.js');
  const { VirtualPersonChatService } = await import('./VirtualPersonChatService.js');

  let modeCase = 'roleplay-beats';
  let step = 0;
  const h = createRuntimeHarness(async () => {
    step += 1;
    if (modeCase === 'roleplay-beats') {
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `call_rp_${step}`,
            type: 'function',
            function: {
              name: 'deliver_reply',
              arguments: JSON.stringify({
                beats: [
                  {
                    action: '把热茶推到你面前',
                    say: '记得《明年今日（2007 Live）》吗？',
                    voice: { pace: 'slow', intensity: 'soft', direction: '声音放轻带气声' },
                    pauseAfterMs: 500,
                  },
                  {
                    say: '外头刚下过雨，要不要坐近一点听完这首？',
                  },
                ],
              }),
            },
          }],
        },
      };
    }
    if (modeCase === 'roleplay-fallback') {
      return { message: { role: 'assistant', content: '窗外安静得只剩雨声。' } };
    }
    return {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: `call_radio_${step}`,
          type: 'function',
          function: {
            name: 'deliver_reply',
            arguments: JSON.stringify({
              beats: [
                { say: '今晚雨声真轻。', pauseAfterMs: 600 },
                { say: '我们接着放那首《夜曲》。', voice: { pace: 'lively', intensity: 'warm', direction: '语气明亮微抬' }, pauseAfterMs: 700 },
                { say: '慢慢听着就好。' },
              ],
            }),
          },
        }],
      },
    };
  }, {
    registerTools: tools => registerDeliverReplyTool(tools),
    capabilityResolver: () => [REPLY_CAPABILITY],
  });

  try {
    const roleplayRoom = h.conversationStore.createRoom({
      title: '私语测试', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });
    await h.chatService.handleChat({ sessionId: roleplayRoom.sessionId, requestId: 'req-rp-1', message: '今晚有点冷' });
    assert.equal(h.synthCalls.length, 0);
    assert.equal(h.publishedSnapshots.at(-1).overlayNarrations, undefined);
    const msg1 = h.publishedSnapshots.at(-1).message;
    assert.equal(msg1.beats.length, 2);
    assert.equal(msg1.beats[0].action, '把热茶推到你面前');
    assert.equal(msg1.beats[0].say, '记得《明年今日（2007 Live）》吗？');
    assert.equal(msg1.beats[0].pauseAfterMs, 500);
    assert.equal(msg1.beats[1].pauseAfterMs, 0);
    assert.deepEqual(msg1.beatProgress, { deliveredCount: 2, totalCount: 2, done: true });
    assert.equal(msg1.voice.status, 'missing');
    assert.equal(msg1.voice.beats.length, 2);
    const rpAllTurns = h.conversationStore.listTurns(roleplayRoom.sessionId, { limit: 50, visibleOnly: false });
    assert.equal(rpAllTurns.some(t => JSON.stringify(t.message).includes('deliver_reply')), false);

    modeCase = 'roleplay-fallback';
    await h.chatService.handleChat({ sessionId: roleplayRoom.sessionId, requestId: 'req-rp-2', message: '你看窗外' });
    assert.equal(h.synthCalls.length, 0);
    const msg2 = h.publishedSnapshots.at(-1).message;
    assert.equal(msg2.beats.length, 1);
    assert.equal(msg2.beats[0].say, '窗外安静得只剩雨声。');
    assert.equal(msg2.beats[0].pauseAfterMs, 0);

    modeCase = 'radio-multi';
    h.publishedSnapshots.length = 0;
    h.synthCalls.length = 0;
    const radioRoom = h.conversationStore.createRoom({
      title: '电台测试', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'radio',
    });
    await h.chatService.handleChat({ sessionId: radioRoom.sessionId, requestId: 'req-radio-1', message: '今晚听什么' });
    assert.equal(h.synthCalls.length, 3);
    assert.deepEqual(h.synthCalls[1].performance, { emotion: 'warm', pace: 'fast', direction: '语气明亮微抬' });
    assert.equal(h.publishedSnapshots.length, 3);
    const radioTurnId = h.publishedSnapshots[0].message.turnId;
    assert.deepEqual(h.publishedSnapshots[0].message.beatProgress, { deliveredCount: 1, totalCount: 3, done: false });
    assert.equal(h.publishedSnapshots[0].message.beats.length, 1);
    assert.equal(h.publishedSnapshots[0].overlayNarrations[0].beatIndex, 0);
    assert.equal(h.publishedSnapshots[0].overlayNarrations[0].beatCount, 3);
    assert.equal(h.publishedSnapshots[0].overlayNarrations[0].isLastBeat, false);
    assert.equal(h.publishedSnapshots[0].overlayNarrations[0].delayBeforeMs, 0);
    assert.equal(h.publishedSnapshots[0].overlayNarrations[0].turnDuckLeaseId, radioTurnId);
    assert.equal(h.publishedSnapshots[0].overlayNarrations[0].holdDuckLease, true);

    assert.deepEqual(h.publishedSnapshots[1].message.beatProgress, { deliveredCount: 2, totalCount: 3, done: false });
    assert.equal(h.publishedSnapshots[1].overlayNarrations[0].beatIndex, 1);
    assert.equal(h.publishedSnapshots[1].overlayNarrations[0].delayBeforeMs, 600);
    assert.equal(h.publishedSnapshots[1].overlayNarrations[0].holdDuckLease, true);

    assert.deepEqual(h.publishedSnapshots[2].message.beatProgress, { deliveredCount: 3, totalCount: 3, done: true });
    assert.equal(h.publishedSnapshots[2].overlayNarrations[0].beatIndex, 2);
    assert.equal(h.publishedSnapshots[2].overlayNarrations[0].delayBeforeMs, 700);
    assert.equal(h.publishedSnapshots[2].overlayNarrations[0].isLastBeat, true);
    assert.equal(h.publishedSnapshots[2].overlayNarrations[0].holdDuckLease, false);

    const storedRadio = h.conversationStore.getTurn(radioTurnId);
    assert.equal(storedRadio.message.beats[0].hash, 'hash_1');
    assert.equal(storedRadio.message.beats[2].audioUrl, '/tts/hash_3.wav');

    // 中途 !isCurrent() 取消：跳过未启动拍的合成，并发出含全量 beats、done=true 且无 overlayNarrations 的兜底快照。
    let currentFlag = true;
    const cancelSnapshots = [];
    let cancelSynthCalls = 0;
    const cancelChat = new VirtualPersonChatService({
      runtime: {
        isPresentationCurrent: () => currentFlag,
        async handleTurn() {
          return {
            ok: true,
            requestId: 'req-cancel',
            sessionId: radioRoom.sessionId,
            roundId: 'round-cancel',
            virtualPersonId: 'lunara',
            presentation: {
              displayText: '第一拍\n\n第二拍\n\n第三拍',
              spokenText: '第一拍 第二拍 第三拍',
              speak: true,
              virtualPersonId: 'lunara',
              voiceProfileId: 'v1',
              sourceTurnId: 'turn-cancel-1',
              correlationId: 'req-cancel',
              expiresAt: Date.now() + 60_000,
              beats: [
                { index: 0, say: '第一拍', pauseAfterMs: 500 },
                { index: 1, say: '第二拍', pauseAfterMs: 500 },
                { index: 2, say: '第三拍', pauseAfterMs: 0 },
              ],
            },
          };
        },
      },
      presentationService: new PresentationService({
        synthesize: async ({ text }) => {
          cancelSynthCalls += 1;
          await new Promise(resolve => setTimeout(resolve, text === '第一拍' ? 5 : 20));
          return { url: `/tts/cancel_${cancelSynthCalls}.wav`, hash: `cancel_${cancelSynthCalls}`, durationMs: 300 };
        },
      }),
      queueService: {
        publishSnapshot: payload => {
          cancelSnapshots.push(payload);
          if (payload.overlayNarrations?.length) currentFlag = false;
        },
      },
    });
    await cancelChat.handleChat({ sessionId: radioRoom.sessionId, requestId: 'req-cancel', message: '继续' });
    assert.ok(cancelSynthCalls <= 2, '取消后不得启动第 3 拍合成');
    const lastCancel = cancelSnapshots.at(-1);
    assert.equal(lastCancel.message.beats.length, 3);
    assert.deepEqual(lastCancel.message.beatProgress, { deliveredCount: 3, totalCount: 3, done: true });
    assert.equal(lastCancel.overlayNarrations, undefined);
  } finally {
    h.close();
  }
});

test('VirtualPersonRuntime emits phase=music activity ONLY when a music tool is proposed', async () => {
  let step = 0;
  let toolMode = 'memory';
  const h = createRuntimeHarness(async () => {
    step += 1;
    if (step % 2 === 1) {
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `call-${step}`,
            type: 'function',
            function: { name: toolMode === 'music' ? 'select_music' : 'remember_person_fact', arguments: '{}' },
          }],
        },
      };
    }
    return { message: { role: 'assistant', content: '好，这就办。' } };
  }, {
    capabilityResolver: () => ['music', 'memory'],
    registerTools: registry => {
      registry.register('select_music', {
        capability: 'music',
        definition: { description: 'select', parameters: { type: 'object', properties: {} } },
        handler: async () => ({ ok: true, code: 'NO_RESULTS', message: 'ok' }),
      });
      registry.register('remember_person_fact', {
        capability: 'memory',
        definition: { description: 'remember', parameters: { type: 'object', properties: {} } },
        handler: async () => ({ ok: true, code: 'MEMORY_SAVED', message: 'ok' }),
      });
    },
  });
  try {
    const draftEvents = [];
    await h.runtime.handleTurn({
      sessionId: 'conversation:primary', requestId: 'req-mem', userText: '记住我喜欢下雨天',
      speak: false, mode: 'text_stream', onDraft: event => draftEvents.push(event),
    });
    assert.equal(h.activities.some(a => a.phase === 'music'), false);
    assert.equal(draftEvents.some(d => d.type === 'activity' && d.phase === 'music'), false);

    toolMode = 'music';
    h.activities.length = 0;
    draftEvents.length = 0;
    await h.runtime.handleTurn({
      sessionId: 'conversation:primary', requestId: 'req-music', userText: '放一首爵士',
      speak: false, mode: 'text_stream', onDraft: event => draftEvents.push(event),
    });
    assert.equal(h.activities.some(a => a.state === 'composing' && a.phase === 'music'), true);
    assert.equal(draftEvents.some(d => d.type === 'activity' && d.phase === 'music'), true);
  } finally {
    h.close();
  }
});

test('VirtualPersonService + routes: interactionMode syncs playback companion mode, on-demand speech dedups/persists, touch checks disk, and deleteRoom/rewind purge unshared audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-vps-speech-'));
  const cacheDir = join(dir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const db = new Database(join(dir, 'state.db'));
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const submittedEvents = [];
  let failSynth = false;
  let synthCount = 0;
  let synthResolver = null;
  let pinnedSet = new Set();

  const lifecycle = createTtsAssetLifecycle({
    cacheDir,
    conversationStore,
    listPinnedTurnIds: () => pinnedSet,
  });

  const service = new VirtualPersonService({
    registry,
    conversationStore,
    playbackRuntime: {
      snapshot: () => ({ activeListeningSessionId: 'conversation:primary', pendingSwitch: null }),
      submit: async event => { submittedEvents.push(event); return { accepted: true }; },
    },
    ttsLifecycle: lifecycle,
    synthesizeSpeech: async ({ text }) => {
      synthCount += 1;
      if (failSynth) throw new Error('upstream sk-secret-key failed');
      const idx = synthCount;
      const hash = `h_${idx}_${text.length}`;
      const path = join(cacheDir, `${hash}.wav`);
      if (synthResolver) await synthResolver();
      writeFileSync(path, Buffer.alloc(64, 0x11));
      return { url: `/tts/${hash}.wav`, hash, durationMs: 900, source: 'mock' };
    },
  }).initialize();

  const app = fakeApp();
  registerVirtualPersonRoutes(app, { virtualPersonService: service });

  try {
    const room = await service.createRoom({
      title: '私语小窝', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });
    assert.equal(room.interactionMode, 'roleplay');
    assert.ok(submittedEvents.some(e => e.type === 'COMPANION_MODE_CHANGED' && e.listeningSessionId === room.sessionId && e.modeId === 'music_only' && Boolean(e.requestId)));

    await service.updateRoom(room.sessionId, { interactionMode: 'radio' });
    assert.ok(submittedEvents.some(e => e.type === 'COMPANION_MODE_CHANGED' && e.listeningSessionId === room.sessionId && e.modeId === null && Boolean(e.requestId)));

    // 插入两轮助手消息：一轮带台词与动作，一轮纯动作。
    conversationStore.beginRequest({ requestId: 'r-speech', sessionId: room.sessionId, virtualPersonId: 'lunara', userText: '嗨' });
    const speechTurn = conversationStore.completeRequest({
      requestId: 'r-speech',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '（托腮）今晚的风很轻。',
        segments: [{ type: 'action', content: '（托腮）' }, { type: 'speech', content: '今晚的风很轻。' }],
        voice: { spokenText: '今晚的风很轻。', voiceProfileId: null },
      },
      result: { ok: true },
    }).turn;

    conversationStore.beginRequest({ requestId: 'r-act', sessionId: room.sessionId, virtualPersonId: 'lunara', userText: '嗯' });
    const actionTurn = conversationStore.completeRequest({
      requestId: 'r-act',
      virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '（只是笑了笑）', segments: [{ type: 'action', content: '（只是笑了笑）' }] },
      result: { ok: true },
    }).turn;

    const transcript = service.transcript(room.sessionId).filter(item => item.role === 'assistant');
    assert.deepEqual(transcript[0].voice, { canSynthesize: true, status: 'missing', url: null, audioUrl: null, durationMs: null });
    assert.equal(transcript[1].voice, undefined);

    // 409 on action-only turn
    const actRes = fakeResponse();
    await app.routes.get('POST /api/conversations/:sessionId/turns/:turnId/speech')(
      { params: { sessionId: room.sessionId, turnId: actionTurn.turnId } }, actRes,
    );
    assert.equal(actRes.statusCode, 409);

    // 503 safe error shielding on provider failure
    failSynth = true;
    const failRes = fakeResponse();
    await app.routes.get('POST /api/conversations/:sessionId/turns/:turnId/speech')(
      { params: { sessionId: room.sessionId, turnId: speechTurn.turnId } }, failRes,
    );
    assert.equal(failRes.statusCode, 503);
    assert.doesNotMatch(failRes.body.error, /sk-secret-key/);

    // 并发单飞去重 + 持久化
    failSynth = false;
    synthCount = 0;
    let release;
    synthResolver = () => new Promise(resolve => { release = resolve; });
    const r1 = fakeResponse();
    const r2 = fakeResponse();
    const p1 = app.routes.get('POST /api/conversations/:sessionId/turns/:turnId/speech')(
      { params: { sessionId: room.sessionId, turnId: speechTurn.turnId } }, r1,
    );
    const p2 = app.routes.get('POST /api/conversations/:sessionId/turns/:turnId/speech')(
      { params: { sessionId: room.sessionId, turnId: speechTurn.turnId } }, r2,
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await Promise.all([p1, p2]);
    assert.equal(synthCount, 1);
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.body.audioUrl, r1.body.audioUrl);
    synthResolver = null;

    // touch 续命与磁盘缺失检测
    const audioPath = join(cacheDir, r1.body.audioUrl.replace('/tts/', ''));
    const oldTs = new Date(Date.now() - 10_000);
    utimesSync(audioPath, oldTs, oldTs);
    const mtimeBefore = statSync(audioPath).mtimeMs;
    const touchRes = fakeResponse();
    await app.routes.get('POST /api/conversations/:sessionId/turns/:turnId/speech/touch')(
      { params: { sessionId: room.sessionId, turnId: speechTurn.turnId } }, touchRes,
    );
    assert.equal(touchRes.body.exists, true);
    assert.ok(statSync(audioPath).mtimeMs > mtimeBefore);

    // deleteRoom 定向删除未共享、未 pin 音频
    await service.deleteRoom(room.sessionId);
    assert.equal(existsSync(audioPath), false);

    // 若被手账 pinned，则即使 deleteRoom 也不删除文件
    const roomPinned = await service.createRoom({ title: '收藏房', memberIds: ['lunara'], hostId: 'lunara' });
    conversationStore.beginRequest({ requestId: 'r-pin', sessionId: roomPinned.sessionId, virtualPersonId: 'lunara', userText: '记一下' });
    const pinTurn = conversationStore.completeRequest({
      requestId: 'r-pin',
      virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '这句留着', voice: { spokenText: '这句留着' } },
      result: { ok: true },
    }).turn;
    const synthPin = await service.synthesizeTurnSpeech(roomPinned.sessionId, pinTurn.turnId);
    const pinPath = join(cacheDir, synthPin.audioUrl.replace('/tts/', ''));
    pinnedSet = new Set([pinTurn.turnId]);
    await service.deleteRoom(roomPinned.sessionId);
    assert.equal(existsSync(pinPath), true);

    // 历史私语消息曾把行内动作算进 spokenText/audioUrl：transcript 实时重算行内 segments 并退回 missing，
    // 点击生成语音时仅以纯台词重新合成并清除旧的脏音频文件。
    const roomLegacy = await service.createRoom({
      title: '历史净化', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });
    const staleHash = 'stale_dirty_inline';
    const stalePath = join(cacheDir, `${staleHash}.wav`);
    writeFileSync(stalePath, Buffer.alloc(64, 0x22));
    conversationStore.beginRequest({ requestId: 'r-stale', sessionId: roomLegacy.sessionId, virtualPersonId: 'lunara', userText: '说吧' });
    const staleTurn = conversationStore.completeRequest({
      requestId: 'r-stale',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '（点头）\n\n“那是我的事。”我抬眼看你，“别拿这个当话柄。”',
        segments: [
          { type: 'action', content: '（点头）' },
          { type: 'speech', content: '“那是我的事。”我抬眼看你，“别拿这个当话柄。”' },
        ],
        voice: {
          spokenText: '那是我的事。 我抬眼看你， 别拿这个当话柄。',
          audioUrl: `/tts/${staleHash}.wav`,
          hash: staleHash,
          durationMs: 1200,
        },
      },
      result: { ok: true },
    }).turn;
    const legacyTranscript = service.transcript(roomLegacy.sessionId).find(t => t.turnId === staleTurn.turnId);
    assert.equal(legacyTranscript.voice.status, 'missing');
    assert.equal(legacyTranscript.voice.audioUrl, null);
    assert.ok(legacyTranscript.segments.some(s => s.type === 'action' && s.inline && s.content === '我抬眼看你，'));

    const synthTexts = [];
    const origSynth = service.synthesizeSpeech;
    service.synthesizeSpeech = async args => {
      synthTexts.push(args.text);
      return origSynth(args);
    };
    const resynth = await service.synthesizeTurnSpeech(roomLegacy.sessionId, staleTurn.turnId);
    assert.equal(synthTexts.length, 1);
    assert.deepEqual(synthTexts, ['那是我的事。 别拿这个当话柄。']);
    assert.notEqual(resynth.audioUrl, `/tts/${staleHash}.wav`);
    assert.equal(existsSync(stalePath), false);
    const updatedTranscript = service.transcript(roomLegacy.sessionId).find(t => t.turnId === staleTurn.turnId);
    assert.equal(updatedTranscript.voice.status, 'ready');
    assert.equal(updatedTranscript.voice.audioUrl, resynth.audioUrl);

    // 结构化多拍按需合成：按拍独立传参、单拍失败或磁盘被淘汰后仅补合缺失拍。
    const capturedCalls = [];
    service.synthesizeSpeech = async args => {
      capturedCalls.push(args);
      return origSynth(args);
    };
    const roomBeats = await service.createRoom({
      title: '分拍按需合成', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });
    conversationStore.beginRequest({ requestId: 'r-beats', sessionId: roomBeats.sessionId, virtualPersonId: 'lunara', userText: '今晚放哪首' });
    const beatsTurn = conversationStore.completeRequest({
      requestId: 'r-beats',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '（托腮）\n第一句《明年今日（2007 Live）》\n\n第二句晚安。',
        beats: [
          {
            index: 0,
            action: '托腮',
            say: '第一句《明年今日（2007 Live）》',
            voice: { pace: 'slow', intensity: 'soft', direction: '气声偏多一点' },
            pauseAfterMs: 650,
          },
          {
            index: 1,
            say: '第二句晚安。',
            pauseAfterMs: 0,
          },
        ],
      },
      result: { ok: true },
    }).turn;

    const beforeBeatsView = service.transcript(roomBeats.sessionId).find(t => t.turnId === beatsTurn.turnId);
    assert.equal(beforeBeatsView.beats.length, 2);
    assert.equal(beforeBeatsView.voice.status, 'missing');
    assert.equal(beforeBeatsView.voice.beats.length, 2);

    const firstSynth = await service.synthesizeTurnSpeech(roomBeats.sessionId, beatsTurn.turnId);
    assert.equal(capturedCalls.length, 2);
    assert.equal(capturedCalls.every(c => c.allowFallback === false), true);
    const callByText = new Map(capturedCalls.map(c => [c.text, c]));
    assert.deepEqual(callByText.get('第一句《明年今日（2007 Live）》').performance, {
      pace: 'slow',
      intensity: 'soft',
      direction: '气声偏多一点',
    });
    assert.equal(callByText.get('第二句晚安。').performance, undefined);
    assert.equal(firstSynth.cached, false);
    assert.equal(firstSynth.beats.length, 2);
    assert.ok(firstSynth.beats[0].audioUrl && firstSynth.beats[1].audioUrl);

    const readyView = service.transcript(roomBeats.sessionId).find(t => t.turnId === beatsTurn.turnId);
    assert.equal(readyView.voice.status, 'ready');
    const touchReady = service.touchTurnSpeech(roomBeats.sessionId, beatsTurn.turnId);
    assert.equal(touchReady.exists, true);
    assert.equal(touchReady.touched, true);

    // 仅删掉第 2 拍磁盘缓存，保留第 1 拍：touch 报 exists=false 且仅清失效拍，点播只补合缺失的第 2 拍。
    rmSync(join(cacheDir, firstSynth.beats[1].audioUrl.replace('/tts/', '')));
    const touchPartial = service.touchTurnSpeech(roomBeats.sessionId, beatsTurn.turnId);
    assert.equal(touchPartial.exists, false);
    assert.equal(touchPartial.touched, false);
    assert.equal(touchPartial.beats[0].audioUrl, firstSynth.beats[0].audioUrl);
    assert.equal(touchPartial.beats[1].audioUrl, undefined);
    const partialView = service.transcript(roomBeats.sessionId).find(t => t.turnId === beatsTurn.turnId);
    assert.equal(partialView.voice.status, 'partial');

    capturedCalls.length = 0;
    const incrementalSynth = await service.synthesizeTurnSpeech(roomBeats.sessionId, beatsTurn.turnId);
    assert.equal(capturedCalls.length, 1);
    assert.equal(capturedCalls[0].text, '第二句晚安。');
    assert.equal(incrementalSynth.beats[0].audioUrl, firstSynth.beats[0].audioUrl);
    assert.notEqual(incrementalSynth.beats[1].audioUrl, firstSynth.beats[1].audioUrl);
    assert.equal(service.touchTurnSpeech(roomBeats.sessionId, beatsTurn.turnId).exists, true);

    // P0-1: marker-only / punctuation-only beats ({叹气} + "……") are treated as non-speakable consistently
    // across transcript, updateTurnVoice, synthesizeTurnSpeech (with toPlainText-enforcing synth returning null), and touchTurnSpeech.
    capturedCalls.length = 0;
    service.synthesizeSpeech = async args => {
      if (!toPlainText(String(args.text || '').trim())) return null;
      capturedCalls.push(args);
      return origSynth(args);
    };
    const silentMixRoom = await service.createRoom({
      title: '静默拍与表演拍混排', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });
    conversationStore.beginRequest({ requestId: 'r-mix-p01', sessionId: silentMixRoom.sessionId, virtualPersonId: 'lunara', userText: '你怎么不说话' });
    const mixedSilentTurn = conversationStore.completeRequest({
      requestId: 'r-mix-p01',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '（叹气）\n……\n\n你终于肯回我了。',
        beats: [
          { index: 0, action: '叹气', say: '……', spoken: '{叹气}', pauseAfterMs: 500 },
          { index: 1, say: '你终于肯回我了。', spoken: '{叹气}你终于肯回我了。', pauseAfterMs: 0 },
        ],
      },
      result: { ok: true },
    }).turn;

    const mixedViewBefore = service.transcript(silentMixRoom.sessionId).find(t => t.turnId === mixedSilentTurn.turnId);
    assert.deepEqual(mixedViewBefore.voice.beats, [
      { index: 0, canSynthesize: false, status: 'none', audioUrl: null, durationMs: null },
      { index: 1, canSynthesize: true, status: 'missing', audioUrl: null, durationMs: null },
    ]);

    const mixedSynth = await service.synthesizeTurnSpeech(silentMixRoom.sessionId, mixedSilentTurn.turnId);
    assert.equal(capturedCalls.length, 1);
    assert.equal(capturedCalls[0].text, '{叹气}你终于肯回我了。');
    assert.ok(mixedSynth.audioUrl);
    const storedAfterMixed = conversationStore.getTurn(mixedSilentTurn.turnId);
    assert.equal(storedAfterMixed.message.voice.audioUrl, mixedSynth.audioUrl);
    assert.equal(service.touchTurnSpeech(silentMixRoom.sessionId, mixedSilentTurn.turnId).exists, true);
    const cachedMixed = await service.synthesizeTurnSpeech(silentMixRoom.sessionId, mixedSilentTurn.turnId);
    assert.equal(cachedMixed.cached, true);
    assert.equal(capturedCalls.length, 1);

    conversationStore.beginRequest({ requestId: 'r-pure-silent', sessionId: silentMixRoom.sessionId, virtualPersonId: 'lunara', userText: '嗯' });
    const pureSilentTurn = conversationStore.completeRequest({
      requestId: 'r-pure-silent',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '（叹气）\n……',
        beats: [{ index: 0, action: '叹气', say: '……', spoken: '{叹气}', pauseAfterMs: 0 }],
      },
      result: { ok: true },
    }).turn;
    const pureSilentView = service.transcript(silentMixRoom.sessionId).find(t => t.turnId === pureSilentTurn.turnId);
    assert.equal(pureSilentView.voice, undefined);
    await assert.rejects(
      () => service.synthesizeTurnSpeech(silentMixRoom.sessionId, pureSilentTurn.turnId),
      err => err?.statusCode === 409 && err?.code === 'turn_has_no_speech',
    );

    // 历史遗留：纯文本多段兜底被误塞进 single-beat say 且缓存了含括号旧音频 -> 自动纠偏拆动作、使旧音频失效、只合成纯台词并清掉 beats
    capturedCalls.length = 0;
    service.synthesizeSpeech = async args => {
      capturedCalls.push(args);
      return origSynth(args);
    };
    const legacyBadRoom = await service.createRoom({
      title: '兜底旧消息自愈', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });
    const oldBadPath = join(cacheDir, 'legacy_bad_paren.wav');
    writeFileSync(oldBadPath, Buffer.alloc(64, 0x22));
    const pollutedText = '（我侧过脸，耳尖烫着，声音压得很低）\n短裙下面……轻一点揉。\n\n（我把额头抵在你肩上）\n今早我没穿别的。';
    conversationStore.beginRequest({ requestId: 'r-bad-fallback', sessionId: legacyBadRoom.sessionId, virtualPersonId: 'lunara', userText: '过来' });
    const badFallbackTurn = conversationStore.completeRequest({
      requestId: 'r-bad-fallback',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: pollutedText,
        beats: [{ index: 0, say: pollutedText, pauseAfterMs: 0, audioUrl: '/tts/legacy_bad_paren.wav', hash: 'legacy_bad_paren', durationMs: 800 }],
        voice: { spokenText: pollutedText, audioUrl: '/tts/legacy_bad_paren.wav', hash: 'legacy_bad_paren', durationMs: 800 },
      },
      result: { ok: true },
    }).turn;

    const healedViewBefore = service.transcript(legacyBadRoom.sessionId).find(t => t.turnId === badFallbackTurn.turnId);
    assert.equal(healedViewBefore.beats, undefined);
    assert.ok(Array.isArray(healedViewBefore.segments) && healedViewBefore.segments.some(s => s.type === 'action'));
    assert.equal(healedViewBefore.voice.status, 'missing');
    assert.equal(service.touchTurnSpeech(legacyBadRoom.sessionId, badFallbackTurn.turnId).exists, false);

    await service.synthesizeTurnSpeech(legacyBadRoom.sessionId, badFallbackTurn.turnId);
    assert.equal(capturedCalls.length, 1);
    assert.doesNotMatch(capturedCalls[0].text, /侧过脸|额头抵在/);
    assert.match(capturedCalls[0].text, /短裙下面.*今早我没穿别的/);
    const healedStored = conversationStore.getTurn(badFallbackTurn.turnId);
    assert.equal(healedStored.message.beats, undefined);
    assert.equal(service.touchTurnSpeech(legacyBadRoom.sessionId, badFallbackTurn.turnId).exists, true);
  } finally {
    conversationStore.close();
    registry.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VirtualPersonRuntime corrects roleplay plain-text stage directions into deliver_reply beats and strips parens if fallback still occurs', async () => {
  const { REPLY_CAPABILITY, registerDeliverReplyTool } = await import('./replyBeats.js');

  let mode = 'auto-correct';
  let llmRound = 0;
  let capturedRetryPrompt = '';
  const h = createRuntimeHarness(async messages => {
    llmRound += 1;
    if (mode === 'auto-correct') {
      if (llmRound === 1) {
        return {
          message: {
            role: 'assistant',
            content: '（我侧过脸，耳尖烫着）\n……你手别那么用力。\n\n（我把额头抵在你肩上）\n今早我没穿别的。',
          },
        };
      }
      capturedRetryPrompt = messages.at(-1)?.content || '';
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_fix_rp',
            type: 'function',
            function: {
              name: 'deliver_reply',
              arguments: JSON.stringify({
                beats: [
                  { action: '我侧过脸，耳尖烫着', say: '……你手别那么用力。', pauseAfterMs: 650 },
                  { action: '我把额头抵在你肩上', say: '今早我没穿别的。', pauseAfterMs: 0 },
                ],
              }),
            },
          }],
        },
      };
    }
    return {
      message: {
        role: 'assistant',
        content: '（我轻轻拉住你的衣袖）\n别走太快。',
      },
    };
  }, {
    registerTools: tools => registerDeliverReplyTool(tools),
    capabilityResolver: () => [REPLY_CAPABILITY],
  });

  try {
    const rpRoom = h.conversationStore.createRoom({
      title: '私语纯文本纠偏', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay',
    });

    const fixed = await h.chatService.handleChat({
      sessionId: rpRoom.sessionId, requestId: 'req-rp-fix', message: '抱抱', speak: false,
    });
    assert.equal(llmRound, 2);
    assert.match(capturedRetryPrompt, /deliver_reply/);
    assert.equal(fixed.ok, true);
    const snap1 = h.publishedSnapshots.at(-1).message;
    assert.equal(snap1.beats.length, 2);
    assert.equal(snap1.beats[0].action, '我侧过脸，耳尖烫着');
    assert.equal(snap1.beats[0].say, '……你手别那么用力。');
    assert.equal(snap1.beats[1].action, '我把额头抵在你肩上');
    assert.equal(snap1.beats[1].say, '今早我没穿别的。');

    // Even if all rounds ignore deliver_reply and end in bracketed fallback text, never store polluted beats and strip actions from TTS spokenText.
    // replay-replies-as-delivered-beats：纯文本兜底按私语解析器拆成干净的 action/say 分拍再入账。
    mode = 'stubborn-plain';
    llmRound = 0;
    const fallbackRes = await h.runtime.handleTurn({
      sessionId: rpRoom.sessionId, requestId: 'req-rp-stubborn', userText: '嗯', speak: false,
    });
    const storedStubborn = h.conversationStore.getTurn(fallbackRes.sourceTurnId);
    assert.deepEqual(storedStubborn.message.beats, [{ index: 0, action: '我轻轻拉住你的衣袖', say: '别走太快。', pauseAfterMs: 0 }]);
    assert.equal(storedStubborn.message.voice.spokenText, '别走太快。');
  } finally {
    h.close();
  }
});
