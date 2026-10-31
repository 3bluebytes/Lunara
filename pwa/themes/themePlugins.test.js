import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createAtmosphereHost } from './atmosphereHost.js';
import { FALLBACK_THEME, THEME_MANIFESTS, VARIANT_OPTIONS, getThemeManifest, themeFileUrl } from './registry.js';

const themesDir = new URL('./', import.meta.url);
const read = (id, file) => readFile(themeFileUrl(id, file), 'utf8');
const stageUrl = new URL('../features/shell/stage.css', import.meta.url);
// 合并后的月色骨架 = 共享舞台版式 + 月色覆盖样式。
const moonlightStageCss = async () => `${await readFile(stageUrl, 'utf8')}\n${await read('moonlight', 'overrides.css')}`;

// 按顶层逗号拆分选择器（:is(a, b) 里的逗号不算），返回每条规则的选择器列表。
// @media / @supports 下钻，@keyframes 等跳过。
function selectorsOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let index = 0;
  function walk(skip) {
    let prelude = '';
    while (index < text.length) {
      const ch = text[index++];
      if (ch === '{') {
        const head = prelude.trim();
        prelude = '';
        if (head.startsWith('@')) walk(!/^@(media|supports|container|layer)\b/.test(head) || skip);
        else {
          if (!skip) out.push(splitTopLevel(head));
          walk(true);
        }
      } else if (ch === '}') return;
      else if (ch === ';') prelude = '';
      else prelude += ch;
    }
  }
  walk(false);
  return out;
}

function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

test('the registry lists exactly the installed theme folders with complete manifests', () => {
  const folders = readdirSync(themesDir).filter(name => statSync(new URL(name, themesDir)).isDirectory()).sort();
  assert.deepEqual([...THEME_MANIFESTS.map(m => m.id)].sort(), folders, 'every folder is registered and every registered theme has a folder');
  assert.ok(getThemeManifest(FALLBACK_THEME), 'the fallback theme must be registered');
  for (const manifest of THEME_MANIFESTS) {
    assert.match(manifest.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(manifest.name && typeof manifest.name === 'string', `${manifest.id} needs a display name`);
    assert.ok(Number.isInteger(manifest.version) && manifest.version >= 1, `${manifest.id} needs a version`);
    assert.ok(['dark', 'light'].includes(manifest.scheme), `${manifest.id} scheme`);
    assert.ok(manifest.swatch, `${manifest.id} needs a chooser swatch`);
    assert.equal(manifest.tokens, 'tokens.css');
    for (const key of ['tokens', 'overrides', 'atmosphere']) {
      if (manifest[key]) assert.ok(existsSync(themeFileUrl(manifest.id, manifest[key])), `${manifest.id}/${manifest[key]} is missing`);
    }
  }
});

test('every theme picks each display variant from the allowed list', () => {
  for (const manifest of THEME_MANIFESTS) {
    assert.deepEqual(Object.keys(manifest.variants).sort(), Object.keys(VARIANT_OPTIONS).sort(), `${manifest.id} declares every variant`);
    for (const [key, value] of Object.entries(manifest.variants)) {
      assert.ok(VARIANT_OPTIONS[key].includes(value), `${manifest.id}.${key}=${value} is not an allowed value`);
    }
  }
});

test('tokens.css holds a single block scoped to its theme', async () => {
  for (const { id } of THEME_MANIFESTS) {
    const rules = selectorsOf(await read(id, 'tokens.css'));
    assert.equal(rules.length, 1, `${id}/tokens.css must contain exactly one block`);
    const expected = id === FALLBACK_THEME ? [':root', `:root[data-theme="${id}"]`] : [`:root[data-theme="${id}"]`];
    assert.deepEqual(rules[0], expected, `${id}/tokens.css selector`);
  }
});

test('every overrides.css selector is scoped to its own theme', async () => {
  for (const manifest of THEME_MANIFESTS) {
    if (!manifest.overrides) continue;
    const prefix = `:root[data-theme="${manifest.id}"]`;
    const rules = selectorsOf(await read(manifest.id, manifest.overrides));
    assert.ok(rules.length > 0, `${manifest.id} overrides parsed`);
    for (const selectors of rules) {
      for (const selector of selectors) {
        assert.ok(selector.startsWith(prefix), `${manifest.id}/overrides.css leaks: ${selector}`);
      }
    }
  }
});

test('the shell links every registered theme style in cascade order', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const position = needle => html.indexOf(needle);
  const styles = position('href="/styles.css');
  const firstFeature = position('href="/features/');
  const lastFeature = html.lastIndexOf('href="/features/');
  assert.ok(styles > 0 && firstFeature > styles);
  for (const manifest of THEME_MANIFESTS) {
    const tokens = position(`href="/themes/${manifest.id}/tokens.css`);
    assert.ok(tokens > styles && tokens < firstFeature, `${manifest.id} tokens must load right after styles.css`);
    if (manifest.overrides) {
      const overrides = position(`href="/themes/${manifest.id}/${manifest.overrides}`);
      assert.ok(overrides > lastFeature, `${manifest.id} overrides must load after the feature styles`);
    }
  }
  assert.doesNotMatch(html, /<canvas id="particle-canvas"/, 'atmospheres create their own canvas');
  assert.match(html, /id="theme-atmosphere"[^>]*aria-hidden="true"/);
});

