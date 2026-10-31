import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppState, reduceServerMessage } from '../../core/appState.js';
import { createPlaybackView } from './playbackView.js';
import { getMusicVolumePreference, resetMusicVolumePreferenceForTest, setMusicVolumePreference } from './musicVolumePreference.js';
import { resetTrayTextModeForTest, setTrayTextMode } from './trayTextPreference.js';

function element() {
  const listeners = new Map();
  const attributes = new Map();
  const style = {
    setProperty(name, value) { this[name] = value; },
  };
  return {
    style, dataset: {}, innerHTML: '', textContent: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    emit(type, event = {}) { listeners.get(type)?.({ type, currentTarget: this, ...event }); },
    querySelector: () => element(),
    querySelectorAll: () => [],
    listenerCount: () => listeners.size,
  };
}

function lyricIdentityFixture() {
  const nodes = new Map(['#np-title', '#np-sub', '#player-cover', '#player-line-text', '#player-line-next',
    '#listening-lyric', '#listening-lyric-next', '#listening-lyric-previous'].map(id => [id, element()]));
  const timers = [];
  const store = createAppState({ sessionId: 'fixture' });
  const music = { paused: false, src: '/jp.mp3', currentTime: 2, duration: 200, volume: 1 };
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: { paused: true, currentTime: 0 },
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    schedule: fn => { timers.push(fn); return timers.length; }, cancelSchedule: () => {} });
  const jp = { queueItemId: 'q:jp', songId: 'jp', source: 'ncm', title: '日本語の曲',
    artist: '日本の歌手', artwork: '/jp.jpg', url: '/jp.mp3', lyric: { lrc: '[00:00]日本語の歌詞\n[00:10]日本語の次の行' } };
  const cn = { queueItemId: 'q:cn', songId: 'cn', source: 'qq', title: '中文歌曲',
    artist: '中文歌手', artwork: '/cn.jpg', url: '/cn.mp3', lyric: { lrc: '[00:00]下一首中文歌词\n[00:10]中文下一句' } };
  let version = 0;
  const broadcast = (queue, currentIndex = 0) => reduceServerMessage(store, { type: 'runtime-state', state: {
    version: ++version, queue, currentIndex, currentSongId: queue[currentIndex]?.songId ?? null,
    activeListeningSessionId: 'fixture', phase: 'playing' } });
  return { nodes, timers, store, music, view, jp, cn, broadcast };
}

test('persisted corrupted lyrics are hidden without mutating runtime or changing media', () => {
  const { nodes, store, view, music, cn, broadcast } = lyricIdentityFixture();
  try {
    for (const lrc of ['� ��y�_w�N��', '[00:00]bad�text', 'deadbeef'.repeat(60)]) {
      const track = { ...cn, lyric: { lrc } };
      broadcast([track]); view.refresh(); view.callbacks.onTimeUpdate(music);
      assert.equal(nodes.get('#listening-lyric').textContent, '');
      assert.equal(nodes.get('#listening-lyric-next').textContent, '');
      assert.equal(nodes.get('#listening-lyric-previous').textContent, '');
      assert.equal(store.getState().runtimeState.queue[0].lyric.lrc, lrc);
      assert.equal(music.src, '/jp.mp3');
      assert.equal(music.currentTime, 2);
      assert.equal(music.paused, false);
    }
    broadcast([{ ...cn, lyric: { lrc: Buffer.from('[00:00]恢复后的合成歌词').toString('base64') } }]);
    view.refresh(); view.callbacks.onTimeUpdate(music);
    assert.equal(nodes.get('#listening-lyric').textContent, '恢复后的合成歌词');
  } finally { view.destroy(); }
});

test('a neighboring track callback cannot mix its title with the current runtime lyrics', () => {
  const { nodes, timers, view, music, jp, cn, broadcast } = lyricIdentityFixture();
  try {
    broadcast([jp, cn]); view.refresh();
    for (const wrong of [cn, { ...jp, songId: 'other' }, { ...jp, source: 'qq' }]) {
      view.callbacks.onTrack(wrong);
      timers.forEach(fn => fn());
      view.callbacks.onTimeUpdate(music);
      assert.equal(nodes.get('#np-title').textContent, jp.title);
      assert.equal(nodes.get('#player-cover').src, jp.artwork);
      assert.equal(nodes.get('#listening-lyric').textContent, '日本語の歌詞');
    }
  } finally { view.destroy(); }
});

test('a matching callback uses runtime metadata and replaces lyrics before refresh or a media tick', () => {
  const { nodes, timers, view, music, jp, cn, broadcast } = lyricIdentityFixture();
  try {
    broadcast([jp, cn]); view.refresh();
    broadcast([jp, cn], 1);
    view.callbacks.onTrack({ ...cn, title: '旧回调标题', lyric: jp.lyric });
    timers.forEach(fn => fn());
    view.callbacks.onTimeUpdate(music);
    assert.equal(nodes.get('#np-title').textContent, cn.title);
    assert.equal(nodes.get('#player-line-text').textContent, '下一首中文歌词');
    assert.equal(nodes.get('#listening-lyric-next').textContent, '中文下一句');
  } finally { view.destroy(); }
});

test('runtime lyrics ignore a contaminated compatibility slice and clear on missing lyrics or idle', () => {
  const { nodes, store, view, music, jp, cn, broadcast } = lyricIdentityFixture();
  try {
    broadcast([jp, cn]); view.refresh();
    store.update({ queue: [{ ...cn, kind: 'track', song_id: cn.songId }], cursor: 0 });
    view.refresh();
    assert.equal(nodes.get('#np-title').textContent, jp.title);
    assert.equal(nodes.get('#listening-lyric').textContent, '日本語の歌詞');
    const silent = { ...cn, queueItemId: 'q:no-lyrics', songId: jp.songId, lyric: null };
    broadcast([silent]);
    view.callbacks.onTrack(silent);
    view.callbacks.onTimeUpdate(music);
    assert.equal(nodes.get('#listening-lyric').textContent, '');
    assert.equal(nodes.get('#listening-lyric-next').textContent, '');
    broadcast([], -1); view.refresh();
    assert.equal(nodes.get('#listening-lyric').textContent, '');
  } finally { view.destroy(); }
});

test('repeated occurrences and cross-provider equal ids replace cached lyric lines synchronously', () => {
  const { nodes, timers, view, music, jp, broadcast } = lyricIdentityFixture();
  try {
    broadcast([jp]); view.refresh();
    for (const source of ['ncm', 'qq']) {
      const repeat = { ...jp, source, queueItemId: `repeat:${source}`, title: `曲目-${source}`,
        lyric: { lrc: `[00:00]新歌词-${source}` } };
      broadcast([repeat]);
      view.callbacks.onTrack(repeat);
      timers.forEach(fn => fn());
      view.callbacks.onTimeUpdate(music);
      assert.equal(nodes.get('#np-title').textContent, repeat.title);
      assert.equal(nodes.get('#listening-lyric').textContent, `新歌词-${source}`);
    }
  } finally { view.destroy(); }
});

test('D interlude is a lyric timestamp projection and browsing another source hides its lyric', () => {
  const nodes = new Map(['#listening-lyric','#listening-lyric-previous','#listening-lyric-next',
    '#listening-interlude','#focus-interlude','#player-line-text','#player-line-next'].map(id=>[id,element()]));
  const store = createAppState({sessionId:'A'});
  reduceServerMessage(store,{type:'runtime-state',state:{version:1,queue:[{queueItemId:'q',songId:'song',title:'歌',artist:'人',url:'/x',
    lyric:{lrc:'[00:00]第一句\\n[00:40]下一句'}}],currentIndex:0,currentSongId:'song',activeListeningSessionId:'A',phase:'playing'}});
  const music = {paused:false,src:'/x',currentTime:15,duration:100,volume:1};
  const view = createPlaybackView({store,musicAudio:music,narrationAudio:{paused:true,volume:1},
    documentLike:{querySelector:id=>nodes.get(id)||element(),querySelectorAll:()=>[]},schedule:()=>null});
  view.refresh();
  assert.match(nodes.get('#listening-interlude').textContent,/约 25 秒/);
  assert.equal(nodes.get('#listening-lyric').hidden,false);
  store.update({sessionId:'B'});view.refresh();
  assert.equal(nodes.get('#listening-lyric').hidden,true);
  assert.equal(nodes.get('#listening-interlude').hidden,true);
  assert.equal(store.getState().runtimeState.activeListeningSessionId,'A');
  view.destroy();
});

