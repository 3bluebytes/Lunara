import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppState } from '../core/appState.js';
import { STORAGE_KEYS } from '../core/storageKeys.js';
import { createArtworkThemeController, estimateArtworkHue, estimateArtworkPalette, loadArtworkHue, loadArtworkPalette } from './artworkThemeController.js';

function pixels(color, count = 16) {
  const data = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index += 1) data.set(color, index * 4);
  return { data, width: count, height: 1 };
}

/* 采样链有多个微任务跳点，用宏任务冲刷比数 Promise.resolve 稳妥。 */
const flush = () => new Promise(resolve => setImmediate(resolve));

function artworkState(source = '/art/red.jpg') {
  return {
    activeListeningSessionId: 'conversation:primary',
    currentIndex: 0,
    queue: [{ queueItemId: 'item-1', songId: 'song-1', artwork: source }],
  };
}

function storage(entries = []) {
  const map = new Map(entries);
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map };
}

test('palette extraction finds a real secondary colour family but never fabricates one', () => {
  // 一半暖红、一半冷蓝的封面：必须产出距离 ≥ 30° 的辅色
  const data = new Uint8ClampedArray(64 * 4);
  for (let index = 0; index < 32; index += 1) data.set([220, 40, 40, 255], index * 4);
  for (let index = 32; index < 64; index += 1) data.set([40, 60, 220, 255], index * 4);
  const palette = estimateArtworkPalette({ data, width: 64, height: 1 });
  assert.ok(palette, 'two-family art yields a palette');
  assert.ok(palette.secondaryHue !== null, 'two-family art yields a secondary hue');
  const distance = Math.abs(((palette.hue - palette.secondaryHue) % 360 + 540) % 360 - 180);
  assert.ok(distance >= 30, `secondary hue must be a distinct family, got ${distance}°`);

  // 纯色封面：主色不变，但不编造辅色
  const flat = estimateArtworkPalette(pixels([220, 30, 30, 255]));
  assert.ok(flat && flat.secondaryHue === null, 'single-colour art has no secondary hue');
  assert.equal(estimateArtworkHue(pixels([220, 30, 30, 255])), flat.hue, 'hue wrapper matches the palette');

  // 无可用色：整体不可用，行为与旧单色相版一致
  assert.equal(estimateArtworkPalette(pixels([255, 255, 255, 255])), null);
  assert.equal(estimateArtworkPalette(pixels([4, 2, 2, 255])), null);
});

test('loadArtworkPalette samples once and loadArtworkHue stays a hue-only wrapper', async () => {
  class FakeImage {
    constructor() { this.naturalWidth = 64; this.naturalHeight = 64; }
    set src(_value) { queueMicrotask(() => this.onload?.()); }
  }
  const twoTone = new Uint8ClampedArray(64 * 4);
  for (let index = 0; index < 32; index += 1) twoTone.set([220, 40, 40, 255], index * 4);
  for (let index = 32; index < 64; index += 1) twoTone.set([40, 60, 220, 255], index * 4);
  const canvasFactory = () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: twoTone, width: 64, height: 1 }) }),
  });
  const palette = await loadArtworkPalette('/art/duo.jpg', { ImageConstructor: FakeImage, canvasFactory });
  assert.ok(palette && palette.secondaryHue !== null);
  const hue = await loadArtworkHue('/art/duo.jpg', { ImageConstructor: FakeImage, canvasFactory });
  assert.equal(hue, palette.hue, 'the hue wrapper reads the same sampling pass');
});

test('dominant hue handles representative art and rejects unusable colors', () => {
  const redHue = estimateArtworkHue(pixels([220, 30, 30, 255]));
  assert.ok(redHue !== null && (redHue < 8 || redHue > 352));
  assert.equal(estimateArtworkHue(pixels([4, 2, 2, 255])), null, 'near-black art should use fallback');
  assert.equal(estimateArtworkHue(pixels([255, 255, 255, 255])), null, 'white art should use fallback');
  assert.equal(estimateArtworkHue(pixels([128, 125, 124, 255])), null, 'low-saturation art should use fallback');
  assert.equal(estimateArtworkHue(pixels([235, 20, 20, 0])), null, 'transparent art should use fallback');
});

