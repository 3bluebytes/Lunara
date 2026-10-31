import assert from 'node:assert/strict';
import test from 'node:test';
import { createListeningReactions, songReactionKey, LIKE_STATE_COPY } from './listeningReactions.js';

function button(kind) {
  return {
    dataset: { reaction: kind },
    disabled: false,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    closest(selector) {
      const name = String(selector);
      if (name.includes('reaction-retry')) return undefined;
      if (name.includes('listening-panel')) return { id: 'listening-panel' };
      return this;
    },
    focus() {},
  };
}

function statusSlot() {
  return {
    textContent: '',
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); } },
    setAttribute() {},
  };
}

function retryButton() {
  return { hidden: true, disabled: false, closest: selector => (String(selector).includes('reaction-retry') ? this : undefined) };
}

function fixture({
  onDislike = async () => ({ ok: true }),
  onLike = async ({ desired }) => ({ ok: true, like: { desired, remoteState: 'synced' } }),
  onRetryLike = async () => ({ ok: true, like: { desired: true, remoteState: 'synced' } }),
  fetchLike = async () => null,
  confirmAction = async () => true,
} = {}) {
  const handlers = new Map();
  const values = new Map();
  const errors = [];
  const confirms = [];
  const notices = [];
  const buttons = [button('like'), button('dislike')];
  const slots = [statusSlot()];
  const retries = [retryButton()];
  const documentLike = {
    querySelectorAll: selector => {
      if (selector.includes('[data-reaction-status]')) return slots;
      if (selector.includes('[data-reaction-retry]')) return retries;
      return buttons;
    },
    addEventListener: (name, fn) => handlers.set(name, fn),
    removeEventListener: name => handlers.delete(name),
    activeElement: null,
  };
  const reaction = createListeningReactions({
    documentLike,
    localStorageLike: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    onDislike,
    onLike,
    onRetryLike,
    fetchLike,
    confirmAction: async request => { confirms.push(request); return confirmAction(request); },
    onNotice: notice => notices.push(notice),
    onError: error => errors.push(error),
  });
  reaction.init();
  const track = { queueItemId: 'q-a', songId: '186016', source: 'ncm', listeningSessionId: 'room' };
  reaction.setTrack(track);
  return {
    reaction, track, buttons, slots, retries, values, errors, confirms, notices,
    click: async kind => {
      const target = buttons.find(b => b.dataset.reaction === kind);
      await handlers.get('click')({ target });
      await new Promise(done => setTimeout(done, 0));
    },
    clickRetry: async () => {
      await handlers.get('click')({ target: retries[0] });
      await new Promise(done => setTimeout(done, 0));
    },
    stored: () => JSON.parse(values.get('lunara.songReactions') || '{}'),
    likePressed: () => buttons[0].attrs['aria-pressed'],
    status: () => slots[0].textContent,
  };
}

test('like goes to the server, not to localStorage', async () => {
  const calls = [];
  const f = fixture({ onLike: async input => { calls.push(input); return { ok: true, like: { desired: true, remoteState: 'synced' } }; } });
  try {
    await f.click('like');
    assert.deepEqual(calls, [{ provider: 'ncm', songId: '186016', desired: true }]);
    assert.equal(f.likePressed(), 'true');
    assert.equal(f.status(), LIKE_STATE_COPY.synced);
    assert.deepEqual(f.stored(), {}, '喜欢不再写浏览器本地存储');
  } finally { f.reaction.destroy(); }
});

test('a local-only source never claims it synced to the cloud', async () => {
  const f = fixture({ onLike: async ({ desired }) => ({ ok: true, reason: 'no_write_capability', like: { desired, remoteState: 'local_only' } }) });
  try {
    f.reaction.setTrack({ ...f.track, source: 'qq', songId: '0039MnYb0qxYhV' });
    await f.click('like');
    assert.equal(f.likePressed(), 'true');
    assert.equal(f.status(), LIKE_STATE_COPY.local_only);
    assert.notEqual(f.status(), LIKE_STATE_COPY.synced);
  } finally { f.reaction.destroy(); }
});

test('while syncing the copy never says synced', async () => {
  let finish;
  const f = fixture({ onLike: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const pending = f.click('like');
    assert.equal(f.status(), LIKE_STATE_COPY.pending);
    assert.notEqual(f.status(), LIKE_STATE_COPY.synced);
    finish({ ok: true, like: { desired: true, remoteState: 'synced' } });
    await pending;
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.status(), LIKE_STATE_COPY.synced);
  } finally { f.reaction.destroy(); }
});

test('a failed sync keeps the intent, shows the failure and offers an explicit retry', async () => {
  const f = fixture({ onLike: async ({ desired }) => ({ ok: false, like: { desired, remoteState: 'failed' }, sync: { reason: 'not_collectable' } }) });
  try {
    await f.click('like');
    assert.equal(f.likePressed(), 'true', '技术失败不改写用户意图');
    assert.equal(f.status(), LIKE_STATE_COPY.failed);
    assert.equal(f.retries[0].hidden, false);

    f.reaction.setTrack({ ...f.track, songId: 'other' });
    await f.click('like');
  } finally { f.reaction.destroy(); }
});