test('untimed text, empty lyrics and the last line never invent a next-line countdown', () => {
  const nodes = new Map(['#listening-lyric', '#listening-lyric-next', '#listening-lyric-previous',
    '#listening-interlude', '#focus-interlude', '#player-line-text', '#player-line-next'].map(id => [id, element()]));
  const store = createAppState({ sessionId: 'A' });
  const music = { paused: false, src: '/x', currentTime: 15, duration: 240, volume: 1 };
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: { paused: true, volume: 1 },
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] }, schedule: () => null });
  let version = 0;
  const show = lrc => {
    const id = 'q-' + (++version);
    reduceServerMessage(store, { type: 'runtime-state', state: { version,
      queue: [{ queueItemId: id, songId: id, title: '曲名', artist: '艺人', url: '/x', lyric: { lrc } }],
      currentIndex: 0, currentSongId: id, activeListeningSessionId: 'A', phase: 'playing' } });
    view.refresh();
    view.callbacks.onTimeUpdate(music);
  };
  try {
    show('[00:00]第一句\n[00:40]下一句');
    for (const id of ['#listening-interlude', '#focus-interlude']) {
      assert.equal(nodes.get(id).hidden, false);
      assert.match(nodes.get(id).textContent, /约 25 秒/);
    }
    for (const lrc of ['曲名-艺人\n作曲-艺人\n纯音乐，请欣赏', '', '[00:00]最后一句']) {
      show(lrc);
      for (const id of ['#listening-interlude', '#focus-interlude']) {
        assert.equal(nodes.get(id).hidden, true, lrc);
        assert.equal(nodes.get(id).textContent, '', lrc);
      }
      if (lrc.startsWith('曲名')) {
        assert.equal(nodes.get('#player-line-text').textContent, '曲名-艺人');
        assert.equal(nodes.get('#player-line-next').textContent, '作曲-艺人');
        music.currentTime = 180;
        view.callbacks.onTimeUpdate(music);
        assert.equal(nodes.get('#player-line-text').textContent, '曲名-艺人');
        music.currentTime = 15;
      }
    }
  } finally { view.destroy(); }
});

test('auto-continue shows server state, pending selection, and a recoverable retry without optimistic toggling', async () => {
  const nodes = new Map(['#radio-toggle', '#continuation-status', '#continuation-retry'].map(id => [id, element()]));
  const label = element();
  nodes.get('#radio-toggle').querySelector = () => label;
  const store = createAppState({ runtimeState: { radioMode: false, phase: 'exhausted' } });
  const errors = [];
  let retried = 0;
  let finish;
  const view = createPlaybackView({ store, musicAudio: { paused: true }, narrationAudio: { paused: true },
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    getRuntimeClient: () => ({
      setRadioMode: () => new Promise(resolve => { finish = resolve; }),
      retry: async () => { retried += 1; return { accepted: true }; },
    }), onError: error => errors.push(error) });
  view.init(); view.refresh();
  assert.equal(label.textContent, '自动续播：关');
  nodes.get('#radio-toggle').emit('click');
  assert.equal(label.textContent, '自动续播：关');
  assert.equal(nodes.get('#radio-toggle').disabled, true);
  store.update({ runtimeState: { radioMode: true, phase: 'exhausted', pendingContinuation: { status: 'requested' } } });
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(label.textContent, '自动续播：开');
  assert.equal(nodes.get('#continuation-status').textContent, '正在准备下一首…');
  store.update({ runtimeState: { radioMode: true, phase: 'exhausted', pendingContinuation: { status: 'failed' } } });
  view.refresh();
  assert.equal(nodes.get('#continuation-retry').hidden, false);
  assert.equal(nodes.get('#continuation-status').textContent, '续播没成功，可以重试');
  nodes.get('#continuation-retry').emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retried, 1);
  assert.deepEqual(errors, []);
  view.destroy();
});

test('playback view init is idempotent and destroy removes owned listeners', () => {
  const nodes = new Map([
    ['#big-play', element()], ['#skip-btn', element()], ['#radio-toggle', element()],
    ['#player-volume', element()],
    ['#progress-bar', element()], ['#player-line', element()], ['#status', element()],
    ['#thinking', element()], ['#sb-queue', element()], ['#np-time', element()], ['#np-duration', element()],
    ['#progress-fill', element()], ['#player-line-text', element()],
    ['#player-line-next', element()], ['#np-title', element()], ['#np-sub', element()],
  ]);
  const documentLike = {
    querySelector: selector => nodes.get(selector) || element(),
    querySelectorAll: () => [],
    createElement: () => element(),
    body: element(),
  };
  const music = { paused: true, src: '', duration: 0, currentTime: 0, volume: 1, play() {}, pause() {} };
  const narration = { ...music };
  const controller = {
    getSnapshot: () => ({ overlayActive: false }),
    hasRealMusicPlaying: () => false, playOverlayNarrations() {}, restoreMusic() {},
    reportPartial() {}, flushOutcomeQueue() {}, resetOutcomeLatch() {}, setDuckLevel() {},
  };
  const view = createPlaybackView({
    store: createAppState({ queue: [], cursor: -1 }),
    narrationAudio: narration,
    musicAudio: music,
    documentLike,
    locationHref: 'http://localhost/',
    getController: () => controller,
    getRuntimeClient: () => ({ setRadioMode() {}, resume() {}, pause() {}, requestNext() {} }),
  });
  view.init();
  view.init();
  assert.equal(nodes.get('#big-play').listenerCount(), 1);
  assert.equal(nodes.get('#player-volume').listenerCount(), 1);
  view.destroy();
  assert.equal(nodes.get('#big-play').listenerCount(), 0);
  assert.equal(nodes.get('#player-volume').listenerCount(), 0);
});

test('focus transport projects duration, supports keyboard seeking, and mutes both mounted outputs', () => {
  const nodes = new Map([
    ['#big-play', element()], ['#skip-btn', element()], ['#player-volume', element()],
    ['#progress-bar', element()], ['#progress-fill', element()], ['#np-time', element()],
    ['#np-duration', element()], ['#radio-toggle', element()],
  ]);
  const music = Object.assign(element(), {
    paused: false, src: '/song.mp3', currentTime: 61, duration: 245, muted: false,
  });
  const narration = Object.assign(element(), {
    paused: true, src: '', currentTime: 0, duration: 0, muted: false,
  });
  let prevented = false;
  const view = createPlaybackView({
    store: createAppState(),
    narrationAudio: narration,
    musicAudio: music,
    documentLike: { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] },
    getController: () => ({ flushOutcomeQueue() {}, reportPartial() {} }),
    getRuntimeClient: () => ({}),
  });

  view.init();
  view.callbacks.onTimeUpdate(music);
  assert.equal(nodes.get('#np-time').textContent, '1:01');
  assert.equal(nodes.get('#np-duration').textContent, '4:05');
  assert.equal(nodes.get('#progress-bar').getAttribute('aria-valuetext'), '1:01 / 4:05');
  assert.equal(nodes.get('#progress-bar').style['--player-progress'], `${61 / 245 * 100}%`);

  nodes.get('#progress-bar').emit('keydown', { key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(music.currentTime, 66);
  assert.equal(nodes.get('#np-time').textContent, '1:06');
  assert.equal(prevented, true);

  nodes.get('#player-volume').emit('click');
  assert.equal(music.muted, true);
  assert.equal(narration.muted, true);
  assert.equal(nodes.get('#player-volume').getAttribute('aria-pressed'), 'true');
  assert.equal(nodes.get('#player-volume').getAttribute('aria-label'), '恢复声音');
  view.destroy();
});

test('runtime status labels distinguish confirmed playback, pause, setup, and recoverable failures', () => {
  const label = element();
  const status = element();
  status.dataset = {};
  status.querySelector = () => label;
  const thinking = element();
  const nodes = new Map([['#status', status], ['#thinking', thinking]]);
  const view = createPlaybackView({
    store: createAppState(),
    narrationAudio: { paused: true },
    musicAudio: { paused: true },
    documentLike: { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] },
  });

  view.setStatus('paused');
  assert.equal(label.textContent, '已暂停');
  assert.equal(status.dataset.state, 'paused');
  view.setStatus('loading');
  assert.equal(label.textContent, '正在准备');
  assert.equal(status.dataset.state, 'loading');
  view.setStatus('autoplay-blocked');
  assert.equal(label.textContent, '点击开始播放');
  assert.equal(status.dataset.state, 'autoplay-blocked');
  view.setStatus('error');
  assert.equal(label.textContent, '播放遇到问题，可重试');
  assert.equal(status.dataset.state, 'error');
  view.setStatus('playing');
  assert.equal(label.textContent, '正在播放');
  assert.equal(status.dataset.state, 'playing');
  view.setStatus('thinking');
  assert.equal(label.textContent, '正在回应');
  assert.equal(thinking.style.display, 'flex');
});

