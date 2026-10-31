import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRAY_LYRIC_WINDOW, buildTrayMenuTemplate, normalizeTrayState, trayMenuSignature, trayScrollFrame, trayTitlePlan, trayTitleText, trayTooltip,
} from './trayModel.js';

const labelOf = (template, index) => template[index].label;
const byLabel = (template, label) => template.find(item => item.label === label);

test('a track that is playing shows a pause action and a quiet title', () => {
  const state = { title: 'Forever Love', artist: '王力宏', playing: true, canPrevious: true };
  assert.equal(trayTitleText(state), 'Forever Love', '菜单栏只放曲名，不显示播放/暂停标记');
  assert.equal(trayTooltip(state), 'Lunara · 正在播放：Forever Love — 王力宏');
  const template = buildTrayMenuTemplate(state, {});
  assert.equal(labelOf(template, 0), 'Forever Love — 王力宏', '曲目行在最上面');
  assert.equal(template[0].enabled, false, '信息行不可点');
  assert.equal(byLabel(template, '暂停').enabled, true);
  assert.equal(byLabel(template, '上一首').enabled, true);
  assert.equal(byLabel(template, '下一首').enabled, true);
});

test('a paused track flips only the action label', () => {
  const state = { title: 'Forever Love', artist: '王力宏', playing: false, canPrevious: false };
  assert.equal(trayTitleText(state), 'Forever Love', '暂停不改变菜单栏文字');
  assert.equal(trayTooltip(state), 'Lunara · 已暂停：Forever Love — 王力宏');
  const template = buildTrayMenuTemplate(state, {});
  assert.equal(byLabel(template, '播放').enabled, true);
  assert.equal(byLabel(template, '上一首').enabled, false, '队首：上一首灰掉');
});

test('trayMenuSignature 只含菜单字段：歌词行与扫色进度不进签名', () => {
  const base = { title: '错过', artist: '梁咏琪', playing: true, canPrevious: false };
  // 歌词模式、换行、扫色进度变化——菜单栏文字会变，但菜单内容没变，不该重建菜单。
  assert.equal(trayMenuSignature(base), trayMenuSignature({ ...base, textMode: 'lyrics', subtitle: '我们都有过错' }));
  assert.equal(trayMenuSignature(base), trayMenuSignature({ ...base, textMode: 'lyrics', subtitle: '错过 我们都有过错', subtitleProgress: 0.42, subtitleSpanMs: 4000 }));
  // 这些字段会真的出现在菜单里，必须重建。
  assert.notEqual(trayMenuSignature(base), trayMenuSignature({ ...base, playing: false }), '播放/暂停换标签');
  assert.notEqual(trayMenuSignature(base), trayMenuSignature({ ...base, canPrevious: true }), '上一首可用性');
  assert.notEqual(trayMenuSignature(base), trayMenuSignature({ ...base, title: '另一首' }), '曲目行文案');
  assert.notEqual(trayMenuSignature(base), trayMenuSignature(null), '没有内容时');
});

test('nothing playing leaves the icon alone and greys the transport', () => {
  for (const empty of [null, undefined, {}, { title: '   ' }, { artist: '只给了艺人' }]) {
    assert.equal(trayTitleText(empty), '', '没有内容时不占菜单栏文字');
    assert.equal(trayTooltip(empty), 'Lunara · 未在播放');
    const template = buildTrayMenuTemplate(empty, {});
    assert.equal(labelOf(template, 0), '未在播放');
    assert.equal(byLabel(template, '播放').enabled, false);
    assert.equal(byLabel(template, '上一首').enabled, false);
  }
});

test('playback state is never invented without a track', () => {
  // 只有 playing 标记但没有曲目：不能报成「正在播放」，否则托盘会撒谎。
  const state = normalizeTrayState({ playing: true, canPrevious: true });
  assert.equal(state.hasTrack, false);
  assert.equal(state.playing, false);
  assert.equal(state.canPlayPause, false);
  assert.equal(state.canPrevious, false);
});

test('a very long title is clipped so it cannot eat the menu bar', () => {
  const title = '一首名字非常非常长的歌曲标题用来测试截断逻辑是否生效并且不会无限延伸';
  const text = trayTitleText({ title, playing: true }, { limit: 12 });
  assert.equal(text.length, 12);
  assert.match(text, /…$/, '截断要有明确的省略号');
  assert.ok(text.length < title.length, '长标题必须真的被截短');
});

test('menu items call the injected actions in a fixed order', () => {
  const calls = [];
  const actions = {
    toggle: () => calls.push('toggle'),
    previous: () => calls.push('previous'),
    next: () => calls.push('next'),
    show: () => calls.push('show'),
    quit: () => calls.push('quit'),
  };
  const template = buildTrayMenuTemplate({ title: 'A', playing: true }, actions);
  assert.deepEqual(template.map(item => item.label ?? item.type),
    ['A', 'separator', '暂停', '上一首', '下一首', 'separator', '显示 Lunara', '退出']);
  for (const item of template) item.click?.();
  assert.deepEqual(calls, ['toggle', 'previous', 'next', 'show', 'quit']);
});

