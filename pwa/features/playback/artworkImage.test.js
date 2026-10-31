import assert from 'node:assert/strict';
import test from 'node:test';

import { APP_ICON, COVER_FALLBACK, applyArtwork } from './artworkImage.js';

function image() {
  return {
    src: '', dataset: {},
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    emit(type) { this.listeners.get(type)?.({ type }); },
  };
}

test('an empty cover renders the placeholder instead of an empty image', () => {
  const img = image();
  applyArtwork(img, '');
  assert.equal(img.src, COVER_FALLBACK);
  applyArtwork(img, null);
  assert.equal(img.src, COVER_FALLBACK);
  assert.equal(img.dataset.coverFallback, '1', '没有封面和加载失败一样标记，主题可据此换成首字方块');
});

test('a cover URL that fails to load falls back once and never loops', () => {
  const img = image();
  applyArtwork(img, 'https://y.gtimg.cn/music/photo_new/x.jpg');
  assert.equal(img.src, 'https://y.gtimg.cn/music/photo_new/x.jpg');
  img.emit('error');
  assert.equal(img.src, COVER_FALLBACK);
  img.emit('error');
  assert.equal(img.src, COVER_FALLBACK);
  assert.equal(img.dataset.coverFallback, '1');
});

test('a later track re-arms the fallback for its own cover', () => {
  const img = image();
  applyArtwork(img, 'https://y.gtimg.cn/music/photo_new/a.jpg');
  img.emit('error');
  assert.equal(img.src, COVER_FALLBACK);
  applyArtwork(img, 'https://y.gtimg.cn/music/photo_new/b.jpg');
  assert.equal(img.src, 'https://y.gtimg.cn/music/photo_new/b.jpg');
  assert.equal(img.dataset.coverFallback, undefined);
  img.emit('error');
  assert.equal(img.src, COVER_FALLBACK);
});

test('the app icon stays distinct from the track placeholder', () => {
  const img = image();
  applyArtwork(img, APP_ICON);
  assert.equal(img.src, APP_ICON);
  img.emit('error');
  assert.equal(img.src, COVER_FALLBACK);
});

test('a missing element is a no-op', () => {
  assert.doesNotThrow(() => applyArtwork(null, 'https://x/a.jpg'));
});

test('an element without addEventListener is still written', () => {
  const img = { src: '', dataset: {} };
  applyArtwork(img, 'https://x/a.jpg');
  assert.equal(img.src, 'https://x/a.jpg');
});
