// selectionIdentity.test.js — 「同一首歌在候选里只出现一次」的判定。
//
// 最重要的一条：**没有身份层时必须与今天完全一致**。这层是增量映射，
// 不能因为它存在而改变未合并场景的任何结果。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionIdentity } from './selectionIdentity.js';

/** 一个最小的身份层替身：edges 描述「哪两条供给身份是同一首歌」。 */
function fakeStore({ edges = {}, representatives = {}, fail = false } = {}) {
  const groupOf = (provider, songId) => {
    const key = `${provider}:${songId}`;
    return edges[key] || `self:${key}`;
  };
  return {
    recordingOf: (provider, songId) => {
      if (fail) throw new Error('store down');
      const recordingId = groupOf(provider, songId);
      const representative = representatives[recordingId] || null;
      return { recordingId, isSelf: recordingId.startsWith('self:'), representative };
    },
  };
}

const qqTrack = { candidateOrigin: 'qq', songId: 'qq-1', title: '晴天', artist: '周杰伦' };
const ncmTrack = { candidateOrigin: 'ncm', songId: '12345', title: '晴天', artist: '周杰伦' };
const otherTrack = { candidateOrigin: 'ncm', songId: '999', title: '稻香', artist: '周杰伦' };

test('without an identity layer the dedupe result is unchanged', () => {
  const identity = createSelectionIdentity({ getRecordingStore: () => null });
  // 供给身份不同就是两条：这正是今天的行为。
  assert.deepEqual(identity.dedupeByRecording([qqTrack, ncmTrack, otherTrack]), [qqTrack, ncmTrack, otherTrack]);
  assert.equal(identity.keyOfTrack(qqTrack), 'qq:qq-1');
  assert.equal(identity.keyOfRef({ provider: 'qq', songId: 'qq-1' }), 'qq:qq-1');
});

test('two sources of the same recording collapse into one candidate', () => {
  const identity = createSelectionIdentity({
    getRecordingStore: () => fakeStore({ edges: { 'qq:qq-1': 'rec:1', 'ncm:12345': 'rec:1' } }),
  });
  const result = identity.dedupeByRecording([qqTrack, ncmTrack, otherTrack]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(track => track.songId), ['qq-1', '999']);
  // 位置由首次出现决定，不打乱既有排序语义。
  assert.equal(result[0], qqTrack);
});

test('the representative source wins even when it appears second', () => {
  const identity = createSelectionIdentity({
    getRecordingStore: () => fakeStore({
      edges: { 'qq:qq-1': 'rec:1', 'ncm:12345': 'rec:1' },
      representatives: { 'rec:1': { provider: 'ncm', songId: '12345' } },
    }),
  });
  const result = identity.dedupeByRecording([qqTrack, ncmTrack]);
  assert.equal(result.length, 1);
  assert.equal(result[0].songId, '12345', '展示与点播应落在代表源上');
  assert.equal(result[0].title, '晴天');
});

test('a collected native source wins over an online representative only in a confirmed group', () => {
  const collected = {...qqTrack, candidateOrigin:'qq:library'};
  const identity = createSelectionIdentity({getRecordingStore:()=>fakeStore({
    edges:{'qq:qq-1':'rec:1','ncm:12345':'rec:1'},
    representatives:{'rec:1':{provider:'ncm',songId:'12345'}}
  })});
  assert.deepEqual(identity.dedupeByRecording([ncmTrack,collected]),[collected]);
  assert.deepEqual(identity.dedupeByRecording([collected,ncmTrack]),[collected]);
  const unrelated = createSelectionIdentity({getRecordingStore:()=>null});
  assert.equal(unrelated.dedupeByRecording([ncmTrack,collected]).length,2);
});

test('a non-representative first entry is not replaced by another non-representative', () => {
  const identity = createSelectionIdentity({
    getRecordingStore: () => fakeStore({
      // 代表源是组内成员，只是本批候选中没有它：不能用另一个非代表源替换第一条。
      edges: { 'qq:qq-1': 'rec:1', 'kugou:k-1': 'rec:1', 'ncm:12345': 'rec:1' },
      representatives: { 'rec:1': { provider: 'ncm', songId: '12345' } },
    }),
  });
  const third = { candidateOrigin: 'kugou', songId: 'k-1', title: '晴天', artist: '周杰伦' };
  const result = identity.dedupeByRecording([qqTrack, third]);
  assert.equal(result.length, 1);
  assert.equal(result[0], qqTrack, '两者都不是代表源时保持首次出现的那条');
});

test('exclusions apply across sources of the same recording', () => {
  const identity = createSelectionIdentity({
    getRecordingStore: () => fakeStore({ edges: { 'qq:qq-1': 'rec:1', 'ncm:12345': 'rec:1' } }),
  });
  // 节目里已经用过 QQ 那条；同一首歌的网易那一条也必须被排除。
  const excluded = identity.keySetOfRefs([{ provider: 'qq', songId: 'qq-1' }]);
  assert.equal(excluded.has(identity.keyOfTrack(ncmTrack)), true);
  assert.equal(excluded.has(identity.keyOfTrack(otherTrack)), false);
});

test('a broken or throwing identity layer degrades to supply identity instead of breaking selection', () => {
  const identity = createSelectionIdentity({ getRecordingStore: () => fakeStore({ fail: true }) });
  assert.equal(identity.keyOfTrack(qqTrack), 'qq:qq-1');
  assert.deepEqual(identity.dedupeByRecording([qqTrack, ncmTrack]), [qqTrack, ncmTrack]);
  const throwing = createSelectionIdentity({ getRecordingStore: () => { throw new Error('boom'); } });
  assert.equal(throwing.keyOfTrack(qqTrack), 'qq:qq-1');
});

test('candidates without a song id fall back to a title-based key and are never merged', () => {
  const identity = createSelectionIdentity({ getRecordingStore: () => fakeStore() });
  const anonymous = { candidateOrigin: 'qq', title: '未知', artist: '某人' };
  assert.equal(identity.keyOfTrack(anonymous), 'qq:某人:未知');
  assert.deepEqual(identity.dedupeByRecording([anonymous, { ...anonymous }]).length, 1);
});

test('refs with a sub-source prefix still resolve to the provider namespace', () => {
  const identity = createSelectionIdentity({ getRecordingStore: () => fakeStore() });
  assert.equal(identity.providerOfTrack({ source: 'ncm:liked', songId: '1' }), 'ncm');
  // 有身份层时返回的是录音身份（自我身份带 self: 前缀），子来源前缀已被剥掉。
  assert.equal(identity.keyOfRef({ provider: 'ncm:liked', songId: '1' }), 'self:ncm:1');
  assert.equal(identity.keyOfRef({ provider: '', songId: '1' }), '');
  assert.deepEqual([...identity.keySetOfRefs([{ provider: '', songId: '1' }, null])], []);
});