test('retry is available even after a thrown transport error', async () => {
  const f = fixture({ onLike: async () => { throw new Error('socket hang up'); } });
  try {
    await f.click('like');
    assert.equal(f.status(), LIKE_STATE_COPY.failed);
    assert.equal(f.errors.length, 1);
    assert.equal(f.retries[0].hidden, false);
  } finally { f.reaction.destroy(); }
});

test('clicking again on a liked track asks to unlike it', async () => {
  const calls = [];
  const f = fixture({ onLike: async input => { calls.push(input); return { ok: true, like: { desired: input.desired, remoteState: 'synced' } }; } });
  try {
    await f.click('like');
    await f.click('like');
    assert.deepEqual(calls.map(c => c.desired), [true, false]);
    assert.equal(f.likePressed(), 'false');
    assert.equal(f.status(), '', '未喜欢时不显示同步状态');
  } finally { f.reaction.destroy(); }
});

test('the stored like state is loaded for the current track and stale answers are dropped', async () => {
  const resolvers = new Map();
  const f = fixture({ fetchLike: ({ songId }) => new Promise(resolve => resolvers.set(songId, resolve)) });
  try {
    f.reaction.setTrack({ ...f.track, songId: 'first' });
    f.reaction.setTrack({ ...f.track, songId: 'second' });
    resolvers.get('first')({ like: { desired: true, remoteState: 'synced' } });
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.likePressed(), 'false', '换歌后旧答案不得套到新歌上');

    resolvers.get('second')({ like: { desired: true, remoteState: 'local_only' } });
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.likePressed(), 'true');
    assert.equal(f.status(), LIKE_STATE_COPY.local_only);
  } finally { f.reaction.destroy(); }
});

test('a song already in the cloud playlist reads as liked, with its own copy', async () => {
  const f = fixture({
    fetchLike: async () => ({ ok: true, adopted: true, like: { desired: true, remoteState: 'synced' } }),
  });
  try {
    f.reaction.setTrack({ ...f.track, songId: '1398654758' });
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.likePressed(), 'true', '本地没记录过也要如实显示云端已有的喜欢');
    assert.equal(f.status(), LIKE_STATE_COPY.adopted);
  } finally { f.reaction.destroy(); }
});

test('a state hydrated at queue time (origin=adopted) also uses the adopted copy', async () => {
  const f = fixture({
    fetchLike: async () => ({
      ok: true, adopted: false,
      like: { desired: true, remoteState: 'synced', origin: 'adopted' },
    }),
  });
  try {
    f.reaction.setTrack({ ...f.track, songId: '1398654758' });
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.likePressed(), 'true');
    assert.equal(f.status(), LIKE_STATE_COPY.adopted);
  } finally { f.reaction.destroy(); }
});

test('clicking a liked track asks to unlike it even when the state came from the cloud', async () => {
  const calls = [];
  const f = fixture({
    fetchLike: async () => ({ ok: true, adopted: true, like: { desired: true, remoteState: 'synced' } }),
    onLike: async input => { calls.push(input); return { ok: true, like: { desired: input.desired, remoteState: 'synced' } }; },
  });
  try {
    f.reaction.setTrack({ ...f.track, songId: '1398654758' });
    await new Promise(done => setTimeout(done, 0));
    await f.click('like');
    assert.deepEqual(calls.map(c => c.desired), [false], '第一次点就该是取消，而不是又收藏一遍');
    assert.equal(f.likePressed(), 'false');
  } finally { f.reaction.destroy(); }
});

test('dislike is set, not toggled off, and is not written to the like endpoint', async () => {
  const likes = [];
  const f = fixture({ onLike: async input => { likes.push(input); return { ok: true, like: { desired: true, remoteState: 'synced' } }; } });
  try {
    f.reaction.setTrack({ ...f.track, queueItemId: 'q-a' });
    await f.click('dislike');
    await f.click('dislike');
    assert.equal(f.stored()[songReactionKey(f.track)], 'dislike');
    assert.equal(f.buttons[1].attrs['aria-pressed'], 'true');
    assert.deepEqual(likes, [], '不喜欢不该触发远端喜欢写入');
  } finally { f.reaction.destroy(); }
});

test('a failed dismissal preserves local state and reports an error', async () => {
  let attempts = 0;
  const f = fixture({ onDislike: async () => (++attempts === 1 ? { accepted: false } : { ok: true }) });
  try {
    await f.click('dislike');
    assert.deepEqual(f.stored(), {});
    assert.equal(f.errors.length, 1);
    await f.click('dislike');
    assert.equal(f.stored()['ncm:186016'], 'dislike');
  } finally { f.reaction.destroy(); }
});

