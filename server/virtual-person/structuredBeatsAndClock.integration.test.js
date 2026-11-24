// structuredBeatsAndClock.integration.test.js
// OpenSpec: add-structured-beats-and-real-clock-presence 跨层端到端集成测试。
//
// 使用真实 ConversationStore (SQLite)、VirtualPersonRuntime、AgentLoop、
// TurnContextAssembler、PromptAssembler、VirtualPersonChatService、VirtualPersonService、
// PlaybackRuntimeHost、createPresenceWiring、AppOpenGreeter、AmbientPresence 与 server/tts.js，
// 仅对外部 LLM 与底层 TTS provider 做可控本地替身（零真实网络请求）。
process.env.TZ = 'Asia/Shanghai';

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentLoop } from './AgentLoop.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { ConversationStore, presenceTurnId } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonChatService } from './VirtualPersonChatService.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonService } from './VirtualPersonService.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { turnContextOf } from './contextBlocks.js';
import { registerMusicTools } from './musicTools.js';
import {
  DELIVER_REPLY_TOOL_NAME,
  MAX_VOICE_DIRECTION_CHARS,
  REPLY_CAPABILITY,
  registerDeliverReplyTool,
} from './replyBeats.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { AMBIENT_CAPABILITY, registerAmbientTools } from '../presence/ambientTools.js';
import { createPresenceWiring } from '../presence/createPresenceWiring.js';
import { createTtsGateway, LONG_SPEECH_CHUNK_LIMIT, LONG_SPEECH_THRESHOLD } from '../tts.js';
import { createTtsAudio } from '../tts/TtsProvider.js';
import { TtsProviderRegistry } from '../tts/TtsProviderRegistry.js';
import { createTtsAssetLifecycle } from '../tts/ttsAssetLifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePcmWav(sampleCount = 1600, { sampleRate = 16000, channels = 1, amplitude = 1200 } = {}) {
  const dataSize = sampleCount * channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount * channels; i += 1) {
    const sample = Math.round(amplitude * Math.sin((i % 32) / 32 * Math.PI * 2));
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

function deliverReplyResponse(id, beats) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name: DELIVER_REPLY_TOOL_NAME,
          arguments: JSON.stringify({ beats }),
        },
      }],
    },
    finishReason: 'tool_calls',
  };
}

function toolCallResponse(id, name, args) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      }],
    },
    finishReason: 'tool_calls',
  };
}

function multiToolCallResponse(calls) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: calls.map(({ id, name, args }) => ({
        id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      })),
    },
    finishReason: 'tool_calls',
  };
}

