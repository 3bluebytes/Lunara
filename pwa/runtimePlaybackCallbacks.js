const NOOP = () => {};

/** Keep runtime media callbacks limited to playback presentation and status. */
export function createRuntimePlaybackCallbacks({
  playbackView,
  setupAnalyser = NOOP,
  musicAudio,
  onTrackEnded = NOOP,
  onError = NOOP,
  onAutoplayBlocked = NOOP,
} = {}) {
  const view = playbackView?.callbacks;
  if (!view?.onTrack || !view?.onNarration) throw new TypeError('runtime playback view callbacks are required');

  return Object.freeze({
    // 人声不进波形图：串词/聊天朗读不把 analyser 抢给 narrationAudio，
    // 也不为此把人声元素挂进 Web Audio 图；只有歌曲接管。
    onNarration: (command, options = {}) => {
      view.onNarration(command, options);
    },
    onTrack: item => {
      setupAnalyser(musicAudio);
      view.onTrack(item);
    },
    onStatus: view.onStatus || NOOP,
    onChanged: view.onChanged || NOOP,
    onTrackEnded,
    onError,
    onAutoplayBlocked,
  });
}