test('runtime target remains the now-playing source during an ordinary chat overlay', () => {
  const nodes = new Map([
    ['#np-title', element()], ['#np-sub', element()], ['#np-album', element()], ['#player-cover', element()],
    ['#player-line-text', element()], ['#player-line-next', element()],
    ['#np-time', element()], ['#progress-fill', element()], ['#big-play', element()],
  ]);
  const documentLike = {
    querySelector: selector => nodes.get(selector) || element(),
    querySelectorAll: () => [], createElement: () => element(), body: element(),
  };
  const queue = [
    { kind: 'track', song_id: 'one', title: 'First', artist: 'A', url: '/one.mp3', lyric: { lrc: '[00:00.00]first lyric' } },
    { kind: 'track', song_id: 'two', title: 'Second', artist: 'B', album: 'Second album', pic_url: '/two.jpg', url: '/two.mp3', lyric: { lrc: '[00:00.00]second lyric\n[00:10.00]coming lyric' } },
  ];
  const store = createAppState({
    queue, cursor: 1,
    runtimeState: { phase: 'playing', currentIndex: 1, currentSongId: 'two', txn: null },
  });
  const musicAudio = { paused: false, src: 'http://localhost/one.mp3', currentTime: 1, duration: 180 };
  const view = createPlaybackView({
    store,
    narrationAudio: { paused: false, src: 'http://localhost/voice.mp3', currentTime: 1 },
    musicAudio,
    documentLike,
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
    getController: () => ({
      hasRealMusicPlaying: () => true,
    }),
  });

  view.callbacks.onTrack(queue[1]);
  view.refresh();
  view.callbacks.onNarration({ text: 'overlay' }, { overlay: true });

  assert.equal(nodes.get('#np-title').textContent, 'Second');
  assert.equal(nodes.get('#np-sub').textContent, 'B');
  assert.equal(nodes.get('#np-album').textContent, 'Second album');
  // 来源标签只在播放器区域出现；队列项没有 source 时不留空尾巴。
  assert.equal(nodes.get('#np-album').textContent.includes('·'), false, 'no dangling separator without a source');
  assert.equal(nodes.get('#player-cover').src, '/two.jpg');
  assert.equal(nodes.get('#player-line-text').textContent, 'second lyric');
  assert.equal(nodes.get('#player-line-next').textContent, 'coming lyric');
  assert.doesNotMatch(nodes.get('#player-line-text').textContent, /正在说话/);
});

test('a runtime broadcast mid-song keeps the current lyric line instead of reviving the track title', () => {
  const nodes = new Map([
    ['#np-title', element()], ['#np-sub', element()], ['#np-album', element()], ['#player-cover', element()],
    ['#player-line-text', element()], ['#player-line-next', element()],
    ['#np-time', element()], ['#progress-fill', element()], ['#big-play', element()],
  ]);
  const documentLike = {
    querySelector: selector => nodes.get(selector) || element(),
    querySelectorAll: () => [], createElement: () => element(), body: element(),
  };
  const store = createAppState({});
  const musicAudio = { paused: false, src: 'http://localhost/audio/a.mp3', currentTime: 5, duration: 229 };
  const view = createPlaybackView({ store, musicAudio, narrationAudio: { paused: true, src: '', currentTime: 0 },
    documentLike, locationHref: 'http://localhost/', schedule: () => 1, cancelSchedule: () => {},
    getController: () => ({ hasRealMusicPlaying: () => true }) });
  // 真实的 runtime-state 广播形状：queue item 带 queueItemId + songId，经 appState 投影进 store。
  const broadcast = (overrides = {}) => {
    const base = { queueItemId: 'queue:a', songId: 'a', title: '今天只做一件事', artist: '陈奕迅',
      album: 'H3M', url: '/a.mp3', artwork: null, duration: 229,
      lyric: { lrc: '[00:00.00]或有几多争斗与比赛\n[00:10.00]越觉得剩低几多未变的爱' } };
    const queue = (overrides.queue || [base]).map(item => ({ ...base, ...item }));
    const state = { version: 1, phase: 'playing', currentIndex: 0, currentSongId: 'a', radioMode: true, txn: null,
      ...overrides, queue };
    reduceServerMessage(store, { type: 'runtime-state', state });
    view.refresh();
    return queue[state.currentIndex];
  };

  const track = broadcast();
  view.callbacks.onTrack(track);
  view.callbacks.onTimeUpdate(musicAudio);
  assert.equal(nodes.get('#player-line-text').textContent, '或有几多争斗与比赛');

  // 串词开始／结束：音乐仍然拥有播放器，歌词行必须留在原位。
  broadcast({ phase: 'speaking', txn: { correlationId: 'c1', queueItemId: 'queue:a', songId: 'a' } });
  assert.equal(nodes.get('#player-line-text').textContent, '或有几多争斗与比赛');
  broadcast();
  assert.equal(nodes.get('#player-line-text').textContent, '或有几多争斗与比赛');
  assert.equal(nodes.get('#player-line-next').textContent, '越觉得剩低几多未变的爱');

  // 同一首歌的其它 runtime 广播（续播、队列投影刷新）同样不得重播标题态。
  broadcast();
  assert.doesNotMatch(nodes.get('#player-line-text').textContent, /♪/);
  assert.equal(nodes.get('#player-line-text').textContent, '或有几多争斗与比赛');
});

test('the track title introduces a new queue occurrence but never a re-render of the same one', () => {
  const nodes = new Map([
    ['#np-title', element()], ['#np-sub', element()], ['#np-album', element()], ['#player-cover', element()],
    ['#player-line-text', element()], ['#player-line-next', element()],
    ['#np-time', element()], ['#progress-fill', element()], ['#big-play', element()],
  ]);
  const documentLike = {
    querySelector: selector => nodes.get(selector) || element(),
    querySelectorAll: () => [], createElement: () => element(), body: element(),
  };
  const trackA = { queueItemId: 'queue:a', songId: 'a', title: '今天只做一件事', artist: '陈奕迅',
    url: '/a.mp3', lyric: null };
  const trackB = { queueItemId: 'queue:b', songId: 'b', title: '另一首', artist: '陈绮贞',
    url: '/b.mp3', lyric: null };
  const store = createAppState({});
  const musicAudio = { paused: false, src: 'http://localhost/audio/a.mp3', currentTime: 5, duration: 229 };
  const view = createPlaybackView({ store, musicAudio, narrationAudio: { paused: true, src: '', currentTime: 0 },
    documentLike, locationHref: 'http://localhost/', schedule: () => 1, cancelSchedule: () => {},
    getController: () => ({ hasRealMusicPlaying: () => true }) });
  const broadcast = (currentIndex, queue) => {
    reduceServerMessage(store, { type: 'runtime-state', state: { version: 1, phase: 'playing',
      currentIndex, currentSongId: queue[currentIndex].songId, radioMode: true, txn: null, queue } });
    view.refresh();
  };

  view.callbacks.onTrack(trackA);
  assert.match(nodes.get('#player-line-text').textContent, /^♪ 今天只做一件事 — 陈奕迅$/);
  broadcast(0, [trackA]);
  assert.match(nodes.get('#player-line-text').textContent, /^♪ 今天只做一件事 — 陈奕迅$/);

  // 同一出现位置再次收到 PLAY_TRACK（媒体重挂）不重播、也不清行。
  view.callbacks.onTrack(trackA);
  assert.match(nodes.get('#player-line-text').textContent, /^♪ 今天只做一件事 — 陈奕迅$/);

  // 新的队列出现位置：标题态重新引入这首歌。
  broadcast(1, [trackA, trackB]);
  assert.match(nodes.get('#player-line-text').textContent, /^♪ 另一首 — 陈绮贞$/);
});

test('runtime card selection reports the song without changing the browser cursor', () => {
  const selected = [];
  const store = createAppState({
    queue: [{ kind: 'track', song_id: 'long-way', url: '/long-way.mp3' }],
    cursor: 0,
    runtimeState: { queue: [{ queueItemId: 'queue:long-way', songId: 'long-way' }], currentIndex: 0 },
  });
  const view = createPlaybackView({
    store,
    narrationAudio: { paused: true, src: '', currentTime: 0 },
    musicAudio: { paused: false, src: '/old-name.mp3', currentTime: 15, duration: 200 },
    documentLike: { querySelector: () => element(), querySelectorAll: () => [], createElement: () => element(), body: element() },
    getController: () => ({}),
    getRuntimeClient: () => ({ selectSong: songId => selected.push(songId) }),
  });
  view.handleTrackCard({ dataset: { songId: 'long-way' }, classList: { contains: () => false } });
  assert.deepEqual(selected, ['long-way']);
  assert.equal(store.getState().cursor, 0);
});