test('browsing another source cannot like or dismiss on the active song', async () => {
  const f = fixture();
  try {
    f.reaction.setTrack({ ...f.track, browsingSessionId: 'other' });
    assert.equal(f.buttons[0].disabled, true);
  } finally { f.reaction.destroy(); }
});

test('a plain like writes right away and reports only what the server confirmed', async () => {
  const f = fixture();
  try {
    await f.click('like');
    assert.deepEqual(f.confirms, [], '普通收藏不需要二次确认');
    assert.deepEqual(f.notices.map(notice => notice.title), ['已同步到云端']);
  } finally { f.reaction.destroy(); }
});

test('a source without remote write still tells the truth in the toast', async () => {
  const f = fixture({
    onLike: async ({ desired }) => ({ ok: true, like: { desired, remoteState: 'local_only' } }),
  });
  try {
    await f.click('like');
    assert.deepEqual(f.notices.map(notice => notice.title), ['只记在本机']);
    assert.notEqual(f.notices[0].title, '已同步到云端');
  } finally { f.reaction.destroy(); }
});

test('clicking like on a track that already lives in the cloud asks before removing it', async () => {
  const calls = [];
  let allow = false;
  const f = fixture({
    fetchLike: async () => ({ ok: true, adopted: true, like: { desired: true, remoteState: 'synced' } }),
    onLike: async input => { calls.push(input); return { ok: true, like: { desired: input.desired, remoteState: 'synced' } }; },
    confirmAction: async () => allow,
  });
  try {
    f.reaction.setTrack({ ...f.track, songId: '1398654758' });
    await new Promise(done => setTimeout(done, 0));

    await f.click('like');
    assert.equal(f.confirms.length, 1, '云端已有这首时先解释一次');
    assert.equal(f.confirms[0].kind, 'unlike');
    assert.equal(f.confirms[0].adopted, true, '文案要知道这是从云端采纳的喜欢');
    assert.deepEqual(calls, [], '用户说保留时不能动云端收藏');
    assert.equal(f.likePressed(), 'true');

    allow = true;
    await f.click('like');
    assert.equal(f.confirms.length, 2);
    assert.deepEqual(calls.map(c => c.desired), [false], '再点一次才取消云端收藏');
    assert.equal(f.likePressed(), 'false');
    assert.deepEqual(f.notices.map(notice => notice.title), ['已取消云端收藏']);
  } finally { f.reaction.destroy(); }
});

test('a modal left open while the song changes does not unlike the new song', async () => {
  const calls = [];
  let release;
  const f = fixture({
    fetchLike: async () => ({ ok: true, adopted: true, like: { desired: true, remoteState: 'synced' } }),
    onLike: async input => { calls.push(input); return { ok: true, like: { desired: input.desired, remoteState: 'synced' } }; },
    confirmAction: () => new Promise(resolve => { release = resolve; }),
  });
  try {
    f.reaction.setTrack({ ...f.track, songId: 'cloud-one' });
    await new Promise(done => setTimeout(done, 0));
    const pending = f.click('like');
    f.reaction.setTrack({ ...f.track, songId: 'cloud-two' });
    release(true);
    await pending;
    assert.deepEqual(calls, [], '换歌之后旧歌的取消决定不能落到新歌上');
  } finally { f.reaction.destroy(); }
});

test('dislike asks once before it removes the song and leaves the queue alone when refused', async () => {
  let allow = false;
  const dismissed = [];
  const f = fixture({
    onDislike: async target => { dismissed.push(target.songId); return { ok: true }; },
    confirmAction: async () => allow,
  });
  try {
    f.reaction.setTrack({ ...f.track, queueItemId: 'q-a' });
    await f.click('dislike');
    assert.equal(f.confirms.length, 1);
    assert.equal(f.confirms[0].kind, 'dislike');
    assert.deepEqual(dismissed, [], '用户取消时不能移出播放列表');
    assert.deepEqual(f.stored(), {});

    allow = true;
    await f.click('dislike');
    assert.deepEqual(dismissed, ['186016']);
    assert.deepEqual(f.notices.map(notice => notice.title), ['已移出播放列表']);
  } finally { f.reaction.destroy(); }
});

test('unliking a local-only like needs no confirmation because nothing is in the cloud', async () => {
  const f = fixture({
    fetchLike: async () => null,
    onLike: async ({ desired }) => ({ ok: true, like: { desired, remoteState: 'local_only' } }),
  });
  try {
    f.reaction.setTrack({ ...f.track, source: 'qq', songId: '0039MnYb0qxYhV' });
    await f.click('like');
    assert.deepEqual(f.confirms, []);
    await f.click('like');
    assert.equal(f.confirms.length, 0, '只在本机记过的喜欢，取消时不打扰');
    assert.equal(f.likePressed(), 'false');
  } finally { f.reaction.destroy(); }
});
