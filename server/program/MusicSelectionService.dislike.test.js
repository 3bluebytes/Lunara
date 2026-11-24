import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'r6a-dislike-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { MusicSelectionService } = await import(`${ROOT}/program/MusicSelectionService.js`);
const { ConversationStore } = await import(`${ROOT}/virtual-person/ConversationStore.js`);
const { VirtualPersonRegistry } = await import(`${ROOT}/virtual-person/VirtualPersonRegistry.js`);
const { PlaybackRuntimeHost } = await import(`${ROOT}/playback/PlaybackRuntimeHost.js`);
const { ProgramCommitService } = await import(`${ROOT}/program/ProgramCommitService.js`);
const { revokeMemory } = await import(`${ROOT}/memory/memoryProvenance.js`);

const feedback = (memory, ns, { turn, sentiment, songId = '123', source = 'qq', policy = { disclosure: 'normal' }, expiresAt }) =>
  memory.addMemory({ namespace: ns, type: expiresAt ? 'working' : 'semantic', source: 'user_explicit_feedback', importance: 7, confidence: 0.7,
    content: `反馈 ${sentiment}`, tags: ['person-relationship', 'music-feedback', `song:${songId}`], expiresAt,
    evidence: JSON.stringify({ writeKey: `k-${turn}`, sourceTurnId: turn, songId, source, sentiment, quote: 'x', policy }) });

function exclusion(memory, sessionId = 's1') {
  const self = { now: () => Date.now(), getRecentPlays: () => [], getMemoryService: () => memory };
  return MusicSelectionService.prototype._recommendationExclusion.call(self,
    { source: 'qq', songId: '123', title: 'T', artist: 'A' },
    { sessionId, entity: { memoryNamespace: 'person:a' }, listening: { queue: [] } });
}

test('先说不喜欢、后来改口喜欢同一首：以最新反馈为准，不再排除', async () => {
  const memory = new MemoryService('person:a');
  await memory.initialize();
  try {
    feedback(memory, 'person:a', { turn: 't1', sentiment: 'dislike' });
    feedback(memory, 'person:a', { turn: 't2', sentiment: 'like' });
    const reason = exclusion(memory);
    assert.equal(reason, null, '最新的明确反馈是喜欢，不应再以 disliked 排除');
  } finally { await memory.shutdown(); }
});

test('只限某个聊天的"这次不想听这首"不排除别的聊天里的推荐', async () => {
  const memory = new MemoryService('person:a');
  await memory.initialize();
  try {
    memory.store.db.exec('DELETE FROM memories');
    feedback(memory, 'person:a', { turn: 't3', sentiment: 'dislike',
      policy: { disclosure: 'normal', onlyConversationId: 's1', until: Date.now() + 86_400_000 }, expiresAt: Date.now() + 86_400_000 });
    const reason = exclusion(memory, 's2');
    assert.equal(reason, null, '限定在 s1 的临时反馈不应作用于 s2');
  } finally { await memory.shutdown(); }
});

test('select() 开放式选歌屏蔽当前聊天的最新 dislike，但遵循同 id 跨源边界、改口与撤回', async t => {
  const localDir = mkdtempSync(join(tmpdir(), 'r6a-select-dislike-'));
  const dbPath = join(localDir, 'state.db');
  const prevDb = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = dbPath;
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  registry.createRadiohost({ id: 'a', displayName: 'A', voiceProfileId: 'voice-a' });
  conversationStore.createRoom({ sessionId: 's1', memberIds: ['a'] });
  conversationStore.createRoom({ sessionId: 's2', memberIds: ['a'] });
  const memory = new MemoryService('radiohost:a');
  await memory.initialize();
  const playbackRuntime = new PlaybackRuntimeHost();
  const tracks = [
    { song_id: '10', title: 'QQ这首', artist: '歌手甲', source: 'qq' },
    { song_id: '10', title: 'NCM同ID歌', artist: '歌手乙', source: 'ncm' },
    { song_id: '20', title: '保留歌', artist: '歌手丙', source: 'qq' },
  ];
  const service = new MusicSelectionService({
    programCommitService: new ProgramCommitService({ playbackRuntime, queueService: { publishSnapshot() {} },
      resolveTrack: async () => ({ ok: false }) }),
    playbackRuntime, registry, conversationStore,
    getMemoryService: () => memory,
    getCandidates: async () => tracks,
    getSongTagStore: () => null,
    getUserPlaylists: async () => [],
    getPlaylistTracks: async () => ({ ok: true, data: { matches: [{ tracks }] } }),
  });
  t.after(async () => {
    await memory.shutdown();
    conversationStore.close();
    registry.close();
    if (prevDb === undefined) delete process.env.LUNARA_DB_PATH; else process.env.LUNARA_DB_PATH = prevDb;
    rmSync(localDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  const d = feedback(memory, 'radiohost:a', { turn: 'td1', sentiment: 'dislike', songId: '10', source: 'qq',
    policy: { disclosure: 'normal', onlyConversationId: 's1', until: Date.now() + 86_400_000 }, expiresAt: Date.now() + 86_400_000 });
  const s1Result = await service.select({ mode: 'discovery', delivery: 'append', count: 2 },
    { sessionId: 's1', virtualPersonId: 'a', requestId: 'r1' });
  assert.deepEqual(s1Result.offer.candidates.map(c => `${c.source}:${c.songId}`), ['ncm:10', 'qq:20'], '仅屏蔽 qq:10，不连坐 ncm:10');

  const s2Result = await service.select({ mode: 'discovery', delivery: 'append', count: 3 },
    { sessionId: 's2', virtualPersonId: 'a', requestId: 'r2' });
  assert.equal(s2Result.offer.candidates.some(c => c.source === 'qq' && c.songId === '10'), true, '作用域外聊天不受影响');

  revokeMemory(memory.store, d.id);
  const afterRevoke = await service.select({ mode: 'discovery', delivery: 'append', count: 3 },
    { sessionId: 's1', virtualPersonId: 'a', requestId: 'r3' });
  assert.equal(afterRevoke.offer.candidates.some(c => c.source === 'qq' && c.songId === '10'), true, '撤回后立即恢复候选');
});
