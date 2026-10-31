// audioGraph.js — Web Audio graph manager for independent voice/music outputs.

/**
 * 元素当前源是否与应用同源。空源或拿不到应用地址时返回 true（保持旧行为）。
 *
 * 为什么重要：浏览器把跨源媒体的 MediaElementAudioSourceNode 输出成静音（防止采样
 * 他人音源），而元素本身照常前进——那就是「进度条在走、一点声音没有」。
 */
export function isSameOriginMedia(url, locationHref) {
  const value = String(url || '').trim();
  if (!value) return true;
  const base = String(locationHref || '').trim();
  if (!base) return true;
  try {
    return new URL(value, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export function createAudioGraphController({ getAudioContext, musicAudio, locationHref = globalThis.location?.href || '' } = {}) {
  let audioCtx = null;
  let currentAnalyser = null;
  const nodes = new WeakMap();

  function getCtx() {
    if (!audioCtx) audioCtx = getAudioContext?.() || null;
    return audioCtx;
  }

  function ensureNodes(el) {
    const ctx = getCtx();
    if (!ctx || !el) return null;
    const existing = nodes.get(el);
    if (existing) return existing;

    // Attaching a source transfers the element's output to Web Audio forever.
    // On first run the browser can allow media playback while this context is
    // still gesture-locked. Keep native output until the graph can really run.
    if (ctx.state && ctx.state !== 'running') {
      if (ctx.state === 'suspended') ctx.resume?.()?.catch?.(() => {});
      return null;
    }

    // 跨源元素不能接进图：接了就只出静音，而且不可撤销。宁可没波形也必须出声。
    if (!isSameOriginMedia(el.currentSrc || el.src, locationHref)) return null;

    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    source.connect(gain);
    gain.connect(ctx.destination);
    gain.connect(analyser);

    const node = { source, gain, analyser };
    nodes.set(el, node);
    return node;
  }

  function setupAnalyser(el) {
    const node = ensureNodes(el);
    if (!node) return null;
    currentAnalyser = node.analyser;
    return node;
  }

  function setMusicGain(value, durationMs = 80) {
    const ctx = getCtx();
    const node = musicAudio ? ensureNodes(musicAudio) : null;
    if (!ctx || !node?.gain?.gain) return false;

    const param = node.gain.gain;
    const target = Math.max(0, Math.min(1, Number(value)));
    const startAt = Number(ctx.currentTime) || 0;
    const duration = Math.max(0, Number(durationMs) || 0) / 1000;
    if (duration > 0 && typeof param.linearRampToValueAtTime === 'function') {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(startAt);
      else {
        if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(startAt);
        if (typeof param.setValueAtTime === 'function') param.setValueAtTime(Number(param.value) || 0, startAt);
      }
      param.linearRampToValueAtTime(target, startAt + duration);
    } else if (duration > 0 && typeof param.setTargetAtTime === 'function') {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(startAt);
      else if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(startAt);
      param.setTargetAtTime(target, startAt, Math.max(0.005, duration / 4));
    } else if (typeof param.setValueAtTime === 'function') {
      if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(startAt);
      param.setValueAtTime(target, startAt);
    } else {
      if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(startAt);
      param.value = target;
    }
    return true;
  }

  return {
    setupAnalyser,
    setMusicGain,
    get audioCtx() { return audioCtx; },
    get analyser() { return currentAnalyser; },
    getAnalyserFor(el) { return nodes.get(el)?.analyser || null; },
  };
}
