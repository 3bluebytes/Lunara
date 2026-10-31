import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// 夜场正文对比度：文字 token 在两种材质、任意封面色相下都要 ≥ 4.5:1（WCAG AA 正文）。
// 背景按最不利情况取：实底取最亮的那层面板；玻璃取「封面取色后最亮的夜色」透过 58% 的面板。
// --t-xlo 只给禁用态 / 装饰线用，不在正文之列。

const tokens = await readFile(new URL('./tokens.css', import.meta.url), 'utf8');
const token = name => {
  const match = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `${name} 未定义`);
  return match[1].trim();
};

function parse(color) {
  let m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).concat(1);
  m = color.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return [r / 255, g / 255, b / 255, a];
  }
  throw new Error(`不认识的颜色 ${color}`);
}

function hsl(h, s, l, a = 1) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const f = n => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4), a];
}

const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const lum = ([r, g, b]) => {
  const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (fg, bg) => {
  const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

const BODY_TEXT = ['--t-hi', '--text', '--t-mid', '--t-lo', '--t-placeholder', '--accent', '--warn-ink', '--ok'];
const HUES = Array.from({ length: 12 }, (_, i) => i * 30);

function backgrounds(material) {
  const panels = ['--ink-0', '--ink-1', '--ink-2', '--ink-3', '--studio-surface-solid'].map(name => parse(token(name)));
  // 封面取色后最亮的一点：radial 中心 hsl(h 40% 27% / .5) 叠在 linear 上端 hsl(h 24% 13%)。
  const brightest = HUES.map(h => over(hsl(h, 40, 27, 0.5), hsl(h, 24, 13)));
  const neutral = over(hsl(32, 9, 19, 0.9), hsl(32, 8, 13));
  const stages = [...brightest, neutral];
  if (material === 'flat') return [...panels, ...stages];
  const glass = parse(token('--ink-1')).slice(0, 3).concat(0.58);
  return [...stages.map(stage => over(glass, stage)), ...stages];
}

for (const material of ['flat', 'glass']) {
  test(`夜场 ${material === 'flat' ? '实底' : '玻璃'}：正文文字对比度 ≥ 4.5:1`, () => {
    const failures = [];
    for (const name of BODY_TEXT) {
      const fg = parse(token(name));
      const worst = Math.min(...backgrounds(material).map(bg => ratio(fg, bg)));
      if (worst < 4.5) failures.push(`${name} ${worst.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('时间线的三级文字只映射到通过上面检查的 token', async () => {
  const timeline = await readFile(new URL('../../features/shell/timeline.css', import.meta.url), 'utf8');
  assert.match(timeline, /--timeline-ink-2: var\(--t-mid\);/);
  assert.match(timeline, /--timeline-ink-3: var\(--t-lo\);/);
});
