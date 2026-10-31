import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// 「标宋」字阶契约（specs/nocturne-theme「Biaosong type scale」）：
// 一级 900 只给当前歌名与页面标题；二级 400；正文 300；数字 Bodoni 500 等宽；窄屏正文至少 400。
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const rulesUsing = (css, needle) => css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter(rule => rule.includes(needle))
  .map(rule => rule.slice(0, rule.indexOf('{')).replace(/\s+/g, ' ').trim());

test('字重 token 与字族', async () => {
  const tokens = await read('./tokens.css');
  assert.match(tokens, /--weight-heavy: 900; --weight-regular: 400; --weight-light: 300; --weight-number: 500;/);
  // 拉丁排在宋体前面：英文走 Newsreader，中文逐字回退到标宋。
  assert.match(tokens, /--font-display: 'Lunara Latin', 'Lunara Serif', 'Noto Serif SC', 'Songti SC'/);
  assert.match(tokens, /--font-reading: 'Lunara Latin', 'Lunara Serif', 'Noto Serif SC', 'Songti SC'/);
  assert.match(tokens, /--font-ui: 'Lunara Sans', 'Noto Sans SC'/);
  assert.match(tokens, /--font-number: 'Lunara Number', 'Bodoni Moda'/);
});

test('900 只出现在当前歌名与页面标题上', async () => {
  const timeline = rulesUsing(await read('../../features/shell/timeline.css'), '--weight-heavy');
  assert.deepEqual(timeline, [':root[data-layout="timeline"] #app .listening-song-title']);
  const overrides = rulesUsing(await read('./overrides.css'), '--weight-heavy');
  assert.deepEqual(overrides, [':root[data-theme="nocturne"] .settings-page-title', ':root[data-theme="nocturne"] .shell-page-title']);
});

test('时刻与序号用 Bodoni 500 等宽数字', async () => {
  const timeline = await read('../../features/shell/timeline.css');
  for (const selector of ['#app .timeline-clock {', '#app :is(.timeline-order, .timeline-at) {']) {
    const rule = timeline.slice(timeline.indexOf(selector), timeline.indexOf('}', timeline.indexOf(selector)));
    assert.match(rule, /var\(--weight-number, 500\)[^;]*var\(--font-number/, selector);
    assert.match(rule, /tabular-nums/, selector);
  }
});

// 正文、旁白、歌词一律 400。15–20px 的 300 宋体笔画只占约 1 个设备像素，栅格化按亚像素位置取整，
// 同一个字里有的笔画是 1px、有的是 2px 灰带，整段就会「有的字粗、有的字细」——与字重、字体、子集都
// 无关，整数 2 倍屏也会出现。所以不用媒体查询兜着，直接不让阅读级正文引用 300。
test('阅读级正文用 400，不用 300', async () => {
  const overrides = await read('./overrides.css');
  const timeline = await read('../../features/shell/timeline.css');
  const tokens = await read('./tokens.css');
  // 聊天气泡、串词、旁白都不再引用细字 token，也没有按像素比的临时覆盖。
  assert.doesNotMatch(overrides, /font-weight: var\(--weight-light\)/);
  assert.doesNotMatch(overrides, /max-resolution/);
  assert.match(overrides, /:root\[data-theme="nocturne"\] \.chat-msg\.assistant \.chat-bubble \{[^}]*font-weight: var\(--weight-regular\); \}/);
  assert.doesNotMatch(timeline, /var\(--weight-light/);
  for (const selector of ['.listening-intro p {']) {
    const rule = timeline.slice(timeline.indexOf(selector), timeline.indexOf('}', timeline.indexOf(selector)));
    assert.match(rule, /var\(--weight-regular, 400\)/, selector);
  }
  // token 与字体文件留着给 ≥24px 的大字号，不删也不许正文再引用。
  assert.match(tokens, /--weight-light: 300/);
});


test('「标宋」字体同源打包：独立族名、swap、文件都在，只被夜场引用', async () => {
  const { stat } = await import('node:fs/promises');
  const css = await readFile(new URL('../../assets/fonts/nocturne-fonts.css', import.meta.url), 'utf8');
  const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map(m => m[1]);
  assert.deepEqual(faces.map(f => `${f.match(/font-family: '([^']+)'/)[1]} ${f.match(/font-weight: ([\d ]+);/)[1]}`),
    ['Lunara Serif 900', 'Lunara Serif 400', 'Lunara Serif 500 800', 'Lunara Serif 300', 'Lunara Sans 400',
      'Lunara Number 500', 'Lunara Latin 300', 'Lunara Latin 400', 'Lunara Latin 500 600', 'Lunara Latin 700 900']);
  for (const face of faces) {
    assert.match(face, /font-display: swap;/);
    const src = face.match(/src: url\((\/assets\/fonts\/[\w.-]+\.woff2)\) format\('woff2'\)/);
    assert.ok(src, '只引用同源 woff2');
    assert.ok((await stat(new URL(`../..${src[1]}`, import.meta.url))).size > 1000, src[1]);
  }
  assert.doesNotMatch(css, /https?:/);
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/assets\/fonts\/nocturne-fonts.css" \/>/);
  for (const theme of ['moonlight', 'modernist']) {
    const themeTokens = await readFile(new URL(`../${theme}/tokens.css`, import.meta.url), 'utf8');
    assert.doesNotMatch(themeTokens, /Lunara (Serif|Latin|Sans|Number)/, theme);
  }
  const overrides = await readFile(new URL('./overrides.css', import.meta.url), 'utf8');
  assert.match(overrides, /:root\[data-theme="nocturne"\] body \{[^}]*font-family: var\(--font-ui\);/);
});

test('拉丁族四个字重档都是同源拉丁子集', async () => {
  const { stat } = await import('node:fs/promises');
  const css = await readFile(new URL('../../assets/fonts/nocturne-fonts.css', import.meta.url), 'utf8');
  const latin = [...css.matchAll(/@font-face \{([^}]*'Lunara Latin'[^}]*)\}/g)].map(m => m[1]);
  assert.equal(latin.length, 4, '300 / 400 / 500–600 / 700–900 四档');
  for (const face of latin) {
    assert.match(face, /font-style: normal;/);
    assert.match(face, /font-display: swap;/);
    const src = face.match(/src: url\((\/assets\/fonts\/nocturne-latin-(?:300|400|500|800)\.woff2)\)/);
    assert.ok(src, face.trim());
    const { size } = await stat(new URL(`../..${src[1]}`, import.meta.url));
    // 拉丁子集只有几百个字形；超过 300KB 通常意味着误把汉字一起打了进去（opsz 可变也就是几十 KB）。
    assert.ok(size > 5000 && size < 300 * 1024, `${src[1]} ${size} bytes`);
  }
});

test('字标转成路径，不依赖字体文件', async () => {
  const svg = await readFile(new URL('../../assets/brand/orbit-wordmark.svg', import.meta.url), 'utf8');
  assert.doesNotMatch(svg, /<text|font-family|Gradient/);
  assert.match(svg, /<path fill="currentColor" d="M[^"]{200,}"\/>/);
});
