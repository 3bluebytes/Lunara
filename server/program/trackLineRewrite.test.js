// 隔久恢复的重写：按 host 分组交给 startLinePass，带上停顿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackLineRewrite } from './trackLineRewrite.js';

test('按写这首的 host 分组，用 runtime 的写入目标交给 startLinePass，带上停顿', async () => {
  const passes = [];
  const rewrite = createTrackLineRewrite({
    getRegistry: () => ({ get: id => (id === 'p1' ? { id: 'p1' } : null) }),
    getHost: () => ({ startLinePass: async input => { passes.push(input); } }),
    getSelectionService: () => ({ lineTargetFor: (item, sessionId) => ({ track: item, sessionId }) }),
  });
  await rewrite({ listeningSessionId: 's1', stoppedAtMs: 1, resumedAtMs: 2,
    tracks: [{ songId: 'a', virtualPersonId: 'p1' }, { songId: 'b', virtualPersonId: 'p1' }, { songId: 'c', virtualPersonId: 'gone' }] });
  assert.equal(passes.length, 2);
  assert.deepEqual(passes[0].targets.map(target => target.track.songId), ['a', 'b']);
  assert.equal(passes[0].entity.id, 'p1');
  assert.equal(passes[0].sessionId, 's1');
  assert.deepEqual(passes[0].playbackGap, { stoppedAtMs: 1, resumedAtMs: 2 });
  assert.equal(passes[1].entity, null, '找不到 host：交给 startLinePass 走 fail');
});

test('host 或选歌服务还没就绪：抛出，由组合层按代次报失败', async () => {
  const rewrite = createTrackLineRewrite({ getRegistry: () => null, getHost: () => null, getSelectionService: () => null });
  await assert.rejects(rewrite({ listeningSessionId: 's1', tracks: [{ songId: 'a' }] }));
});