test('artwork sampling is bounded and cross-origin canvas restrictions fall back cleanly', async () => {
  let imageInstance;
  let drawnSize = null;
  class FakeImage {
    constructor() { imageInstance = this; this.naturalWidth = 4096; this.naturalHeight = 2048; }
    set src(value) { this.source = value; queueMicrotask(() => this.onload?.()); }
  }
  const hue = await loadArtworkHue('https://covers.example.test/album.jpg', {
    ImageConstructor: FakeImage,
    locationHref: 'https://lunara.example.test/app',
    canvasFactory: () => ({
      set width(value) { this._width = value; },
      get width() { return this._width; },
      set height(value) { this._height = value; },
      get height() { return this._height; },
      getContext: () => ({
        drawImage(_image, _x, _y, width, height) { drawnSize = [width, height]; },
        getImageData: () => pixels([220, 35, 35, 255]),
      }),
    }),
  });
  assert.ok(hue !== null);
  assert.equal(imageInstance.crossOrigin, 'anonymous');
  assert.equal(imageInstance.source, 'https://covers.example.test/album.jpg');
  assert.ok(drawnSize[0] <= 32 && drawnSize[1] <= 32);

  class RestrictedImage extends FakeImage {}
  const restricted = await loadArtworkHue('https://private.example.test/art.jpg', {
    ImageConstructor: RestrictedImage,
    locationHref: 'https://lunara.example.test/app',
    canvasFactory: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {}, getImageData() { throw Object.assign(new Error('tainted'), { name: 'SecurityError' }); } }),
    }),
  });
  assert.equal(imageInstance.crossOrigin, 'anonymous');
  assert.equal(restricted, null);
  assert.equal(await loadArtworkHue(''), null, 'missing artwork should fall back without creating an image');

  class CorruptImage {
    constructor() { queueMicrotask(() => this.onerror?.()); }
    set src(_value) {}
  }
  assert.equal(await loadArtworkHue('/broken.jpg', { ImageConstructor: CorruptImage }), null);
});