test('disabled items do not run their action', () => {
  const calls = [];
  const template = buildTrayMenuTemplate({}, { toggle: () => calls.push('toggle') });
  const play = byLabel(template, '播放');
  assert.equal(play.enabled, false);
  // Electron 不会给禁用项派发 click；这里确认 enabled 标记本身是唯一判据。
  assert.equal(typeof play.click, 'function');
});

test('lyric mode puts the current line in the menu bar and falls back to the title', () => {
  const base = { title: 'Forever Love', artist: '王力宏', playing: true };
  // 歌词模式一律滚动：静态渲染取的是第 0 帧（整句 + 两个全角空格）
  assert.equal(trayTitleText({ ...base, textMode: 'lyrics', subtitle: '爱你 不是因为你的美而已' }),
    '爱你 不是因为你的美而已\u3000\u3000');
  // 前奏、纯音乐、还没走到第一句：宁可显示曲名，也不显示占位文案
  assert.equal(trayTitleText({ ...base, textMode: 'lyrics', subtitle: '' }), 'Forever Love');
  assert.equal(trayTitleText({ ...base, textMode: 'lyrics' }), 'Forever Love');
  // 默认（没传模式）仍是曲名
  assert.equal(trayTitleText({ ...base, subtitle: '某句歌词' }), 'Forever Love');
});

test('a long lyric line scrolls instead of being cut with an ellipsis', () => {
  const line = '这是一句非常非常长的歌词用来验证菜单栏不会因为一句歌词就被撑到屏幕的另一边去';
  const plan = trayTitlePlan({ title: 'A', textMode: 'lyrics', subtitle: line, playing: true });
  assert.equal(plan.kind, 'scroll');
  assert.equal(plan.text, line, '滚动方案拿到整行，由托盘按帧取窗口');
  const frame = trayScrollFrame(plan.text, 0);
  assert.equal([...frame].length, TRAY_LYRIC_WINDOW, '每帧宽度恒定');
  assert.equal(frame, [...line].slice(0, TRAY_LYRIC_WINDOW).join(''));
});

test('scrolling frames walk the line and loop through a gap', () => {
  const line = '第一句歌词第二句歌词第三句歌词';
  const width = 8;
  const frames = [0, 1, 2, 3].map(offset => trayScrollFrame(line, offset, { window: width }));
  assert.deepEqual(frames, ['第一句歌词第二句', '一句歌词第二句歌', '句歌词第二句歌词', '歌词第二句歌词第']);
  // 走到行尾之后接两个全角空格再回卷，帧宽不变
  const atEnd = trayScrollFrame(line, [...line].length, { window: width });
  assert.equal([...atEnd].length, width);
  assert.match(atEnd, /^\u3000\u3000/);
});

test('lyrics always scroll, with the window shrinking to fit short lines', () => {
  const short = trayTitlePlan({ title: 'T', textMode: 'lyrics', subtitle: '我在人间彷徨', playing: true });
  assert.equal(short.kind, 'scroll', '短句也要有动效：不拿长度当开关');
  assert.equal(short.window, [...'我在人间彷徨'].length + 2, '窗宽 = 整句 + 两个全角空格');
  const framed = trayScrollFrame(short.text, 0, { window: short.window });
  assert.equal([...framed].length, short.window);
  assert.match(framed, /\u3000\u3000$/, '首帧就是整句 + 间隔');

  const long = trayTitlePlan({ title: 'T', textMode: 'lyrics', subtitle: '第一句歌词第二句歌词第三句歌词第四句', playing: true });
  assert.equal(long.kind, 'scroll');
  assert.equal(long.window, TRAY_LYRIC_WINDOW, '长句用窗宽上限');
});

test('a long title is still clipped, not scrolled', () => {
  const text = trayTitleText({ title: '这是一首名字非常长的歌用来验证曲名会被截断并且不会无限延伸下', playing: true });
  assert.match(text, /…$/);
  assert.equal(trayTitlePlan({ title: '短标题', playing: true }).kind, 'static');
});

test('the menu bar never shows a lyric when there is no track', () => {
  assert.equal(trayTitleText({ textMode: 'lyrics', subtitle: '一句歌词' }), '',
    '没有曲目时只留图标，哪怕上游给了歌词行');
});

test('a missing progress is null, not zero percent', () => {
  // Number(null) === 0 是这里最容易踩的坑：没有进度必须表示「没法扫色」。
  for (const missing of [undefined, null, '']) {
    assert.equal(normalizeTrayState({ title: 'A', subtitle: 'B', subtitleProgress: missing }).subtitleProgress, null);
  }
  assert.equal(normalizeTrayState({ title: 'A', subtitle: 'B', subtitleProgress: 0 }).subtitleProgress, 0,
    '真正的 0% 要保留');
  assert.equal(normalizeTrayState({ title: 'A', subtitle: 'B', subtitleProgress: 1.7 }).subtitleProgress, 1, '越界收敛');
  assert.equal(normalizeTrayState({ title: 'A', subtitleSpanMs: 0 }).subtitleSpanMs, null, '跨度 0 等于没有');
});