test('moonlight sidebar styles are isolated and loaded after the shared stage', async () => {
  const css = await read('moonlight', 'sidebar.css');
  for (const selectors of selectorsOf(css)) {
    for (const selector of selectors) assert.ok(selector.startsWith(':root[data-theme="moonlight"][data-layout="stage"]'), selector);
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/themes/moonlight/sidebar.css') > html.indexOf('/themes/moonlight/partner.css'));
  assert.match(css, /not\(\[data-moonlight-sidebar="expanded"\]\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('every atmosphere module exports mount', async () => {
  for (const manifest of THEME_MANIFESTS) {
    if (!manifest.atmosphere) continue;
    const module = await import(themeFileUrl(manifest.id, manifest.atmosphere).href);
    assert.equal(typeof module.mount, 'function', `${manifest.id} atmosphere`);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fakeAtmosphere(id, log) {
  return {
    mount(container, context) {
      log.push(`mount:${id}`);
      assert.equal(typeof context.getState, 'function');
      assert.equal(typeof context.reducedMotion, 'boolean');
      return {
        update: state => log.push(`update:${id}:${state.amplitude}`),
        refresh: () => log.push(`refresh:${id}`),
        unmount: () => log.push(`unmount:${id}`),
      };
    },
  };
}

test('the atmosphere host unmounts before mounting and drops late modules', async () => {
  const log = [];
  const pending = new Map();
  const host = createAtmosphereHost({
    container: {},
    reducedMotion: () => true,
    load: id => { const d = deferred(); pending.set(id, d); return d.promise; },
  });

  const first = host.activate('moonlight');
  pending.get('moonlight').resolve(fakeAtmosphere('moonlight', log));
  await first;
  assert.deepEqual(log, ['mount:moonlight']);

  // 月色氛围尚未加载完就切到无氛围的素色：迟到模块不得挂载。
  const toMoonlight = host.activate('moonlight');
  await host.activate('modernist');
  pending.get('moonlight').resolve(fakeAtmosphere('moonlight', log));
  await toMoonlight;
  assert.deepEqual(log, ['mount:moonlight', 'unmount:moonlight']);
  assert.equal(host.activeTheme(), 'modernist');
  const back = host.activate('moonlight');
  pending.get('moonlight').resolve(fakeAtmosphere('moonlight', log));
  await back;
  host.update({ amplitude: 0.5 });
  host.refresh();
  host.destroy();
  assert.deepEqual(log.slice(3), ['update:moonlight:0.5', 'refresh:moonlight', 'unmount:moonlight']);
  assert.equal(host.isMounted(), false);
});

test('a theme without an atmosphere mounts nothing and load failures are reported', async () => {
  const errors = [];
  const host = createAtmosphereHost({
    container: {},
    load: () => Promise.reject(new Error('offline')),
    onError: error => errors.push(error.message),
  });
  assert.equal(await host.activate('not-installed'), null);
  assert.equal(await host.activate('moonlight'), null);
  assert.deepEqual(errors, ['offline']);
  assert.equal(host.isMounted(), false);
});

// 共享 JS 不按主题名分支：差异只来自 theme.json 变体与主题 token（--shell-sidebar 等）。
function sharedScripts(dir = new URL('../', import.meta.url)) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) {
      if (!['themes', 'node_modules', 'vendor'].includes(name)) out.push(...sharedScripts(new URL(`${name}/`, dir)));
    } else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push(url);
  }
  return out;
}

test('shared scripts never branch on a theme id', async () => {
  const ids = THEME_MANIFESTS.map(m => m.id).join('|');
  const pattern = new RegExp(`(dataset\\.theme|data-theme)[^\\n]{0,40}(===|!==|==)\\s*['"](${ids})['"]|['"](${ids})['"]\\s*(===|!==)[^\\n]{0,40}dataset\\.theme`);
  for (const url of sharedScripts()) {
    const source = await readFile(url, 'utf8');
    assert.doesNotMatch(source, pattern, `${url.pathname} branches on a theme id`);
  }
});

test('the merged moonlight hides controls the design does not have but keeps every action reachable', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await moonlightStageCss();
  const tokens = await read('moonlight', 'overrides.css');
  for (const id of ['nav-settings', 'nav-create', 'nav-account', 'room-archived', 'sidebar-close']) {
    assert.match(css, new RegExp(`#${id}[,)\\s]`), `cike hides #${id}`);
  }
  // 被隐藏的设置 / 新建入口改走稿里已有的位置：底栏齿轮与「聊天 +」。登录在设置页里。
  for (const id of ['sb-settings-open', 'room-list-create', 'people-list-create', 'person-detail-edit']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} exists once`);
  }
  assert.match(css, /\.room-list-create \{ display: inline-flex/);
  assert.match(css, /\.sb-settings-open \{ display: inline-flex/);
  assert.match(tokens, /--shell-sidebar: collapsible;/);
  assert.match(tokens, /--shell-person: page;/);
  assert.match(tokens, /--person-edit: toggle;/);
  // 新入口在其余主题下不出现：基础样式默认隐藏。
  const shared = await readFile(new URL('../features/conversations/conversations.css', import.meta.url), 'utf8');
  assert.match(shared, /\.room-list-create, \.sb-settings-open, \.person-edit-toggle \{ display: none; \}/);
});

test('moonlight uses the dual waveform and focus listening collapses the sidebar', async () => {
  assert.equal(getThemeManifest('moonlight').variants.waveform, 'dual');
  const css = await moonlightStageCss();
  assert.match(css, /#app\.focus-mode \.conversation-sidebar \{ display: none !important; \}/);
  assert.match(css, /\.player-waveform:has\(\.waveform-row\)/);
});

// ===== theme-modernist-organic：舞台版式、语义变量、对比度 =====

const SEMANTIC_TOKENS = [
  '--bg-page', '--bg-stage', '--bg-sidebar', '--bg-player', '--bg-raised', '--bg-input', '--bg-selected', '--bg-hover',
  '--text', '--text-2', '--text-3', '--text-4', '--text-on-accent',
  '--line', '--line-strong', '--line-control',
  '--accent', '--accent-hover', '--danger', '--ok',
  ...[1, 2, 3, 4, 5, 6].flatMap(n => [`--partner-${n}`, `--partner-${n}-rgb`]), '--partner-lunara',
  '--font-display', '--font-reading', '--font-ui', '--font-mono',
  '--size-clock-hero', '--size-clock', '--size-title', '--size-song', '--size-lyric-current', '--size-lyric',
  '--size-reading', '--size-body', '--size-meta', '--size-label',
  '--radius-pill', '--radius-card', '--radius-row', '--radius-input', '--radius-cover', '--radius-bubble',
  '--motion-breath', '--motion-ease',
];

// 一个 CSS 块里的自定义属性声明（注释去掉；值里没有分号）。
function declarations(block) {
  const out = new Map();
  for (const match of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

function blockBody(css, selectorStart) {
  const start = css.indexOf(selectorStart);
  assert.ok(start >= 0, `missing block ${selectorStart}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed block ${selectorStart}`);
}

let baseRoot = null;
async function themeVariables(id) {
  baseRoot ??= declarations(blockBody(await readFile(new URL('../styles.css', import.meta.url), 'utf8'), ':root {'));
  const own = declarations(blockBody(await read(id, 'tokens.css'), ':root'));
  return { own, all: new Map([...baseRoot, ...own]) };
}

function resolve(vars, value, depth = 0) {
  assert.ok(depth < 20, `var() cycle in ${value}`);
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name, fallback) => {
    const next = vars.get(name) ?? fallback;
    assert.ok(next != null, `undefined ${name}`);
    return resolve(vars, next, depth + 1);
  });
}

function hslToRgb(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// 字面颜色 → [r, g, b, a]。只支持 hex、rgb()/rgba()、hsl()/hsla()；calc() / color-mix() 直接报错。
function parseColor(text) {
  const value = text.trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map(c => c + c).join('');
    const n = [0, 2, 4, 6].map(i => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  const fn = value.match(/^(rgba?|hsla?)\((.*)\)$/);
  assert.ok(fn, `unsupported colour: ${text}`);
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  const num = (part, scale = 1) => (part.endsWith('%') ? parseFloat(part) / 100 * scale : parseFloat(part));
  const alpha = parts[3] == null ? 1 : num(parts[3], 1);
  if (fn[1].startsWith('rgb')) return [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), alpha];
  return [...hslToRgb(parseFloat(parts[0]), num(parts[1], 1), num(parts[2], 1)), alpha];
}

const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
function luminance([r, g, b]) {
  const lin = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('every theme declares the full semantic token set in its own block', async () => {
  for (const { id } of THEME_MANIFESTS) {
    const { own } = await themeVariables(id);
    for (const token of SEMANTIC_TOKENS) assert.ok(own.has(token), `${id} is missing ${token}`);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const [r, g, b] = parseColor(resolve(own, own.get(`--partner-${n}`)));
      assert.equal(own.get(`--partner-${n}-rgb`), [r, g, b].map(Math.round).join(' '), `${id} --partner-${n}-rgb matches --partner-${n}`);
    }
  }
});

test('every theme keeps body text readable against its page and raised surfaces', async () => {
  for (const { id, scheme } of THEME_MANIFESTS) {
    const { all } = await themeVariables(id);
    const color = name => parseColor(resolve(all, all.get(name)));
    const ground = scheme === 'light' ? [255, 255, 255, 1] : [0, 0, 0, 1];
    const page = over(color('--bg-page'), ground);
    const raised = over(color('--bg-raised'), page);
    const accent = over(color('--accent'), page);
    const pairs = [
      ['--text on --bg-page', over(color('--text'), page), page, 4.5],
      ['--text-2 on --bg-page', over(color('--text-2'), page), page, 4.5],
      ['--text on --bg-raised', over(color('--text'), raised), raised, 4.5],
      ['--text-on-accent on --accent', over(color('--text-on-accent'), accent), accent, 3],
    ];
    for (const [label, fg, bg, minimum] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= minimum, `${id}: ${label} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
    }
  }
});

test('the contrast check rejects a low-contrast palette', () => {
  const page = parseColor('#f5eee1');
  assert.ok(contrast(over(parseColor('rgba(59,46,36,.3)'), page), page) < 4.5);
  assert.ok(contrast(parseColor('hsl(215 30% 16%)'), parseColor('hsl(212 30% 97%)')) > 4.5);
  assert.throws(() => parseColor('calc(1px)'), /unsupported colour/);
});

test('the stage skeleton is shared by layout, not by theme id, and loads before theme overrides', async () => {
  const css = await readFile(stageUrl, 'utf8');
  const rules = selectorsOf(css);
  assert.ok(rules.length > 200, 'stage skeleton parsed');
  for (const selectors of rules) {
    for (const selector of selectors) assert.ok(selector.startsWith(':root[data-layout="stage"]'), `stage.css leaks: ${selector}`);
  }
  assert.doesNotMatch(css, /data-theme/, 'stage.css never branches on a theme id');
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [], [], 'stage.css reads colours from semantic tokens only');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const stage = html.indexOf('href="/features/shell/stage.css');
  // 共享版式（stage、timeline）排在所有功能样式之后；timeline 紧随 stage。
  const layouts = html.indexOf('href="/features/shell/timeline.css');
  assert.equal(layouts, html.lastIndexOf('href="/features/'), 'layout stylesheets are the last feature stylesheets');
  assert.equal(html.lastIndexOf('href="/features/', layouts - 1), stage, 'stage.css comes right before timeline.css');
  for (const manifest of THEME_MANIFESTS) {
    if (manifest.overrides) assert.ok(html.indexOf(`href="/themes/${manifest.id}/${manifest.overrides}`) > stage, `${manifest.id} overrides load after stage.css`);
  }
  for (const { id, variants } of THEME_MANIFESTS) {
    const expected = id === 'nocturne' ? 'timeline' : 'stage';
    assert.equal(variants.layout, expected, `${id} layout`);
  }
});

test('moonlight is the scheme A refresh on the stage layout and stays the fallback', async () => {
  assert.equal(FALLBACK_THEME, 'moonlight');
  assert.deepEqual({ ...getThemeManifest('moonlight').variants }, { identity: 'dot', clock: 'hidden', waveform: 'dual', decoration: 'on', layout: 'stage' });
  assert.equal(getThemeManifest('moonlight').atmosphere, 'atmosphere.js', 'the star field stays');
  assert.equal(getThemeManifest('moonlight').overrides, 'overrides.css');
  const tokens = await read('moonlight', 'tokens.css');
  assert.match(tokens, /^:root,\n:root\[data-theme="moonlight"\] \{/m, 'the moonlight block still applies to the bare root');
  assert.match(tokens, /--bg-stage:[^;]*var\(--ambient-hue\)/, 'the stage sky follows the ambient hue');
  // 壳层 token 不能写进裸 :root 的块，否则旧版式主题也会继承常驻侧栏。
  assert.doesNotMatch(tokens, /--shell-sidebar/);
  const css = await read('moonlight', 'overrides.css');
  for (const habit of ['--shell-sidebar: collapsible;', '--shell-person: page;', '--person-edit: toggle;']) assert.ok(css.includes(habit), `moonlight ${habit}`);
  assert.doesNotMatch(css, /(\.persistent-player|\.compose|#compose-input|#focus-mode-chat|#big-play)\s*\{[^}]*display:\s*none/, 'moonlight hides a shared control');
  // 封面色晕画在 body::before 上：#app 不透明会把它整层盖住，封面取不到色相时只剩主题原色。
  assert.match(css, /:root\[data-theme="moonlight"\] #app \{ background: transparent; \}/, 'moonlight lets the artwork wash show through');
});

test('modernist declares the agreed variants and keeps the shared controls', async () => {
  assert.deepEqual({ ...getThemeManifest('modernist').variants }, { identity: 'name', clock: 'hidden', waveform: 'line', decoration: 'off', layout: 'stage' });
  assert.equal(getThemeManifest('modernist').atmosphere, undefined, 'modernist mounts no atmosphere');
  // 主题只换皮：播放条、输入框、专注退出入口在共享 DOM 里各有且只有一个，覆盖样式不隐藏它们。
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['compose-input', 'compose-send', 'progress-bar', 'big-play', 'focus-mode-chat']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} exists once`);
  }
  assert.equal((html.match(/class="persistent-player"/g) || []).length, 1);
  for (const id of ['modernist']) {
    const css = await read(id, 'overrides.css');
    assert.doesNotMatch(css, /(\.persistent-player|\.compose|#compose-input|#focus-mode-chat|#big-play)\s*\{[^}]*display:\s*none/, `${id} hides a shared control`);
    const tokens = await read(id, 'tokens.css');
    for (const habit of ['--shell-sidebar: pinned;', '--shell-person: page;', '--person-edit: toggle;']) assert.ok(tokens.includes(habit), `${id} ${habit}`);
  }
  const modernist = await read('modernist', 'overrides.css');
  assert.match(modernist, /border-radius: 0 !important; box-shadow: none !important/);
  assert.doesNotMatch(modernist, /grayscale\(1\)/, 'modernist keeps album artwork in its original color');
  assert.match(modernist, /\.listening-panel \{ border-right: 2px solid/);
  const stage = await readFile(stageUrl, 'utf8');
  assert.match(stage, /\[data-waveform="line"\] \.player-waveform \{ display: none !important; \}/);
  assert.match(stage, /\[data-waveform="line"\] \.persistent-player \.progress > i \{[^}]*height: 4px/);
  assert.match(stage, /\[data-clock="hidden"\] :is\(#listening-clock,#focus-clock\) \{ display: none; \}/);
});

test('timeline is a registered layout and its stylesheet is scoped to it', async () => {
  assert.ok(VARIANT_OPTIONS.layout.includes('timeline'));
  const css = await readFile(new URL('../features/shell/timeline.css', import.meta.url), 'utf8');
  const rules = selectorsOf(css);
  assert.ok(rules.length > 0, 'timeline.css parsed');
  for (const selectors of rules) {
    for (const selector of selectors) assert.ok(selector.startsWith(':root[data-layout="timeline"]'), `timeline.css leaks: ${selector}`);
  }
  for (const { id, overrides } of THEME_MANIFESTS) {
    if (overrides) assert.doesNotMatch(await read(id, overrides), /data-layout="timeline"/, `${id} must not define timeline layout`);
  }
});

test('timeline shows the person panel as a page like ledger, with the strip player', async () => {
  const css = await readFile(new URL('../features/shell/timeline.css', import.meta.url), 'utf8');
  assert.match(css, /#app:is\(\.today-open, \.settings-open, \.person-page\):not\(\.focus-mode\) > \.persistent-player \{/, 'person page gets the strip player');
  assert.match(css, /> :is\(#today-panel, #settings-panel, #person-detail\[open\]\) \{\s*grid-column: 1 \/ -1; grid-row: 1;/);
  const page = css.match(/#app\.person-page > #person-detail\[open\] \{([^}]*)\}/)?.[1] || '';
  for (const decl of ['position: relative', 'box-shadow: none', 'max-width: none']) assert.ok(page.includes(decl), `person page ${decl}`);
  assert.match(css, /#app\.person-page > #person-detail \[data-close-dialog\] \{ display: none; \}/, 'no close button on the page');
  assert.match(css, /#app\.person-page :is\(\.listening-panel, \.conversation-main, \.mobile-pane-switch\) \{ display: none !important; \}/, 'listening page does not show through');
  assert.match(css, /@media \(max-width: 860px\) \{\s*:root\[data-layout="timeline"\] #app\.person-page > #person-detail \.person-sheet-body \{ display: block; \}/, 'narrow person page stacks as plain blocks');
});

test('timeline clock rides the playhead but stays inside the cover width', async () => {
  const css = await readFile(new URL('../features/shell/timeline.css', import.meta.url), 'utf8');
  const clock = css.match(/#app \.timeline-clock \{([^}]*)\}/)?.[1] || '';
  assert.match(clock, /left: var\(--timeline-p, 0%\)/);
  assert.match(clock, /transform: translateX\(calc\(-1 \* var\(--timeline-p, 0%\)\)\)/, 'left-aligned at 0%, right-aligned at 100%');
});

test('--studio-surface is an image in every theme so layered backgrounds stay valid', async () => {
  // 共享样式写 `background: var(--studio-surface), var(--studio-surface-solid)`：非最后一层是纯颜色时整条声明失效，面板透明。
  const defaults = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const sources = [['styles.css', defaults], ...await Promise.all(THEME_MANIFESTS.map(async ({ id }) => [id, await read(id, 'tokens.css').catch(() => '')]))];
  for (const [name, css] of sources) {
    for (const [, value] of css.matchAll(/--studio-surface:\s*([^;]+);/g)) assert.match(value.trim(), /^(linear|radial)-gradient\(/, `${name} --studio-surface`);
  }
});

test('timeline lays the overlay out as list plus one footer row and keeps panels below the top bar', async () => {
  const css = await readFile(new URL('../features/shell/timeline.css', import.meta.url), 'utf8');
  assert.match(css, /#conversation-sidebar \{[^}]*display: grid;[^}]*"arch \. tail"/, 'narrow: nav on top, footer row');
  assert.match(css, /@media \(min-width: 768px\) \{\s*:root\[data-layout="timeline"\] #conversation-sidebar \{ grid-template-areas: "head head head" "search search search" "list list list" "arch nav tail" "meta meta meta";/);
  assert.match(css, /#conversation-sidebar > \.shell-navigation > :not\(#recording-review-open\),\s*:root\[data-layout="timeline"\] #conversation-sidebar #nav-today \{ display: none; \}/, 'top bar already has these destinations');
  assert.match(css, /#app > \.recording-review \{ top: calc\(var\(--top-bar-height\) \+ 8px\); \}/);
  const nocturne = await read('nocturne', 'overrides.css');
  assert.match(nocturne, /\[data-material="glass"\] \.conversation-sidebar \{\s*background: var\(--ink-1\); -webkit-backdrop-filter: none; backdrop-filter: none;/, 'overlay is solid in glass');
});

test('the shell links timeline.css after stage.css and keeps a single player and media pair', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const stage = html.indexOf('href="/features/shell/stage.css');
  const timeline = html.indexOf('href="/features/shell/timeline.css');
  assert.ok(stage > 0 && timeline > stage, 'timeline.css loads after stage.css');
  assert.ok(timeline < html.indexOf('href="/themes/moonlight/overrides.css'), 'and before theme overrides');
  assert.match(html, /<header id="top-bar" class="top-bar"[^>]*hidden/);
  assert.equal(html.match(/class="persistent-player"/g)?.length, 1, 'one persistent player');
  assert.equal(html.match(/<audio id="audio"/g)?.length, 1);
  assert.equal(html.match(/<audio id="audioMusic"/g)?.length, 1);
  const view = await readFile(new URL('../features/shell/topBarView.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /createElement\(['"](audio|video)|cloneNode|persistent-player/, 'the top bar never creates media or clones the player');
});

test('moonlight partner.css 只作用于月色舞台版式，排在月色覆盖样式之后，且不藏共享控件', async () => {
  const css = await read('moonlight', 'partner.css');
  const prefix = ':root[data-theme="moonlight"][data-layout="stage"]';
  const rules = selectorsOf(css);
  assert.ok(rules.length > 0, 'partner.css parsed');
  for (const selectors of rules) {
    for (const selector of selectors) assert.ok(selector.startsWith(prefix), `moonlight/partner.css leaks: ${selector}`);
  }
  assert.doesNotMatch(css, /(\.persistent-player|\.compose|#compose-input|#big-play)\s*\{[^}]*display:\s*none/, 'partner.css hides a shared control');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const overrides = html.indexOf('href="/themes/moonlight/overrides.css');
  const partner = html.indexOf('href="/themes/moonlight/partner.css');
  assert.ok(overrides > 0 && partner > overrides, 'partner.css loads after moonlight overrides');
});

// 人物页是整页替换：stage.css 自己给了两列并让 #person-detail 占第 2 列。
// 月色伙伴版式的三列模板（聊天流 + 420px 月盘）一旦也套到人物页，
// 资料就被塞进 640px 的中间列，右边留一列空门框，人格与记忆都挤成窄条。
test('月色伙伴版式的三列模板不接管人物页', async () => {
  const partner = await read('moonlight', 'partner.css');
  const columns = partner.match(/:root\[data-theme="moonlight"\]\[data-layout="stage"\] #app:not\(\.focus-mode\)[^{]*\{[^}]*grid-template-columns[^}]*\}/)?.[0] || '';
  assert.match(columns, /:not\(\.person-page\)/, 'person page is excluded from the chat three-column template');
  assert.match(columns, /minmax\(340px,420px\)/, 'the chat layout still reserves the moon column');
  const stage = await readFile(stageUrl, 'utf8');
  assert.match(stage, /#app\.person-page \{ grid-template-columns: var\(--room-sidebar-width\) minmax\(0,1fr\);/, 'person page keeps its own two-column grid');
});

// 左列两层（字段区滚动 + 列底动作条）是 base sheet 的约定；stage 曾把它放开成单一内部滚动，
// 编辑态下「保存修改」落在视口外，用户看到的是「根本没有保存按钮」。
test('人物页编辑态保留字段滚动与常驻保存动作', async () => {
  const stage = await readFile(stageUrl, 'utf8');
  const block = selector => stage.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))?.[1] || '';
  const form = block(':root[data-layout="stage"] #person-detail .person-profile-form');
  const fields = block(':root[data-layout="stage"] #person-detail .person-profile-scroll');
  const actions = block(':root[data-layout="stage"] #person-detail .person-profile-actions');
  assert.ok(form && fields && actions, 'person profile rules exist');
  for (const [name, body] of [['form', form], ['fields', fields]]) {
    assert.doesNotMatch(body, /overflow:\s*visible/, `${name} must not release the scroll container`);
    assert.doesNotMatch(body, /display:\s*block/, `${name} must not break the two-layer column`);
  }
  assert.match(actions, /border-top:\s*1px solid var\(--line-strong\)/, 'the pinned action bar keeps a visible separator');
  const base = await readFile(new URL('../features/conversations/conversations.css', import.meta.url), 'utf8');
  assert.match(base, /\.person-profile-scroll \{[^}]*overflow-y: auto/, 'the base sheet scrolls the fields, not the page');
  assert.match(base, /\.person-profile-actions \{\s*flex: 0 0 auto/, 'the base sheet pins the action bar under the fields');
});
