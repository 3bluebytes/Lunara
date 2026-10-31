import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TrackLikeStore } from '../music/trackLikeStore.js';
import { TrackLikeService } from './TrackLikeService.js';

function registryWith(writable) {
  return {
    supports: (id, capability) => (capability === 'like'
      ? true // 读取喜欢：本 change 里每个可播源都有
      : capability === 'like-write' && writable.includes(id)),
  };
}

function fixture({ writable = ['ncm'], ncm, qq } = {}) {
  const store = new TrackLikeStore({ dbPath: ':memory:', now: () => 1_700_000_000_000 }).initialize();
  const writes = [];
  const providers = {
    ncm: ncm || {
      setSongLiked: async (songId, desired) => { writes.push({ provider: 'ncm', songId, desired }); return { ok: true, state: 'liked' }; },
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: ['186016'] }),
    },
    qq: qq || {
      setSongLiked: async (songId, desired) => { writes.push({ provider: 'qq', songId, desired }); return { ok: true }; },
      isSongLiked: async () => ({ ok: true, liked: false }),
    },
  };
  const service = new TrackLikeService({ store, providers, registry: registryWith(writable) });
  return { service, store, writes, providers };
}

test('a song already in the remote playlist is adopted on first view, not shown as unliked', async () => {
  let reads = 0;
  const { service, store } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => { reads += 1; return { ok: true, ids: ['1398654758'] }; },
    },
  });

  const first = await service.resolveLike({ provider: 'ncm', songId: '1398654758' });
  assert.equal(first.adopted, true, '本来就在云端歌单里，心形必须一开始就是实的');
  assert.equal(first.like.desired, true);
  assert.equal(first.like.remoteState, 'synced');
  assert.equal(store.get('ncm', '1398654758').desired, true);

  const second = await service.resolveLike({ provider: 'ncm', songId: '1398654758' });
  assert.equal(second.adopted, false, '第二次直接读本地记录');
  assert.equal(reads, 1, '采纳一次之后不再打远端');
});

test('a song that is not in the remote playlist stays unexpressed locally', async () => {
  const { service, store } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: ['other'] }),
    },
  });

  const resolved = await service.resolveLike({ provider: 'ncm', songId: '1398654758' });
  assert.equal(resolved.like, null);
  assert.equal(resolved.adopted, false);
  assert.equal(store.get('ncm', '1398654758'), null, '没读过远端就写一行假意图');
});

test('an unreadable remote state is never adopted', async () => {
  const { service, store } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: false }),
      likedSongIds: async () => ({ ok: false, ids: [], reason: 'not_logged_in' }),
    },
  });

  const resolved = await service.resolveLike({ provider: 'ncm', songId: '1' });
  assert.equal(resolved.like, null);
  assert.equal(resolved.readError, 'not_logged_in');
  assert.equal(store.get('ncm', '1'), null);
});

test('the remote liked list is cached briefly so切换歌曲不会逐首打远端', async () => {
  let reads = 0;
  const { service } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => { reads += 1; return { ok: true, ids: ['a', 'b'] }; },
    },
  });

  await service.resolveLike({ provider: 'ncm', songId: 'a' });
  await service.resolveLike({ provider: 'ncm', songId: 'b' });
  assert.equal(reads, 1);
});

test('qq adoption uses the read-only module and still never writes', async () => {
  const writes = [];
  const { service } = fixture({
    writable: ['ncm'],
    qq: {
      setSongLiked: async () => { writes.push('write'); return { ok: true }; },
      isSongLiked: async () => ({ ok: true, liked: true }),
    },
  });

  const resolved = await service.resolveLike({ provider: 'qq', songId: '0039MnYb0qxYhV' });
  assert.equal(resolved.adopted, true);
  assert.equal(resolved.canWriteRemote, false);
  assert.deepEqual(writes, [], '采纳是只读动作，不能触发写');
});

test('hydrate adopts the whole committed batch in one remote read', async () => {
  let reads = 0;
  const { service, store } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => { reads += 1; return { ok: true, ids: ['a', 'c'] }; },
    },
  });

  const summary = await service.hydrate({ tracks: [
    { source: 'ncm', songId: 'a' }, { source: 'ncm', songId: 'b' }, { source: 'ncm', songId: 'c' },
  ] });

  assert.equal(reads, 1, '排歌时一次 likelist 覆盖整批');
  assert.equal(summary.adopted, 2);
  assert.equal(store.get('ncm', 'a').origin, 'adopted');
  assert.equal(store.get('ncm', 'a').remoteState, 'synced');
  assert.equal(store.get('ncm', 'b'), null, '云端没有的歌不造行');
});