// ---------------------------------------------------------------------------
// 用例组 1：roleplay 多拍全链路 + 240 字整拍不切分 + 纯气口拍安全跳过与缓存重听
// ---------------------------------------------------------------------------
test('用例组 1：roleplay 多拍结构化提交、165 字含括号歌名整拍直出、{叹气} 拍安全跳过与缓存命中', async () => {
  assert.equal(LONG_SPEECH_THRESHOLD, 240);
  assert.equal(LONG_SPEECH_CHUNK_LIMIT, 220);

  const dir = mkdtempSync(join(tmpdir(), 'lunara-sb-case1-'));
  const dbPath = join(dir, 'state.db');
  const cacheDir = join(dir, 'tts-cache');
  mkdirSync(cacheDir, { recursive: true });

  const nowMs = Date.UTC(2026, 10, 23, 2, 0, 0); // 2026-11-23 10:00 Asia/Shanghai
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath, now: () => nowMs }).initialize();
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerDeliverReplyTool(tools);

  const providerCalls = [];
  const ttsRegistry = new TtsProviderRegistry({
    providers: [{
      id: 'mock-wav',
      label: 'Mock WAV',
      isConfigured: () => true,
      listVoices: async () => [{ id: 'v_zh_1', name: 'V1' }],
      synth: async (text, opts) => {
        providerCalls.push({ text, opts });
        return createTtsAudio({
          bytes: makePcmWav(1600),
          extension: 'wav',
          source: 'mock-wav',
          durationMs: 420,
        });
      },
    }],
  });
  const ttsGateway = createTtsGateway({ registry: ttsRegistry, cacheDir, initialVoice: 'v_zh_1' });
  const ttsLifecycle = createTtsAssetLifecycle({ cacheDir, conversationStore });

  const beat1Say = '窗外的雨丝斜斜打在玻璃上，我刚刚顺手翻起那张旧唱片封套，忽然就想起《明年今日（2007 Live）》里那段微哑却克制的钢琴前奏，听众席间轻轻响起的呼吸声隔着多年依然清楚。人一忙起来就容易错过这种安静的夜色，你今天在外面奔波到现在才回来，肩膀一定早发沉了，不如先把外套搭在椅背上，靠过来听会儿雨声缓一缓神。';
  assert.ok([...beat1Say].length > 140 && [...beat1Say].length <= 240, `expected 141..240 chars, got ${[...beat1Say].length}`);

  const chatCalls = [];
  const chat = async (messages, definitions) => {
    chatCalls.push({ messages: structuredClone(messages), definitions });
    return deliverReplyResponse('call_rp_3beats', [
      {
        action: '垂眸靠在窗边',
        say: '……',
        spoken: '{叹气}',
        pauseAfterMs: 500,
      },
      {
        action: '指尖轻轻摩挲着温热的杯壁',
        say: beat1Say,
        voice: { pace: 'slow', intensity: 'soft', direction: '贴耳低哑气声' },
        pauseAfterMs: 700,
      },
      {
        say: '夜还长，你先歇口气，我就在这儿陪着你。',
        voice: { pace: 'slow', intensity: 'soft', direction: '贴耳低哑气声' },
      },
    ]);
  };

  const budgeter = new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const presentationService = new PresentationService({
    synthesize: input => ttsGateway.synth(input.text, {
      voiceId: input.voiceProfileId || 'v_zh_1',
      performance: input.performance || null,
    }),
  });
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date(nowMs) }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService,
    capabilityResolver: () => [REPLY_CAPABILITY],
    retrieveMemories: async () => [],
    getRuntimeState: () => null,
    logger: { error() {}, warn() {} },
  }).initialize();

  const publishedSnapshots = [];
  const chatService = new VirtualPersonChatService({
    runtime,
    presentationService,
    conversationStore,
    queueService: { publishSnapshot: payload => publishedSnapshots.push(payload) },
    logger: { error() {}, warn() {} },
  });

  const vpService = new VirtualPersonService({
    registry,
    conversationStore,
    ttsLifecycle,
    synthesizeSpeech: input => ttsGateway.synth(input.text, {
      voiceId: input.voiceProfileId || 'v_zh_1',
      performance: input.performance || null,
    }),
  }).initialize();

  try {
    const room = await vpService.createRoom({
      title: '私语独处房',
      memberIds: ['lunara'],
      hostId: 'lunara',
      interactionMode: 'roleplay',
    });

    const chatRes = await chatService.handleChat({
      sessionId: room.sessionId,
      requestId: 'req-rp-3beats',
      message: '外头雨下大了',
      speak: false,
    });

    assert.equal(chatRes.ok, true);
    assert.equal(chatCalls.length, 1);
    assert.equal(providerCalls.length, 0, 'roleplay 首次回复零自动 TTS 调用');
    assert.equal(publishedSnapshots.length, 1);
    assert.equal(publishedSnapshots[0].overlayNarrations, undefined);

    const allTurns = conversationStore.listTurns(room.sessionId, { limit: 50, visibleOnly: false });
    assert.equal(allTurns.length, 2, '仅存 1 条 user + 1 条 assistant，无 deliver_reply 内部账本行');
    assert.equal(allTurns.every(t => t.visibility === 'visible'), true);
    assert.equal(allTurns.some(t => JSON.stringify(t.message).includes('deliver_reply')), false);
    assert.equal(allTurns.some(t => t.role === 'tool' || Array.isArray(t.message?.tool_calls)), false);

    const assistantTurn = allTurns[1];
    assert.equal(assistantTurn.role, 'assistant');
    assert.equal(assistantTurn.message.beats.length, 3);
    assert.equal(assistantTurn.message.beats[1].say, beat1Say);
    assert.equal(assistantTurn.message.beats[1].pauseAfterMs, 700);
    assert.equal(assistantTurn.message.beats[2].pauseAfterMs, 0);

    const deliveredMsg = publishedSnapshots[0].message;
    assert.equal(deliveredMsg.beats.length, 3);
    assert.equal(deliveredMsg.voice.status, 'missing');
    assert.deepEqual(deliveredMsg.voice.beats[0], {
      index: 0,
      canSynthesize: false,
      status: 'none',
      audioUrl: null,
      durationMs: null,
    });
    assert.equal(deliveredMsg.voice.beats[1].canSynthesize, true);
    assert.equal(deliveredMsg.voice.beats[1].status, 'missing');
    assert.equal(deliveredMsg.voice.beats[2].canSynthesize, true);
    assert.equal(deliveredMsg.voice.beats[2].status, 'missing');

    const synthRes = await vpService.synthesizeTurnSpeech(room.sessionId, assistantTurn.turnId);
    assert.equal(synthRes.cached, false);
    assert.equal(providerCalls.length, 2, '纯气口 {叹气} 拍安全跳过，第 1 拍 ~165 字整拍单次调用不拆片');
    assert.equal(providerCalls[0].text, beat1Say);
    assert.equal(providerCalls[1].text, '夜还长，你先歇口气，我就在这儿陪着你。');
    assert.equal(providerCalls.some(c => c.text.includes('垂眸') || c.text.includes('摩挲')), false);

    assert.equal(synthRes.beats.length, 3);
    assert.equal(synthRes.beats[0].audioUrl, undefined);
    assert.ok(synthRes.beats[1].audioUrl && synthRes.beats[2].audioUrl);
    assert.equal(existsSync(join(cacheDir, synthRes.beats[1].audioUrl.replace('/tts/', ''))), true);
    assert.equal(existsSync(join(cacheDir, synthRes.beats[2].audioUrl.replace('/tts/', ''))), true);

    const transcriptAfterSynth = vpService.transcript(room.sessionId).find(t => t.turnId === assistantTurn.turnId);
    assert.equal(transcriptAfterSynth.voice.status, 'ready');
    assert.equal(transcriptAfterSynth.voice.beats[0].status, 'none');
    assert.equal(transcriptAfterSynth.voice.beats[1].status, 'ready');
    assert.equal(transcriptAfterSynth.voice.beats[2].status, 'ready');

    const touchRes = vpService.touchTurnSpeech(room.sessionId, assistantTurn.turnId);
    assert.equal(touchRes.exists, true);
    assert.equal(touchRes.touched, true);

    const replaySynth = await vpService.synthesizeTurnSpeech(room.sessionId, assistantTurn.turnId);
    assert.equal(replaySynth.cached, true);
    assert.equal(providerCalls.length, 2, '全拍命中缓存不重合成');
    assert.equal(replaySynth.beats[1].audioUrl, synthRes.beats[1].audioUrl);
    assert.equal(replaySynth.beats[2].audioUrl, synthRes.beats[2].audioUrl);
  } finally {
    runtime.shutdown();
    conversationStore.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 用例组 2：现实时钟 <25m 过去时发声回显 vs >=25m 归零（含归来 3 秒内连发 2 条消息）
// ---------------------------------------------------------------------------
test('用例组 2：<25 分钟历史附带只读过去时发声回显；>=25 分钟归来连发两句仍省略回显并注入物理归零事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-sb-case2-'));
  const dbPath = join(dir, 'state.db');

  let nowMs = Date.UTC(2026, 10, 23, 2, 0, 0);
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath, now: () => nowMs }).initialize();
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerDeliverReplyTool(tools);

  const capturedCalls = [];
  let scriptIndex = 0;
  let burst1Started = null;
  let burst1Release = null;

  const chat = async (messages, _definitions, options = {}) => {
    const callIdx = scriptIndex++;
    capturedCalls.push({ callIdx, messages: structuredClone(messages) });
    if (callIdx === 0) {
      return deliverReplyResponse('call_c2_1', [
        { action: '坐在地毯上翻唱片', say: '刚才风好大。', pauseAfterMs: 500 },
        { say: '你要不要先把伞收起来？', voice: { pace: 'slow', intensity: 'soft', direction: '贴耳低哑气声' } },
      ]);
    }
    if (callIdx === 1) {
      return deliverReplyResponse('call_c2_2', [
        {
          action: '忽然转头望向厨房',
          say: '等我一下，炉子上的水好像烧开了——',
          voice: { pace: 'lively', intensity: 'warm', direction: '呼吸微促贴近耳畔' },
        },
      ]);
    }
    if (callIdx === 2) {
      burst1Started?.resolve();
      await new Promise(resolve => {
        burst1Release = resolve;
        options.signal?.addEventListener('abort', resolve, { once: true });
      });
      return deliverReplyResponse('call_c2_b1_aborted', [{ say: '旧回复' }]);
    }
    return deliverReplyResponse('call_c2_b2', [
      { action: '已经关好火回到桌边', say: '水刚关上，先坐下歇歇，怎么急匆匆接电话去了？' },
    ]);
  };

  const budgeter = new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const presentationService = new PresentationService();
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date(nowMs) }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService,
    capabilityResolver: () => [REPLY_CAPABILITY],
    retrieveMemories: async () => [],
    getRuntimeState: () => null,
    logger: { error() {}, warn() {} },
  }).initialize();

  const publishedSnapshots = [];
  const chatService = new VirtualPersonChatService({
    runtime,
    presentationService,
    conversationStore,
    queueService: { publishSnapshot: payload => publishedSnapshots.push(payload) },
    logger: { error() {}, warn() {} },
  });
  const vpService = new VirtualPersonService({ registry, conversationStore }).initialize();

  try {
    const room = await vpService.createRoom({
      title: '现实时钟测试房',
      memberIds: ['lunara'],
      hostId: 'lunara',
      interactionMode: 'roleplay',
    });

    // Turn 1
    await chatService.handleChat({
      sessionId: room.sessionId,
      requestId: 'req-c2-1',
      message: '外头风声好大',
      speak: false,
    });

    // +5 分钟（< 25m）发 Turn 2
    nowMs += 5 * 60_000;
    await chatService.handleChat({
      sessionId: room.sessionId,
      requestId: 'req-c2-2',
      message: '你刚才手里端着什么？',
      speak: false,
    });

    const call2Messages = capturedCalls[1].messages;
    const call2AssistantMsgs = call2Messages.filter(m => m.role === 'assistant');
    assert.equal(call2AssistantMsgs.length, 1, '2 拍历史应合并投影为 1 条 assistant 消息');
    // 分拍历史以 deliver_reply 调用回放，发声状态回显随「已送达」工具结果给出（replay-replies-as-delivered-beats）。
    assert.equal(call2AssistantMsgs[0].tool_calls?.[0]?.function?.name, 'deliver_reply');
    assert.equal(JSON.parse(call2AssistantMsgs[0].tool_calls[0].function.arguments).beats.length, 2);
    const call2Result = call2Messages.find(m => m.role === 'tool' && m.tool_call_id === call2AssistantMsgs[0].tool_calls[0].id);
    assert.match(
      call2Result.content,
      /\[当时你的发声状态：贴耳低哑气声，语速偏慢，声音偏轻柔\]/,
    );
    assert.doesNotMatch(turnContextOf(call2Messages), /距这个聊天上一条消息已过/);

    // 数据库 visible_text 与前端 transcript 绝不包含 [当时你的发声状态：
    const turnsMid = conversationStore.listTurns(room.sessionId, { limit: 50, visibleOnly: false });
    assert.equal(turnsMid.some(t => t.visibleText.includes('[当时你的发声状态：')), false);
    const transcriptMid = vpService.transcript(room.sessionId);
    assert.equal(transcriptMid.some(t => t.text.includes('[当时你的发声状态：')), false);

    // +45 分钟（>= 25m）归来并在 3 秒内连发两条消息
    nowMs += 45 * 60_000;
    burst1Started = deferred();
    const pBurst1 = chatService.handleChat({
      sessionId: room.sessionId,
      requestId: 'req-burst-1',
      message: '抱歉刚才突然接了个急电',
      speak: false,
    });
    await burst1Started.promise;

    nowMs += 3_000;
    const pBurst2 = chatService.handleChat({
      sessionId: room.sessionId,
      requestId: 'req-burst-2',
      interruptRequestId: 'req-burst-1',
      message: '让你久等啦，水关好了吗？',
      speak: false,
    });

    const [res1, res2] = await Promise.all([pBurst1, pBurst2]);
    assert.equal(res1.ok, false);
    assert.equal(res2.ok, true);

    assert.equal(capturedCalls.length, 4);
    for (const call of [capturedCalls[2], capturedCalls[3]]) {
      const assistantEntries = call.messages.filter(m => m.role === 'assistant' || m.role === 'tool');
      assert.equal(
        assistantEntries.some(m => String(m.content || '').includes('[当时你的发声状态：')),
        false,
        `call ${call.callIdx} >=25m 归来必须确定性省略瞬态声态回显`,
      );
      const tc = turnContextOf(call.messages);
      assert.match(tc, /距这个聊天上一条消息已过 45 分钟/);
      assert.match(tc, /瞬态生理喘息、紧绷与半截动作现场早已自然平复归零/);
    }

    const lastBurstUser = capturedCalls[3].messages.filter(m => m.role === 'user').at(-1).content;
    assert.match(lastBurstUser, /抱歉刚才突然接了个急电[\s\S]*让你久等啦，水关好了吗？/);
  } finally {
    burst1Release?.();
    runtime.shutdown();
    conversationStore.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 用例组 3：双模式 Schema 物理隔离 + 音乐工具 beats 截断兜底 + radio 流水线与末拍无声释租
// ---------------------------------------------------------------------------
test('用例组 3：双模式 schema 隔离、音乐 beats 截断兜底、radio 首拍先发与末拍无声/null 释放租约', async () => {
  // 3.1：4 个分拍工具的双模式 schema 物理隔离 + 强传 action 硬拒绝
  const schemaRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const musicSideEffects = [];
  const fakeMusicService = {
    execute: async args => {
      musicSideEffects.push(['select', args]);
      return { ok: true, code: 'MUSIC_CANDIDATES_OFFERED', offerId: 'o1', offer: { offerId: 'o1', candidates: [] } };
    },
    commitSelection: async args => {
      musicSideEffects.push(['commit', args]);
      return { ok: true, code: 'MUSIC_COMMITTED', terminal: true, tracks: [{ title: '夜曲' }], userMessage: '已安排《夜曲》。' };
    },
  };
  registerDeliverReplyTool(schemaRegistry);
  registerMusicTools(schemaRegistry, () => fakeMusicService);
  registerAmbientTools(schemaRegistry);

  const allCaps = [REPLY_CAPABILITY, MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY, AMBIENT_CAPABILITY];
  const beatToolNames = ['deliver_reply', 'select_music', 'commit_music_selection', 'presence_respond'];

  // 单人 roleplay：4 个工具均开放 action
  const rpDefs = schemaRegistry.definitions({ capabilities: allCaps, interactionMode: 'roleplay', isGroup: false });
  for (const name of beatToolNames) {
    const def = rpDefs.find(d => d.function.name === name);
    assert.ok(def, `${name} definition exists`);
    assert.equal(Object.hasOwn(def.function.parameters.properties.beats.items.properties, 'action'), true, `${name} allows action in single roleplay`);
  }

  // radio 单聊 / radio 群聊 / roleplay 群聊：4 个工具物理省略 action
  for (const modeCase of [
    { interactionMode: 'radio', isGroup: false },
    { interactionMode: 'radio', isGroup: true },
    { interactionMode: 'roleplay', isGroup: true },
  ]) {
    const defs = schemaRegistry.definitions({ capabilities: allCaps, ...modeCase });
    for (const name of beatToolNames) {
      const def = defs.find(d => d.function.name === name);
      assert.equal(
        Object.hasOwn(def.function.parameters.properties.beats.items.properties, 'action'),
        false,
        `${name} omits action in ${JSON.stringify(modeCase)}`,
      );
    }
  }

  // 强传 action 被硬拒绝，且不执行任何音乐副作用
  const rejectPayloads = {
    deliver_reply: { beats: [{ action: '托腮', say: '你好' }] },
    select_music: { mode: 'exact', delivery: 'replace_now', targets: [{ title: '夜曲' }], beats: [{ action: '托腮', say: '挑夜曲' }] },
    commit_music_selection: { offerId: 'o1', indexes: [1], beats: [{ action: '托腮', say: '挑夜曲' }] },
    presence_respond: { action: 'speak', beats: [{ action: '托腮', say: '夜深了' }] },
  };
  for (const modeCase of [
    { interactionMode: 'radio', isGroup: false },
    { interactionMode: 'roleplay', isGroup: true },
  ]) {
    for (const name of beatToolNames) {
      const rejected = await schemaRegistry.execute(name, rejectPayloads[name], {
        capabilities: allCaps,
        ...modeCase,
        userText: '来首夜曲',
        virtualPersonId: 'lunara',
        ambientTask: { contextText: '', recentLines: [] },
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, 'INVALID_TOOL_ARGUMENTS', `${name} rejects action in ${JSON.stringify(modeCase)}`);
    }
  }
  assert.equal(musicSideEffects.length, 0);

  // 3.2 + 3.3：真实 Runtime + ChatService 端到端链路
  const dir = mkdtempSync(join(tmpdir(), 'lunara-sb-case3-'));
  const dbPath = join(dir, 'state.db');
  const nowMs = Date.UTC(2026, 10, 23, 3, 0, 0);
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath, now: () => nowMs }).initialize();
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerDeliverReplyTool(tools);
  registerMusicTools(tools, () => ({
    execute: async () => ({
      ok: true,
      code: 'MUSIC_CANDIDATES_OFFERED',
      offerId: 'offer-mj',
      request: { mode: 'discovery', delivery: 'replace_now', count: 1 },
      offer: {
        offerId: 'offer-mj',
        candidates: [{ index: 1, songId: 's_mj', title: '明年今日', artist: '陈奕迅', album: 'The Line-Up', source: 'qq', duration: 205 }],
      },
    }),
    commitSelection: async () => ({
      ok: true,
      code: 'MUSIC_COMMITTED',
      terminal: true,
      delivery: 'replace_now',
      selectedCount: 1,
      requestedCount: 1,
      tracks: [{ songId: 's_mj', title: '明年今日', artist: '陈奕迅', source: 'qq' }],
      userMessage: '已经给你排好陈奕迅的《明年今日》。',
    }),
  }));

  const overlongDirection = '中低音区气息平稳放松，收音距离适中带着一点温和胸腔共鸣感';
  assert.equal([...overlongDirection].length, 28);

  let llmMode = 'music';
  let llmRoundCalls = 0;
  let musicCallCount = 0;
  const chat = async () => {
    llmRoundCalls += 1;
    if (llmMode === 'music') {
      musicCallCount += 1;
      if (musicCallCount === 1) {
        return toolCallResponse('c_sel_1', 'select_music', { mode: 'discovery', delivery: 'replace_now' });
      }
      return toolCallResponse('c_com_1', 'commit_music_selection', {
        offerId: 'offer-mj',
        indexes: [1],
        beats: [{
          say: '先挑了这首陈奕迅的《明年今日》。',
          voice: { pace: 'steady', intensity: 'warm', direction: overlongDirection },
        }],
      });
    }
    if (llmMode === 'radio-silent-tail') {
      return deliverReplyResponse('c_rad_st', [
        { say: '第一拍立刻就绪。', pauseAfterMs: 500 },
        { say: '第二拍稍后到达。', pauseAfterMs: 400 },
        { say: '……', spoken: '{叹气}' },
      ]);
    }
    return deliverReplyResponse('c_rad_ft', [
      { say: '第一句正常。', pauseAfterMs: 500 },
      { say: '第二句合成返回空。' },
    ]);
  };

  let synthHandler = async () => ({ url: '/tts/default.wav', hash: 'default', durationMs: 400 });
  const presentationService = new PresentationService({
    synthesize: input => synthHandler(input),
  });
  const budgeter = new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date(nowMs) }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService,
    capabilityResolver: () => [REPLY_CAPABILITY, MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    retrieveMemories: async () => [],
    getRuntimeState: () => null,
    logger: { error() {}, warn() {} },
  }).initialize();

  const publishedSnapshots = [];
  const chatService = new VirtualPersonChatService({
    runtime,
    presentationService,
    conversationStore,
    queueService: { publishSnapshot: payload => publishedSnapshots.push(payload) },
    logger: { error() {}, warn() {} },
  });

  try {
    const radioRoom = conversationStore.createRoom({
      title: '电台模式测试',
      memberIds: ['lunara'],
      hostId: 'lunara',
      interactionMode: 'radio',
    });

    // 3.2：music commit beats 安全截断超 25 字 voice.direction，MUSIC_COMMITTED 后零额外模型调用
    const musicRes = await chatService.handleChat({
      sessionId: radioRoom.sessionId,
      requestId: 'req-c3-music',
      message: '来首陈奕迅的歌',
      speak: true,
    });
    assert.equal(musicRes.ok, true);
    assert.equal(llmRoundCalls, 2, 'select_music + commit_music_selection 后不再多调模型');
    assert.equal(publishedSnapshots.length, 1);
    const musicMsg = publishedSnapshots[0].message;
    assert.equal(musicMsg.beats.length, 2);
    assert.equal(musicMsg.beats[0].say, '先挑了这首陈奕迅的《明年今日》。');
    assert.equal([...musicMsg.beats[0].voice.direction].length, MAX_VOICE_DIRECTION_CHARS);
    assert.equal(musicMsg.beats[0].voice.direction, [...overlongDirection].slice(0, MAX_VOICE_DIRECTION_CHARS).join(''));
    assert.equal(musicMsg.beats[1].say, '已经给你排好陈奕迅的《明年今日》。');
    assert.equal(musicMsg.beats[1].pauseAfterMs, 0);

    // 3.3A：radio 3 拍（第 0 拍快、第 1 拍慢、第 2 拍纯气口无发音）流水线首拍先发 + 有声末拍释租
    llmMode = 'radio-silent-tail';
    publishedSnapshots.length = 0;
    const beat1Gate = deferred();
    const beat1Started = deferred();
    synthHandler = async ({ text }) => {
      if (text === '第一拍立刻就绪。') {
        return { url: '/tts/st_0.wav', hash: 'st_0', durationMs: 350 };
      }
      if (text === '第二拍稍后到达。') {
        beat1Started.resolve();
        await beat1Gate.promise;
        return { url: '/tts/st_1.wav', hash: 'st_1', durationMs: 450 };
      }
      throw new Error(`unexpected synth for silent beat: ${text}`);
    };

    const silentTailPromise = chatService.handleChat({
      sessionId: radioRoom.sessionId,
      requestId: 'req-c3-st',
      message: '继续放点气氛歌',
      speak: true,
    });
    await beat1Started.promise;
    // 给微任务队列机会：第 0 拍应已在第 1 拍 resolve 前先推给前端
    for (let i = 0; i < 6 && publishedSnapshots.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(publishedSnapshots.length, 1, '第 1 拍尚未合成完时首拍已经先发');
    assert.deepEqual(publishedSnapshots[0].message.beatProgress, { deliveredCount: 1, totalCount: 3, done: false });
    assert.equal(publishedSnapshots[0].overlayNarrations[0].beatIndex, 0);
    assert.equal(publishedSnapshots[0].overlayNarrations[0].holdDuckLease, true);
    assert.equal(publishedSnapshots[0].overlayNarrations[0].isLastBeat, false);

    beat1Gate.resolve();
    await silentTailPromise;
    assert.equal(publishedSnapshots.length, 3);
    assert.equal(publishedSnapshots[1].overlayNarrations[0].beatIndex, 1);
    assert.equal(publishedSnapshots[1].overlayNarrations[0].delayBeforeMs, 500);
    assert.equal(publishedSnapshots[1].overlayNarrations[0].isLastBeat, true);
    assert.equal(publishedSnapshots[1].overlayNarrations[0].holdDuckLease, false, '最后一个有声拍必须释放租约');
    assert.equal(publishedSnapshots[2].overlayNarrations, undefined);
    assert.deepEqual(publishedSnapshots[2].message.beatProgress, { deliveredCount: 3, totalCount: 3, done: true });

    // 3.3B：radio 2 拍（第 0 拍有声、第 1 拍 TTS 返回 null）最终快照 beatProgress.done=true 封口租约
    llmMode = 'radio-null-tail';
    publishedSnapshots.length = 0;
    synthHandler = async ({ text }) => (
      text === '第一句正常。'
        ? { url: '/tts/nt_0.wav', hash: 'nt_0', durationMs: 400 }
        : null
    );
    await chatService.handleChat({
      sessionId: radioRoom.sessionId,
      requestId: 'req-c3-nt',
      message: '再来两句',
      speak: true,
    });
    assert.equal(publishedSnapshots.length, 2);
    assert.equal(publishedSnapshots[0].overlayNarrations[0].holdDuckLease, true);
    assert.equal(publishedSnapshots[1].overlayNarrations, undefined);
    assert.deepEqual(publishedSnapshots[1].message.beatProgress, { deliveredCount: 2, totalCount: 2, done: true });
    assert.equal(publishedSnapshots[1].message.voice.status, 'partial');
  } finally {
    runtime.shutdown();
    conversationStore.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 用例组 4：roleplay & radio 回归唤醒 app_open / idleReturn 与 lastUserTurnId 幂等锁
// ---------------------------------------------------------------------------
test('用例组 4：roleplay 阻断 heartbeat 但开放 app_open、radio 支持静置 idleReturn、以及 lastUserTurnId 幂等锁边界', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-sb-case4-'));
  const dbPath = join(dir, 'state.db');

  // 2026-11-23 10:00 Asia/Shanghai（避开 23:30-08:00 静默时段）
  let nowMs = Date.UTC(2026, 10, 23, 2, 0, 0);
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath, now: () => nowMs }).initialize();
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerDeliverReplyTool(tools);
  registerAmbientTools(tools);

  const ordinaryCalls = [];
  const ambientCalls = [];
  let nextAmbientBehaviour = () => toolCallResponse('amb_quiet', 'presence_respond', { action: 'quiet' });

  const chat = async (messages, definitions, options = {}) => {
    if (options.taskId === 'ambient_turn') {
      ambientCalls.push({ messages: structuredClone(messages), options });
      return nextAmbientBehaviour({ messages, options });
    }
    ordinaryCalls.push({ messages: structuredClone(messages), options });
    return deliverReplyResponse(`ord_${ordinaryCalls.length}`, [
      { say: '嗯，我刚把门掩上，你先坐。' },
    ]);
  };

  const budgeter = new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const presentationService = new PresentationService();
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date(nowMs) }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService,
    capabilityResolver: () => [REPLY_CAPABILITY],
    retrieveMemories: async () => [],
    getRuntimeState: () => null,
    logger: { error() {}, warn() {} },
  }).initialize();

  const chatService = new VirtualPersonChatService({
    runtime,
    presentationService,
    conversationStore,
    queueService: { publishSnapshot() {} },
    logger: { error() {}, warn() {} },
  });

  const prefsStore = new Map();
  const state = {
    getPref: key => prefsStore.get(key) ?? null,
    setPref: (key, value) => prefsStore.set(key, typeof value === 'string' ? value : JSON.stringify(value)),
  };
  const presenceListeners = new Set();
  const clientHub = {
    clientCount: 1,
    onClientsChanged: () => () => {},
    onPresenceChanged: listener => {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },
    presenceSummary: () => ({ connected: 1, visible: 1, typing: false }),
  };
  const emitPresence = summary => {
    for (const listener of presenceListeners) listener(summary);
  };

  const publishedPresence = [];
  const playbackRuntime = new PlaybackRuntimeHost({ now: () => nowMs });
  const presence = createPresenceWiring({
    playbackRuntime,
    state,
    getActivity: sid => runtime.presenceActivity(sid),
    virtualPerson: { runtime, conversationStore, presentationService, registry, toolRegistry: tools },
    queueService: { publishSnapshot: payload => publishedPresence.push(payload) },
    clientHub,
    now: () => nowMs,
    timeZone: 'Asia/Shanghai',
  });

  let blockingAbortResolve = null;
  try {
    // 1. 创建 roleplay 房间并完成一轮对话
    const rpRoom = conversationStore.createRoom({
      title: '私语回归测试',
      memberIds: ['lunara'],
      hostId: 'lunara',
      interactionMode: 'roleplay',
    });
    await chatService.handleChat({
      sessionId: rpRoom.sessionId,
      requestId: 'req-c4-rp1',
      message: '我先接个电话，话说到一半',
      speak: false,
    });
    const rpUserTurnId = conversationStore.getSession(rpRoom.sessionId).lastUserTurnId;
    assert.ok(rpUserTurnId);

    // 音乐 heartbeat 对 roleplay 仍被阻断
    const ambientCountBeforeHb = ambientCalls.length;
    const hbBlocked = await runtime.handleAmbientTurn({
      sessionId: rpRoom.sessionId,
      personId: 'lunara',
      wake: { id: 'hb:rp:1', sessionId: rpRoom.sessionId, personId: 'lunara', reason: 'heartbeat', firedAtMs: nowMs, signal: new AbortController().signal },
    });
    assert.deepEqual(hbBlocked, { action: 'silent', reason: 'roleplay-mode' });
    assert.equal(ambientCalls.length, ambientCountBeforeHb);

    // 2. 6 分钟短重开：模型选择 quiet 不锁定 return_greeted_turn_id
    emitPresence({ connected: 1, visible: 0, typing: false });
    nowMs += 6 * 60_000;
    nextAmbientBehaviour = () => toolCallResponse('amb_6m_q', 'presence_respond', { action: 'quiet' });
    emitPresence({ connected: 1, visible: 1, typing: false });
    const res6m = await presence.greeter.settled();
    assert.equal(res6m.outcome, 'quiet');
    assert.equal(conversationStore.getReturnGreetedTurnId(rpRoom.sessionId), null, '6 分钟短重开 quiet 不得消耗幂等锁');

    // 3a. 离开 2 小时后回归，生成中途被 typing 打断 -> silent(interrupted)，不写 turn、不锁死
    emitPresence({ connected: 1, visible: 0, typing: false });
    nowMs += 2 * 60 * 60_000;
    const typingStarted = deferred();
    nextAmbientBehaviour = ({ options }) => {
      typingStarted.resolve();
      return new Promise(resolve => {
        blockingAbortResolve = () => resolve({ message: { role: 'assistant', content: '' } });
        options.signal?.addEventListener('abort', blockingAbortResolve, { once: true });
      });
    };
    const turnsBeforeInterrupt = conversationStore.listTurns(rpRoom.sessionId, { limit: 50, visibleOnly: false }).length;
    emitPresence({ connected: 1, visible: 1, typing: false });
    await typingStarted.promise;
    emitPresence({ connected: 1, visible: 1, typing: true });
    const resTyping = await presence.greeter.settled();
    assert.equal(resTyping.outcome, 'silent');
    assert.equal(resTyping.reason, 'interrupted');
    assert.equal(conversationStore.getReturnGreetedTurnId(rpRoom.sessionId), null);
    assert.equal(
      conversationStore.listTurns(rpRoom.sessionId, { limit: 50, visibleOnly: false }).length,
      turnsBeforeInterrupt,
    );

    // 3b. 超时 (AGENT_TIMEOUT) -> silent(timeout)，不锁死
    emitPresence({ connected: 1, visible: 0, typing: false });
    nowMs += 30 * 60_000;
    nextAmbientBehaviour = () => {
      throw Object.assign(new Error('provider timed out'), { code: 'AGENT_TIMEOUT' });
    };
    emitPresence({ connected: 1, visible: 1, typing: false });
    const resTimeout = await presence.greeter.settled();
    assert.equal(resTimeout.outcome, 'silent');
    assert.equal(resTimeout.reason, 'timeout');
    assert.equal(conversationStore.getReturnGreetedTurnId(rpRoom.sessionId), null);

    // 4. 离开 2 小时回归：note_thought + presence_respond({ action: 'speak', beats: 2 拍 })
    emitPresence({ connected: 1, visible: 0, typing: false });
    nowMs += 2 * 60 * 60_000;
    nextAmbientBehaviour = () => multiToolCallResponse([
      {
        id: 'amb_note_1',
        name: 'note_thought',
        args: { text: '刚才说到一半就去接电话了，先记着等会儿顺着接上。' },
      },
      {
        id: 'amb_speak_1',
        name: 'presence_respond',
        args: {
          action: 'speak',
          beats: [
            { action: '抬头往门口看了看', say: '刚才那阵急事忙完了吗？', pauseAfterMs: 500 },
            { say: '你要是还不困，我们接着往下聊。' },
          ],
        },
      },
    ]);
    emitPresence({ connected: 1, visible: 1, typing: false });
    const resRpWake = await presence.greeter.settled();
    assert.equal(resRpWake.outcome, 'text-only');
    assert.equal(conversationStore.getReturnGreetedTurnId(rpRoom.sessionId), rpUserTurnId);

    const rpNotes = conversationStore.db.prepare(
      'SELECT * FROM companion_notes WHERE person_id = ? AND session_id = ?',
    ).all('lunara', rpRoom.sessionId);
    assert.equal(rpNotes.length, 1);
    assert.match(rpNotes[0].text, /接电话/);

    const rpPresenceMsg = publishedPresence.at(-1).message;
    assert.equal(rpPresenceMsg.presentation, 'presence');
    assert.equal(rpPresenceMsg.beats.length, 2);
    assert.equal(rpPresenceMsg.beats[0].action, '抬头往门口看了看');

    // 无新消息再次离开 1 小时重开：被 already-greeted 确定性拦截，零模型调用
    const callsBeforeDup = ambientCalls.length;
    emitPresence({ connected: 1, visible: 0, typing: false });
    nowMs += 60 * 60_000;
    emitPresence({ connected: 1, visible: 1, typing: false });
    const resDup = await presence.greeter.settled();
    assert.deepEqual(resDup, { outcome: 'skipped', reason: 'already-greeted' });
    assert.equal(ambientCalls.length, callsBeforeDup);

    // 5. radio 桌面常开静置 40 分钟 idleReturn 与 lastUserTurnId 幂等锁推进
    const radioRoom = conversationStore.createRoom({
      title: '电台静置回归房',
      memberIds: ['lunara'],
      hostId: 'lunara',
      interactionMode: 'radio',
    });
    await chatService.handleChat({
      sessionId: radioRoom.sessionId,
      requestId: 'req-c4-rad1',
      message: '今晚就听到这首吧，晚安',
      speak: false,
    });
    const radioUserTurnId1 = conversationStore.getSession(radioRoom.sessionId).lastUserTurnId;
    assert.ok(radioUserTurnId1);

    // 静置 40 分钟重新聚焦：模型选择 quiet -> >=25m 归来静默亦推进幂等锁
    nowMs += 40 * 60_000;
    nextAmbientBehaviour = () => toolCallResponse('amb_idle_q', 'presence_respond', { action: 'quiet' });
    emitPresence({
      connected: 1,
      visible: 1,
      typing: false,
      idleReturn: { sessionId: radioRoom.sessionId, awayMs: 40 * 60_000, firedAtMs: nowMs },
    });
    const resIdleQuiet = await presence.greeter.settled();
    assert.equal(resIdleQuiet.outcome, 'quiet');
    assert.equal(conversationStore.getReturnGreetedTurnId(radioRoom.sessionId), radioUserTurnId1);

    // 无新用户消息再次触发 idleReturn -> already-greeted 拦截，零模型调用
    const callsBeforeIdleDup = ambientCalls.length;
    nowMs += 40 * 60_000;
    emitPresence({
      connected: 1,
      visible: 1,
      typing: false,
      idleReturn: { sessionId: radioRoom.sessionId, awayMs: 40 * 60_000, firedAtMs: nowMs },
    });
    const resIdleDup = await presence.greeter.settled();
    assert.deepEqual(resIdleDup, { outcome: 'skipped', reason: 'already-greeted' });
    assert.equal(ambientCalls.length, callsBeforeIdleDup);

    // 用户发送新消息推进 lastUserTurnId 后，再静置 40 分钟可再次唤醒并提交 speak
    await chatService.handleChat({
      sessionId: radioRoom.sessionId,
      requestId: 'req-c4-rad2',
      message: '刚才回来倒了杯水',
      speak: false,
    });
    const radioUserTurnId2 = conversationStore.getSession(radioRoom.sessionId).lastUserTurnId;
    assert.notEqual(radioUserTurnId2, radioUserTurnId1);

    nowMs += 40 * 60_000;
    nextAmbientBehaviour = () => toolCallResponse('amb_idle_speak', 'presence_respond', {
      action: 'speak',
      beats: [{ say: '水倒好啦？想接着听什么随时跟我说。' }],
    });
    emitPresence({
      connected: 1,
      visible: 1,
      typing: false,
      idleReturn: { sessionId: radioRoom.sessionId, awayMs: 40 * 60_000, firedAtMs: nowMs },
    });
    const resIdleSpeak = await presence.greeter.settled();
    assert.equal(resIdleSpeak.outcome, 'text-only');
    assert.equal(conversationStore.getReturnGreetedTurnId(radioRoom.sessionId), radioUserTurnId2);
    const radioPresenceTurns = conversationStore.listTurns(radioRoom.sessionId, { limit: 20, visibleOnly: true })
      .filter(t => t.message?.presentation === 'presence');
    assert.equal(radioPresenceTurns.length, 1);
    assert.equal(radioPresenceTurns[0].message.beats[0].say, '水倒好啦？想接着听什么随时跟我说。');
  } finally {
    blockingAbortResolve?.();
    presence.stop();
    runtime.shutdown();
    conversationStore.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
