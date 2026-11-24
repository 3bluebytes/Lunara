// 串词表演意图在 runtime 里的持久化：text 是唯一人读文本，spokenText/performance 只为重合成保留。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlaybackRuntimeState, reducePlayback } from './PlaybackRuntime.js';
import { PlaybackCommandType, PlaybackEffectType, PlaybackEventType, normalizeRuntimeTrack, publicRuntimeState } from './playbackRuntimeTypes.js';

function committed() {
  const result = reducePlayback(createPlaybackRuntimeState({ companionModeId: 'conversational' }), {
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'commit-1',
    delivery: 'replace_now',
    source: 'user',
    tracks: [{ songId: 's1', programId: 'p1', requestId: 'r1', title: '晴天', artist: '周杰伦', url: '/s1.mp3',
      duration: 200, narration: { status: 'preparing', generationRevision: 1 } }],
  }, { nowMs: 1_000 });
  assert.equal(result.accepted, true, result.reason);
  return result.state;
}

// 先写文字，再合成声音：两步走完等于一条能说出口的串词。
function ready(state, { ttsUrl = '/tts/a.mp3', synthesisReason, synthesisElapsedMs, ...written } = {}) {
  const track = state.queue[0];
  const identity = { queueItemId: track.queueItemId, songId: track.songId, programId: track.programId,
    generationRevision: track.narration.generationRevision, listeningSessionId: state.activeListeningSessionId };
  const write = reducePlayback(state, { type: PlaybackEventType.TRACK_NARRATION_READY,
    eventId: `ready-${Math.random()}`, ...identity, ...written }, { nowMs: 2_000 });
  if (!write.accepted || write.state.queue[0].narration.status !== 'ready') return write;
  const asset = reducePlayback(write.state, { type: PlaybackEventType.TRACK_NARRATION_ASSET_READY,
    eventId: `asset-${Math.random()}`, ...identity, ttsUrl, synthesisReason, synthesisElapsedMs }, { nowMs: 2_000 });
  return { ...asset, commands: [...write.commands, ...asset.commands], effects: [...write.effects, ...asset.effects] };
}

test('READY 携带 spokenText 与 performance 时一并保存；text 保持纯文本', () => {
  const result = ready(committed(), {
    text: '已经很晚了。我们听首安静的。',
    spokenText: '{叹气}已经很晚了。{停顿:0.6}我们听首安静的。',
    performance: { emotion: 'sad', pace: 'slow', intensity: null, direction: null, native: { emotion: 'whisper' } },
  });
  assert.equal(result.accepted, true, result.reason);
  const narration = result.state.queue[0].narration;
  assert.equal(narration.text, '已经很晚了。我们听首安静的。');
  assert.equal(narration.spokenText, '{叹气}已经很晚了。{停顿:0.6}我们听首安静的。');
  assert.deepEqual(narration.performance, { emotion: 'sad', pace: 'slow', intensity: null, direction: null },
    '只保留中立字段，原生参数不能经事件混进来');
});

test('READY 的 text 若仍带标记，runtime 存纯文本，原文转为 spokenText', () => {
  const result = ready(committed(), { text: '{笑}晚上好。来首歌。' });
  const narration = result.state.queue[0].narration;
  assert.equal(narration.text, '晚上好。来首歌。');
  assert.equal(narration.spokenText, '{笑}晚上好。来首歌。');
});

test('没有表演的 READY 不留 spokenText/performance 字段值', () => {
  const narration = ready(committed(), { text: '乙。' }).state.queue[0].narration;
  assert.equal(narration.text, '乙。');
  assert.equal(narration.spokenText, null);
  assert.equal(narration.performance, null);
});

test('只有 performance、没有标记文本时也保存中立表演', () => {
  const narration = ready(committed(), { text: '乙。', performance: { emotion: 'warm', pace: 'slow' } }).state.queue[0].narration;
  assert.equal(narration.spokenText, null);
  assert.deepEqual(narration.performance, { emotion: 'warm', pace: 'slow', intensity: null, direction: null });
});

test('spokenText 与 text 不对应时不保存（防止显示与发声指向不同内容）', () => {
  const result = ready(committed(), { text: '甲。', spokenText: '{笑}完全不同的话。', performance: { emotion: 'happy' } });
  const narration = result.state.queue[0].narration;
  assert.equal(narration.spokenText, null);
  assert.equal(narration.performance, null);
});

