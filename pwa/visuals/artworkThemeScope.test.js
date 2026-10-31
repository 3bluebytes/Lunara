import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAppState } from '../core/appState.js';
import { STORAGE_KEYS } from '../core/storageKeys.js';
import { createArtworkThemeController } from './artworkThemeController.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(theme, loadPalette = async () => ({ hue: 12, secondaryHue: 210 })) {
  const properties = new Map();
  const saved = new Map([[STORAGE_KEYS.artworkTheme, '1']]);
  const requests = [];
  const root = {
    dataset: { theme },
    style: { setProperty: (k, v) => properties.set(k, v), removeProperty: k => properties.delete(k) },
  };
  const toggle = { checked: false, disabled: false, addEventListener() {}, removeEventListener() {} };
  const store = createAppState({ runtimeState: { currentIndex: 0, queue: [{ artwork: '/red.png' }] } });
  const controller = createArtworkThemeController({
    root, store, toggle,
    storage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) },
    loadPalette: source => { requests.push(source); return loadPalette(source); },
  }).init();
  const switchTo = theme => { root.dataset.theme = theme; controller.setTheme(theme); };
  return { controller, root, store, toggle, properties, saved, requests, switchTo };
}

for (const theme of ['cike', 'modernist', 'organic']) {
  test(`${theme} startup does not sample or apply a saved artwork preference`, async () => {
    const f = fixture(theme);
    await flush();
    assert.deepEqual(f.requests, []);
    assert.equal(f.controller.isEnabled(), false);
    assert.equal(f.toggle.disabled, true);
    assert.equal(f.toggle.checked, false);
    assert.equal(f.root.dataset.artworkTheme, 'off');
    assert.equal(f.properties.get('--artwork-image'), 'none');
    assert.equal(f.properties.has('--ambient-hue'), false);
    f.controller.setEnabled(true);
    await flush();
    assert.deepEqual(f.requests, [], 'unsupported themes cannot enable sampling');
    assert.equal(f.saved.get(STORAGE_KEYS.artworkTheme), '1');
    f.controller.destroy();
  });
}

test('switching themes clears cover overrides but preserves moonlight preference', async () => {
  const f = fixture('moonlight');
  await flush();
  assert.equal(f.properties.get('--ambient-hue'), '12');
  assert.equal(f.properties.get('--ambient-hue-2'), '210');
  for (const theme of ['cike', 'modernist', 'organic']) {
    f.switchTo(theme);
    assert.equal(f.properties.has('--ambient-hue'), false);
    assert.equal(f.properties.has('--ambient-hue-2'), false);
    assert.equal(f.properties.get('--artwork-image'), 'none');
    assert.equal(f.root.dataset.artworkCover, 'none');
  }
  f.store.update({ runtimeState: { currentIndex: 0, queue: [{ artwork: '/blue.png' }] } });
  await flush();
  assert.deepEqual(f.requests, ['/red.png']);
  assert.equal(f.saved.get(STORAGE_KEYS.artworkTheme), '1');
  f.switchTo('moonlight');
  await flush();
  assert.deepEqual(f.requests, ['/red.png', '/blue.png']);
  assert.equal(f.toggle.checked, true);
  assert.equal(f.toggle.disabled, false);
  assert.equal(f.properties.get('--artwork-image'), 'url("/blue.png")');
  f.controller.setEnabled(false);
  f.switchTo('cike');
  f.switchTo('moonlight');
  await flush();
  assert.equal(f.controller.isEnabled(), false, 'an explicitly disabled preference stays disabled');
  assert.equal(f.requests.length, 2);
  f.controller.destroy();
});

test('late samples cannot recolour another theme or overwrite a newer moonlight sample', async () => {
  const pending = [];
  const f = fixture('moonlight', () => new Promise(resolve => pending.push(resolve)));
  f.switchTo('cike');
  f.switchTo('moonlight');
  assert.equal(pending.length, 2);
  pending[0]({ hue: 12 });
  await flush();
  assert.equal(f.properties.has('--ambient-hue'), false);
  pending[1]({ hue: 210 });
  await flush();
  assert.equal(f.properties.get('--ambient-hue'), '210');
  f.switchTo('organic');
  assert.equal(f.root.dataset.artworkTheme, 'off');
  f.controller.destroy();
});

test('moonlight restores its sky on body and only moonlight exposes colour controls', async () => {
  const css = await readFile(new URL('../themes/moonlight/overrides.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-theme="moonlight"\] body\s*\{\s*background:\s*var\(--bg-stage\);\s*\}/);
  assert.match(css, /:root\[data-theme="moonlight"\] #app\s*\{\s*background:\s*transparent;\s*\}/);
  assert.match(css, /:root\[data-theme="moonlight"\] \.panel-door\s*\{\s*--panel-door-fill:\s*transparent;\s*\}/);
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /onThemeChange: theme => \{\s*artworkThemeController\.setTheme\(theme\);\s*syncArtworkThemeQuick\(\);/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="artwork-theme-controls"/);
});

test('夜场也随封面变色；切到不支持的主题清掉，无封面退回主题暖灰', async () => {
  const f = fixture('nocturne');
  await flush();
  assert.deepEqual(f.requests, ['/red.png']);
  assert.equal(f.toggle.disabled, false);
  assert.equal(f.properties.get('--ambient-hue'), '12');
  assert.equal(f.root.dataset.artworkHue, 'active');
  f.store.update({ runtimeState: { currentIndex: 0, queue: [{ title: '无封面' }] } });
  await flush();
  assert.equal(f.properties.has('--ambient-hue'), false, '没有封面不保留上一首的颜色');
  assert.equal(f.root.dataset.artworkHue, 'none');
  f.switchTo('cike');
  assert.equal(f.toggle.disabled, true);
  f.controller.destroy();
});

test('夜场取色态只换色相，饱和与亮度压在夜色范围内', async () => {
  const css = await readFile(new URL('../themes/nocturne/overrides.css', import.meta.url), 'utf8');
  const block = css.match(/:root\[data-theme="nocturne"\]\[data-artwork-hue="active"\]\s*\{([^}]*)\}/)?.[1] || '';
  const tones = [...block.matchAll(/hsl\(var\(--ambient-hue\)\s+(\d+)%\s+(\d+)%/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.ok(tones.length >= 2, 'cover-coloured stage is defined');
  for (const [s, l] of tones) {
    assert.ok(s <= 40, `saturation ${s}% ≤ 40%`);
    assert.ok(l >= 8 && l <= 27, `lightness ${l}% within 8–27%`);
  }
});
