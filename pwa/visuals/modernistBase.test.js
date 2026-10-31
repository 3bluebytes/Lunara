import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createThemeController } from './themeController.js';
import { STORAGE_KEYS } from '../core/storageKeys.js';

function fixture(base, theme = 'modernist') {
  const values = new Map([[STORAGE_KEYS.theme, theme]]);
  if (base != null) values.set('lunara.modernistBase', base);
  const root = { dataset: {} }, changes = [], errors = [];
  const options = ['paper', 'indigo'].map(value => {
    const listeners = new Map(), attrs = new Map();
    return { dataset: { modernistBase: value }, tabIndex: -1,
      setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key),
      addEventListener: (key, fn) => listeners.set(key, fn),
      removeEventListener: (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); },
      focus() { this.focused = true; }, listeners };
  });
  const container = { hidden: true, querySelectorAll: () => options };
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const controller = createThemeController({ root, storage, modernistBaseContainer: container,
    onThemeChange: id => changes.push(id), onError: e => errors.push(e) }).init();
  return { controller, root, container, options, values, changes, errors };
}

test('modernist defaults to paper and restores indigo with one checked choice', () => {
  const f = fixture();
  assert.equal(STORAGE_KEYS.modernistBase, 'lunara.modernistBase');
  assert.equal(f.root.dataset.modernistBase, 'paper');
  assert.equal(f.container.hidden, false);
  assert.equal(f.controller.modernistBase(), 'paper');
  assert.deepEqual(f.options.map(o => o.getAttribute('aria-checked')), ['true', 'false']);
  const dark = fixture('indigo');
  assert.equal(dark.root.dataset.modernistBase, 'indigo');
  assert.deepEqual(dark.options.map(o => o.tabIndex), [-1, 0]);
});

test('base click persists independently and theme switches retain it without extra theme events', () => {
  const f = fixture();
  f.changes.length = 0;
  f.options[1].listeners.get('click')();
  assert.equal(f.root.dataset.modernistBase, 'indigo');
  assert.equal(f.values.get(STORAGE_KEYS.modernistBase), 'indigo');
  assert.equal(f.values.get(STORAGE_KEYS.theme), 'modernist');
  assert.deepEqual(f.changes, [], 'base change must not remount a theme or touch playback wiring');
  for (const id of ['moonlight', 'nocturne']) {
    f.controller.set(id);
    assert.equal(f.container.hidden, true);
    assert.equal(f.root.dataset.theme, id);
  }
  f.controller.set('modernist');
  assert.equal(f.container.hidden, false);
  assert.equal(f.controller.modernistBase(), 'indigo');
  f.controller.destroy();
  assert.ok(f.options.every(o => o.listeners.size === 0));
});

test('base keyboard supports arrows, wrapping, Home and End with roving focus', () => {
  const f = fixture();
  let prevented = 0;
  const key = (index, key) => f.options[index].listeners.get('keydown')({ key, preventDefault() { prevented++; } });
  key(0, 'ArrowRight');
  assert.equal(f.controller.modernistBase(), 'indigo');
  assert.equal(f.options[1].focused, true);
  key(1, 'ArrowDown');
  assert.equal(f.controller.modernistBase(), 'paper');
  key(0, 'End'); assert.equal(f.controller.modernistBase(), 'indigo');
  key(1, 'Home'); assert.equal(f.controller.modernistBase(), 'paper');
  key(0, 'ArrowLeft'); assert.equal(f.controller.modernistBase(), 'indigo');
  assert.equal(prevented, 5);
});

test('unknown values use paper; other themes do not expose the chooser', () => {
  const f = fixture('sepia');
  assert.equal(f.controller.modernistBase(), 'paper');
  f.controller.setModernistBase('indigo');
  f.controller.setModernistBase('not-a-base');
  assert.equal(f.root.dataset.modernistBase, 'paper');
  assert.equal(f.values.get(STORAGE_KEYS.modernistBase), 'paper');
  const other = fixture('indigo', 'moonlight');
  assert.equal(other.container.hidden, true);
  other.controller.set('modernist');
  assert.equal(other.controller.modernistBase(), 'indigo');
});

test('unavailable storage does not break base selection and errors use the callback', () => {
  const errors = [], root = { dataset: {} };
  const c = createThemeController({ root,
    storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } },
    onError: error => errors.push(error.message) }).init();
  c.set('modernist');
  c.setModernistBase('indigo');
  assert.equal(c.modernistBase(), 'indigo');
  assert.equal(root.dataset.modernistBase, 'indigo');
  assert.ok(errors.includes('blocked') && errors.includes('quota'));
});

test('base CSS stays scoped to modernist and paper keeps its original colours', async () => {
  const css = await readFile(new URL('../themes/modernist/tokens.css', import.meta.url), 'utf8');
  assert.match(css, /--bg-page: #f2f0eb/);
  assert.match(css, /--accent: #d42a1c/);
  const skin = await readFile(new URL('../themes/modernist/overrides.css', import.meta.url), 'utf8');
  assert.match(skin, /:root\[data-theme="modernist"\]\[data-modernist-base="indigo"\]\s*\{/);
  const dark = skin.slice(skin.indexOf('[data-modernist-base="indigo"]'));
  assert.match(dark, /--bg-page: #24334e/);
  assert.match(dark, /--accent: #f0d889/);
  assert.doesNotMatch(dark, /--font-|--radius-|--size-/);
});

test('indigo literal palette meets contrast requirements on its input, panel and player surfaces', async () => {
  const css = await readFile(new URL('../themes/modernist/overrides.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('[data-modernist-base="indigo"]')).split('}')[0];
  const values = new Map([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/g)].map(m => [m[1], m[2]]));
  const luminance = key => {
    assert.ok(values.has(key), `missing ${key}`);
    const c = values.get(key).slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
      .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  };
  for (const surface of ['--bg-page', '--bg-raised', '--bg-input']) {
    for (const ink of ['--text', '--text-2', '--text-3', '--text-4', '--t-placeholder']) {
      const a = luminance(ink), b = luminance(surface);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${ink} on ${surface}`);
    }
  }
  for (const [ink, surface] of [['--text-on-accent', '--accent'], ['--player-control-ink', '--player-control'], ['--accent', '--bg-page']]) {
    const a = luminance(ink), b = luminance(surface);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${ink} on ${surface}`);
  }
});

test('appearance markup exposes a labelled native-button radio group and independent storage wiring', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(html, /<fieldset id="modernist-base-setting"[^>]* hidden>/);
  assert.match(html, /role="radiogroup" aria-labelledby="modernist-base-label"/);
  assert.match(html, /role="radio" data-modernist-base="paper" aria-checked="true" tabindex="0"/);
  assert.match(html, /role="radio" data-modernist-base="indigo" aria-checked="false" tabindex="-1"/);
  assert.match(app, /modernistBaseContainer: \$\('#modernist-base-setting'\)/);
});
