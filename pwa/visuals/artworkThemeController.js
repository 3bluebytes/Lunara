import { STORAGE_KEYS } from '../core/storageKeys.js';

const SAMPLE_EDGE = 32;
const MAX_SAMPLES = SAMPLE_EDGE * SAMPLE_EDGE;
const HUE_BINS = 24;
/* 辅色必须与主色相拉开距离，权重也不能只是噪点，否则「色彩分布」是编出来的。 */
const SECONDARY_MIN_DISTANCE = 30;
const SECONDARY_MIN_WEIGHT_RATIO = 0.25;
/* 支持随封面变色的主题：月色（明亮夜空）与夜场（压暗压饱和，见 themes/nocturne/tokens.css）。 */
const ARTWORK_THEMES = new Set(['moonlight', 'nocturne']);

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: max === 0 ? 0 : delta / max, value: max };
}

/**
 * Return the artwork palette: a dominant hue plus, when the art really has a
 * second colour family, a secondary hue. Null for art with no usable colour.
 * A single-colour cover yields `{ hue, secondaryHue: null }` — we never
 * fabricate a distribution that the cover does not have.
 */
export function estimateArtworkPalette(imageData, { maxSamples = MAX_SAMPLES } = {}) {
  const data = imageData?.data;
  if (!data || data.length < 4) return null;
  const pixels = Math.floor(data.length / 4);
  const stride = Math.max(1, Math.ceil(pixels / Math.max(1, maxSamples)));
  const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, x: 0, y: 0, samples: 0 }));

  for (let pixel = 0, seen = 0; pixel < pixels && seen < maxSamples; pixel += stride, seen += 1) {
    const offset = pixel * 4;
    const alpha = data[offset + 3] / 255;
    if (alpha < 0.25) continue;
    const { hue, saturation, value } = rgbToHsv(data[offset], data[offset + 1], data[offset + 2]);
    // Ignore near-neutral and extreme pixels so monochrome/white borders do not
    // steer the scene color and nearly black covers do not make it muddy.
    if (saturation < 0.2 || value < 0.1 || value > 0.94) continue;
    const weight = saturation * alpha * Math.min(1, (value - 0.08) / 0.25);
    const bin = bins[Math.floor(hue / 360 * HUE_BINS) % HUE_BINS];
    const radians = hue * Math.PI / 180;
    bin.weight += weight;
    bin.x += Math.cos(radians) * weight;
    bin.y += Math.sin(radians) * weight;
    bin.samples += 1;
  }

  const minSamples = Math.max(1, Math.floor(seenColorThreshold(maxSamples)));
  const ranked = bins.filter(bin => bin.weight > 0 && bin.samples >= minSamples)
    .sort((a, b) => b.weight - a.weight);
  const dominant = ranked[0];
  if (!dominant) return null;
  const hue = binHue(dominant);
  let secondaryHue = null;
  for (const bin of ranked.slice(1)) {
    const candidate = binHue(bin);
    if (bin.weight < dominant.weight * SECONDARY_MIN_WEIGHT_RATIO) break;
    if (hueDistance(candidate, hue) < SECONDARY_MIN_DISTANCE) continue;
    secondaryHue = candidate;
    break;
  }
  return { hue, secondaryHue };
}

/** Return a stable dominant hue, or null for art that has no useful color. */
export function estimateArtworkHue(imageData, options = {}) {
  return estimateArtworkPalette(imageData, options)?.hue ?? null;
}

function binHue(bin) {
  const hue = Math.atan2(bin.y, bin.x) * 180 / Math.PI;
  return Math.round((hue + 360) % 360);
}

function hueDistance(a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}

function seenColorThreshold(maxSamples) {
  return Math.min(8, Math.max(2, Math.floor(maxSamples * 0.003)));
}

function loadArtwork(source, {
  ImageConstructor = globalThis.Image,
  canvasFactory = () => globalThis.document?.createElement?.('canvas'),
  locationHref = globalThis.location?.href || 'http://localhost/',
  timeoutMs = 3500,
} = {}) {
  if (!source || typeof ImageConstructor !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    const image = new ImageConstructor();
    let settled = false;
    const finish = palette => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(palette);
    };
    const timer = setTimeout(() => finish(null), Math.max(1, Number(timeoutMs) || 3500));
    image.onload = () => {
      try {
        const edge = SAMPLE_EDGE;
        const width = Math.max(1, Number(image.naturalWidth || image.width) || 0);
        const height = Math.max(1, Number(image.naturalHeight || image.height) || 0);
        if (!width || !height) return finish(null);
        const scale = Math.min(1, edge / Math.max(width, height));
        const canvas = canvasFactory();
        if (!canvas) return finish(null);
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext?.('2d', { willReadFrequently: true });
        if (!context) return finish(null);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        finish(estimateArtworkPalette(context.getImageData(0, 0, canvas.width, canvas.height)));
      } catch {
        // Canvas security errors (including cross-origin images without CORS)
        // are an expected fallback, not a playback or UI failure.
        finish(null);
      }
    };
    image.onerror = () => finish(null);
    try {
      const artworkUrl = new URL(source, locationHref);
      const pageUrl = new URL(locationHref);
      if (['http:', 'https:'].includes(artworkUrl.protocol) && artworkUrl.origin !== pageUrl.origin) {
        image.crossOrigin = 'anonymous';
      }
      image.src = artworkUrl.href;
    } catch {
      finish(null);
    }
  });
}

/** Load and sample the cover once, returning the full palette (or null). */
export function loadArtworkPalette(source, options = {}) {
  return loadArtwork(source, options);
}