test('artwork colour is an opt-in override that yields to the theme base', async () => {
  const first = artworkState('/art/first.jpg');
  const store = createAppState({ runtimeState: first });
  const values = storage();
  const vars = new Map();
  const root = {
    style: {
      setProperty: (key, value) => vars.set(key, value),
      removeProperty: key => vars.delete(key),
    },
    dataset: {},
  };
  const listeners = new Map();
  const toggle = {
    checked: false,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const requested = [];
  const palettes = [];
  const controller = createArtworkThemeController({
    root, store, storage: values, toggle,
    loadHue: async source => { requested.push(source); return source.includes('first') ? 205 : null; },
    onPaletteChange: palette => palettes.push(palette),
  }).init();
  await flush();
  // 默认关闭：不采样、不覆盖主题基底。
  assert.deepEqual(requested, []);
  assert.equal(root.dataset.artworkTheme, 'off');
  assert.equal(root.dataset.artworkHue, 'none', 'a disabled colour override has no sampled hue');
  assert.equal(root.dataset.artworkCover, 'none');
  assert.equal(vars.has('--ambient-hue'), false, 'default keeps the theme base hue');
  assert.equal(vars.get('--artwork-image'), 'none');
  assert.equal(toggle.checked, false);

  // 开启：内联覆盖为封面色。
  toggle.checked = true;
  listeners.get('change')();
  await flush();
  assert.deepEqual(requested, ['/art/first.jpg']);
  assert.equal(vars.get('--ambient-hue'), '205');
  assert.equal(vars.get('--artwork-image'), 'url("/art/first.jpg")');
  assert.equal(root.dataset.artworkTheme, 'on');
  assert.equal(root.dataset.artworkHue, 'active', 'surfaces can react only after a usable hue is sampled');
  assert.equal(root.dataset.artworkCover, 'present');
  assert.equal(values.getItem(STORAGE_KEYS.artworkTheme), '1');

  store.update({ runtimeState: artworkState('/art/first.jpg') });
  await flush();
  assert.equal(requested.length, 1, 'same artwork is not sampled repeatedly');

  // 再关闭：移除内联覆盖，月色基底恢复，且不再采样。
  toggle.checked = false;
  listeners.get('change')();
  assert.equal(root.dataset.artworkTheme, 'off');
  assert.equal(root.dataset.artworkHue, 'none');
  assert.equal(root.dataset.artworkCover, 'none');
  assert.equal(vars.has('--ambient-hue'), false, 'turning off restores the theme base');
  assert.equal(vars.get('--artwork-image'), 'none');
  assert.equal(values.getItem(STORAGE_KEYS.artworkTheme), '0');
  store.update({ runtimeState: artworkState('/art/second.jpg') });
  await flush();
  assert.equal(requested.length, 1, 'disabled theme ignores later tracks');

  // 再开启：新封面不可用色时移除内联覆盖，但仍给出视觉色场。
  toggle.checked = true;
  listeners.get('change')();
  await flush();
  assert.deepEqual(requested, ['/art/first.jpg', '/art/second.jpg']);
  assert.equal(vars.has('--ambient-hue'), false, 'unusable artwork restores the theme base hue');
  assert.equal(root.dataset.artworkHue, 'none', 'unusable artwork must not tint theme surfaces');
  assert.equal(root.dataset.artworkCover, 'present', 'the fallback can display a remote cover even when canvas sampling fails');
  assert.equal(vars.get('--artwork-image'), 'url("/art/second.jpg")', 'cross-origin or neutral art still supplies the visual color field');
  assert.equal(values.getItem(STORAGE_KEYS.artworkTheme), '1');
  assert.equal(palettes.at(-1).source, '/art/second.jpg');
  controller.destroy();
  assert.equal(listeners.has('change'), false);
});

test('switching tracks clears the previous cover hue while the next cover loads', async () => {
  const store = createAppState({ runtimeState: artworkState('/art/first.jpg') });
  const vars = new Map();
  const root = {
    style: { setProperty: (key, value) => vars.set(key, value), removeProperty: key => vars.delete(key) },
    dataset: {},
  };
  let finishSecond;
  createArtworkThemeController({
    root, store,
    storage: storage([[STORAGE_KEYS.artworkTheme, '1']]),
    loadHue: source => source.includes('first') ? Promise.resolve(20) : new Promise(resolve => { finishSecond = resolve; }),
  }).init();
  await flush();
  assert.equal(vars.get('--ambient-hue'), '20');

  store.update({ runtimeState: artworkState('/art/second.jpg') });
  assert.equal(root.dataset.artworkHue, 'none', 'the old track colour must not label the next cover');
  assert.equal(root.dataset.artworkCover, 'present');
  assert.equal(vars.has('--ambient-hue'), false);
  assert.equal(vars.get('--artwork-image'), 'url("/art/second.jpg")');

  finishSecond(145);
  await flush();
  assert.equal(vars.get('--ambient-hue'), '145');
  assert.equal(root.dataset.artworkHue, 'active');
});

test('controller publishes the secondary hue only when the cover really has one', async () => {
  const store = createAppState({ runtimeState: artworkState('/art/duo.jpg') });
  const vars = new Map();
  const root = {
    style: { setProperty: (key, value) => vars.set(key, value), removeProperty: key => vars.delete(key) },
    dataset: {},
  };
  const palettes = {
    '/art/duo.jpg': { hue: 20, secondaryHue: 210 },
    '/art/flat.jpg': { hue: 145, secondaryHue: null },
    '/art/near.jpg': { hue: 100, secondaryHue: 112 },   // 距离太近，不是独立色族
  };
  const controller = createArtworkThemeController({
    root, store,
    storage: storage([[STORAGE_KEYS.artworkTheme, '1']]),
    loadPalette: async source => palettes[source] ?? null,
  }).init();
  await flush();
  assert.equal(vars.get('--ambient-hue'), '20');
  assert.equal(vars.get('--ambient-hue-2'), '210', 'a real second colour family is published');

  store.update({ runtimeState: artworkState('/art/flat.jpg') });
  await flush();
  assert.equal(vars.get('--ambient-hue'), '145');
  assert.equal(vars.has('--ambient-hue-2'), false, 'a flat cover removes the override so the theme offset takes over');

  store.update({ runtimeState: artworkState('/art/near.jpg') });
  await flush();
  assert.equal(vars.get('--ambient-hue'), '100');
  assert.equal(vars.has('--ambient-hue-2'), false, 'a near-identical secondary is dropped');
  controller.destroy();
});

test('stored artwork-colour preference of 1 re-enables sampling on init', async () => {
  const store = createAppState({ runtimeState: artworkState('/art/first.jpg') });
  const values = storage([[STORAGE_KEYS.artworkTheme, '1']]);
  const vars = new Map();
  const root = {
    style: { setProperty: (key, value) => vars.set(key, value), removeProperty: key => vars.delete(key) },
    dataset: {},
  };
  const requested = [];
  const controller = createArtworkThemeController({
    root, store, storage: values,
    loadHue: async source => { requested.push(source); return 260; },
  }).init();
  await flush();
  assert.deepEqual(requested, ['/art/first.jpg']);
  assert.equal(vars.get('--ambient-hue'), '260');
  assert.equal(root.dataset.artworkTheme, 'on');
  assert.equal(root.dataset.artworkHue, 'active');
  controller.destroy();
});
