import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { THEMES } from './themeController.js';

// 主题 token 块在 pwa/themes/<id>/tokens.css，接在共享 styles.css 后面一起读。
let styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
for (const id of THEMES) styles += '\n' + await readFile(new URL(`../themes/${id}/tokens.css`, import.meta.url), 'utf8');
const shell = await readFile(new URL('../features/conversations/conversations.css', import.meta.url), 'utf8');
const shellHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const roles = ['surface', 'surface-low', 'ink', 'muted', 'accent', 'control', 'control-ink', 'wash-opacity', 'wash-brightness', 'cover-surface-l', 'cover-low-l', 'cover-ink-l', 'cover-muted-l', 'cover-accent-l', 'cover-control-l', 'cover-control-ink-l', 'cover-fallback', 'cover-fallback-opacity', 'cover-surface-s', 'cover-low-s', 'cover-control-s', 'cover-accent-s'];

function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  return css.slice(start, css.indexOf('}', start) + 1);
}

test('all themes explicitly own every player colour role', () => {
  for (const id of THEMES) {
    const body = rule(styles, `:root[data-theme="${id}"]`);
    for (const role of roles) assert.match(body, new RegExp(`--player-${role}:`), `${id} owns ${role}`);
  }
});

test('each theme has its own artwork tone map instead of copying moonlight', () => {
  const toneRoles = ['cover-surface-l', 'cover-low-l', 'cover-surface-s', 'cover-low-s', 'cover-control-s', 'cover-accent-s'];
  const maps = THEMES.map(id => {
    const body = rule(styles, `:root[data-theme="${id}"]`);
    return toneRoles.map(role => body.match(new RegExp(`--player-${role}:\\s*([^;]+);`))?.[1]).join('|');
  });
  assert.equal(new Set(maps).size, THEMES.length, 'theme-specific artwork lightness/saturation must remain distinct');
  const sampled = rule(shell, ':root[data-artwork-theme="on"][data-artwork-cover="present"][data-artwork-hue="active"] .persistent-player');
  assert.match(sampled, /var\(--player-cover-surface-s\)/);
  assert.match(sampled, /var\(--player-cover-low-s\)/);
  const enabled = rule(shell, ':root[data-artwork-theme="on"][data-artwork-cover="present"] .persistent-player');
  assert.match(enabled, /var\(--player-cover-control-s\)/);
  assert.match(enabled, /var\(--player-cover-accent-s\)/);
});

test('player uses theme surfaces and control roles, not hardcoded amber or playback halos', () => {
  const player = rule(shell, '.persistent-player');
  assert.match(player, /var\(--player-surface\)/);
  assert.match(player, /var\(--player-surface-low\)/);
  assert.doesNotMatch(player, /overflow:\s*hidden/, 'queue popup must not be clipped');
  for (const selector of ['.persistent-player .play-btn', '.persistent-player .play-btn:hover', '.persistent-player .progress > i', '.persistent-player .progress::after', '.persistent-player .mixer-slider::-webkit-slider-thumb', '.persistent-player .mixer-slider::-moz-range-thumb']) {
    assert.match(rule(shell, selector), /var\(--player-/);
    assert.doesNotMatch(rule(shell, selector), /var\(--amber\)|#[0-9a-f]+/i);
  }
  assert.doesNotMatch(shell, /\.persistent-player\.is-playing \.play-btn\s*\{/, 'playing must not restore a different palette');
});

test('every theme owns its scene through role tokens, never through shared selectors', () => {
  // 主题块只允许声明自定义属性（外加 color-scheme 这类浏览器方案提示，它不是场景色）。
  // 元素级的 background/color 声明意味着某个主题在借用共享选择器做特例——星夜画廊曾用
  // 一张附加样式表贴画作裁切并覆盖共享表面，导致听歌区/聊天列被洗成灰。
  const allowedProperties = new Set(['color-scheme']);
  for (const id of THEMES) {
    const body = rule(styles, `:root[data-theme="${id}"]`);
    const declarations = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'))
      .replace(/\/\*[\s\S]*?\*\//g, '').split(';');
    for (const declaration of declarations) {
      const property = declaration.split(':')[0].trim();
      if (!property || allowedProperties.has(property)) continue;
      assert.ok(property.startsWith('--'), `${id} must not declare ${property}; scene colour belongs to tokens`);
    }
  }
  // 天空几何的基线：月晕默认关闭、月盘半径默认值，主题不声明也不会串味。
  const base = rule(styles, ':root');
  assert.match(base, /--sky-moon-halo-a:\s*0/, 'the halo must default to off so other themes keep their sky');
  assert.match(base, /--sky-moon-stop:\s*34%/, 'the moon radius needs a shared baseline');
  assert.match(shell, /var\(--sky-moon-halo-a, 0\)/, 'the halo layer must read the token');
  assert.match(shell, /var\(--sky-moon-stop, 34%\)/, 'the moon disc must read the radius token');
  // 画作素材不得进入生产壳层；想表达夜色只能用 token。
  assert.doesNotMatch(styles + shell + shellHtml, /starry-night\.jpg|starry-fragment|starryAtelier\.css/);
});

test('artwork leads the full player surface, controls and soft separator when enabled', () => {
  const enabled = rule(shell, ':root[data-artwork-theme="on"][data-artwork-cover="present"] .persistent-player');
  for (const role of ['ink', 'muted', 'accent', 'control', 'control-ink']) {
    assert.match(enabled, new RegExp(`--player-${role}:\\s*hsl\\(var\\(--ambient-hue\\)`), role);
  }
  assert.match(enabled, /border-top-color:\s*color-mix/);
  const sampled = rule(shell, ':root[data-artwork-theme="on"][data-artwork-cover="present"][data-artwork-hue="active"] .persistent-player');
  for (const role of ['surface', 'surface-low']) {
    assert.match(sampled, new RegExp(`--player-${role}:\\s*hsl\\(var\\(--ambient-hue\\)`));
  }
  assert.match(enabled, /--player-surface:\s*var\(--player-cover-fallback\)/);
});

test('full-width artwork layer is opt-in, non-interactive and clipped independently of popups', () => {
  const wash = rule(shell, '.persistent-player::before');
  assert.match(wash, /var\(--artwork-image, none\)/);
  assert.match(wash, /pointer-events:\s*none/);
  assert.match(wash, /opacity:\s*0/);
  assert.match(wash, /clip-path:\s*inset\(0\)/);
  assert.doesNotMatch(wash, /mask-image:/, 'artwork must not fade back to grey-violet on the right');
  assert.match(wash, /background-size:\s*100% 100%/);
  assert.doesNotMatch(wash, /animation:|transition:/);
  const enabled = rule(shell, ':root[data-artwork-theme="on"][data-artwork-cover="present"] .persistent-player::before');
  assert.match(enabled, /opacity:\s*var\(--player-cover-fallback-opacity\)/);
  const sampled = rule(shell, ':root[data-artwork-theme="on"][data-artwork-cover="present"][data-artwork-hue="active"] .persistent-player::before');
  assert.match(sampled, /opacity:\s*var\(--player-wash-opacity\)/);
});
