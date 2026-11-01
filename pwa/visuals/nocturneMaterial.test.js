import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { STORAGE_KEYS } from '../core/storageKeys.js';
import { createNocturneMaterialController } from './nocturneMaterial.js';

function fixture(stored) {
  const values = new Map();
  if (stored != null) values.set(STORAGE_KEYS.nocturneMaterial, stored);
  const root = { dataset: {} };
  const options = ['flat', 'glass'].map(value => {
    const listeners = new Map(), attrs = new Map();
    return { dataset: { materialOption: value }, tabIndex: -1,
      setAttribute: (key, v) => attrs.set(key, v), getAttribute: key => attrs.get(key),
      addEventListener: (key, fn) => listeners.set(key, fn),
      removeEventListener: (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); },
      focus() { this.focused = true; }, listeners };
  });
  const container = { querySelectorAll: () => options };
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, v) => values.set(key, v) };
  const controller = createNocturneMaterialController({ root, storage, container }).init();
  return { controller, root, options, values };
}

test('材质默认实底，恢复已存的玻璃，未知值按实底', () => {
  assert.equal(STORAGE_KEYS.nocturneMaterial, 'lunara.nocturneMaterial');
  const f = fixture();
  assert.equal(f.root.dataset.material, 'flat');
  assert.deepEqual(f.options.map(o => o.getAttribute('aria-checked')), ['true', 'false']);
  assert.equal(fixture('glass').root.dataset.material, 'glass');
  assert.equal(fixture('frosted').root.dataset.material, 'flat');
});

test('点选与方向键切换材质并持久化；销毁后解绑', () => {
  const f = fixture();
  f.options[1].listeners.get('click')();
  assert.equal(f.root.dataset.material, 'glass');
  assert.equal(f.values.get(STORAGE_KEYS.nocturneMaterial), 'glass');
  assert.deepEqual(f.options.map(o => o.tabIndex), [-1, 0]);
  f.options[1].listeners.get('keydown')({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(f.controller.material(), 'flat');
  assert.equal(f.options[0].focused, true);
  f.controller.destroy();
  assert.ok(f.options.every(o => o.listeners.size === 0));
});

test('存储不可用时仍可切换', () => {
  const root = { dataset: {} };
  const errors = [];
  const c = createNocturneMaterialController({ root,
    storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } },
    onError: e => errors.push(e.message) }).init();
  c.set('glass');
  assert.equal(root.dataset.material, 'glass');
  assert.deepEqual(errors, ['blocked', 'quota']);
});

test('玻璃只在支持模糊时生效，减少透明度时退回实底；选项只在夜场显示', async () => {
  const css = await readFile(new URL('../themes/nocturne/overrides.css', import.meta.url), 'utf8');
  assert.match(css, /@supports \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce)'));
  assert.match(reduced, /\[data-material="glass"\][^{]*\{[^}]*backdrop-filter: none/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<fieldset id="nocturne-material-setting"[^>]*>/);
  assert.match(html, /role="radio" data-material-option="flat" aria-checked="true" tabindex="0"/);
  // 说明文案已按 e2f735d 删除；减少透明度的退回由上面的 CSS 断言保证。
  const shared = await readFile(new URL('../features/conversations/conversations.css', import.meta.url), 'utf8');
  assert.match(shared, /:root:not\(\[data-theme="nocturne"\]\) \.nocturne-material-setting \{ display: none; \}/);
});

test('切回其他主题无残留：data-material 只被夜场样式读取', async () => {
  // 原实现 spawn GNU grep（-rlF），Windows 无 grep 且 new URL().pathname 在盘符路径下不合法；
  // 改为纯 Node 遍历 pwa/ 下的 .css 文件，语义不变：data-material 只允许出现在夜场样式里。
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, sep } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cssFiles = readdirSync(root, { recursive: true })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => rel.endsWith('.css'));
  const hits = cssFiles.filter(rel => readFileSync(join(root, rel), 'utf8').includes('[data-material='));
  assert.deepEqual(hits, ['themes/nocturne/overrides.css']);
  const css = await readFile(new URL('../themes/nocturne/overrides.css', import.meta.url), 'utf8');
  for (const line of css.split('\n').filter(l => l.includes('[data-material='))) {
    assert.match(line, /:root\[data-theme="nocturne"\]\[data-material="glass"\]/);
  }
});