test('hydrate lets the remote win for adopted rows and the user win for explicit ones', async () => {
  let remoteLiked = false;
  const { service, store } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: remoteLiked ? ['a', 'b'] : [] }),
    },
  });

  // a 是用户在 Lunara 里点的喜欢；b 是云端带过来的。
  await service.setLike({ provider: 'ncm', songId: 'a', desired: true, requestId: 'ua' });
  remoteLiked = true;
  await service.hydrate({ tracks: [{ source: 'ncm', songId: 'a' }, { source: 'ncm', songId: 'b' }] });
  assert.equal(store.get('ncm', 'a').remoteState, 'synced');
  assert.equal(store.get('ncm', 'b').origin, 'adopted');

  // 用户在音乐源 App 里把两首都不喜欢了
  remoteLiked = false;
  service.invalidateRemoteCache();
  await service.hydrate({ tracks: [{ source: 'ncm', songId: 'a' }, { source: 'ncm', songId: 'b' }] });

  const userRow = store.get('ncm', 'a');
  assert.equal(userRow.desired, true, '用户在自己 UI 上表达过的喜欢不该被远端静默改掉');
  assert.equal(userRow.remoteState, 'pending', '冲突时标 pending 交给有界重试');

  const adoptedRow = store.get('ncm', 'b');
  assert.equal(adoptedRow.desired, false, '采纳来的状态必须跟随远端');
  assert.equal(adoptedRow.origin, 'adopted');
});

test('hydrate leaves every row untouched when the remote cannot be read', async () => {
  const { service, store } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: false }),
      likedSongIds: async () => ({ ok: false, ids: [], reason: 'not_logged_in' }),
    },
  });
  store.setDesired('ncm', 'a', true, { remoteState: 'synced', requestId: 'u1' });
  const before = store.get('ncm', 'a');

  const summary = await service.hydrate({ tracks: [{ source: 'ncm', songId: 'a' }, { source: 'ncm', songId: 'b' }] });

  assert.equal(summary.readErrors.ncm, 'not_logged_in');
  assert.deepEqual(store.get('ncm', 'a'), before);
  assert.equal(store.get('ncm', 'b'), null);
});

test('hydrate asks QQ once for the whole batch instead of per track', async () => {
  const asked = [];
  const { service } = fixture({
    writable: ['ncm'],
    qq: {
      setSongLiked: async () => ({ ok: true }),
      isSongLiked: async () => ({ ok: true, liked: false }),
      isSongLikedBatch: async mids => { asked.push(mids); return { ok: true, liked: new Set([mids[0]]) }; },
    },
  });

  const summary = await service.hydrate({ tracks: [
    { source: 'qq', songId: 'm1' }, { source: 'qq', songId: 'm2' },
  ] });

  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], ['m1', 'm2']);
  assert.equal(summary.adopted, 1);
});

test('a source whose registry entry lacks like-write stays local_only and never touches the network', async () => {
  const { service, writes } = fixture({ writable: ['ncm'] });

  const result = await service.setLike({ provider: 'qq', songId: '0039MnYb0qxYhV', desired: true, requestId: 'q1' });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no_write_capability');
  assert.equal(result.like.remoteState, 'local_only');
  assert.equal(result.like.desired, true);
  assert.equal(writes.length, 0);
});

test('QQ mirrors through the same service path once it declares like-write', async () => {
  const { service, writes, store } = fixture({ writable: ['ncm', 'qq'] });

  const result = await service.setLike({ provider: 'qq', songId: '000T1Ws32MWrUj', desired: true, requestId: 'q2' });

  assert.deepEqual(writes, [{ provider: 'qq', songId: '000T1Ws32MWrUj', desired: true }]);
  assert.equal(result.like.remoteState, 'synced');
  assert.equal(store.get('qq', '000T1Ws32MWrUj').desired, true);
});

test('a QQ song the source refuses to collect stays failed and is not auto-retried', async () => {
  const { service, store } = fixture({
    writable: ['ncm', 'qq'],
    qq: {
      setSongLiked: async () => ({ ok: false, reason: 'not_collectable', code: 80105 }),
      isSongLiked: async () => ({ ok: true, liked: false }),
    },
  });

  const result = await service.setLike({ provider: 'qq', songId: '003aAYrm3GE0Ac', desired: true, requestId: 'q3' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_collectable');
  assert.equal(result.retryable, false);
  assert.equal(store.get('qq', '003aAYrm3GE0Ac').remoteState, 'failed');
});

test('a writable source mirrors and only claims synced after the provider confirms', async () => {
  const { service, writes, store } = fixture();

  const result = await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'n1' });

  assert.deepEqual(writes, [{ provider: 'ncm', songId: '186016', desired: true }]);
  assert.equal(result.like.remoteState, 'synced');
  assert.equal(store.get('ncm', '186016').desired, true);
});

test('the same requestId replays without writing the remote twice', async () => {
  const { service, writes } = fixture();

  const first = await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'same' });
  const second = await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'same' });

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(writes.length, 1);
});

test('an expired login degrades to local_only instead of a scary sync failure', async () => {
  const { service } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: false, reason: 'not_logged_in', code: 301 }),
      loginStatus: async () => ({ loggedIn: false }),
      likedSongIds: async () => ({ ok: true, ids: [] }),
    },
  });

  const result = await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'n2' });

  assert.equal(result.kind ?? result.reason, 'not_logged_in');
  assert.equal(result.like.remoteState, 'local_only');
  assert.equal(result.like.desired, true, '登录失效不等于用户不想喜欢');
});