test('播放命令下发的 text 是纯文本', () => {
  const result = ready(committed(), { text: '已经很晚了。', spokenText: '{叹气}已经很晚了。' });
  const commands = result.commands.filter(command => command.type === PlaybackCommandType.PLAY_TRACK_NARRATION);
  for (const command of commands) assert.doesNotMatch(command.text, /\{/);
  assert.doesNotMatch(JSON.stringify(result.state.queue[0].narration.text), /\{/);
});

test('READY 无音频时保留正文与表演，只把资产标为失败并记录封闭原因与耗时', () => {
  const text = '已经开始很久了。我们听首安静的。';
  const result = ready(committed(), { ttsUrl: null, text,
    spokenText: `{叹气}${text}`, performance: { emotion: 'sad' },
    synthesisReason: 'timeout', synthesisElapsedMs: 30_000 });
  assert.equal(result.accepted, true, result.reason);
  const narration = result.state.queue[0].narration;
  assert.equal(narration.status, 'ready', '正文仍可复用');
  assert.equal(narration.assetStatus, 'failed', '资产失败独立记录');
  assert.equal(narration.ttsUrl, null);
  assert.equal(narration.text, text);
  assert.equal(narration.spokenText, `{叹气}${text}`);
  assert.deepEqual(narration.performance, { emotion: 'sad', pace: null, intensity: null, direction: null });
  assert.equal(narration.synthesisReason, 'timeout');
  assert.equal(narration.synthesisElapsedMs, 30_000);
  assert.equal(result.commands.some(command => command.type === PlaybackCommandType.PLAY_TRACK_NARRATION), false,
    '没有音频不得下发口播命令');
  assert.notEqual(result.state.txn.narrationDelivery, 'delivered', '正文未出声不算已交付');
  const diagnostic = result.state.diagnostics.find(entry => entry.type === 'track-narration-asset-failed');
  assert.equal(diagnostic.reason, 'timeout');
  assert.equal(diagnostic.elapsedMs, 30_000);
});

test('READY 没有正文就是没写成：这首安静播放，不算错误状态', () => {
  const result = ready(committed(), { text: '' });
  const narration = result.state.queue[0].narration;
  assert.equal(narration.status, 'absent');
  assert.equal(narration.ttsUrl, null);
  const diagnostic = result.state.diagnostics.find(entry => entry.type === 'track-line-not-written');
  assert.equal(diagnostic.reason, 'empty narration');
});

test('合成失败的封闭原因掩盖原始错误', () => {
  const result = ready(committed(), { text: '乙。', ttsUrl: null, synthesisReason: 'E_RAW provider rejected key sk-secret' });
  assert.equal(result.state.queue[0].narration.assetStatus, 'failed');
  assert.equal(JSON.stringify(result.state).includes('sk-secret'), false, '原始错误不得写进状态');
});

test('保留下来的正文让下一次准备只做资产解析，不重跑模型', () => {
  const text = '接下来是周杰伦的《花海》。这一首可以安静听完。';
  const result = reducePlayback(createPlaybackRuntimeState({ companionModeId: null }), {
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'reuse-commit', delivery: 'replace_now', source: 'user',
    tracks: [
      { songId: 'one', programId: 'p1', requestId: 'r1', title: '晴天', artist: '周杰伦', url: '/1.mp3', duration: 200,
        narration: { status: 'absent', context: { origin: 'live' } } },
      { songId: 'two', programId: 'p1', requestId: 'r2', title: '花海', artist: '周杰伦', url: '/2.mp3', duration: 200,
        narration: { status: 'ready', assetStatus: 'failed', generationRevision: 4, text, context: { origin: 'prepared' } } },
    ],
  }, { nowMs: 1_000 });
  assert.equal(result.accepted, true, result.reason);
  const upcoming = result.state.queue[1];
  const upcomingEffects = result.effects.filter(effect => effect.queueItemId === upcoming.queueItemId);
  assert.deepEqual(upcomingEffects.map(effect => effect.type), [PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET]);
  assert.equal(upcoming.narration.text, text, '正文随 occurrence 保留');
  assert.equal(upcoming.narration.assetStatus, 'resolving');
});

test('重启恢复：已保存的 spokenText/performance 随轨道规范化保留，不对应就丢弃', async () => {
  const { normalizeRuntimeTrack } = await import('./playbackRuntimeTypes.js');
  const base = { songId: 's1', programId: 'p1', requestId: 'r1', title: '晴天', artist: '周杰伦', url: '/s1.mp3', queueItemId: 'q1' };
  const kept = normalizeRuntimeTrack({ ...base, narration: { status: 'ready', text: '晚了。', ttsUrl: '/tts/a.mp3',
    spokenText: '{叹气}晚了。', performance: { emotion: 'sad', native: { x: 1 } } } });
  assert.equal(kept.narration.spokenText, '{叹气}晚了。');
  assert.deepEqual(kept.narration.performance, { emotion: 'sad', pace: null, intensity: null, direction: null });
  const dropped = normalizeRuntimeTrack({ ...base, narration: { status: 'ready', text: '晚了。', ttsUrl: '/tts/a.mp3',
    spokenText: '{叹气}别的话。', performance: { emotion: 'sad' } } });
  assert.equal(dropped.narration.spokenText, null);
  assert.equal(dropped.narration.performance, null);
});

test('真实写入路径：时间线、聊天消息、账本与反思读到的串词都不含表演标记', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { ConversationStore } = await import('../virtual-person/ConversationStore.js');
  const { recordTrackIntroTurn } = await import('../app/createSessionTraceWiring.js');
  const result = ready(committed(), {
    text: '已经很晚了。我们听首安静的。',
    spokenText: '{叹气}已经很晚了。{停顿:0.6}我们听首安静的。',
    performance: { emotion: 'sad' }, about: '夜深了，放首安静的',
  });
  const snapshot = result.state;
  const track = snapshot.queue[0];
  const dir = mkdtempSync(join(tmpdir(), 'lunara-narration-performance-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  try {
    store.createRoom({ sessionId: snapshot.activeListeningSessionId, memberIds: ['lunara', 'friend'], hostId: 'lunara' });
    const traced = [];
    const published = [];
    const turn = recordTrackIntroTurn({
      sessionTrace: { recordScoped: (_sessionId, entry) => traced.push(entry) },
      conversationStore: store,
      queueService: { snapshot: () => ({}) },
      publish: message => published.push(message),
      snapshot, event: { queueItemId: track.queueItemId, correlationId: 'transition:1' }, track,
    });
    assert.ok(turn, 'intro turn recorded');
    const surfaces = {
      trace: traced.map(entry => entry.text),
      published: published.flatMap(message => message.messages.map(item => item.say)),
      timeline: store.listTurns(snapshot.activeListeningSessionId, { visibleOnly: true }).map(item => item.message.content),
      reflection: store.recentEncounters('friend').map(item => item.message?.content ?? item.visibleText),
    };
    for (const [surface, texts] of Object.entries(surfaces)) {
      assert.ok(texts.length > 0, `${surface} 有内容`);
      for (const text of texts) assert.doesNotMatch(String(text), /[{}]/, `${surface} 泄漏了标记`);
    }
    assert.equal(surfaces.timeline[0], '已经很晚了。我们听首安静的。');
    // 要点备忘跟着入账，但不进播放器协议消息。
    assert.equal(store.listTurns(snapshot.activeListeningSessionId, { visibleOnly: true })[0].message.about, '夜深了，放首安静的');
    assert.ok(!JSON.stringify(published).includes('夜深了'), '播放器消息不带备忘');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 要点备忘：host 写这段话时自己记下的意思，跟着串词存、跟着作废，任何时候都不对外。
test('READY 携带 about 时保存为单行有界文本；对外状态和播放命令都不带它，快照恢复后仍在', () => {
  const result = ready(committed(), { text: '已经很晚了。我们听首安静的。', about: `夜深了\n放首安静的${'。'.repeat(200)}` });
  assert.equal(result.accepted, true, result.reason);
  const track = result.state.queue[0];
  assert.match(track.narration.about, /^夜深了 放首安静的/u);
  assert.equal(track.narration.about.length, 80);
  assert.equal('about' in publicRuntimeState(result.state).queue[0].narration, false);
  assert.equal('about' in publicRuntimeState({ queue: [{ ...track, narration: { ...track.narration, spoken: true } }] }).queue[0].narration, false,
    '说出口之后也不对外');
  assert.ok(!JSON.stringify(result.commands).includes('夜深了'), '播放器命令不带备忘');
  assert.equal(normalizeRuntimeTrack(JSON.parse(JSON.stringify(track))).narration.about, track.narration.about);
  assert.equal(ready(committed(), { text: '乙。' }).state.queue[0].narration.about, null);
});