test('a card that names its queue occurrence selects that occurrence, not a duplicate song id', () => {
  const selected = [];
  const store = createAppState({
    queue: [], cursor: 0,
    runtimeState: {
      queue: [
        { queueItemId: 'queue:1', songId: 'same-song' },
        { queueItemId: 'queue:2', songId: 'same-song' },
      ],
      currentIndex: 0,
    },
  });
  const view = createPlaybackView({
    store,
    narrationAudio: { paused: true, src: '', currentTime: 0 },
    musicAudio: { paused: false, src: '', currentTime: 0, duration: 0 },
    documentLike: { querySelector: () => element(), querySelectorAll: () => [], createElement: () => element(), body: element() },
    getController: () => ({}),
    getRuntimeClient: () => ({
      selectQueueItem: id => selected.push(id),
      selectSong: id => selected.push(id),
    }),
  });
  view.handleTrackCard({ dataset: { queueItemId: 'queue:2' }, classList: { contains: () => false } });
  assert.deepEqual(selected, ['queue:2']);
});

test('a card whose song already left the queue says so instead of failing silently', () => {
  const selected = [];
  let notices = 0;
  const store = createAppState({
    queue: [], cursor: 0,
    runtimeState: { queue: [{ queueItemId: 'queue:1', songId: 'still-here' }], currentIndex: 0 },
  });
  const view = createPlaybackView({
    store,
    narrationAudio: { paused: true, src: '', currentTime: 0 },
    musicAudio: { paused: false, src: '', currentTime: 0, duration: 0 },
    documentLike: { querySelector: () => element(), querySelectorAll: () => [], createElement: () => element(), body: element() },
    getController: () => ({}),
    getRuntimeClient: () => ({
      selectSong: id => selected.push(id),
      selectQueueItem: id => selected.push(id),
    }),
    onCardUnavailable: () => { notices += 1; },
  });
  // runtime 只在当前队列里解析身份，所以这里必须当场说清楚，而不是默不做声。
  view.handleTrackCard({ dataset: { songId: 'long-gone' }, classList: { contains: () => false } });
  assert.deepEqual(selected, []);
  assert.equal(notices, 1);
  view.handleTrackCard({ dataset: { queueItemId: 'queue:gone' }, classList: { contains: () => false } });
  assert.deepEqual(selected, []);
  assert.equal(notices, 2);
});

test('runtime refresh projects the authoritative target over a stale loaded media source', () => {
  const nodes = new Map([
    ['#np-title', element()], ['#np-sub', element()], ['#player-line-text', element()], ['#player-line-next', element()],
    ['#np-time', element()], ['#progress-fill', element()], ['#big-play', element()],
  ]);
  const documentLike = {
    querySelector: selector => nodes.get(selector) || element(),
    querySelectorAll: () => [], createElement: () => element(), body: element(),
  };
  const oldTrack = {
    kind: 'track', song_id: 'old', title: 'Old title', artist: 'Old artist',
    url: '/old.mp3', lyric: { lrc: '[00:00.00]old lyric' },
  };
  const runtimeTrack = {
    kind: 'track', song_id: 'continued', title: 'Continued title', artist: 'New artist',
    url: '/continued.mp3', lyric: { lrc: '[00:00.00]continued lyric' },
  };
  const store = createAppState({
    queue: [oldTrack, runtimeTrack], cursor: 1,
    runtimeState: {
      phase: 'playing', currentIndex: 1, currentSongId: 'continued',
      txn: { correlationId: 'runtime-continued' },
    },
  });
  const view = createPlaybackView({
    store,
    narrationAudio: { paused: true, src: '', currentTime: 0 },
    musicAudio: {
      paused: false, src: 'http://localhost/old.mp3', currentTime: 1, duration: 180,
    },
    documentLike,
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
    getController: () => ({
      currentPlayingSongId: () => 'old',
      currentTrackItem: () => oldTrack,
    }),
  });

  view.refresh();

  assert.equal(nodes.get('#np-title').textContent, 'Continued title');
  assert.equal(nodes.get('#np-sub').textContent, 'New artist');
  assert.equal(nodes.get('#player-line-text').textContent, 'continued lyric');
  assert.equal(nodes.get('#player-line-next').textContent, '');
});

test('narration never competes with music for the player bar', () => {
  const label = element();
  const status = element();
  status.dataset = {};
  status.querySelector = () => label;
  const thinking = element();
  const nodes = new Map([
    ['#status', status], ['#thinking', thinking],
    ['#np-time', element()], ['#np-duration', element()],
    ['#progress-fill', element()], ['#progress-bar', element()],
    ['#np-title', element()], ['#np-sub', element()], ['#np-album', element()],
    ['#player-cover', element()], ['#player-line-text', element()], ['#player-line-next', element()],
  ]);
  const track = { kind: 'track', song_id: 'one', title: 'First', artist: 'A', url: '/one.mp3' };
  const store = createAppState({
    queue: [track], cursor: 0,
    runtimeState: { phase: 'playing', currentIndex: 0, currentSongId: 'one', txn: null },
  });
  const musicAudio = { paused: false, src: 'http://localhost/one.mp3', currentTime: 61, duration: 180, volume: 1, muted: false };
  const narrationAudio = { paused: false, src: 'http://localhost/voice.mp3', currentTime: 3, duration: 12, volume: 1, muted: false };
  const view = createPlaybackView({
    store, narrationAudio, musicAudio,
    documentLike: { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] },
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
  });

  view.callbacks.onTrack(track);
  view.callbacks.onTimeUpdate(musicAudio);
  // While music is sounding, narration ticks must not repaint time or progress.
  view.callbacks.onTimeUpdate(narrationAudio);
  assert.equal(nodes.get('#np-time').textContent, '1:01');
  assert.equal(nodes.get('#progress-fill').style.width, `${61 / 180 * 100}%`);

  // Status stays on the music channel even when TTS reports speaking over it.
  view.setStatus('speaking');
  assert.equal(label.textContent, '正在播放');
  assert.equal(status.dataset.state, 'playing');

  // Narration presentation must not take the bar either, with or without the
  // overlay option (runtime PLAY_TTS-style calls omit it).
  view.callbacks.onNarration({ text: 'radiohost line' });
  assert.equal(nodes.get('#np-title').textContent, 'First');
  assert.doesNotMatch(nodes.get('#player-line-text').textContent, /正在说话/);

  // A paused song still owns its progress and identity during a spoken reply.
  musicAudio.paused = true;
  view.callbacks.onTimeUpdate(narrationAudio);
  assert.equal(nodes.get('#np-time').textContent, '1:01');
  view.setStatus('speaking');
  assert.equal(label.textContent, '已暂停');
  assert.equal(status.dataset.state, 'paused');
  view.callbacks.onNarration({ text: 'radiohost line' });
  assert.equal(nodes.get('#np-title').textContent, 'First');

  // With no loaded music, voice progress still must not touch the player bar:
  // chat narration is never mapped onto it.
  musicAudio.src = '';
  view.callbacks.onTimeUpdate(narrationAudio);
  assert.equal(nodes.get('#np-time').textContent, '1:01');
  assert.equal(nodes.get('#progress-fill').style.width, `${61 / 180 * 100}%`);
  view.callbacks.onNarration({ text: 'radiohost line' });
  assert.equal(nodes.get('#np-title').textContent, 'Lunara 说话中…');
});

test('companion mode control mirrors authoritative state and recovers from a failed save', async () => {
  const nodes = new Map([['#companion-mode', element()]].map(([id, node]) => [id, node]));
  const select = nodes.get('#companion-mode');
  select.value = 'occasional';
  const store = createAppState({ runtimeState: { companionModeId: 'occasional', modeSource: 'default' } });
  const errors = [];
  const requested = [];
  let finish;
  const view = createPlaybackView({ store, musicAudio: { paused: true }, narrationAudio: { paused: true },
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    getRuntimeClient: () => ({
      setCompanionMode: modeId => new Promise(resolve => { requested.push(modeId); finish = resolve; }),
    }), onError: error => errors.push(error) });
  const finishFailure = () => finish({ ok: false, error: '保存失败' });
  view.init();
  view.refresh();
  assert.equal(select.value, 'occasional');
  assert.equal(select.disabled, false);

  // 用户切到只听歌：提交期间禁用，失败后回显权威值并可重试。
  select.value = 'music_only';
  select.emit('change');
  assert.equal(select.disabled, true);
  assert.deepEqual(requested, ['music_only']);
  store.update({ runtimeState: { companionModeId: 'occasional' } });
  finishFailure();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(select.value, 'occasional', '保存失败后回到权威旧值');
  assert.equal(select.disabled, false, '控件保持可重试');
  assert.equal(errors.length, 1);

  // 旧未设置投影与尚未收到模式时统一回显多聊一点，不发保存请求。
  store.update({ runtimeState: { companionModeId: null } });
  view.refresh();
  assert.equal(select.value, 'conversational');
  assert.doesNotMatch(select.title, /沿用|未设置/);
  assert.deepEqual(requested, ['music_only']);
  store.update({ runtimeState: {} });
  view.refresh();
  assert.equal(select.value, 'conversational');
  view.destroy();
});

