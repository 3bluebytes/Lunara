import assert from 'node:assert/strict';
import test from 'node:test';

import { STORAGE_KEYS } from '../core/storageKeys.js';
import { DEFAULT_THEME, THEMES, createThemeController, isKnownTheme } from './themeController.js';

function fakeOptions(ids) {
  return ids.map(id => {
    const listeners = new Map();
    return {
      dataset: { themeId: id },
      tabIndex: -1,
      attributes: {},
      focused: false,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
      focus() { this.focused = true; },
      listeners,
    };
  });
}

function harness({ stored = null, options = null } = {}) {
  const values = new Map(stored == null ? [] : [[STORAGE_KEYS.theme, stored]]);
  const root = { dataset: {} };
  const container = {
    options: options || fakeOptions(THEMES),
    innerHTML: '',
    querySelectorAll: () => container.options,
  };
  const changes = [];
  const errors = [];
  const controller = createThemeController({
    root,
    container,
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    onThemeChange: theme => changes.push(theme),
    onError: error => errors.push(error),
  });
  return { controller, root, container, values, changes, errors };
}

test('every registered theme is a known id and the default is timeline', () => {
  assert.deepEqual([...THEMES], ['moonlight', 'modernist', 'nocturne']);
  assert.equal(DEFAULT_THEME, 'nocturne');
  assert.equal(isKnownTheme('organic'), false);
  assert.equal(isKnownTheme('cike'), false);
  // 旧 classic 主题已删除（见 legacy/ui-v2 分支），不再是已知主题。
  for (const removed of ['daylight', 'dusk', 'starry-atelier']) assert.equal(isKnownTheme(removed), false);
  assert.equal(isKnownTheme('sepia'), false);
  assert.equal(isKnownTheme(undefined), false);
});

test('init applies the stored theme, marks one option checked, and renders every theme', () => {
  const { controller, root, container, values, changes } = harness({ stored: 'modernist' });
  controller.init();

  assert.equal(root.dataset.theme, 'modernist');
  assert.equal(changes.at(-1), 'modernist');
  assert.equal(container.innerHTML.includes('data-theme-id="moonlight"'), true, 'all themes are rendered');
  assert.match(container.innerHTML, /role="radio"/);
  for (const option of container.options) {
    const expected = option.dataset.themeId === 'modernist';
    assert.equal(option.getAttribute('aria-checked'), String(expected));
    assert.equal(option.tabIndex, expected ? 0 : -1, 'exactly one option is in the tab order');
  }
  assert.equal(values.get(STORAGE_KEYS.theme), 'modernist');
});

test('missing or unknown stored themes fall back to the default and are normalised', () => {
  const missing = harness();
  missing.controller.init();
  assert.equal(missing.root.dataset.theme, DEFAULT_THEME);
  assert.equal(missing.values.get(STORAGE_KEYS.theme), DEFAULT_THEME);

  const bogus = harness({ stored: 'sepia' });
  bogus.controller.init();
  assert.equal(bogus.root.dataset.theme, DEFAULT_THEME);
  assert.equal(bogus.values.get(STORAGE_KEYS.theme), DEFAULT_THEME, 'a bogus stored value is rewritten');
  assert.equal(bogus.controller.set('also-not-a-theme'), DEFAULT_THEME);

  const removed = harness({ stored: 'daylight' });
  removed.controller.init();
  assert.equal(removed.root.dataset.theme, DEFAULT_THEME, '保存过已删除主题的用户回到默认主题');
  assert.equal(removed.values.get(STORAGE_KEYS.theme), DEFAULT_THEME);
});

test('selecting an option persists it, notifies once, and arrow keys move the selection', () => {
  const { controller, root, container, values, changes } = harness();
  controller.init();
  changes.length = 0;
  const [moonlight, modernist, timeline] = container.options;
  modernist.listeners.get('click')();
  assert.equal(root.dataset.theme, 'modernist');
  assert.equal(values.get(STORAGE_KEYS.theme), 'modernist');
  assert.deepEqual(changes, ['modernist']);
  assert.equal(modernist.getAttribute('aria-checked'), 'true');
  assert.equal(moonlight.getAttribute('aria-checked'), 'false');
  modernist.listeners.get('click')();
  assert.deepEqual(changes, ['modernist']);
  const key = (option, key) => option.listeners.get('keydown')({ key, preventDefault() {} });
  key(modernist, 'ArrowRight');
  assert.equal(root.dataset.theme, 'nocturne');
  assert.equal(timeline.focused, true);
  key(timeline, 'ArrowRight');
  assert.equal(root.dataset.theme, 'moonlight');
  key(moonlight, 'ArrowLeft');
  assert.equal(root.dataset.theme, 'nocturne');
  key(timeline, 'ArrowLeft');
  assert.equal(root.dataset.theme, 'modernist');
});

test('destroy releases option listeners and a failed write is reported not thrown', () => {
  const { controller, container, errors } = harness();
  controller.init();
  controller.destroy();
  for (const option of container.options) {
    assert.equal(option.listeners.size, 0);
  }

  const failing = createThemeController({
    root: { dataset: {} },
    storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } },
    onError: error => errors.push(error.message),
  }).init();
  assert.equal(failing.current(), DEFAULT_THEME);
  assert.deepEqual(errors, ['blocked', 'quota']);
});

test('init notifies once even when the stored theme is the default, so the atmosphere mounts', () => {
  const { controller, changes } = harness({ stored: DEFAULT_THEME });
  controller.init();
  assert.deepEqual(changes, [DEFAULT_THEME]);
  controller.set(DEFAULT_THEME);
  assert.deepEqual(changes, [DEFAULT_THEME], 're-applying the same theme must not remount');
});

test('applying a theme mirrors its manifest variants onto the root', async () => {
  const { getThemeManifest } = await import('../themes/registry.js');
  const { controller, root } = harness({ stored: 'moonlight' });
  controller.init();
  for (const id of THEMES) {
    controller.set(id);
    const { variants } = getThemeManifest(id);
    assert.deepEqual(
      { identity: root.dataset.identity, clock: root.dataset.clock, waveform: root.dataset.waveform, decoration: root.dataset.decoration, layout: root.dataset.layout },
      { ...variants },
      `${id} variants`,
    );
  }
});

test('the dev layout override applies only registered layouts and leaves the theme alone', () => {
  const { controller, root, values } = harness({ stored: 'moonlight' });
  values.set(STORAGE_KEYS.layoutOverride, 'timeline');
  controller.init();
  assert.equal(root.dataset.theme, 'moonlight');
  assert.equal(root.dataset.layout, 'timeline');
  values.set(STORAGE_KEYS.layoutOverride, 'sideways');
  controller.set('modernist');
  assert.equal(root.dataset.layout, 'stage', 'an unknown override falls back to the theme layout');
});
