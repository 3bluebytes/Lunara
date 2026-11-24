import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { LifeContextStore } from '../life/LifeContextStore.js';
import { createTtsAssetLifecycle } from './ttsAssetLifecycle.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function writeDummyAudio(dir, hash, size, mtimeMs, ext = 'wav') {
  const path = join(dir, `${hash}.${ext}`);
  writeFileSync(path, Buffer.alloc(size, 0x55));
  const ts = new Date(mtimeMs);
  utimesSync(path, ts, ts);
  return path;
}

function seedAssistantTurnWithVoice(convStore, { sessionId, requestId, hash, text = '一句回应' }) {
  convStore.beginRequest({ requestId, sessionId, virtualPersonId: 'lunara', userText: '嗨' });
  const done = convStore.completeRequest({
    requestId,
    virtualPersonId: 'lunara',
    message: {
      role: 'assistant',
      content: text,
      voice: { spokenText: text, hash, audioUrl: `/tts/${hash}.wav`, synthesizedAt: 1000 },
    },
    result: { ok: true },
  });
  return done.turn;
}

test('ttsAssetLifecycle: ephemeral 7d TTL, dialogue LRU with 30d floor, and journal pinned exemption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-lifecycle-'));
  const convDb = join(dir, 'conv.sqlite');
  const lifeDb = join(dir, 'life.sqlite');
  const cacheDir = join(dir, 'cache');
  const nowMs = 1_800_000_000_000;
  let currentNow = nowMs;

  const convStore = new ConversationStore({ dbPath: convDb, now: () => currentNow });
  convStore.initialize();
  const lifeStore = new LifeContextStore({ dbPath: lifeDb, now: () => currentNow });
  try {
    const room = convStore.createRoom({ title: '测试房', memberIds: ['lunara'], hostId: 'lunara' });

    const pinnedTurn = seedAssistantTurnWithVoice(convStore, {
      sessionId: room.sessionId, requestId: 'req-pin', hash: 'hash_pinned', text: '被手账收藏的话',
    });
    const oldDialogueTurn = seedAssistantTurnWithVoice(convStore, {
      sessionId: room.sessionId, requestId: 'req-old', hash: 'hash_dlg_old', text: '老对话语音',
    });
    const recentDialogueTurn = seedAssistantTurnWithVoice(convStore, {
      sessionId: room.sessionId, requestId: 'req-new', hash: 'hash_dlg_new', text: '新对话语音',
    });
    assert.ok(oldDialogueTurn.turnId && recentDialogueTurn.turnId);

    // 手账引用第一条回合，使其成为 pinned。
    lifeStore.db.prepare(`INSERT INTO life_entries (
      id, type, title, content, local_date, attached_quotes_json, created_at, updated_at
    ) VALUES (?, 'note', '日记', '摘录一句', '2026-11-23', ?, ?, ?)`).run(
      'life-1',
      JSON.stringify([{ turnId: pinnedTurn.turnId, speaker: 'Lunara', text: '被手账收藏的话' }]),
      nowMs,
      nowMs,
    );

    const { mkdirSync } = await import('node:fs');
    mkdirSync(cacheDir, { recursive: true });
    // pinned：即使 90 天前且很大，也绝不清理。
    const pinnedPath = writeDummyAudio(cacheDir, 'hash_pinned', 600, nowMs - 90 * DAY_MS);
    // dialogue（老）：45 天前，> 30 天保护期，且触发预算超限 -> 应被 LRU 淘汰。
    const oldDlgPath = writeDummyAudio(cacheDir, 'hash_dlg_old', 600, nowMs - 45 * DAY_MS);
    // dialogue（新）：5 天前，< 30 天保护期 -> 即使预算紧张也保留。
    const newDlgPath = writeDummyAudio(cacheDir, 'hash_dlg_new', 600, nowMs - 5 * DAY_MS);
    // ephemeral（过期）：9 天前，不在 conversation_turns 中 -> 清理。
    const oldEphPath = writeDummyAudio(cacheDir, 'hash_eph_old', 300, nowMs - 9 * DAY_MS, 'mp3');
    // ephemeral（新鲜）：2 天前 -> 保留。
    const freshEphPath = writeDummyAudio(cacheDir, 'hash_eph_fresh', 300, nowMs - 2 * DAY_MS);
    // 非目标扩展名文件 -> 忽略。
    const tmpPath = join(cacheDir, 'abc.wav.tmp-1');
    writeFileSync(tmpPath, 'tmp');

    const lifecycle = createTtsAssetLifecycle({
      cacheDir,
      conversationStore: convStore,
      listPinnedTurnIds: () => lifeStore.listQuotedTurnIds(),
      now: () => currentNow,
      ephemeralTtlMs: 7 * DAY_MS,
      dialogueMaxBytes: 1000, // pinned 不计入预算，仅 hash_dlg_old(600) + hash_dlg_new(600) = 1200 > 1000
      dialogueMinAgeMs: 30 * DAY_MS,
      batchSize: 2,
    });

    assert.equal(lifecycle.existsByUrl('/tts/hash_dlg_new.wav'), true);
    assert.equal(lifecycle.existsByUrl('/tts/missing.wav'), false);

    // 验证 touchByUrl 刷新 mtime。
    const beforeTouch = statSync(freshEphPath).mtimeMs;
    currentNow += 5000;
    assert.equal(lifecycle.touchByUrl('/tts/hash_eph_fresh.wav'), true);
    assert.ok(statSync(freshEphPath).mtimeMs > beforeTouch);

    const summary = await lifecycle.sweep();
    assert.equal(summary.ephemeralDeleted, 1);
    assert.equal(summary.dialogueDeleted, 1);
    assert.equal(summary.pinnedCount, 1);
    assert.equal(existsSync(pinnedPath), true);
    assert.equal(existsSync(oldDlgPath), false);
    assert.equal(existsSync(newDlgPath), true);
    assert.equal(existsSync(oldEphPath), false);
    assert.equal(existsSync(freshEphPath), true);
    assert.equal(existsSync(tmpPath), true);
  } finally {
    convStore.close();
    lifeStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ttsAssetLifecycle: purgeUnreferencedHashes deletes room-only files but keeps shared or pinned ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-purge-'));
  const convDb = join(dir, 'conv.sqlite');
  const lifeDb = join(dir, 'life.sqlite');
  const cacheDir = join(dir, 'cache');
  const nowMs = 1_800_000_000_000;

  const convStore = new ConversationStore({ dbPath: convDb, now: () => nowMs });
  convStore.initialize();
  const lifeStore = new LifeContextStore({ dbPath: lifeDb, now: () => nowMs });
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cacheDir, { recursive: true });
    const roomA = convStore.createRoom({ title: '房A', memberIds: ['lunara'], hostId: 'lunara' });
    const roomB = convStore.createRoom({ title: '房B', memberIds: ['lunara'], hostId: 'lunara' });

    seedAssistantTurnWithVoice(convStore, { sessionId: roomA.sessionId, requestId: 'a1', hash: 'only_a' });
    seedAssistantTurnWithVoice(convStore, { sessionId: roomA.sessionId, requestId: 'a2', hash: 'shared_ab' });
    const pinnedInA = seedAssistantTurnWithVoice(convStore, { sessionId: roomA.sessionId, requestId: 'a3', hash: 'pinned_in_a' });
    seedAssistantTurnWithVoice(convStore, { sessionId: roomB.sessionId, requestId: 'b1', hash: 'shared_ab' });

    lifeStore.db.prepare(`INSERT INTO life_entries (
      id, type, title, content, local_date, attached_quotes_json, created_at, updated_at
    ) VALUES ('l1', 'note', '手账', '引用', '2026-11-23', ?, ?, ?)`).run(
      JSON.stringify([{ turnId: pinnedInA.turnId, speaker: 'Lunara', text: '一句回应' }]),
      nowMs,
      nowMs,
    );

    const onlyAPath = writeDummyAudio(cacheDir, 'only_a', 200, nowMs);
    const sharedPath = writeDummyAudio(cacheDir, 'shared_ab', 200, nowMs);
    const pinnedPath = writeDummyAudio(cacheDir, 'pinned_in_a', 200, nowMs);

    const lifecycle = createTtsAssetLifecycle({
      cacheDir,
      conversationStore: convStore,
      listPinnedTurnIds: () => lifeStore.listQuotedTurnIds(),
    });

    const candidates = convStore.voiceHashesForSession(roomA.sessionId);
    const preservePinned = lifecycle.readPinnedHashes();
    convStore.deleteRoom(roomA.sessionId);

    const purged = lifecycle.purgeUnreferencedHashes(candidates, { preserveHashes: preservePinned });
    assert.equal(purged.deleted, 1);
    assert.equal(existsSync(onlyAPath), false);
    assert.equal(existsSync(sharedPath), true);
    assert.equal(existsSync(pinnedPath), true);
  } finally {
    convStore.close();
    lifeStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
