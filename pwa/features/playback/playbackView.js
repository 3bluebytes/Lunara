import { isInstrumentalNotice, pairLyrics, parseLrc } from './lyrics.js';
import { normalizeLyricText } from '../../core/lyricText.js';
import { projectRuntimeQueueItem } from '../../core/appState.js';
import { lyricGap, trackTitleSize } from '../../visuals/cikePresentation.js';
import { getMusicVolumePreference, setMusicVolumePreference } from './musicVolumePreference.js';
import { applyArtwork } from './artworkImage.js';
import { installTransportShortcuts } from './transportShortcuts.js';
import { createMediaSessionControls } from './mediaSessionControls.js';
import { createDesktopTrayBridge } from './desktopTrayBridge.js';
import { getTrayTextMode, subscribeTrayTextMode } from './trayTextPreference.js';

/** 播放/暂停的快捷键提示：与 transportShortcuts 的绑定一一对应，只写在可显示文案里。 */
const PLAY_KEY_HINT = '（空格）';

function realSource(audio, locationHref) {
  return Boolean(audio?.src && audio.src !== locationHref);
}

export function formatPlaybackTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function createPlaybackView({
  store,
  narrationAudio,
  musicAudio,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  navigatorLike = globalThis.navigator,
  locationHref = globalThis.location?.href || '',
  getController,
  getRuntimeClient,
  onUnlock = () => {},
  onPendingNarration = () => {},
  /** 卡片指的歌已经不在当前队列里：什么都不做，但必须让用户知道。 */
  onCardUnavailable = () => {},
  onError = error => console.warn('[playback-control]', error.message),
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancelSchedule = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (!store || !narrationAudio || !musicAudio) throw new TypeError('playback view dependencies are required');
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let initialized = false;
  let radioMode = true;
  let effectiveRadioOn = true;
  let radioChanging = false;
  let lyricLines = [];
  let activeLyricIndex = -1;
  let lyricsIdentity = null;
  let lineMode = 'idle';
  let lineTimer = null;
  let titleGeneration = 0;
  let trackTitle = '';
  let visiblePresentationKey = null;
  // 上一个**按曲目渲染过**的队列出现位置。与 visiblePresentationKey 分开：后者会被
  // 串词的表现覆盖，而标题态要不要重播只取决于“这首歌是不是刚成为当前曲目”。
  let visibleTrackKey = null;

  // 系统媒体键桥（init 时创建；测试与无媒体会话环境里可以是空实现）
  let mediaSessionControls = null;
  // 桌面托盘桥：只有桌面壳里存在（window.lunaraDesktop），浏览器里为 null
  let desktopTray = null;
  const controller = () => getController?.();
  const runtime = () => getRuntimeClient?.();
  const state = () => store.getState();
  const queue = () => state().queue || [];
  const cursor = () => state().cursor ?? -1;
  const currentItem = () => Array.isArray(state().runtimeState?.queue)
    ? projectRuntimeQueueItem(state().runtimeState)
    : queue()[cursor()] || null;
  const queueItemId = item => item?.queueItemId || item?.queue_item_id || null;
  const activeQueueItemId = runtimeState => runtimeState?.txn?.queueItemId
    || queueItemId(runtimeState?.queue?.[runtimeState?.currentIndex]) || null;
  /**
   * 曲目的表现身份是**队列出现位置**（queue occurrence），不是歌曲本身：同一首歌在队列里
   * 出现两次、或队列被替换成新的出现位置，都要重新走一次表现。
   * 以前一边用 queueItemId、一边用 songId 各算一套，两边永远不相等，于是每次 runtime
   * 广播（串词结束、续播、队列编辑、暂停恢复）都会重进「标题态」，把正在显示的那句歌词
   * 顶掉几秒——慢歌歌词推进慢，这个替换恰好落在两句歌词中间，看起来就像歌名插进了歌词。
   */
  const trackPresentationKey = (item, runtimeState) => `track:${queueItemId(item)
    || activeQueueItemId(runtimeState) || item?.song_id || item?.songId || item?.url || ''}`;
  // The server-selected runtime target is the only valid visual projection. A
  // stale HTMLAudioElement source must never keep an older title or lyric alive.
  const presentedTrack = () => {
    const item = currentItem();
    if (state().runtimeState?.currentSongId === null) return null;
    return item?.kind === 'track' ? item : null;
  };
  /**
   * 播放器这一刻在呈现什么媒体（`#app[data-media]` 的唯一判据）。
   * 判据与 syncRuntimePresentation 的分支条件逐字对应，不允许各有各的算法。
   */
  function currentMediaIdentity() {
    const runtimeState = state().runtimeState;
    if (currentItem()?.kind === 'track' && runtimeState?.currentSongId != null) {
      return Object.freeze({ kind: 'track', queueItemId: activeQueueItemId(runtimeState), revision: null });
    }
    return Object.freeze({ kind: 'idle', queueItemId: null, revision: null });
  }

  // The player bar presents the music channel. Narration may duck the music,
  // but it must never compete with it for the bar, so every narration-driven
  // write below defers to this predicate.
  function musicOwnsPlayer() {
    return realSource(musicAudio, locationHref);
  }
  let companionModeChanging = false;

  // ---- 混音（人声与音乐都是本地设备偏好） ----
  const VOICE_VOLUME_KEY = 'lunara-voice-volume';
  let voiceVolume = 1;
  try {
    const stored = Number(globalThis.localStorage?.getItem(VOICE_VOLUME_KEY));
    if (Number.isFinite(stored) && stored >= 0 && stored <= 1) voiceVolume = stored;
  } catch { /* 无存储环境（测试/隐私模式）保持默认 */ }
  narrationAudio.volume = voiceVolume;

  function listen(element, type, listener) {
    element?.addEventListener?.(type, listener);
    if (element) cleanups.push(() => element.removeEventListener?.(type, listener));
  }

  function setStatus(mode) {
    // TTS over music must not flip the status to "speaking": the runtime keeps
    // phase=playing during narration, and both channels' events interleave here.
    if (String(mode || '').toLowerCase() === 'speaking' && musicOwnsPlayer()) {
      mode = musicAudio.paused ? 'paused' : 'playing';
    }
    const status = $('#status');
    if (!status) return;
    const state = String(mode || 'idle').toLowerCase();
    const labels = {
      speaking: ['正在播报', 'var(--green)'],
      thinking: ['正在回应', 'var(--amber)'],
      playing: ['正在播放', 'var(--green)'],
      paused: ['已暂停', 'var(--t-mid)'],
      loading: ['正在准备', 'var(--t-mid)'],
      'autoplay-blocked': ['点击开始播放', 'var(--amber)'],
      error: ['播放遇到问题，可重试', 'var(--coral)'],
      exhausted: ['队列已结束', 'var(--t-mid)'],
      idle: ['尚未开始', 'var(--t-mid)'],
    };
    const presentation = labels[state] || labels.idle;
    const textNode = status.querySelector?.('.status-text');
    if (textNode) textNode.textContent = presentation[0];
    if (status.dataset) status.dataset.state = Object.hasOwn(labels, state) ? state : 'idle';
    status.style.color = presentation[1];
    const thinking = $('#thinking');
    if (thinking) thinking.style.display = state === 'thinking' ? 'flex' : 'none';
  }

  function updateLineText() {
    const current = $('#player-line-text');
    const next = $('#player-line-next');
    if (!current) return;
    current.classList?.remove('idle', 'speaking', 'title', 'lyric', 'notice', 'marquee');
    next?.classList?.remove('idle', 'speaking', 'title', 'lyric', 'notice', 'marquee');
    let currentText = '';
    let nextText = '';
    if (lineMode === 'title') {
      currentText = `♪ ${trackTitle}`;
      current.classList?.add('title');
    } else if (lineMode === 'lyric' && lyricLines.length) {
      const index = Math.max(0, activeLyricIndex);
      currentText = lyricLines[index]?.text || '♪';
      const notice = isInstrumentalNotice(currentText);
      nextText = notice ? '' : lyricLines[index + 1]?.text || '';
      current.classList?.add(notice ? 'notice' : 'lyric');
      if (!notice) next?.classList?.add('lyric');
    } else if (lineMode === 'lyric' && trackTitle) {
      currentText = '暂无同步歌词';
      current.classList?.add('idle');
    } else {
      currentText = '未在播放';
      current.classList?.add('idle');
    }
    current.textContent = currentText;
    if (next) next.textContent = nextText;
    updateMarquee(current);
    updateMarquee(next);
    syncListeningLyric(lineMode, currentText);
    // 歌词行推进时菜单栏要跟着走（不是等下一次 runtime 广播）：桥内部按签名去重。
    syncDesktopTray();
  }

  /**
   * 听歌列底部常驻歌词（参考稿）：只在真正有同步歌词时亮出，
   * 其余状态（标题轮播/说话中/无歌词）保持隐藏，不制造“伪歌词”。
   */
  /**
   * 托盘菜单栏可显示的当前歌词行。只取**真正的歌词**：标题态、说话中、
   * 「暂无同步歌词」都不算——那些属于播放器自己的提示，不该被
   * 当成歌词搬到菜单栏上。取不到就返回空串，由调用方回落到曲名。
   */
  function activeLyricLine() {
    return activeLyricSpan()?.text || '';
  }

  /**
   * 当前歌词句 + 它在时间轴上的跨度：LRC 只有行首时间，句尾取下一行；
   * 最后一行用音频总时长兜底。
   * 菜单栏的扫色靠这个算「唱到哪」。拿不到跨度时返回 spanMs: null——托盘会整行全亮，
   * 不会凭空猜一个速度。
   */
  function activeLyricSpan() {
    if (lineMode !== 'lyric') return null;
    const seconds = Number(musicAudio.currentTime) || 0;
    if (lyricLines.length) {
      const index = Math.max(0, activeLyricIndex);
      const line = lyricLines[index];
      if (!line?.text || isInstrumentalNotice(line.text)) return null;
      if (!Number.isFinite(line.time)) return { text: line.text, progress: null, spanMs: null };
      const startMs = Math.max(0, (Number(line.time) || 0) * 1000);
      const next = lyricLines[index + 1];
      const endSeconds = Number(next?.time) > Number(line.time)
        ? Number(next.time)
        : (Number(musicAudio.duration) > 0 ? Number(musicAudio.duration) : null);
      const spanMs = Number.isFinite(endSeconds) ? Math.max(0, (endSeconds * 1000) - startMs) : null;
      const progress = spanMs > 0 ? (seconds * 1000 - startMs) / spanMs : null;
      return { text: line.text, progress, spanMs };
    }
    return null;
  }

  function syncListeningLyric(mode, text) {
    const lyric = documentLike.querySelector?.('#listening-lyric');
    if (!lyric) return;
    const sameSource = !state().sessionId || !state().runtimeState?.activeListeningSessionId
      || state().sessionId === state().runtimeState.activeListeningSessionId;
    const hasLyric = sameSource && mode === 'lyric' && lyricLines.length > 0 && text && !text.startsWith('♪')
      && text !== '暂无同步歌词';
    const notice = hasLyric && isInstrumentalNotice(text);
    if (lyric.dataset) lyric.dataset.kind = notice ? 'notice' : 'lyric';
    lyric.hidden = !hasLyric;
    lyric.textContent = hasLyric ? text : '';
    for (const [id, index] of [['#listening-lyric-previous', activeLyricIndex - 1], ['#listening-lyric-next', activeLyricIndex + 1]]) {
      const node = $(id);
      if (node) { node.hidden = !hasLyric || notice || !lyricLines[index]; node.textContent = hasLyric && !notice ? lyricLines[index]?.text || '' : ''; }
    }
    syncInterlude();
  }

  function syncInterlude() {
    const sameSource = !state().sessionId || state().sessionId === state().runtimeState?.activeListeningSessionId;
    const notice = isInstrumentalNotice(lyricLines[Math.max(0, activeLyricIndex)]?.text);
    const seconds = !notice && lyricLines.length
      ? lyricGap(lyricLines.filter(line => !isInstrumentalNotice(line.text)), Number(musicAudio.currentTime) || 0) : null;
    for (const id of ['#listening-interlude', '#focus-interlude']) {
      const node = $(id);
      if (node) {
        node.hidden = seconds == null || (id === '#listening-interlude' && !sameSource);
        node.textContent = node.hidden ? '' : `〔 间奏 〕 · 约 ${seconds} 秒后下一句回来`;
      }
    }
  }

  function updateMarquee(element = $('#player-line-text')) {
    if (!element) return;
    const viewport = element?.parentElement;
    if (!viewport) return;
    const distance = Math.max(0, element.scrollWidth - viewport.clientWidth);
    element.style.setProperty('--marquee-offset', `${-distance}px`);
    element.classList.toggle('marquee', distance > 1);
  }

  function setTitleMode(title) {
    trackTitle = title || '';
    titleGeneration += 1;
    const generation = titleGeneration;
    if (lineTimer != null) cancelSchedule?.(lineTimer);
    if (!trackTitle) {
      lineMode = 'idle';
      lineTimer = null;
      updateLineText();
      return;
    }
    lineMode = 'title';
    updateLineText();
    lineTimer = schedule?.(() => {
      lineTimer = null;
      if (lineMode === 'title' && titleGeneration === generation) {
        lineMode = 'lyric';
        updateLineText();
      }
    }, 4000) ?? null;
  }

  function resetLineMode() {
    lineMode = 'idle';
    titleGeneration += 1;
    if (lineTimer != null) cancelSchedule?.(lineTimer);
    lineTimer = null;
    trackTitle = '';
    updateLineText();
  }

  function syncLyricLine(time) {
    syncInterlude();
    if (!lyricLines.length) {
      updateLineText();
      return;
    }
    // 无时间戳文本固定在首行，不随音频进度推进。
    let index = lyricLines[0]?.time === null ? 0 : -1;
    for (let candidate = 0; candidate < lyricLines.length; candidate += 1) {
      if (Number.isFinite(lyricLines[candidate].time) && lyricLines[candidate].time <= time) index = candidate;
      else break;
    }
    if (index === activeLyricIndex) {
      // 浏览来源变化不一定推进歌词索引，但应立即撤下旧来源的听歌列歌词。
      // 只刷新只读镜像，不重进标题态，也不改全局播放器的歌词。
      syncListeningLyric(lineMode, $('#player-line-text')?.textContent || '');
      return;
    }
    activeLyricIndex = index;
    if (lineMode === 'title' && index >= 0) {
      if (lineTimer != null) cancelSchedule?.(lineTimer);
      lineTimer = null;
      lineMode = 'lyric';
    }
    updateLineText();
  }

  /**
   * 当前媒体的种类标记（track / idle）。
   * 只由 syncRuntimePresentation 在算完 currentMediaIdentity() 之后写一次。
   */
  function markMediaKind(kind) {
    const app = $('#app');
    if (!app?.dataset) return;
    if (app.dataset.media !== kind) app.dataset.media = kind;
  }

  function updateLyrics() {
    const item = presentedTrack();
    const identity = item?.kind === 'track'
      ? `${queueItemId(item) || ''}:${trackSourceOf(item)}:${item.song_id ?? item.url ?? cursor()}:${item.lyric?.lrc || ''}:${item.lyric?.tlyric || ''}`
      : null;
    if (identity === lyricsIdentity) {
      syncLyricLine((musicOwnsPlayer() ? musicAudio.currentTime : narrationAudio.currentTime) || 0);
      return;
    }
    lyricsIdentity = identity;
    activeLyricIndex = -1;
    if (!identity) {
      lyricLines = [];
      updateLineText();
      return;
    }
    const lrc = normalizeLyricText(item.lyric?.lrc);
    const translated = normalizeLyricText(item.lyric?.tlyric);
    const originalLines = parseLrc(lrc);
    if (originalLines.length) {
      lyricLines = pairLyrics(originalLines, parseLrc(translated));
      syncLyricLine((!musicAudio.paused ? musicAudio.currentTime : narrationAudio.currentTime) || 0);
    } else if (lrc) {
      const lines = String(lrc).split('\n').map(line => line.trim()).filter(Boolean);
      // 无同步时间的文本只静态展示，不能伪造时间供间奏倒计时/托盘扫色使用。
      lyricLines = lines.map(text => ({ time: null, text }));
      syncLyricLine(0);
    } else {
      lyricLines = [];
      updateLineText();
    }
  }

  function renderTrack(item) {
    if (Array.isArray(state().runtimeState?.queue)) {
      const target = presentedTrack();
      // A callback is a notification, not another source of track metadata.
      // Never let an old/neighboring occurrence repaint the runtime target.
      if (!target || queueItemId(item) !== queueItemId(target)
        || String(item.song_id ?? item.songId ?? '') !== String(target.song_id ?? '')
        || (trackSourceOf(item) && trackSourceOf(item) !== trackSourceOf(target))) return;
      item = target;
    }
    const key = trackPresentationKey(item, state().runtimeState);
    // 同一队列出现位置的重渲染（串词前后的 runtime 广播、续播事件、队列投影刷新）
    // 只是把行还原到当前歌词，不得重播标题态。
    const sameOccurrence = visibleTrackKey === key;
    visibleTrackKey = key;
    visiblePresentationKey = key;
    const title = $('#np-title');
    const subtitle = $('#np-sub');
    const album = $('#np-album');
    if (title) title.textContent = item.title || '?';
    if (subtitle) subtitle.textContent = item.artist || '';
    const albumSource = sourceLabel(trackSourceOf(item));
    if (album) album.textContent = [...[item.album].filter(Boolean), ...(albumSource ? [albumSource] : [])].join(' · ');
    mirrorNowPlayingMeta(item);
    // 有曲目但缺封面用占位封面；没有任何曲目时显示 Lunara 应用图标。
    setPlayerArtwork(item ? (item.pic_url || item.artwork || '/cover-fallback.jpg') : '/icon.png');
    const lineTitle = item.title ? (item.artist ? `${item.title} — ${item.artist}` : item.title) : '';
    if (!sameOccurrence) {
      // Invalidate before publishing the new title: media ticks and title timers
      // can run before the next refresh and must not reveal the previous cache.
      lyricsIdentity = null;
      lyricLines = [];
      activeLyricIndex = -1;
      setTitleMode(lineTitle);
    } else {
      // 标题态只属于这首歌刚成为当前曲目的那一刻；同一出现位置不重播。
      trackTitle = lineTitle;
      if (lyricLines.length && lineMode !== 'lyric') lineMode = 'lyric';
      updateLineText();
    }
    updateLyrics();
  }

  /**
   * 听歌列主视觉（data-np-*）是播放器同一份事实的镜像：标题/艺人/专辑、
   * 封面与当前歌词都由这里统一写入，不建第二个真相源。
   */
  /**
   * 播放来源的短名。只在播放器区域出现：聊天气泡不挂来源标签，那里陈述的是
   * 「聊到过这首歌」，而「此刻响的是哪条资源」属于播放器。未知源如实显示 id。
   */
  // 队列项里这个字段叫 source（canonical 供给身份），双轨背景项才叫 provider。
  function trackSourceOf(item) {
    return item?.source || item?.provider || '';
  }

  function sourceLabel(provider) {
    const id = String(provider || '').trim().toLowerCase();
    if (!id) return '';
    if (id === 'qq') return 'QQ 音乐';
    if (id === 'ncm') return '网易云音乐';
    if (id === 'apple') return 'Apple Music';
    return id;
  }

  function mirrorNowPlayingMeta(item) {
    const source = sourceLabel(trackSourceOf(item));
    const size = trackTitleSize(item?.title);
    const playerTitle = $('#np-title');
    if (playerTitle?.dataset) playerTitle.dataset.titleSize = size;
    documentLike.querySelectorAll?.('[data-np-title]')?.forEach(node => {
      if (node.dataset) node.dataset.titleSize = size;
    });
    // 封面兜底时夜场画歌名首字方块；首字随歌名写在封面容器上，样式自取。
    const artwork = $('.listening-artwork');
    if (artwork?.dataset) artwork.dataset.initial = Array.from(String(item?.title || '').trim())[0] || '';
    const map = [
      ['[data-np-title]', item?.title || '?'],
      ['[data-np-meta]', [...[item?.artist, item?.album].filter(Boolean), ...(source ? [source] : [])].join(' / ')],
    ];
    for (const [selector, value] of map) {
      documentLike.querySelectorAll?.(selector)?.forEach(node => { node.textContent = value; });
    }
    // 大字歌名在窄处会截成两行省略号；悬停给出全名。
    documentLike.querySelectorAll?.('[data-np-title]')?.forEach(node => { node.title = item?.title || ''; });
  }

  function setPlayerArtwork(src) {
    // 空封面与加载失败都由 applyArtwork 落到兜底图，避免出现空白/破图。
    applyArtwork($('#player-cover'), src);
    documentLike.querySelectorAll?.('[data-player-cover]')?.forEach(img => {
      applyArtwork(img, src);
    });
  }

  function renderNarration(_item, _options = {}) {
    // A loaded song keeps the bar even while paused during a spoken reply.
    if (musicOwnsPlayer()) return;
    visiblePresentationKey = `speaking:${state().runtimeState?.txn?.correlationId || _item?.correlationId || _item?.url || ''}`;
    const title = $('#np-title');
    const subtitle = $('#np-sub');
    if (title) title.textContent = 'Lunara 说话中…';
    if (subtitle) subtitle.textContent = '';
    const heroTitle = documentLike.querySelector?.('[data-np-title]');
    if (heroTitle) heroTitle.textContent = 'Lunara 说话中…';
    const heroMeta = documentLike.querySelector?.('[data-np-meta]');
    if (heroMeta) heroMeta.textContent = '';
    resetLineMode();
    const line = $('#player-line-text');
    if (line) {
      line.textContent = 'Lunara 正在说话…';
      line.className = 'player-line-text speaking';
    }
    const nextLine = $('#player-line-next');
    if (nextLine) nextLine.textContent = '';
  }

  /**
   * 进度条唯一的落笔处。current=total=0 时只清空文本、不留旧宽度。
   */
  function paintTimeline(current, total) {
    const time = $('#np-time');
    const duration = $('#np-duration');
    const progress = $('#progress-fill');
    const progressBar = $('#progress-bar');
    const percent = total ? Math.min(100, Math.max(0, current / total * 100)) : 0;
    if (time) time.textContent = formatPlaybackTime(current);
    if (duration) duration.textContent = formatPlaybackTime(total);
    if (progress) progress.style.width = `${percent}%`;
    progressBar?.style?.setProperty?.('--player-progress', `${percent}%`);
    progressBar?.setAttribute?.('aria-valuemax', String(Math.max(0, Math.floor(total))));
    progressBar?.setAttribute?.('aria-valuenow', String(Math.max(0, Math.floor(current))));
    progressBar?.setAttribute?.('aria-valuetext', `${formatPlaybackTime(current)} / ${formatPlaybackTime(total)}`);
    syncLyricLine(current);
  }

  function timeUpdate(audio) {
    // 人声音频的进度永远不映射到播放器进度条：聊天朗读、串词的裸 timeupdate
    // 任何情况下都不落笔，纯聊天没放歌时也不例外（以前这里只在“有歌加载中”
    // 时才挡，没放歌就把 0:03 这类人声进度画上了进度条）。
    if (audio === narrationAudio) return;
    paintTimeline(audio.currentTime || 0, audio.duration || 0);
  }

  /** 播放器这一刻是否在放歌。按钮态、系统媒体键的 playbackState 都用这一个判据。 */
  function currentlyPlaying() {
    return !musicAudio.paused;
  }

  function updatePlayButton() {
    const button = $('#big-play');
    const svg = button?.querySelector?.('svg');
    if (!svg) return;
    const playing = currentlyPlaying();
    svg.innerHTML = playing
      ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'
      : '<path d="M8 5v14l11-7z"/>';
    button.setAttribute?.('aria-label', playing ? '暂停' : '播放');
    button.title = playing ? `暂停${PLAY_KEY_HINT}` : `播放${PLAY_KEY_HINT}`;
    $('.persistent-player')?.classList?.toggle?.('is-playing', playing);
  }

  function updateVolumeButton() {
    const button = $('#player-volume');
    if (button) {
      const muted = Boolean(musicAudio.muted && narrationAudio.muted);
      button.setAttribute?.('aria-pressed', String(muted));
      button.setAttribute?.('aria-label', muted ? '恢复声音' : '静音');
      button.title = muted ? '恢复声音' : '静音';
    }
    syncVolumeSlider();
  }

  // 音量滑块只是 getMusicVolumePreference() 的另一处视图（另一处是混音区的「音乐」通道），
  // 不缓存、不新建状态：每次都回读偏好，避免两处回显漂移。拖动中不回写，防止和手指抢值。
  function syncVolumeSlider() {
    const slider = $('#player-volume-slider');
    if (!slider) return;
    const next = String(getMusicVolumePreference());
    if (slider.value !== next) slider.value = next;
  }

  function toggleMuted() {
    const muted = !(musicAudio.muted && narrationAudio.muted);
    musicAudio.muted = muted;
    narrationAudio.muted = muted;
    updateVolumeButton();
  }

  function seekTo(nextTime) {
    const total = Number(musicAudio.duration) || 0;
    if (!total) return;
    musicAudio.currentTime = Math.min(total, Math.max(0, Number(nextTime) || 0));
    timeUpdate(musicAudio);
  }

  /**
   * 混音区：放歌时显示人声/音乐两条滑杆（都是本地设备偏好，0–1）；没有当前歌曲时隐藏。
   * DOM 钩子沿用 #episode-mixer / #mixer-bed，主题样式依赖这些名字。
   */
  function syncMixer() {
    const mixer = $('#episode-mixer');
    if (!mixer) return;
    const visible = state().runtimeState?.currentSongId != null;
    mixer.hidden = !visible;
    if (!visible) return;
    const voice = $('#mixer-voice');
    if (voice) voice.value = String(voiceVolume);
    const label = $('#mixer-bed-label');
    if (label) label.textContent = '音乐';
    const bed = $('#mixer-bed');
    if (bed) {
      bed.min = '0';
      bed.max = '1';
      bed.step = '0.05';
      bed.value = String(getMusicVolumePreference());
    }
  }

  function refreshTrackCards() {
    const playing = state().runtimeState?.currentSongId;
    documentLike.querySelectorAll?.('.chat-track')?.forEach(button => {
      const songId = button.dataset?.songId;
      const active = songId
        ? playing != null && songId === String(playing)
        : Number.parseInt(button.dataset?.queueIdx, 10) === cursor();
      button.classList?.toggle('active', Boolean(active));
    });
  }

  function syncRuntimePresentation() {
    const runtimeState = state().runtimeState;
    const item = currentItem();
    // 媒体身份先算、先落。data-media 晚一帧写，封面就会先按上一种媒体排版画一遍
    // 再跳一次。
    const identity = currentMediaIdentity();
    markMediaKind(identity.kind);
    if (runtimeState?.phase === 'speaking') {
      const key = `speaking:${runtimeState?.txn?.correlationId || item?.song_id || ''}`;
      if (visiblePresentationKey !== key) renderNarration({
        correlationId: runtimeState?.txn?.correlationId || null,
      });
      return;
    }
    if (item?.kind === 'track' && runtimeState?.currentSongId != null) {
      if (visiblePresentationKey !== trackPresentationKey(item, runtimeState)) renderTrack(item);
      return;
    }
    if (runtimeState && runtimeState.currentSongId == null && visiblePresentationKey !== 'idle') {
      visiblePresentationKey = 'idle';
      const title = $('#np-title');
      const subtitle = $('#np-sub');
      const album = $('#np-album');
      if (title) title.textContent = '未在播放';
      if (subtitle) subtitle.textContent = '';
      if (album) album.textContent = '';
      documentLike.querySelectorAll?.('[data-np-title]')?.forEach(node => { node.textContent = '—'; node.title = ''; });
      documentLike.querySelectorAll?.('[data-np-meta]')?.forEach(node => { node.textContent = ''; });
      setPlayerArtwork('/icon.png');
      resetLineMode();
      syncListeningLyric('idle', '');
    }
  }

  function refresh() {
    if (state().runtimeState) { radioMode = state().runtimeState.radioMode; updateRadioToggle(); }
    updateCompanionModeControl();
    refreshTrackCards();
    updatePlayButton();
    updateVolumeButton();
    syncPreviousControl();
    syncMediaSessionNowPlaying();
    syncDesktopTray();
    syncRuntimePresentation();
    syncMixer();
    updateLyrics();
    updateUpcomingCount();
  }

  /**
   * 播放条「待播 NN」：当前游标之后的歌曲数（两位数十位补零）。
   * 只是 runtime 队列的读数投影，不维护自己的计数状态。
   */
  function updateUpcomingCount() {
    const node = $('#player-upcoming-count');
    if (!node) return;
    const remaining = Math.max(0, queue().length - cursor() - 1);
    node.textContent = String(Math.min(remaining, 99)).padStart(2, '0');
  }

  /** 模式控件回显权威状态；未收到/旧缺省投影与服务端默认一致，不自动提交。 */
  function updateCompanionModeControl() {
    const select = $('#companion-mode');
    if (!select) return;
    const snapshot = state().runtimeState;
    const value = snapshot?.companionModeId || 'conversational';
    if (select.value !== value) select.value = value;
    select.disabled = companionModeChanging;
    select.title = '只影响当前一起听的会话；不切歌、不改人格';
  }

  async function changeCompanionMode(rawValue) {
    if (companionModeChanging) return;
    if (!['music_only', 'occasional', 'conversational'].includes(rawValue)) {
      updateCompanionModeControl();
      return;
    }
    const nextModeId = rawValue;
    companionModeChanging = true;
    updateCompanionModeControl();
    try {
      const result = await runtime()?.setCompanionMode?.(nextModeId);
      if (result?.ok === false || result?.accepted === false) {
        throw new Error(result?.error || '模式没有保存，请再试一次。');
      }
    } catch (error) {
      // 权威值已经由客户端恢复并回显；这里只把失败告诉用户。
      onError(error);
    } finally {
      companionModeChanging = false;
      refresh();
    }
  }

  function handleControl(command) {
    const playback = controller();
    if (!playback) return;
    if (command === 'pause' || command === 'stop') void runtime()?.pause?.();
    else if (command === 'resume') void runtime()?.resume?.();
    else if (command === 'next') void runtime()?.requestNext?.();
    else if (command !== 'louder' && command !== 'softer') return;
    if (command === 'stop' || command === 'pause') {
      return;
    } else if (command === 'resume') {
      return;
    } else if (command === 'next') {
      return;
    } else if (command === 'louder') {
      const target = !musicAudio.paused ? musicAudio : narrationAudio;
      target.volume = Math.min(1, target.volume + 0.15);
      // 调的是主音乐通道时同步本地偏好，避免滑杆回显漂移。
      if (target === musicAudio) setMusicVolumePreference(target.volume);
    } else if (command === 'softer') {
      const target = !musicAudio.paused ? musicAudio : narrationAudio;
      target.volume = Math.max(0, target.volume - 0.15);
      if (target === musicAudio) {
        setMusicVolumePreference(target.volume);
        playback.setDuckLevel(Math.max(0.05, target.volume * 0.3));
      }
    }
  }

  /**
   * 聊天气泡里的歌曲卡。卡片自带播放身份（队列出现位置优先，其次 canonical songId），
   * 不能拿媒体 url 当门槛：气泡里的歌来自已提交的账本，本来就没有 url。
   * 点到的歌已经不在当前队列里时不能默不做声：runtime 只会在当前队列里解析身份，
   * 静默失败会让按钮看起来像坏的。
   */
  function handleTrackCard(button) {
    if (!button || button.classList?.contains('unavailable')) return;
    const client = runtime();
    if (!client) return;
    const queueItemId = button.dataset?.queueItemId || '';
    const songId = button.dataset?.songId || '';
    const queued = state().runtimeState?.queue || [];
    if (queueItemId) {
      if (!queued.some(track => track?.queueItemId === queueItemId)) { onCardUnavailable(); return; }
      void client.selectQueueItem?.(queueItemId);
      return;
    }
    if (!songId) return;
    if (!queued.some(track => track?.songId === songId)) { onCardUnavailable(); return; }
    void client.selectSong?.(songId);
  }

  function handleQueueUpdate(message) {
    const playback = controller();
    if (!playback) return;
    if (message.overlayNarrations?.length) {
      playback.playOverlayNarrations(message.overlayNarrations);
    }
    refresh();
  }

  function updateRadioToggle() {
    const button = $('#radio-toggle');
    if (!button) return;
    const effectiveOn = Boolean(radioMode);
    effectiveRadioOn = effectiveOn;
    button.classList?.toggle('active', effectiveOn);
    button.title = effectiveOn ? '自动续播已开启，当前队列播完后继续选歌；点击关闭' : '自动续播已关闭，播完当前队列后停止；点击开启';
    button.setAttribute?.('aria-checked', String(effectiveOn));
    button.disabled = radioChanging;
    const label = button.querySelector?.('.radio-label');
    if (label) label.textContent = `自动续播：${effectiveOn ? '开' : '关'}`;
    const continuation = state().runtimeState?.pendingContinuation;
    const failed = effectiveOn && continuation?.status === 'failed';
    const waiting = effectiveOn && continuation?.status === 'requested';
    const status = $('#continuation-status');
    if (status) { status.hidden = !failed && !waiting; status.textContent = failed ? '续播没成功，可以重试' : waiting ? '正在准备下一首…' : ''; }
    const retry = $('#continuation-retry');
    if (retry) { retry.hidden = !failed; retry.disabled = radioChanging; }
  }

  async function changeRadioMode(enabled) {
    if (radioChanging) return;
    radioChanging = true;
    updateRadioToggle();
    try { await runtime()?.setRadioMode?.(enabled); }
    catch (error) { onError(error); }
    finally { radioChanging = false; refresh(); }
  }

  async function retryContinuation() {
    if (radioChanging) return;
    radioChanging = true;
    updateRadioToggle();
    try {
      const result = await runtime()?.retry?.();
      if (result?.error || result?.accepted === false || result?.ok === false) {
        throw result.error || new Error(result?.reason || '续播没有恢复，请再试一次。');
      }
    } catch (error) {
      onError(error);
    } finally {
      radioChanging = false;
      refresh();
    }
  }

  /**
   * 播放/暂停的唯一行为：按钮点击与空格快捷键走同一份分派。
   * 快捷键另写一份必然与这里分叉，所以只允许调用，不允许复制。
   */
  function togglePlayPause() {
    const phase = state().runtimeState?.phase;
    if (phase === 'error') void runtime()?.retry?.();
    else if (!musicAudio.paused && realSource(musicAudio, locationHref)) void runtime()?.pause?.();
    else void runtime()?.resume?.();
  }

  /** 「下一首」的唯一行为：队尾按自动续播边界。 */
  function playNext() {
    void runtime()?.requestNext?.();
  }

  /**
   * 「上一首」= 当前**队列出现位置**的前一个（不是歌曲的前一首：同一首歌出现两次是两处）。
   * 队首或 runtime client 不支持时什么都不做，绝不猜目标。
   */
  function playPrevious() {
    const runtimeState = state().runtimeState;
    const target = runtimeState?.queue?.[Number(runtimeState?.currentIndex) - 1];
    if (!target?.queueItemId) return;
    void runtime()?.selectQueueItem?.(target.queueItemId);
  }

  /** 上一首按钮的可用性：与 playPrevious 用同一个判据，避免「看起来能点但什么都没发生」。 */
  function syncPreviousControl() {
    const button = $('#player-previous');
    if (!button) return;
    const runtimeState = state().runtimeState;
    const target = runtimeState?.queue?.[Number(runtimeState?.currentIndex) - 1];
    button.disabled = !target?.queueItemId || typeof runtime()?.selectQueueItem !== 'function';
  }

  /**
   * 播放条此刻是否真的呈现给用户：classic 版式的设置页会把整条播放器隐藏
   * （`#app.settings-open`），舞台版式则在每一页都保留播放条。
   * 能读到计算样式时以播放条实际是否显示为准；读不到时退回按页面类名判断。
   * 看不见的控件不能默默改变播放，这些页面上的空格与方向键仍然属于页面自己（滚动、表单）。
   */
  function playerPresented() {
    const player = $('.persistent-player');
    const computed = player && documentLike.defaultView?.getComputedStyle?.(player);
    if (computed?.display) return computed.display !== 'none';
    const classList = $('#app')?.classList;
    if (typeof classList?.contains !== 'function') return true;
    return !classList.contains('settings-open');
  }

  /**
   * 系统媒体键看到的「正在播放」：与播放条同一份事实。
   * 当前曲目给标题/艺人/专辑/封面；没有当前内容时交回 none，
   * 免得锁屏/媒体中心继续把媒体键发给一个已经不播东西的会话。
   */
  function syncMediaSessionNowPlaying() {
    if (!mediaSessionControls) return;
    const playing = currentlyPlaying();
    const item = presentedTrack();
    if (!item) { mediaSessionControls.setNowPlaying({ track: null }); return; }
    mediaSessionControls.setNowPlaying({
      playing,
      artwork: item.pic_url || item.artwork || '',
      track: { kind: 'track', title: item.title || '', artist: item.artist || '', album: item.album || '' },
    });
  }

  /**
   * 桌面托盘（macOS 菜单栏 / Windows 托盘）看到的播放身份：与播放条同一份事实。
   * 托盘只做展示，命令回来仍走 togglePlayPause / playPrevious / playNext。
   */
  function syncDesktopTray() {
    if (!desktopTray) return;
    const item = presentedTrack();
    const runtimeState = state().runtimeState;
    const canPrevious = Boolean(runtimeState?.queue?.[Number(runtimeState?.currentIndex) - 1]?.queueItemId);
    const lyric = activeLyricSpan();
    desktopTray.publish({
      title: item?.title || '',
      artist: item?.artist || '',
      playing: currentlyPlaying(),
      canPrevious,
      // 菜单栏文字由用户选：曲名，或当前歌词行（取不到歌词时主进程回落曲名）。
      textMode: getTrayTextMode(),
      subtitle: lyric?.text || '',
      // 扫色用：这一句唱到哪（0..1）与它的时间跨度；缺一项时托盘整行全亮。
      subtitleProgress: Number.isFinite(lyric?.progress) ? Math.min(1, Math.max(0, lyric.progress)) : null,
      subtitleSpanMs: Number.isFinite(lyric?.spanMs) && lyric.spanMs > 0 ? lyric.spanMs : null,
    });
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    desktopTray = createDesktopTrayBridge({
      desktopLike: windowLike?.lunaraDesktop ?? globalThis.lunaraDesktop,
      handlers: { toggle: togglePlayPause, previous: playPrevious, next: playNext },
    });
    cleanups.push(() => desktopTray?.destroy());
    cleanups.push(subscribeTrayTextMode(() => syncDesktopTray()));
    // 硬件媒体键（F7/F8/F9、外接键盘 Fn 组合、耳机按键）走媒体会话，不是页内 keydown；
    // 四条动作与播放条按钮同一批函数，因此队首无上一首等规则自动一致。
    mediaSessionControls = createMediaSessionControls({
      mediaSessionLike: navigatorLike?.mediaSession,
      MediaMetadataImpl: globalThis.MediaMetadata,
      handlers: {
        play: () => { void runtime()?.resume?.(); },
        pause: () => { void runtime()?.pause?.(); },
        next: playNext,
        previous: playPrevious,
      },
    });
    cleanups.push(() => mediaSessionControls?.destroy());
    const ResizeObserverImpl = windowLike?.ResizeObserver;
    const lineViewports = [$('#player-line-text')?.parentElement, $('#player-line-next')?.parentElement].filter(Boolean);
    if (ResizeObserverImpl && lineViewports.length) {
      const observer = new ResizeObserverImpl(() => {
        updateMarquee($('#player-line-text'));
        updateMarquee($('#player-line-next'));
      });
      lineViewports.forEach(viewport => observer.observe(viewport));
      cleanups.push(() => observer.disconnect());
    }
    updateRadioToggle();
    updateCompanionModeControl();
    // 键盘与播放条按钮走同一批函数（transportShortcuts 只做按键→动作映射）。
    // 空格只绑定播放/暂停：不另外发明应用内快捷键。
    listen($('#big-play'), 'click', togglePlayPause);
    listen($('#skip-btn'), 'click', playNext);
    listen($('#player-previous'), 'click', playPrevious);
    cleanups.push(installTransportShortcuts({
      documentLike,
      isEnabled: playerPresented,
      handlers: { toggle: togglePlayPause },
    }));
    listen($('#player-volume'), 'click', toggleMuted);
    listen($('#mixer-voice'), 'input', event => {
      const value = Number(event.target?.value);
      if (!Number.isFinite(value) || value < 0 || value > 1) return;
      voiceVolume = value;
      narrationAudio.volume = value;
      try { globalThis.localStorage?.setItem(VOICE_VOLUME_KEY, String(value)); } catch { /* 无存储环境时忽略 */ }
    });
    listen($('#mixer-bed'), 'input', event => {
      // 音乐通道：主音乐音量，本地设备偏好，换歌与压低恢复后保持。
      musicAudio.volume = setMusicVolumePreference(Number(event.target?.value));
    });
    // 传输控制区的音乐音量：与混音区「音乐」通道同源（同一偏好）。
    listen($('#player-volume-slider'), 'input', event => {
      const value = Number(event.target?.value);
      if (!Number.isFinite(value) || value < 0 || value > 1) return;
      musicAudio.volume = setMusicVolumePreference(value);
      updateVolumeButton();
    });
    listen(musicAudio, 'volumechange', updateVolumeButton);
    listen(narrationAudio, 'volumechange', updateVolumeButton);
    listen($('#radio-toggle'), 'click', () => { void changeRadioMode(!effectiveRadioOn); });
    listen($('#companion-mode'), 'change', event => {
      event.preventDefault?.();
      const source = event.currentTarget || event.target;
      void changeCompanionMode(source?.value ?? '');
    });
    listen($('#continuation-retry'), 'click', () => { void retryContinuation(); });
    listen($('#progress-bar'), 'click', event => {
      if (!musicAudio.duration) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      seekTo((event.clientX - rect.left) / rect.width * musicAudio.duration);
    });
    listen($('#progress-bar'), 'keydown', event => {
      const total = Number(musicAudio.duration) || 0;
      if (!total) return;
      const steps = {
        ArrowLeft: -5,
        ArrowDown: -5,
        ArrowRight: 5,
        ArrowUp: 5,
        PageDown: -30,
        PageUp: 30,
      };
      if (event.key === 'Home') seekTo(0);
      else if (event.key === 'End') seekTo(total);
      else if (Object.hasOwn(steps, event.key)) seekTo(musicAudio.currentTime + steps[event.key]);
      else return;
      event.preventDefault?.();
    });
    listen(narrationAudio, 'stalled', () => console.warn('[audio] narration stalled', narrationAudio.src));
    listen(musicAudio, 'stalled', () => console.warn('[audio] music stalled', musicAudio.src));
    listen(windowLike, 'beforeunload', () => controller()?.reportPartial?.(navigatorLike?.sendBeacon?.bind(navigatorLike)));
    listen(documentLike, 'visibilitychange', () => {
      if (documentLike.visibilityState === 'hidden') controller()?.reportPartial?.(navigatorLike?.sendBeacon?.bind(navigatorLike));
    });
    void controller()?.flushOutcomeQueue?.();
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    if (lineTimer != null) cancelSchedule?.(lineTimer);
    lineTimer = null;
    cleanups.splice(0).forEach(cleanup => cleanup());
  }

  const callbacks = Object.freeze({
    onStatus: setStatus,
    // 波形图（analyser）不经过 view：人声不属于播放器内容，歌曲路径由
    // runtimePlaybackCallbacks.onTrack 直接接管 setupAnalyser。
    onUnlock,
    onTrack: renderTrack,
    onNarration: renderNarration,
    onTimeUpdate: timeUpdate,
    onError: (error, item) => console.warn('[play] failed', item?.url, error?.message),
    onChanged: refresh,
  });

  const api = Object.freeze({
    init,
    destroy,
    callbacks,
    setStatus,
    refresh,
    refreshTrackCards,
    updateLyrics,
    resetLineMode,
    handleTrackCard,
    handleQueueUpdate,
    handleControl,
    getRadioMode: () => effectiveRadioOn,
  });
  return api;
}