test('a delisted song fails closed without burning retry budget', async () => {
  const { service } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: false, reason: 'not_collectable', code: 500 }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: [] }),
    },
  });

  const result = await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'n3' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_collectable');
  assert.equal(result.like.remoteState, 'failed');
  assert.equal(result.like.attempts, 0);
  assert.equal(result.like.desired, true);
});

test('retryable failures accumulate and stop at the cap', async () => {
  const { service } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: false, reason: 'request_failed' }),
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: [] }),
    },
  });

  await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'first' });
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = await service.retry({ provider: 'ncm', songId: '186016' });
  }
  assert.equal(last.like.remoteState, 'failed');
  assert.equal(last.retryable, false);
});

test('concurrent opposite intents on one track serialize and end on the last one', async () => {
  const seen = [];
  let release = null;
  const gate = new Promise(done => { release = done; });
  const { service } = fixture({
    ncm: {
      setSongLiked: async (songId, desired) => {
        seen.push(desired);
        if (seen.length === 1) await gate;
        return { ok: true };
      },
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: ['186016'] }),
    },
  });

  const first = service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'a' });
  const second = service.setLike({ provider: 'ncm', songId: '186016', desired: false, requestId: 'b' });
  await new Promise(done => setTimeout(done, 10));
  release();
  await Promise.all([first, second]);

  assert.deepEqual(seen, [true, false], '同一首歌的写必须串行');
});

test('reconcile detects drift, retries once, and keeps the intent', async () => {
  let remoteLiked = false;
  const writes = [];
  const { service } = fixture({
    ncm: {
      setSongLiked: async (songId, desired) => { writes.push(desired); remoteLiked = desired; return { ok: true }; },
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: remoteLiked ? ['186016'] : [] }),
    },
  });

  await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'a' });
  remoteLiked = false; // 用户在音乐源 App 里取消了收藏

  const result = await service.reconcile({ provider: 'ncm', songId: '186016' });

  assert.equal(result.drifted, true);
  assert.equal(result.like.remoteState, 'synced');
  assert.equal(result.like.desired, true);
  assert.deepEqual(writes, [true, true], '漂移只重试一次');
});

test('reconcile never rewrites the intent when the remote cannot be read', async () => {
  const { service } = fixture({
    ncm: {
      setSongLiked: async () => ({ ok: true }),
      loginStatus: async () => ({ loggedIn: false }),
      likedSongIds: async () => ({ ok: true, ids: [] }),
    },
  });

  await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'a' });
  const before = service.getLike('ncm', '186016');
  const result = await service.reconcile({ provider: 'ncm', songId: '186016' });
  const after = service.getLike('ncm', '186016');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_logged_in');
  assert.deepEqual(after, before, '读不到远端时什么都不该变');
});

test('a provider that throws is treated as a retryable failure, never as disliking it', async () => {
  const { service } = fixture({
    ncm: {
      setSongLiked: async () => { throw new Error('socket hang up'); },
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      likedSongIds: async () => ({ ok: true, ids: [] }),
    },
  });

  const result = await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'a' });

  assert.equal(result.ok, false);
  assert.equal(result.like.desired, true);
  assert.equal(result.like.remoteState, 'pending');
  assert.equal(result.like.lastError, 'request_failed');
});

test('the model feedback path and the like path stay separated at the source level', () => {
  // 两条路径必须互不认识：模型记「用户喜欢这首歌」只写关系记忆；
  // 用户点心形只动 song_likes 与远端收藏。任何一边开始引用另一边都会在这里红。
  // 只看代码行：注释里提到这些名字（说明「不该用」）是正常的。
  const codeOnly = path => readFileSync(path, 'utf8').split('\n')
    .filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');

  const tools = codeOnly(new URL('../virtual-person/musicTools.js', import.meta.url));
  assert.doesNotMatch(tools, /trackLike|setSongLiked|song_likes/i);

  const likeService = codeOnly(new URL('./TrackLikeService.js', import.meta.url));
  assert.doesNotMatch(likeService, /memoryService|addMemory|agentLoop|conversationStore/i);

  const likeStore = codeOnly(new URL('../music/trackLikeStore.js', import.meta.url));
  assert.doesNotMatch(likeStore, /memoryService|addMemory|agentLoop/i);
});

test('the service writes no memory and starts no agent turn', async () => {
  const { service } = fixture();
  const before = new Set(Object.keys(service));
  await service.setLike({ provider: 'ncm', songId: '186016', desired: true, requestId: 'a' });
  // 依赖面就是这些：没有 memory、没有 agent、没有 conversation store。
  assert.deepEqual([...Object.keys(service)].filter(k => !before.has(k)), []);
  for (const forbidden of ['memory', 'agentLoop', 'conversationStore', 'playbackRuntime']) {
    assert.equal(forbidden in service, false, `${forbidden} 不该出现在喜欢服务里`);
  }
});