test('the companion selector ignores a removed empty option instead of clearing an override', async () => {
  const nodes = new Map([['#companion-mode', element()]]);
  const select = nodes.get('#companion-mode');
  select.value = '';
  const requested = [];
  const store = createAppState({ runtimeState: { companionModeId: 'occasional', modeSource: 'explicit' } });
  const view = createPlaybackView({ store, musicAudio: { paused: true }, narrationAudio: { paused: true },
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    getRuntimeClient: () => ({ setCompanionMode: async modeId => { requested.push(modeId); return { ok: true }; } }),
    onError: () => {} });
  view.init();
  select.value = '';
  select.emit('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requested, []);
  assert.equal(select.value, 'occasional', '无效选项恢复权威值');
  view.destroy();
});

// ---- 混音区：人声与音乐两条本地音量 ----

function playerNodes() {
  const ids = ['#app', '#np-title', '#np-sub', '#np-album', '#player-cover', '#progress-bar', '#np-time',
    '#np-duration', '#skip-btn', '#big-play', '#player-volume', '#progress-fill', '#radio-toggle',
    '#continuation-status', '#continuation-retry', '#companion-mode', '#player-line-text', '#player-line-next',
    '#episode-mixer', '#mixer-voice', '#mixer-bed', '#mixer-voice-label', '#mixer-bed-label',
    '#player-volume-slider'];
  const nodes = new Map(ids.map(id => [id, element()]));
  // 混音滑杆的假节点：range input 需要可写的 value 与可触发的 input/change 事件。
  const mixer = nodes.get('#episode-mixer');
  mixer.hidden = true;
  nodes.get('#mixer-voice').value = '1';
  nodes.get('#mixer-bed').value = '1';
  nodes.get('#player-volume-slider').value = '1';
  return nodes;
}

function mixerFixture(runtimeState) {
  const nodes = playerNodes();
  const store = createAppState({ runtimeState, queue: [], cursor: -1 });
  const music = { paused: false, currentTime: 0, duration: 180, src: '/one.mp3', muted: false, volume: 1 };
  const narration = { paused: true, currentTime: 0, duration: 0, src: '', muted: false, volume: 1 };
  const calls = [];
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: narration,
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    locationHref: 'http://localhost/', schedule: () => 1, cancelSchedule: () => {},
    getRuntimeClient: () => new Proxy({}, { get: (_, name) => async () => { calls.push(name); return { accepted: true }; } }),
    onError: () => {} });
  view.init();
  view.refresh();
  return { view, store, nodes, music, narration, calls };
}

test('the voice slider changes narration volume locally without the runtime', () => {
  const f = mixerFixture({ version: 3, currentIndex: 0, currentSongId: 's1', phase: 'playing' });
  const voice = f.nodes.get('#mixer-voice');
  voice.value = '0.6';
  voice.emit('input', { target: voice });
  assert.equal(f.narration.volume, 0.6);
  assert.deepEqual(f.calls, [], 'voice volume never round-trips through the runtime');
  f.view.destroy();
});

test('the mixer shows the music channel only while a song is current', () => {
  resetMusicVolumePreferenceForTest();
  const f = mixerFixture({ version: 3, currentIndex: -1, currentSongId: null, phase: 'idle' });
  assert.equal(f.nodes.get('#episode-mixer').hidden, true, '没有当前歌曲时混音区不出现');
  f.store.update({ runtimeState: { version: 4, currentIndex: 0, currentSongId: 's2', phase: 'playing' } });
  f.view.refresh();
  assert.equal(f.nodes.get('#episode-mixer').hidden, false);
  assert.equal(f.nodes.get('#mixer-bed-label').textContent, '音乐');
  assert.equal(f.nodes.get('#mixer-bed').min, '0');
  assert.equal(f.nodes.get('#mixer-bed').max, '1');
  f.view.destroy();
});

test('the companion music slider writes the local preference and survives track changes', () => {
  resetMusicVolumePreferenceForTest();
  const nodes = playerNodes();
  const queue = [
    { kind: 'track', song_id: 's2', title: 'Next', artist: 'A', url: '/next.mp3' },
    { kind: 'track', song_id: 's3', title: 'After', artist: 'B', url: '/after.mp3' },
  ];
  const store = createAppState({
    queue, cursor: 0,
    runtimeState: { version: 3, currentIndex: 0, currentSongId: 's2', phase: 'playing' },
  });
  const music = { paused: false, currentTime: 0, duration: 180, src: 'http://localhost/next.mp3', muted: false, volume: 1 };
  const view = createPlaybackView({
    store, narrationAudio: { paused: true }, musicAudio: music,
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
    getRuntimeClient: () => ({}),
    onError: () => {},
  });
  view.init();
  view.refresh();
  assert.equal(nodes.get('#episode-mixer').hidden, false, '伴听会话播放音乐时混音区可用');
  assert.equal(nodes.get('#mixer-bed-label').textContent, '音乐');
  assert.equal(nodes.get('#mixer-bed').value, String(getMusicVolumePreference()));
  nodes.get('#mixer-bed').emit('input', { target: { value: '0.6' } });
  assert.equal(music.volume, 0.6, '音乐音量立即生效');
  assert.equal(getMusicVolumePreference(), 0.6, '写入本地偏好');
  // 换一首歌后回显仍为用户偏好，不被激活逻辑重置。
  store.update({ runtimeState: { version: 4, currentIndex: 1, currentSongId: 's3', phase: 'playing' }, cursor: 1 });
  view.refresh();
  assert.equal(nodes.get('#mixer-bed').value, '0.6');
  view.destroy();
  resetMusicVolumePreferenceForTest();
});

test('the transport volume slider is the same preference as the companion mixer, not a second source', () => {
  resetMusicVolumePreferenceForTest();
  const nodes = playerNodes();
  const store = createAppState({
    queue: [], cursor: -1,
    runtimeState: { version: 3, currentIndex: -1, currentSongId: 's2', phase: 'playing' },
  });
  const music = { paused: false, currentTime: 0, duration: 180, src: 'http://localhost/next.mp3', muted: false, volume: 1 };
  const view = createPlaybackView({
    store, narrationAudio: { paused: true }, musicAudio: music,
    documentLike: { querySelector: id => nodes.get(id) || element(), querySelectorAll: () => [] },
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
    getRuntimeClient: () => ({}),
    onError: () => {},
  });
  view.init();
  view.refresh();
  const slider = nodes.get('#player-volume-slider');
  assert.equal(slider.value, String(getMusicVolumePreference()), '滑块回显既有偏好');
  slider.emit('input', { target: { value: '0.4' } });
  assert.equal(getMusicVolumePreference(), 0.4, '写入的是同一个音乐音量偏好');
  assert.equal(music.volume, 0.4, '音乐音量立即生效');
  // 混音区「音乐」通道是同一偏好的另一处视图：下一次 refresh 回读后必须一致，不得漂移。
  view.refresh();
  assert.equal(nodes.get('#mixer-bed').value, '0.4', '两处视图同源，不产生第二个音量真相源');
  // 越界值被既有偏好收敛，滑块不会写坏存储。
  slider.emit('input', { target: { value: '9' } });
  assert.equal(getMusicVolumePreference(), 0.4, '越界输入不改写偏好');
  view.destroy();
  resetMusicVolumePreferenceForTest();
});

