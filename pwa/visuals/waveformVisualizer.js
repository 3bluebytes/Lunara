// 播放条波形。显示方式由主题的 waveform 变体决定（根元素 data-waveform）：
//   single：一行，读当前分析器（默认，旧四套主题）；
//   dual：两行。上行音乐，读音乐分析器，已播部分标 .played；下行是伙伴声音的
//         “在说话”指示——旁白音频没有接入 Web Audio，没有真实声纹可读，所以这里
//         只在旁白播放时画一条平滑起伏，不说话时静止。它不是声纹，也不写任何播放状态。
//   line：显示上与 single 相同的一行，由主题样式隐藏波形柱、只画细线进度（stage.css）。
// 音乐柱的横轴是频谱（左低频、右高频），不是时间轴：频段按指数曲线分布（低频更细），
// 读不截顶的 dB 值并补偿高频的天然衰减，每根柱子快升慢降地平滑过渡
// （减少动态时直接跳到目标值）。只读分析器，不改它的配置。
// 切换主题后调 refresh() 按新变体重建。
export function createWaveformVisualizer({
  container,
  root = globalThis.document?.documentElement,
  windowLike = globalThis.window,
  createElement = () => globalThis.document.createElement('div'),
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  now = () => globalThis.performance?.now?.() || Date.now(),
  scheduleInterval = globalThis.setInterval?.bind(globalThis),
  cancelInterval = globalThis.clearInterval?.bind(globalThis),
  isIdle = () => true,
  onAmplitude = () => {},
  random = Math.random,
  getVariant = () => root?.dataset?.waveform || 'single',
  getProgress = () => 0,
  isVoiceActive = () => false,
  barCount = 96,
  dualBarCount = 72,
  maxBarHeight = 80,
  dualMaxBarHeight = 12,
  dualMusicMaxBarHeight = 24,
  attack = 0.55,
  release = 0.16,
  idleBarHeight = 10,
  idleIntervalMs = 180,
} = {}) {
  if (!container) throw new TypeError('waveform container is required');
  let musicBars = [];
  let voiceBars = [];
  const owned = [];
  let mode = 'single';
  let initialized = false;
  let analyser = null;
  let frequencyData = null;
  let floatData = false;
  let binLevels = null;
  let frameId = null;
  let intervalId = null;
  let voicePhase = 0;
  let levels = [];
  let bands = null;
  // 波形只画给人看的“响度起伏”：60fps 与 120Hz 屏幕上肉眼没区别，按帧写 140 多根柱子的样式会白烧一半预算。
  // 这里按时间节流到 ~60fps，并按时间步长换算快升慢降的系数，降帧不会让响应变慢。
  const FRAME_MS = 1000 / 60;
  let lastRenderAt = 0;
  let lastPlayedIndex = -1;
  const writtenHeight = [];
  const writtenOpacity = [];
  const writtenHot = [];

  const reducedMotion = () => Boolean(windowLike?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  function makeBars(parent, count) {
    const list = [];
    for (let index = 0; index < count; index += 1) {
      const bar = createElement('div');
      bar.className = 'bar';
      bar.style.height = '3px';
      parent.appendChild(bar);
      list.push(bar);
    }
    return list;
  }

  function build() {
    mode = getVariant() === 'dual' ? 'dual' : 'single';
    if (mode === 'single') {
      musicBars = makeBars(container, barCount);
      owned.push(...musicBars);
      return;
    }
    const musicRow = createElement('div');
    musicRow.className = 'waveform-row waveform-music';
    const voiceRow = createElement('div');
    voiceRow.className = 'waveform-row waveform-voice';
    container.appendChild(musicRow);
    container.appendChild(voiceRow);
    owned.push(musicRow, voiceRow);
    musicBars = makeBars(musicRow, dualBarCount);
    voiceBars = makeBars(voiceRow, dualBarCount);
  }

  function clearBars() {
    for (const node of owned) node.remove?.();
    owned.length = 0;
    musicBars = [];
    voiceBars = [];
    levels = [];
    bands = null;
    lastPlayedIndex = -1;
    writtenHeight.length = 0;
    writtenOpacity.length = 0;
    writtenHot.length = 0;
  }

  function markPlayed() {
    if (mode !== 'dual') return;
    const ratio = Math.max(0, Math.min(1, Number(getProgress()) || 0));
    const played = Math.round(ratio * musicBars.length);
    // 播放进度一秒钟才跨过一两根柱子：只有边界变化时才碰 DOM，不再每帧 toggle 两行 144 个类名。
    if (played === lastPlayedIndex) return;
    lastPlayedIndex = played;
    musicBars.forEach((bar, index) => bar.classList.toggle('played', index < played));
    voiceBars.forEach((bar, index) => bar.classList.toggle('played', index < played));
  }

  function renderVoice() {
    if (mode !== 'dual') return;
    const speaking = isVoiceActive() && !reducedMotion();
    if (speaking) voicePhase += 0.42;
    for (let index = 0; index < voiceBars.length; index += 1) {
      const bar = voiceBars[index];
      if (!speaking) { bar.style.height = '2px'; continue; }
      const swell = Math.abs(Math.sin(voicePhase * 0.37 + index * 0.13));
      const ripple = Math.abs(Math.sin(voicePhase + index * 0.55));
      bar.style.height = `${Math.max(2, Math.round(2 + ripple * (0.35 + 0.65 * swell) * (dualMaxBarHeight - 2)))}px`;
    }
  }

  function renderFrame() {
    if (!initialized || !analyser || !frequencyData) return;
    frameId = null;
    const time = now();
    const elapsed = lastRenderAt ? time - lastRenderAt : FRAME_MS;
    // 只有“明显快于 60fps 的真实帧”才跳过；同时调用（测试、事件回调）的 elapsed 不足 1ms，按一帧处理。
    if (elapsed >= 1 && elapsed < FRAME_MS - 1.5) {
      frameId = requestFrame?.(renderFrame) ?? null;
      return;
    }
    const step = elapsed < 1 ? 1 : Math.min(4, elapsed / FRAME_MS);
    lastRenderAt = time;
    const still = reducedMotion();
    const quiet = isIdle() || still;
    if (quiet) binLevels.fill(0);
    else {
      if (floatData) analyser.getFloatFrequencyData(frequencyData);
      else analyser.getByteFrequencyData(frequencyData);
      const minDb = Number.isFinite(analyser.minDecibels) ? analyser.minDecibels : -100;
      const maxDb = Number.isFinite(analyser.maxDecibels) ? analyser.maxDecibels : -30;
      for (let bin = 0; bin < frequencyData.length; bin += 1) {
        const db = floatData ? frequencyData[bin] : minDb + (frequencyData[bin] / 255) * (maxDb - minDb);
        binLevels[bin] = binLevel(db, bin);
      }
    }
    const maxHeight = mode === 'dual' ? dualMusicMaxBarHeight : maxBarHeight;
    if (!bands || bands.bins !== binLevels.length || bands.count !== musicBars.length) {
      bands = { bins: binLevels.length, count: musicBars.length, edges: logBandEdges(musicBars.length, binLevels.length) };
      levels = new Array(musicBars.length).fill(0);
    }
    let sum = 0;
    for (let index = 0; index < musicBars.length; index += 1) {
      const target = bandLevel(binLevels, bands.edges[index], bands.edges[index + 1]);
      const previous = levels[index];
      const k = target > previous ? attack : release;
      // 用时间步长换算指数平滑的系数：降帧后响应时间不变，只是写 DOM 的次数减半。
      const eased = still || step === 1 ? k : 1 - Math.pow(1 - k, step);
      const value = still ? target : previous + (target - previous) * eased;
      levels[index] = value;
      sum += value;
      const height = `${Math.max(2, Math.round(value * maxHeight + 2))}px`;
      const bar = musicBars[index];
      if (writtenHeight[index] !== height) { writtenHeight[index] = height; bar.style.height = height; }
      // 双行时透明度交给样式（已播/未播两档），单行沿用按响度变化的透明度。
      if (mode === 'single') {
        const opacity = (0.35 + value * 0.65).toFixed(2);
        if (writtenOpacity[index] !== opacity) { writtenOpacity[index] = opacity; bar.style.opacity = opacity; }
      }
      const hot = value > 0.6;
      if (writtenHot[index] !== hot) { writtenHot[index] = hot; bar.classList.toggle('hot', hot); }
    }
    onAmplitude(musicBars.length ? sum / musicBars.length : 0);
    frameId = requestFrame?.(renderFrame) ?? null;
  }

  function tick() {
    if (!initialized) return;
    if (mode === 'dual') { markPlayed(); renderVoice(); }
    if (!isIdle()) return;
    for (const bar of musicBars) {
      const still = mode === 'dual' || reducedMotion();
      bar.style.height = `${still ? 3 : 2 + random() * idleBarHeight}px`;
      if (mode === 'single') bar.style.opacity = '.35';
      bar.classList.remove('hot');
    }
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    build();
    intervalId = scheduleInterval?.(tick, idleIntervalMs) ?? null;
    return api;
  }

  // 主题切换后按新变体重建；分析器保持不变。
  function refresh() {
    if (!initialized) return;
    const next = getVariant() === 'dual' ? 'dual' : 'single';
    if (next === mode) return;
    clearBars();
    build();
    tick();
  }

  function setAnalyser(nextAnalyser) {
    analyser = nextAnalyser || null;
    floatData = typeof analyser?.getFloatFrequencyData === 'function';
    frequencyData = analyser ? new (floatData ? Float32Array : Uint8Array)(analyser.frequencyBinCount) : null;
    binLevels = analyser ? new Float32Array(analyser.frequencyBinCount) : null;
    if (initialized && analyser && frameId == null) {
      frameId = requestFrame?.(renderFrame) ?? null;
    }
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    if (frameId != null) cancelFrame?.(frameId);
    if (intervalId != null) cancelInterval?.(intervalId);
    frameId = null;
    intervalId = null;
    analyser = null;
    frequencyData = null;
    binLevels = null;
    clearBars();
  }

  const api = Object.freeze({ init, destroy, setAnalyser, refresh });
  return api;
}

// 把 count 根柱子按指数曲线摊到 [1, 0.75·bins] 的频点上（跳过直流点 0，最高约 16kHz）。
// 纯对数会让前二十根柱子挤在最低的两三个频点里（fftSize 256 每点约 172Hz），
// 所以用 k=3 的较缓曲线：低频仍比线性细得多，又不至于一片同步。
export function logBandEdges(count, bins, curve = 3) {
  const low = 1;
  const high = Math.max(low + 1, bins * 0.75);
  const scale = Math.expm1(curve);
  const edges = [];
  for (let index = 0; index <= count; index += 1) edges.push(low + (high - low) * Math.expm1(curve * index / Math.max(1, count)) / scale);
  return edges;
}

// 一个频点的显示电平（0..1）：音乐频谱从低到高大约每倍频程掉 6–9dB，先按倍频程补回 6.5dB，
// 再把 -50..-10dB 映射到 0..1，并用 1.8 次方压低常态、留出峰值，让起伏更分明。
export const SPECTRUM = Object.freeze({ slopeDbPerOctave: 6.5, lowDb: -50, highDb: -10, curve: 1.8 });
export function binLevel(db, bin) {
  if (!Number.isFinite(db)) return 0;
  const compensated = db + SPECTRUM.slopeDbPerOctave * Math.log2(Math.max(1, bin));
  const level = (compensated - SPECTRUM.lowDb) / (SPECTRUM.highDb - SPECTRUM.lowDb);
  return Math.min(1, Math.max(0, level)) ** SPECTRUM.curve;
}

// 一个频段的电平：不足一个频点的低频段在相邻频点间插值，宽频段取最大值。
export function bandLevel(levels, from, to) {
  const last = levels.length - 1;
  if (to - from < 1) {
    const center = Math.min(last, (from + to) / 2);
    const base = Math.floor(center);
    const fraction = center - base;
    return levels[base] * (1 - fraction) + levels[Math.min(last, base + 1)] * fraction;
  }
  let peak = 0;
  for (let bin = Math.floor(from); bin < Math.min(levels.length, Math.ceil(to)); bin += 1) peak = Math.max(peak, levels[bin]);
  return peak;
}
