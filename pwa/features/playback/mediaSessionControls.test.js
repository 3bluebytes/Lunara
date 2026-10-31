import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaSessionControls } from './mediaSessionControls.js';

function fakeMediaSession({ unsupported = [] } = {}) {
  const handlers = new Map();
  return {
    playbackState: 'none',
    metadata: null,
    setActionHandler(action, handler) {
      if (unsupported.includes(action)) throw new Error(`unsupported action ${action}`);
      if (handler === null) handlers.delete(action);
      else handlers.set(action, handler);
    },
    emit(action) { handlers.get(action)?.({ action }); },
    installed: () => [...handlers.keys()].sort(),
  };
}

class FakeMetadata {
  constructor(fields) { Object.assign(this, fields); }
}

test('every hardware media key action lands on the injected player behaviour', () => {
  const mediaSession = fakeMediaSession();
  const calls = [];
  const controls = createMediaSessionControls({
    mediaSessionLike: mediaSession,
    MediaMetadataImpl: FakeMetadata,
    handlers: {
      play: () => calls.push('resume'),
      pause: () => calls.push('pause'),
      next: () => calls.push('next'),
      previous: () => calls.push('previous'),
    },
  });
  assert.deepEqual(mediaSession.installed(), ['nexttrack', 'pause', 'play', 'previoustrack'],
    '切歌动作也必须注册：不注册时系统只会暂停音频元素，next/prev 完全没反应');
  for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) mediaSession.emit(action);
  assert.deepEqual(calls, ['resume', 'pause', 'next', 'previous']);
  controls.destroy();
  assert.deepEqual(mediaSession.installed(), [], '销毁后把处理器摘干净，避免迟到媒体键打到已卸载视图');
});

test('one unsupported action does not remove the others', () => {
  const mediaSession = fakeMediaSession({ unsupported: ['previoustrack'] });
  const calls = [];
  const controls = createMediaSessionControls({
    mediaSessionLike: mediaSession,
    handlers: { play: () => calls.push('resume'), previous: () => calls.push('previous') },
  });
  assert.deepEqual(controls.unsupportedActions(), ['previoustrack']);
  assert.deepEqual(mediaSession.installed(), ['play']);
  mediaSession.emit('play');
  assert.deepEqual(calls, ['resume']);
  assert.doesNotThrow(() => controls.destroy());
});

test('now-playing identity and state come from the player, not from the element', () => {
  const mediaSession = fakeMediaSession();
  const controls = createMediaSessionControls({ mediaSessionLike: mediaSession, MediaMetadataImpl: FakeMetadata });

  controls.setNowPlaying({ playing: true, artwork: '/cover.jpg',
    track: { kind: 'track', title: 'Forever Love', artist: '王力宏', album: '心中的日月' } });
  assert.equal(mediaSession.playbackState, 'playing', 'playbackState 决定系统发 play 还是 pause');
  assert.deepEqual(
    { title: mediaSession.metadata.title, artist: mediaSession.metadata.artist, album: mediaSession.metadata.album },
    { title: 'Forever Love', artist: '王力宏', album: '心中的日月' },
  );
  assert.deepEqual(mediaSession.metadata.artwork, [{ src: '/cover.jpg' }]);

  controls.setNowPlaying({ playing: false, artwork: '/cover.jpg',
    track: { kind: 'track', title: 'Forever Love', artist: '王力宏', album: '心中的日月' } });
  assert.equal(mediaSession.playbackState, 'paused');

  // 同一首歌只更新状态，不重建 metadata（每次 refresh 都 new 一份会打断系统侧显示）。
  const first = mediaSession.metadata;
  controls.setNowPlaying({ playing: true, artwork: '/cover.jpg',
    track: { kind: 'track', title: 'Forever Love', artist: '王力宏', album: '心中的日月' } });
  assert.strictEqual(mediaSession.metadata, first);

  controls.setNowPlaying({ track: null });
  assert.equal(mediaSession.playbackState, 'none', '没有当前内容时交回 none，别让媒体键打给空会话');
});

test('a missing media session or metadata implementation never throws', () => {
  const calls = [];
  assert.doesNotThrow(() => {
    const controls = createMediaSessionControls({ mediaSessionLike: undefined, handlers: { play: () => calls.push('x') } });
    controls.setNowPlaying({ track: { title: 'a' } });
    controls.destroy();
  });
  const mediaSession = fakeMediaSession();
  const controls = createMediaSessionControls({ mediaSessionLike: mediaSession, MediaMetadataImpl: undefined });
  assert.doesNotThrow(() => controls.setNowPlaying({ track: { title: 'a' }, playing: true }));
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(mediaSession.metadata, null);
});