test('a track without cover art renders the placeholder and recovers from a failed cover load', () => {
  const nodes = new Map([
    ['#np-title', element()], ['#np-sub', element()], ['#np-album', element()], ['#player-cover', element()],
    ['#player-line-text', element()], ['#player-line-next', element()],
    ['#np-time', element()], ['#progress-fill', element()], ['#big-play', element()],
  ]);
  const documentLike = {
    querySelector: selector => nodes.get(selector) || element(),
    querySelectorAll: () => [], createElement: () => element(), body: element(),
  };
  const queue = [
    { kind: 'track', song_id: 'one', title: 'No cover', artist: 'A', url: '/one.mp3', lyric: { lrc: '' } },
    { kind: 'track', song_id: 'two', title: 'Broken cover', artist: 'B', pic_url: 'https://broken.test/c.jpg', url: '/two.mp3', lyric: { lrc: '' } },
  ];
  const store = createAppState({
    queue, cursor: 0,
    runtimeState: { phase: 'playing', currentIndex: 0, currentSongId: 'one', txn: null },
  });
  const view = createPlaybackView({
    store,
    narrationAudio: { paused: true, src: '', currentTime: 0 },
    musicAudio: { paused: false, src: 'http://localhost/one.mp3', currentTime: 1, duration: 180 },
    documentLike,
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
    getController: () => ({ hasRealMusicPlaying: () => true }),
  });

  view.callbacks.onTrack(queue[0]);
  view.refresh();
  assert.equal(nodes.get('#player-cover').src, '/cover-fallback.jpg');

  view.callbacks.onTrack(queue[1]);
  assert.equal(nodes.get('#player-cover').src, 'https://broken.test/c.jpg');
  nodes.get('#player-cover').emit('error');
  assert.equal(nodes.get('#player-cover').src, '/cover-fallback.jpg');
  nodes.get('#player-cover').emit('error');
  assert.equal(nodes.get('#player-cover').src, '/cover-fallback.jpg');
});

// ---- 键盘快捷键：与传输按钮同一行为、输入焦点让路（add-player-keyboard-shortcuts） ----

/** 文档替身：收起 keydown 监听，让测试像真实键盘一样投递按键。 */
function keyboardDocument(nodes) {
  const listeners = new Set();
  const documentLike = {
    querySelector: id => nodes.get(id) || element(),
    querySelectorAll: () => [],
    addEventListener(type, listener) { if (type === 'keydown') listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  documentLike.press = (event = {}) => {
    const dispatched = { defaultPrevented: false, ...event };
    dispatched.preventDefault = () => { dispatched.defaultPrevented = true; };
    for (const listener of [...listeners]) listener(dispatched);
    return dispatched;
  };
  documentLike.keydownListeners = () => listeners.size;
  return documentLike;
}

/** 焦点替身：只回答「这个元素是不是某类输入/控件」。 */
function focusTarget(marker) {
  return {
    isContentEditable: false,
    closest: selector => (selector.includes(marker) ? true : null),
  };
}

function twoTrackState() {
  const queue = [
    { kind: 'track', queueItemId: 'queue:1', queue_item_id: 'queue:1', song_id: 's1', songId: 's1', title: '第一首', artist: 'A', url: '/one.mp3' },
    { kind: 'track', queueItemId: 'queue:2', queue_item_id: 'queue:2', song_id: 's2', songId: 's2', title: '第二首', artist: 'B', url: '/two.mp3' },
  ];
  return {
    runtimeState: { version: 4, currentIndex: 1, currentSongId: 's2', phase: 'playing',
      activeListeningSessionId: 'conversation:c1', queue },
    queue, cursor: 1,
  };
}

function transportFixture({ runtimeState, queue = [], cursor = 0 } = {}) {
  const nodes = playerNodes();
  nodes.set('#player-previous', element());
  const store = createAppState({ runtimeState, queue, cursor });
  const music = { paused: false, currentTime: 0, duration: 180, src: '/one.mp3', muted: false, volume: 1 };
  const narration = { paused: true, currentTime: 0, duration: 0, src: '', muted: false, volume: 1 };
  const calls = [];
  const documentLike = keyboardDocument(nodes);
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: narration, documentLike,
    locationHref: 'http://localhost/', schedule: () => 1, cancelSchedule: () => {},
    getRuntimeClient: () => ({
      pause: async () => { calls.push('pause'); return { accepted: true }; },
      resume: async () => { calls.push('resume'); return { accepted: true }; },
      retry: async () => { calls.push('retry'); return { accepted: true }; },
      requestNext: async () => { calls.push('next'); return { accepted: true }; },
      selectQueueItem: async id => { calls.push(`select:${id}`); return { accepted: true }; },
      setRadioMode: async () => ({ ok: true }),
    }),
    onError: () => {} });
  view.init();
  view.refresh();
  return { view, store, nodes, music, narration, calls, documentLike };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('space toggles playback through the same path as the play button', async () => {
  const f = transportFixture(twoTrackState());
  const space = f.documentLike.press({ key: ' ', code: 'Space' });
  await tick();
  assert.deepEqual(f.calls, ['pause'], '空格与播放按钮同一个动作：正在响就暂停');
  assert.equal(space.defaultPrevented, true, '空格必须拦下页面滚动');

  f.music.paused = true;
  f.documentLike.press({ key: ' ', code: 'Space' });
  await tick();
  assert.deepEqual(f.calls, ['pause', 'resume']);
  f.music.paused = false; // resume 真的生效了（替身不会自己翻转 paused）
  f.nodes.get('#big-play').emit('click');
  await tick();
  assert.deepEqual(f.calls, ['pause', 'resume', 'pause'],
    '播放按钮与空格都在同一份分派上，谁都不会另开一条播放路径');
  f.view.destroy();
});

test('the transport buttons keep their own click behaviour without extra key bindings', async () => {
  const f = transportFixture(twoTrackState());
  f.documentLike.press({ key: 'ArrowRight', shiftKey: true });
  f.documentLike.press({ key: 'ArrowLeft', shiftKey: true });
  await tick();
  assert.deepEqual(f.calls, [], '不发明应用内快捷键：方向键不切歌');
  f.nodes.get('#skip-btn').emit('click');
  f.nodes.get('#player-previous').emit('click');
  await tick();
  assert.deepEqual(f.calls, ['next', 'select:queue:1'], '两个按钮的点击行为不变');
  f.view.destroy();
});

test('the previous control follows the authoritative queue position', async () => {
  const state = twoTrackState();
  state.runtimeState = { ...state.runtimeState, currentIndex: 0, currentSongId: 's1' };
  state.cursor = 0;
  const f = transportFixture(state);
  assert.equal(f.nodes.get('#player-previous').disabled, true, '队首：上一首禁用');
  await tick();
  assert.deepEqual(f.calls, [], '没有前一个队列出现位置时不提交任何切换');

  f.store.update({ runtimeState: { ...state.runtimeState, currentIndex: 1, currentSongId: 's2' }, cursor: 1 });
  f.view.refresh();
  assert.equal(f.nodes.get('#player-previous').disabled, false, '队列里出现前一首后重新可用');
  f.nodes.get('#player-previous').emit('click');
  await tick();
  assert.deepEqual(f.calls, ['select:queue:1']);
  f.view.destroy();
});

test('space keeps pausing after the user clicked a card or the focus handle', async () => {
  // 鼠标点过的元素保留焦点。点过聊天气泡里的歌卡、点过「收起听歌列」把手之后，
  // 空格必须是播放/暂停，而不是再点一次那个元素。
  const f = transportFixture(twoTrackState());
  for (const marker of ['button', '#chat-focus-toggle', 'role="button"']) {
    const space = f.documentLike.press({ key: ' ', code: 'Space', target: focusTarget(marker) });
    assert.equal(space.defaultPrevented, true, `${marker} 上的空格必须被播放器接管并拦下二次激活`);
    f.music.paused = !f.music.paused; // 暂停/恢复真的生效（替身不会自己翻转 paused）
  }
  await tick();
  assert.deepEqual(f.calls, ['pause', 'resume', 'pause'], '连续三次空格就是三次播放/暂停，没有点中别的元素');
  f.view.destroy();
});

test('typing keeps its own space', async () => {
  const f = transportFixture(twoTrackState());
  const space = f.documentLike.press({ key: ' ', code: 'Space', target: focusTarget('textarea') });
  await tick();
  assert.deepEqual(f.calls, [], '输入框里的空格属于输入框');
  assert.equal(space.defaultPrevented, false);
  f.view.destroy();
});

test('a hidden player does not consume keys on the full-page workbenches', async () => {
  const f = transportFixture(twoTrackState());
  for (const mode of ['settings-open']) {
    f.nodes.get('#app').classList = { contains: name => name === mode };
    const space = f.documentLike.press({ key: ' ', code: 'Space' });
    f.documentLike.press({ key: 'ArrowRight', shiftKey: true });
    assert.equal(space.defaultPrevented, false, `${mode} 上的空格仍然属于页面滚动`);
  }
  await tick();
  assert.deepEqual(f.calls, [], '看不见的播放条不能默默改变播放');
  f.nodes.get('#app').classList = { contains: () => false };
  f.documentLike.press({ key: ' ', code: 'Space' });
  await tick();
  assert.deepEqual(f.calls, ['pause'], '回到会话页后快捷键恢复');
  f.view.destroy();
});

test('a player kept visible on a workbench page still takes the space key', async () => {
  const f = transportFixture(twoTrackState());
  f.nodes.get('#app').classList = { contains: name => name === 'settings-open' };
  f.documentLike.defaultView = { getComputedStyle: () => ({ display: 'flex' }) };
  const space = f.documentLike.press({ key: ' ', code: 'Space' });
  await tick();
  assert.equal(space.defaultPrevented, true, '舞台版式的设置页保留了播放条，空格照常控制播放');
  assert.deepEqual(f.calls, ['pause']);
  f.documentLike.defaultView = { getComputedStyle: () => ({ display: 'none' }) };
  f.documentLike.press({ key: ' ', code: 'Space' });
  await tick();
  assert.deepEqual(f.calls, ['pause'], '播放条真的隐藏时不接管空格');
  f.view.destroy();
});

test('destroying the view uninstalls the shortcut listener', async () => {
  const f = transportFixture(twoTrackState());
  assert.equal(f.documentLike.keydownListeners(), 1);
  f.view.destroy();
  assert.equal(f.documentLike.keydownListeners(), 0);
  f.documentLike.press({ key: ' ', code: 'Space' });
  await tick();
  assert.deepEqual(f.calls, []);
});

// ---- 系统媒体键（媒体会话通道，add-system-media-key-controls） ----

function fakeMediaSession() {
  const handlers = new Map();
  return {
    playbackState: 'none', metadata: null,
    setActionHandler(action, handler) {
      if (handler === null) handlers.delete(action); else handlers.set(action, handler);
    },
    emit(action) { handlers.get(action)?.({ action }); },
    installed: () => [...handlers.keys()].sort(),
  };
}

function transportFixtureWithMediaSession({ runtimeState, queue = [], cursor = 0 } = {}) {
  const nodes = playerNodes();
  nodes.set('#player-previous', element());
  const store = createAppState({ runtimeState, queue, cursor });
  const music = { paused: false, currentTime: 0, duration: 180, src: '/one.mp3', muted: false, volume: 1 };
  const narration = { paused: true, currentTime: 0, duration: 0, src: '', muted: false, volume: 1 };
  const calls = [];
  const mediaSession = fakeMediaSession();
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: narration,
    documentLike: keyboardDocument(nodes), locationHref: 'http://localhost/',
    navigatorLike: { mediaSession },
    schedule: () => 1, cancelSchedule: () => {},
    getRuntimeClient: () => ({
      pause: async () => { calls.push('pause'); return { accepted: true }; },
      resume: async () => { calls.push('resume'); return { accepted: true }; },
      requestNext: async () => { calls.push('next'); return { accepted: true }; },
      selectQueueItem: async id => { calls.push(`select:${id}`); return { accepted: true }; },
      setRadioMode: async () => ({ ok: true }),
    }),
    onError: () => {} });
  view.init();
  view.refresh();
  return { view, store, nodes, music, narration, calls, mediaSession };
}

