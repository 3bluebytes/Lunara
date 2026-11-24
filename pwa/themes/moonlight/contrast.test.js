import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// 月色主题对比度门禁：全部正文与次级文字（--text / --text-2 / --text-3 / --accent / --danger / --ok）
// 在实底面板、半透明侧栏/输入框/播放条以及开启「随歌曲封面变色」的全部 12 色相（0°–330°）最亮月晕点上
// 均须满足 WCAG AA 正文对比度 ≥ 4.5:1；主播放键文字在琥珀底上亦 ≥ 4.5:1。

const tokensCss = await readFile(new URL('./tokens.css', import.meta.url), 'utf8');
const overridesCss = await readFile(new URL('./overrides.css', import.meta.url), 'utf8');

function extractVars(css) {
  const out = new Map();
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!out.has(match[1])) out.set(match[1], match[2].trim());
  }
  return out;
}

const vars = new Map([...extractVars(tokensCss), ...extractVars(overridesCss)]);

function resolveVar(name, depth = 0) {
  assert.ok(depth < 16, `var() cycle at ${name}`);
  const raw = vars.get(name);
  assert.ok(raw, `missing ${name}`);
  return raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref) => resolveVar(ref, depth + 1));
}

function hsl(h, s, l, a = 1) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const f = n => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4), a];
}

function parseColor(text) {
  const value = text.trim();
  let m = value.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).concat(1);
  m = value.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r / 255, g / 255, b / 255, a];
  }
  throw new Error(`unsupported colour: ${text}`);
}

const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const lum = ([r, g, b]) => {
  const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (fg, bg) => {
  const [hi, lo] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const HUES = Array.from({ length: 12 }, (_, i) => i * 30);

test('月色天幕光晕锁定饱和度与明度，12 色相（0°–330°）下正文与次级文字对比度全部 ≥ 4.5:1', () => {
  const stageDecl = vars.get('--bg-stage') || '';
  const glowMatch = stageDecl.match(/hsl\(var\(--ambient-hue\)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\)/);
  assert.ok(glowMatch, '--bg-stage 必须包含受控的 hsl(var(--ambient-hue) S% L%) 月晕');
  const glowS = Number(glowMatch[1]);
  const glowL = Number(glowMatch[2]);

  const skyTop = parseColor('#121a3a');
  const skyBottom = parseColor(resolveVar('--bg-page'));
  const raised = parseColor(resolveVar('--bg-raised'));
  const sidebarOverlay = parseColor(resolveVar('--bg-sidebar'));
  const inputOverlay = parseColor(resolveVar('--bg-input'));
  const playerOverlay = parseColor(resolveVar('--bg-player'));

  // 最不利背景集合：各实底面板 + 12 色相下最亮月晕中心点及叠在月晕上的半透明侧栏/输入框/播放条。
  const glowPeaks = HUES.map(h => hsl(h, glowS, glowL, 1));
  const backgrounds = [
    skyTop,
    skyBottom,
    raised,
    ...glowPeaks,
    ...glowPeaks.map(bg => over(sidebarOverlay, bg)),
    ...glowPeaks.map(bg => over(inputOverlay, bg)),
    ...glowPeaks.map(bg => over(playerOverlay, bg)),
  ];

  const inks = ['--text', '--text-2', '--text-3', '--t-hi', '--t-mid', '--t-lo', '--t-placeholder', '--accent', '--danger', '--ok'];
  const failures = [];
  for (const name of inks) {
    const fg = parseColor(resolveVar(name));
    const worst = Math.min(...backgrounds.map(bg => ratio(fg, bg)));
    if (worst < 4.5) failures.push(`${name}: ${worst.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);

  // 主播放键与主操作实心琥珀底上的深色文字对比度 ≥ 4.5:1。
  const accentBg = over(parseColor(resolveVar('--accent')), skyBottom);
  const onAccent = parseColor(resolveVar('--text-on-accent'));
  assert.ok(ratio(onAccent, accentBg) >= 4.5, '--text-on-accent on --accent must be >= 4.5:1');
});

test('月色锁死底栏琥珀主播放键与无毛玻璃红线', () => {
  assert.match(overridesCss, /:root\[data-theme="moonlight"\] #app \.persistent-player[\s\S]*?--player-control:\s*var\(--accent\)/);
  assert.match(overridesCss, /:root\[data-theme="moonlight"\] :is\(\.aurora,\s*\.noise\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(overridesCss, /\.compose[\s\S]*?backdrop-filter:\s*none/);
});
