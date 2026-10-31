import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { STORAGE_KEYS } from '../core/storageKeys.js';
import { createThemeController } from '../visuals/themeController.js';
import { THEME_MANIFESTS } from './registry.js';

const source = await readFile(new URL('./boot.js', import.meta.url), 'utf8');

// 在假 document / localStorage 上跑启动脚本，返回它写到根元素上的属性。
function boot(values = {}, { throws = false } = {}) {
  const dataset = {};
  const localStorage = {
    getItem: key => { if (throws) throw new Error('blocked'); return values[key] ?? null; },
  };
  vm.runInNewContext(source, { document: { documentElement: { dataset } }, localStorage });
  return dataset;
}

// 控制器 init 后的根属性：启动脚本必须和它完全一致，否则首帧之后还会再跳一次。
function controllerDataset(values = {}) {
  const dataset = {};
  const map = new Map(Object.entries(values));
  createThemeController({ root: { dataset }, storage: { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) } }).init();
  if (values[STORAGE_KEYS.nocturneMaterial] !== undefined) dataset.material = values[STORAGE_KEYS.nocturneMaterial] === 'glass' ? 'glass' : 'flat';
  return dataset;
}

const cases = [
  {},
  { [STORAGE_KEYS.theme]: 'moonlight' },
  { [STORAGE_KEYS.theme]: 'cike' },
  { [STORAGE_KEYS.theme]: 'organic' },
  { [STORAGE_KEYS.theme]: 'modernist', [STORAGE_KEYS.modernistBase]: 'indigo' },
  { [STORAGE_KEYS.theme]: 'modernist' },
  { [STORAGE_KEYS.theme]: 'nocturne', [STORAGE_KEYS.nocturneMaterial]: 'glass' },
  { [STORAGE_KEYS.theme]: 'moonlight', [STORAGE_KEYS.layoutOverride]: 'timeline' },
  { [STORAGE_KEYS.theme]: 'moonlight', [STORAGE_KEYS.layoutOverride]: 'bogus' },
];

for (const values of cases) {
  test(`boot script paints the same root attributes the controller settles on: ${JSON.stringify(values)}`, () => {
    const booted = boot(values);
    assert.equal(booted.themeBooting, '');
    delete booted.themeBooting;
    const expected = controllerDataset(values);
    if (!('material' in expected)) expected.material = 'flat';
    assert.deepEqual(booted, expected);
  });
}

test('boot variants mirror every manifest so a new theme cannot drift', () => {
  for (const manifest of THEME_MANIFESTS) {
    const booted = boot({ [STORAGE_KEYS.theme]: manifest.id });
    for (const [key, value] of Object.entries(manifest.variants)) assert.equal(booted[key], value, `${manifest.id}.${key}`);
  }
});

test('blocked storage still boots the default theme instead of throwing', () => {
  const booted = boot({}, { throws: true });
  assert.equal(booted.theme, 'nocturne');
  assert.equal(booted.layout, 'timeline');
});

test('the shell runs the boot script before any stylesheet and app.js clears the booting flag', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const bootAt = html.indexOf('<script src="/themes/boot.js');
  assert.ok(bootAt > 0, 'boot script linked');
  assert.ok(bootAt < html.indexOf('rel="stylesheet"'), 'boot runs before the first stylesheet');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-theme-booting\][^{]*\{\s*transition: none !important;/);
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /delete document\.documentElement\.dataset\.themeBooting/);
});