test('hardware media keys drive the same runtime actions as the transport buttons', async () => {
  const f = transportFixtureWithMediaSession(twoTrackState());
  assert.deepEqual(f.mediaSession.installed(), ['nexttrack', 'pause', 'play', 'previoustrack'],
    '切歌动作必须也注册：不注册时系统只会暂停元素，切歌键没反应');
  f.mediaSession.emit('pause');
  await tick();
  f.mediaSession.emit('play');
  await tick();
  f.mediaSession.emit('nexttrack');
  await tick();
  f.mediaSession.emit('previoustrack');
  await tick();
  assert.deepEqual(f.calls, ['pause', 'resume', 'next', 'select:queue:1'],
    '媒体键与按钮走同一批函数，队首语义自动一致');
  f.view.destroy();
  assert.deepEqual(f.mediaSession.installed(), [], '视图卸载后摘掉媒体键处理器');
});

test('the now-playing identity shared with the system follows the presented media', async () => {
  const previousMetadata = globalThis.MediaMetadata;
  globalThis.MediaMetadata = class { constructor(fields) { Object.assign(this, fields); } };
  try {
    const f = transportFixtureWithMediaSession(twoTrackState());
    assert.equal(f.mediaSession.playbackState, 'playing');
    assert.equal(f.mediaSession.metadata.title, '第二首');
    assert.equal(f.mediaSession.metadata.artist, 'B');

    f.music.paused = true;
    f.view.refresh();
    assert.equal(f.mediaSession.playbackState, 'paused', '系统据此决定发 play 还是 pause');

    f.store.update({ runtimeState: { ...twoTrackState().runtimeState, currentIndex: 0, currentSongId: 's1' },
      queue: twoTrackState().queue, cursor: 0 });
    f.view.refresh();
    assert.equal(f.mediaSession.metadata.title, '第一首');

    f.store.update({ runtimeState: { version: 9, currentIndex: 0, currentSongId: null, phase: 'idle', queue: [] },
      queue: [], cursor: -1 });
    f.view.refresh();
    assert.equal(f.mediaSession.playbackState, 'none', '没有当前内容时不要继续占用媒体键');
    f.view.destroy();
  } finally {
    globalThis.MediaMetadata = previousMetadata;
  }
});

// ---- 桌面托盘桥（add-desktop-tray） ----

function trayFixture({ runtimeState, queue = [], cursor = 0 } = {}) {
  const nodes = playerNodes();
  nodes.set('#player-previous', element());
  const store = createAppState({ runtimeState, queue, cursor });
  const music = { paused: false, currentTime: 0, duration: 180, src: '/one.mp3', muted: false, volume: 1 };
  const narration = { paused: true, currentTime: 0, duration: 0, src: '', muted: false, volume: 1 };
  const calls = [];
  const published = [];
  let listener = null;
  const desktop = {
    tray: {
      isAvailable: true,
      publishState: state => published.push(state),
      onCommand: next => { listener = next; return () => { listener = null; }; },
    },
  };
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: narration,
    documentLike: keyboardDocument(nodes), locationHref: 'http://localhost/',
    windowLike: { lunaraDesktop: desktop },
    schedule: () => 1, cancelSchedule: () => {},
    getRuntimeClient: () => ({
      pause: async () => { calls.push('pause'); return { accepted: true }; },
      resume: async () => { calls.push('resume'); return { accepted: true }; },
      requestNext: async () => { calls.push('next'); return { accepted: true }; },
      selectQueueItem: async id => { calls.push(`select:${id}`); return { accepted: true }; },
      setRadioMode: async () => ({ ok: true }),
    }),
    onError: () => {} });
  view.init();
  view.refresh();
  return { view, store, nodes, music, calls, published, emit: command => listener?.(command),
    subscribed: () => listener !== null };
}

test('the tray sees what the player is playing', () => {
  const f = trayFixture(twoTrackState());
  const published = f.published.at(-1);
  assert.equal(published.title, '第二首');
  assert.equal(published.artist, 'B');
  assert.equal(published.playing, true);
  assert.equal(published.canPrevious, true);
  assert.equal(published.subtitle, '', '这首歌没有歌词行时给空串');
  f.music.paused = true;
  f.view.refresh();
  assert.equal(f.published.at(-1).playing, false, '暂停后托盘要跟着变');
  f.view.destroy();
});

test('tray commands go through the same transport functions', async () => {
  const f = trayFixture(twoTrackState());
  f.emit('toggle');
  await tick();
  f.emit('next');
  await tick();
  f.emit('previous');
  await tick();
  assert.deepEqual(f.calls, ['pause', 'next', 'select:queue:1']);
  assert.equal(f.subscribed(), true);
  f.view.destroy();
  assert.equal(f.subscribed(), false, '视图销毁后托盘命令不再生效');
});

test('at the queue head the tray is told there is nothing before this', () => {
  const state = twoTrackState();
  state.runtimeState = { ...state.runtimeState, currentIndex: 0, currentSongId: 's1' };
  state.cursor = 0;
  const f = trayFixture(state);
  assert.equal(f.published.at(-1).canPrevious, false);
  f.view.destroy();
});

