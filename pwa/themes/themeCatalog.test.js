import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { STORAGE_KEYS } from '../core/storageKeys.js';
import { createThemeController, DEFAULT_THEME, isKnownTheme } from '../visuals/themeController.js';
import { THEME_MANIFESTS, getThemeManifest } from './registry.js';

function restore(stored) {
  const values = new Map([[STORAGE_KEYS.theme, stored], [STORAGE_KEYS.nocturneMaterial, 'glass'], [STORAGE_KEYS.modernistBase, 'indigo']]);
  const root = { dataset: {} }, changes = [];
  const controller = createThemeController({ root, storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }, onThemeChange: id => changes.push(id) }).init();
  return { controller, root, values, changes };
}

test('only the three consolidated themes are offered and timeline is default', async () => {
  assert.deepEqual(THEME_MANIFESTS.map(({ id, name }) => [id, name]), [['moonlight', '月色'], ['modernist', '素色'], ['nocturne', '时间线']]);
  assert.equal(DEFAULT_THEME, 'nocturne');
  assert.equal(isKnownTheme('cike'), false);
  assert.equal(isKnownTheme('organic'), false);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<html[^>]*data-theme="nocturne"[^>]*data-layout="timeline"/);
  assert.doesNotMatch(html, /href="\/themes\/(cike|organic)\//);
});

for (const [stored, expected] of [[null, 'nocturne'], ['organic', 'nocturne'], ['unknown', 'nocturne'], ['cike', 'moonlight'], ['moonlight', 'moonlight'], ['modernist', 'modernist'], ['nocturne', 'nocturne']]) {
  test(`restoring ${stored} normalizes to ${expected} without touching independent preferences`, () => {
    const { controller, root, values, changes } = restore(stored);
    assert.equal(root.dataset.theme, expected);
    assert.equal(values.get(STORAGE_KEYS.theme), expected);
    assert.deepEqual(changes, [expected]);
    assert.equal(values.get(STORAGE_KEYS.nocturneMaterial), 'glass');
    assert.equal(values.get(STORAGE_KEYS.modernistBase), 'indigo');
    controller.set(expected);
    assert.deepEqual(changes, [expected], 'canonical reapply does not remount the atmosphere');
  });
}

test('legacy set also normalizes the merged theme and uses the existing dual waveform', () => {
  const { controller, root, values } = restore('modernist');
  assert.equal(controller.set('cike'), 'moonlight');
  assert.equal(values.get(STORAGE_KEYS.theme), 'moonlight');
  assert.equal(root.dataset.waveform, 'dual');
  assert.deepEqual({ ...getThemeManifest('moonlight').variants }, { identity: 'dot', clock: 'hidden', waveform: 'dual', decoration: 'on', layout: 'stage' });
});

test('moonlight alone restores the old rotating radio logo with a reduced-motion fallback', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('./moonlight/overrides.css', import.meta.url), 'utf8');
  assert.match(html, /class="sb-logo-radio"[^>]*viewBox="0 0 40 40"/);
  for (const arc of ['a1', 'a2', 'a3']) assert.match(html, new RegExp(`class="logo-arc ${arc}"`));
  assert.match(css, /:root\[data-theme="moonlight"\] \.sb-logo \.sb-logo-orbit\s*\{\s*display: none;/);
  assert.match(css, /animation: arcSpin 16s linear infinite/);
  assert.match(css, /animation-duration: 24s; animation-direction: reverse/);
  assert.match(css, /animation-duration: 11s/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});