/** Backwards-compatible wrapper: dominant hue only. */
export function loadArtworkHue(source, options = {}) {
  return loadArtwork(source, options).then(palette => palette?.hue ?? null);
}

function currentArtwork(runtime) {
  const queue = Array.isArray(runtime?.queue) ? runtime.queue : [];
  const index = Number.isInteger(runtime?.currentIndex) ? runtime.currentIndex : -1;
  const track = queue[index] || null;
  const source = track?.artwork || track?.pic_url || track?.album?.artwork || track?.album?.picUrl || '';
  return String(source || '').trim();
}

export function createArtworkThemeController({
  root,
  store,
  storage = globalThis.localStorage,
  toggle = null,
  loadPalette = null,
  loadHue = null,
  onPaletteChange = () => {},
} = {}) {
  if (!root?.style || !store?.getState || !store?.subscribe) {
    throw new TypeError('artwork theme root and app store are required');
  }
  // loadHue 是旧的单色相注入点（测试用）；包一层成色板。生产默认走完整色板。
  const paletteLoader = loadPalette
    || (loadHue ? source => Promise.resolve(loadHue(source)).then(hue => (Number.isFinite(hue) ? { hue, secondaryHue: null } : null)) : null)
    || loadArtworkPalette;
  let initialized = false;
  let enabled = false; // 封面变色的持久化偏好（月色与夜场共用），切换其他主题不覆盖它。
  let theme = root.dataset.theme || 'moonlight';
  const supported = () => ARTWORK_THEMES.has(theme);
  const isEnabled = () => enabled && supported();
  function syncToggle() {
    if (!toggle) return;
    toggle.checked = isEnabled();
    toggle.disabled = !supported();
  }
  let sourceKey = '';
  let revision = 0;
  let unsubscribe = null;
  let activePalette = null;

  /**
   * 场景色相的默认值属于主题（styles.css 的 :root { --ambient-hue: var(--theme-hue) }）。
   * 这里只在封面取色可用时内联覆盖它；不可用时移除内联值让主题自动接管，
   * 不再写死一个回落色相，否则主题永远看不到自己的颜色。
   * --ambient-hue-2 同理：只有封面真有第二色族时才内联写入；其余情况移除，
   * 让它回落到 styles.css 里的主题偏移推导，主题性格不被封面冲淡。
   */
  function apply(palette, source = '') {
    const hue = Number.isFinite(palette?.hue) ? ((palette.hue % 360) + 360) % 360 : null;
    let secondary = Number.isFinite(palette?.secondaryHue) ? ((palette.secondaryHue % 360) + 360) % 360 : null;
    if (hue == null || (secondary != null && hueDistance(secondary, hue) < SECONDARY_MIN_DISTANCE)) secondary = null;
    activePalette = hue == null ? null : { hue, secondaryHue: secondary };
    if (hue == null) root.style.removeProperty('--ambient-hue');
    else root.style.setProperty('--ambient-hue', String(hue));
    if (secondary == null) root.style.removeProperty('--ambient-hue-2');
    else root.style.setProperty('--ambient-hue-2', String(secondary));
    root.style.setProperty('--artwork-image', isEnabled() && source ? `url(${JSON.stringify(source)})` : 'none');
    root.dataset.artworkTheme = isEnabled() ? 'on' : 'off';
    root.dataset.artworkHue = hue == null ? 'none' : 'active';
    root.dataset.artworkCover = isEnabled() && source ? 'present' : 'none';
    onPaletteChange({ hue, secondaryHue: secondary, source: isEnabled() ? source : '', enabled: isEnabled() });
  }

  function refresh() {
    const source = currentArtwork(store.getState().runtimeState);
    if (!isEnabled() || !source) {
      sourceKey = source;
      revision += 1;
      apply(null);
      return;
    }
    if (source === sourceKey) return;
    sourceKey = source;
    const requestRevision = ++revision;
    // A new track must not briefly inherit the previous cover's hue. The
    // artwork wash can remain visible while colour sampling is pending.
    apply(null, source);
    Promise.resolve(paletteLoader(source)).then(palette => {
      if (!isEnabled() || requestRevision !== revision || source !== sourceKey) return;
      apply(palette, source);
    }).catch(() => {
      if (isEnabled() && requestRevision === revision && source === sourceKey) apply(null, source);
    });
  }

  function setTheme(next) {
    theme = next;
    sourceKey = '';
    syncToggle();
    // refresh 失效旧请求；即便离开后又回到同一封面，也不能接受上一代迟到采样。
    refresh();
  }

  function setEnabled(next) {
    if (!supported()) return false;
    enabled = Boolean(next);
    storage?.setItem?.(STORAGE_KEYS.artworkTheme, enabled ? '1' : '0');
    syncToggle();
    if (!enabled) {
      revision += 1;
      sourceKey = '';
      apply(null);
      return enabled;
    }
    sourceKey = '';
    refresh();
    return enabled;
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    // 封面取色是可选覆盖，默认关闭：月色基底才是默认外观。
    enabled = storage?.getItem?.(STORAGE_KEYS.artworkTheme) === '1';
    syncToggle();
    toggle?.addEventListener?.('change', onToggle);
    unsubscribe = store.subscribe((next, previous) => {
      if (next.runtimeState !== previous.runtimeState) refresh();
    });
    refresh();
    return api;
  }

  function onToggle() { setEnabled(toggle.checked); }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    revision += 1;
    unsubscribe?.();
    unsubscribe = null;
    toggle?.removeEventListener?.('change', onToggle);
  }

  const api = Object.freeze({ init, destroy, refresh, setTheme, setEnabled, isEnabled });
  return api;
}