test('the menu bar can follow the current lyric line when the listener asks for it', () => {
  resetTrayTextModeForTest();
  const state = twoTrackState();
  state.queue[1].lyric = { lrc: '[00:00.00]第一句歌词\n[00:10.00]第二句歌词' };
  const f = trayFixture(state);
  try {
    assert.equal(f.published.at(-1).textMode, 'title', '默认仍是曲名');
    assert.equal(f.published.at(-1).subtitle, '第一句歌词', '歌词行一起上送，主进程按模式取用');

    // 设置页切到「当前歌词」：播放器立刻重发，不用等下一次 runtime 广播
    const before = f.published.length;
    setTrayTextMode('lyrics');
    assert.equal(f.published.length, before + 1);
    assert.equal(f.published.at(-1).textMode, 'lyrics');

    // 歌词行推进时也要跟着走
    f.music.currentTime = 12;
    f.view.callbacks.onTimeUpdate(f.music);
    assert.equal(f.published.at(-1).subtitle, '第二句歌词');
    assert.equal(f.published.at(-1).textMode, 'lyrics');
  } finally {
    setTrayTextMode('title');
    f.view.destroy();
    resetTrayTextModeForTest();
  }
});

test('without a lyric line the tray is told to fall back to the title', () => {
  resetTrayTextModeForTest();
  const f = trayFixture(twoTrackState()); // 这首歌没有 lyric
  try {
    setTrayTextMode('lyrics');
    assert.equal(f.published.at(-1).textMode, 'lyrics');
    assert.equal(f.published.at(-1).subtitle, '', '没有歌词行时给空串，主进程回落曲名');
  } finally {
    setTrayTextMode('title');
    f.view.destroy();
    resetTrayTextModeForTest();
  }
});

test('the player names the source of the track, and only the player does', () => {
  const ids = ['#np-title', '#np-sub', '#np-album', '#player-cover', '#progress-bar', '#np-time', '#np-duration',
    '#big-play', '#player-volume', '#waveform', '#player-line-text', '#player-line-next', '#player-line'];
  const nodes = new Map(ids.map(id => [id, element()]));
  nodes.get('#progress-bar').fixed = element();
  const hero = element();
  const store = createAppState({ runtimeState: { queue: [
    { queueItemId: 'q1', songId: 's1', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', source: 'ncm',
      url: '/n.mp3', pic_url: '/n.jpg' },
  ], currentIndex: 0, phase: 'playing' } });
  const view = createPlaybackView({
    store,
    musicAudio: { paused: true, addEventListener() {}, removeEventListener() {} },
    narrationAudio: { paused: true, addEventListener() {}, removeEventListener() {} },
    documentLike: {
      querySelector: selector => nodes.get(selector) || element(),
      querySelectorAll: selector => (selector === '[data-np-meta]' ? [hero] : []),
    },
    locationHref: 'http://localhost/',
    schedule: () => 1,
    cancelSchedule: () => {},
    getController: () => ({ hasRealMusicPlaying: () => true }),
  });
  view.callbacks.onTrack(store.getState().runtimeState.queue[0]);
  assert.equal(nodes.get('#np-album').textContent, '十一月的萧邦 · 网易云音乐');
  assert.equal(hero.textContent, '周杰伦 / 十一月的萧邦 / 网易云音乐');
  // 聊天里的歌曲卡片不挂来源标签：那条信息属于播放器，不属于「聊到过这首歌」。
  const next = { queueItemId: 'q2', songId: 's2', title: '无源', artist: 'A', album: '', url: '/x.mp3' };
  view.callbacks.onTrack(next);
  assert.equal(nodes.get('#np-album').textContent, '十一月的萧邦 · 网易云音乐', 'unaccepted callbacks cannot change the runtime track');
  reduceServerMessage(store, { type: 'runtime-state', state: { version: 1,
    queue: [next], currentIndex: 0, currentSongId: 's2', phase: 'playing' } });
  view.callbacks.onTrack(next);
  assert.equal(nodes.get('#np-album').textContent, '');
  view.destroy();
});

test('instrumental placeholders are secondary notices, never tray lyrics', () => {
  resetTrayTextModeForTest();
  const state = twoTrackState();
  state.queue[1].lyric = { lrc: '[00:00]此歌曲为没有填词的纯音乐，请您欣赏' };
  const f = trayFixture(state);
  try {
    setTrayTextMode('lyrics');
    f.music.currentTime = 15;
    f.view.refresh();
    assert.equal(f.published.at(-1).subtitle, '');
    assert.equal(f.published.at(-1).subtitleSpanMs, null);
  } finally {
    f.view.destroy();
    resetTrayTextModeForTest();
  }
});

test('long title sizing and instrumental notice styling reset on a real lyric or short title', () => {
  const nodes = new Map(['#listening-lyric', '#listening-lyric-next', '#listening-lyric-previous',
    '#listening-interlude', '#focus-interlude', '#player-line-text', '#player-line-next', '#np-title', '.listening-artwork']
    .map(id => [id, element()]));
  const title = element();
  const store = createAppState({ sessionId: 'A' });
  const music = { paused: false, src: '/x', currentTime: 15, duration: 240, volume: 1 };
  const classes = new Set();
  nodes.get('#player-line-text').classList = {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    toggle() {},
  };
  const view = createPlaybackView({ store, musicAudio: music, narrationAudio: { paused: true, volume: 1 },
    documentLike: { querySelector: id => nodes.get(id) || element(),
      querySelectorAll: selector => selector === '[data-np-title]' ? [title] : [] }, schedule: () => null });
  let version = 0;
  const show = (name, lrc) => {
    const id = 'q-' + (++version);
    reduceServerMessage(store, { type: 'runtime-state', state: { version,
      queue: [{ queueItemId: id, songId: id, title: name, url: '/x', lyric: { lrc } }],
      currentIndex: 0, currentSongId: id, activeListeningSessionId: 'A', phase: 'playing' } });
    view.refresh();
    view.callbacks.onTimeUpdate(music);
  };
  try {
    const long = 'Variations On The Canon By Pachelbel';
    show(long, '[00:00]此歌曲为没有填词的纯音乐，请您欣赏\n[00:40]纯音乐，请欣赏');
    assert.equal(title.textContent, long);
    assert.equal(title.title, long, '截断的大字歌名悬停给全名');
    assert.equal(title.dataset.titleSize, 'long');
    assert.equal(nodes.get('#np-title').dataset.titleSize, 'long');
    assert.equal(nodes.get('.listening-artwork').dataset.initial, 'V', '无封面时夜场用歌名首字方块');
    assert.equal(nodes.get('#listening-lyric').dataset.kind, 'notice');
    assert.equal(nodes.get('#listening-lyric').textContent, '此歌曲为没有填词的纯音乐，请您欣赏');
    assert.ok(classes.has('notice'));
    assert.ok(!classes.has('lyric'));
    assert.equal(nodes.get('#listening-lyric-next').hidden, true);
    assert.equal(nodes.get('#listening-interlude').hidden, true);
    store.update({ sessionId: 'B' });
    view.refresh();
    assert.equal(nodes.get('#listening-lyric').hidden, true);
    store.update({ sessionId: 'A' });
    show('枫叶城', '[00:00]我听着纯音乐，请欣赏这场雨\n[00:40]下一句');
    assert.equal(title.dataset.titleSize, 'normal');
    assert.equal(nodes.get('#listening-lyric').dataset.kind, 'lyric');
    assert.ok(classes.has('lyric'));
    assert.ok(!classes.has('notice'));
    assert.equal(nodes.get('#listening-lyric-next').hidden, false);
    assert.match(nodes.get('#listening-interlude').textContent, /约 25 秒/);
  } finally { view.destroy(); }
});

test('untimed text never invents a sweep span for the tray', () => {
  resetTrayTextModeForTest();
  const state = twoTrackState();
  state.queue[1].lyric = { lrc: '曲名-艺人\n作曲-艺人' };
  const f = trayFixture(state);
  try {
    setTrayTextMode('lyrics');
    f.music.currentTime = 15;
    f.view.refresh();
    const published = f.published.at(-1);
    assert.equal(published.subtitle, '曲名-艺人');
    assert.equal(published.subtitleSpanMs, null);
    assert.equal(published.subtitleProgress, null);
  } finally {
    f.view.destroy();
    resetTrayTextModeForTest();
  }
});

test('the lyric line carries its own time span so the menu bar can sweep', () => {
  resetTrayTextModeForTest();
  const state = twoTrackState();
  state.queue[1].lyric = { lrc: '[00:00.00]第一句歌词\n[00:10.00]第二句歌词\n[00:20.00]第三句歌词' };
  const f = trayFixture(state);
  try {
    setTrayTextMode('lyrics');
    f.music.currentTime = 4; // 处在第二句的第 4 秒
    f.view.refresh();
    const published = f.published.at(-1);
    assert.equal(published.subtitle, '第一句歌词');
    assert.equal(published.subtitleSpanMs, 10000, '句尾取下一行的时间');
    assert.equal(published.subtitleProgress, 0.4, '4s / 10s');
  } finally {
    setTrayTextMode('title');
    f.view.destroy();
    resetTrayTextModeForTest();
  }
});
