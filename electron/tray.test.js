import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopTray } from './tray.js';

function fakeElectron({ emptyIcon = false } = {}) {
  const iconImage = { isEmpty: () => emptyIcon, isTemplate: true };
  const tray = {
    tooltip: null, title: null, menu: null, image: null, destroyed: false,
    setToolTip(value) { this.tooltip = value; },
    setTitle(value) { this.title = value; },
    setImage(value) { this.image = value; },
    setContextMenu(menu) { this.menu = menu; },
    destroy() { this.destroyed = true; },
  };
  const created = [];
  return {
    tray,
    created,
    Tray: class { constructor(image) { created.push(image); return tray; } },
    Menu: { buildFromTemplate: template => ({ template }) },
    iconImage,
    nativeImage: { createFromPath: () => iconImage, createEmpty: () => ({ isEmpty: () => true }) },
  };
}

const actions = () => ({
  toggle: () => {}, previous: () => {}, next: () => {}, show: () => {}, quit: () => {},
});

test('macOS tray is a template icon with the track title beside it', () => {
  const fake = fakeElectron();
  const controller = createDesktopTray({
    ...fake, platform: 'darwin', icons: { macTemplate: '/icons/menuTemplate.png' }, actions: actions(),
  });
  assert.equal(controller.state().hasTrack, false);
  assert.equal(fake.tray.tooltip, 'Lunara · 未在播放');
  assert.equal(fake.tray.title, '', '没有内容时菜单栏只留图标');

  controller.setState({ title: 'Forever Love', artist: '王力宏', playing: true, canPrevious: true });
  assert.equal(fake.tray.title, 'Forever Love', '菜单栏只放曲名');
  assert.equal(fake.tray.tooltip, 'Lunara · 正在播放：Forever Love — 王力宏');
  assert.equal(fake.tray.menu.template[0].label, 'Forever Love — 王力宏');
  assert.equal(fake.tray.menu.template.find(item => item.label === '暂停').enabled, true);

  controller.destroy();
  assert.equal(fake.tray.destroyed, true);
});

test('the menu bar text can be turned off without touching icon or menu', () => {
  const fake = fakeElectron();
  const controller = createDesktopTray({
    ...fake, platform: 'darwin', showTitleText: false,
    icons: { macTemplate: '/icons/menuTemplate.png' }, actions: actions(),
  });
  controller.setState({ title: 'Forever Love', playing: true });
  assert.equal(fake.tray.title, '', 'LUNARA_TRAY_TITLE=0 只关文字');
  assert.ok(fake.tray.menu, '菜单仍然可用');
});

test('windows tray uses the colour icon and never sets a title', () => {
  const fake = fakeElectron();
  const controller = createDesktopTray({
    ...fake, platform: 'win32', icons: { windows: '/icons/tray-win.png' }, actions: actions(),
  });
  controller.setState({ title: 'A', playing: true });
  assert.equal(fake.tray.title, null, 'Windows 托盘没有标题文字');
  assert.equal(fake.tray.tooltip, 'Lunara · 正在播放：A');
  assert.equal(controller.state().playing, true);
});

test('歌词/进度推送不重建菜单：开着的菜单不能被换掉（点了没反应的回归）', () => {
  const fake = fakeElectron();
  let menus = 0;
  fake.tray.setContextMenu = menu => { menus += 1; fake.tray.menu = menu; };
  const controller = createDesktopTray({
    ...fake, platform: 'darwin', icons: { macTemplate: '/icons/menuTemplate.png' }, actions: actions(),
  });
  const afterBoot = menus; // 创建时的空菜单算第一次
  controller.setState({ title: '错过', artist: '梁咏琪', playing: true, canPrevious: false });
  const afterTrack = menus;
  assert.equal(afterTrack, afterBoot + 1, '换曲重建一次菜单');

  // 播放中的歌词推送：每句歌词、每次扫色进度都过线（真实频率约每秒一次），
  // 这些只影响菜单栏文字/图像，绝不能把正开着的菜单换掉。
  for (const push of [
    { title: '错过', artist: '梁咏琪', playing: true, canPrevious: false, textMode: 'lyrics', subtitle: '我们都有过错' },
    { title: '错过', artist: '梁咏琪', playing: true, canPrevious: false, textMode: 'lyrics', subtitle: '我们都有过错', subtitleProgress: 0.42, subtitleSpanMs: 4000 },
    { title: '错过', artist: '梁咏琪', playing: true, canPrevious: false, textMode: 'lyrics', subtitle: '错过 我们都有过错', subtitleProgress: 0.9, subtitleSpanMs: 4000 },
  ]) controller.setState(push);
  assert.equal(menus, afterTrack, '菜单保持原样，用户手里开着的菜单不被替换');

  controller.setState({ title: '错过', artist: '梁咏琪', playing: false, canPrevious: false });
  assert.equal(menus, afterTrack + 1, '播放/暂停真的变了才重建（换「播放」标签）');
  assert.equal(fake.tray.menu.template.find(item => item.label === '播放').enabled, true);
  controller.destroy();
});

test('a missing icon degrades to no tray instead of breaking the app', () => {
  const warnings = [];
  const controller = createDesktopTray({
    ...fakeElectron({ emptyIcon: true }), platform: 'darwin',
    icons: { macTemplate: '/icons/missing.png' }, actions: actions(),
    onWarn: message => warnings.push(message),
  });
  assert.equal(controller, null);
  assert.match(warnings[0], /icon unavailable/);
});

function scrollTray({ platform = 'darwin', lyric = '' } = {}) {
  const fake = fakeElectron();
  const callbacks = [];
  const handles = [];
  const controller = createDesktopTray({
    ...fake, platform,
    icons: platform === 'darwin' ? { macTemplate: '/icons/menuTemplate.png' } : { windows: '/icons/tray-win.png' },
    actions: actions(),
    schedule: (callback) => { callbacks.push(callback); const handle = { cancelled: false }; handles.push(handle); return handle; },
    cancelSchedule: handle => { handle.cancelled = true; },
    state: undefined,
  });
  return { fake, controller, callbacks, handles, lyric };
}

test('a long lyric line scrolls in the menu bar while playing', () => {
  const line = '爱你不只是因为你的美而已我越来越爱';
  const { fake, controller, callbacks, handles } = scrollTray();
  controller.setState({ title: 'Forever Love', textMode: 'lyrics', subtitle: line, playing: true });
  assert.equal(fake.tray.title, [...line].slice(0, 16).join(''), '先停在第一帧');
  assert.equal(callbacks.length, 1, '排了一个帧定时器');

  callbacks[0](); // 走一帧
  const frame1 = fake.tray.title;
  assert.equal([...frame1][0], [...line][1], '每帧右移一个字');
  assert.equal([...frame1].length, 16, '每帧宽度恒定，旁边的菜单栏图标不会被推来推去');
  callbacks[0]();
  const frame2 = fake.tray.title;
  assert.equal([...frame2][0], [...line][2]);
  assert.notEqual(frame2, frame1);

  // 同一行继续滚：状态再推送一次不能把进度重置回第一帧
  controller.setState({ title: 'Forever Love', textMode: 'lyrics', subtitle: line, playing: true });
  assert.equal(fake.tray.title, frame2, '进度保持不变');
  assert.equal(callbacks.length, 1, '不会叠加第二个定时器');

  controller.destroy();
  assert.equal(handles[0].cancelled, true, '销毁时停掉定时器');
});

test('a paused line stays on the first frame and does not animate', () => {
  const line = '爱你不只是因为你的美而已我越来越爱';
  const { fake, controller, callbacks } = scrollTray();
  controller.setState({ title: 'T', textMode: 'lyrics', subtitle: line, playing: false });
  assert.equal(fake.tray.title, [...line].slice(0, 16).join(''));
  assert.equal(callbacks.length, 0, '暂停时不排定时器');
  controller.destroy();
});

test('a short line animates too, in a window sized to that line', () => {
  // 用户实测：13 字的整句因为「没超过窗宽」被静态显示，看起来像没有动效。
  // 歌词模式的动效不该拿行长短当开关。
  const line = '我在人间彷徨';
  const short = scrollTray();
  short.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: line, playing: true });
  assert.equal(short.callbacks.length, 1, '短句也要排帧定时器');
  const first = short.fake.tray.title;
  assert.equal([...first].length, [...line].length + 2, '窗宽随行长度收敛，不留半屏空白');
  short.callbacks[0]();
  assert.notEqual(short.fake.tray.title, first, '确实在动');
  assert.equal([...short.fake.tray.title].length, [...first].length, '宽度保持恒定');
  short.controller.destroy();

  const titleMode = scrollTray();

  titleMode.controller.setState({ title: '标题', textMode: 'title', subtitle: '一句很长的歌词本来滚动但目前是曲名模式', playing: true });
  assert.equal(titleMode.fake.tray.title, '标题');
  assert.equal(titleMode.callbacks.length, 0, '曲名模式不滚动，长曲名仍用省略号');
  titleMode.controller.destroy();
});

test('windows never writes a title, so no scroll timer runs there', () => {
  const line = '爱你不只是因为你的美而已我越来越爱';
  const { fake, controller, callbacks } = scrollTray({ platform: 'win32' });
  controller.setState({ title: 'T', textMode: 'lyrics', subtitle: line, playing: true });
  assert.equal(fake.tray.title, null);
  assert.equal(callbacks.length, 0);
  controller.destroy();
});

// ---- 图像路径：两色扫色（卡拉OK） ----

function imageTray({ shouldUseDarkColors = true } = {}) {
  const fake = fakeElectron();
  const callbacks = [];
  const handles = [];
  const renders = [];
  let clock = 1_000_000;
  const canvas = {
    widthPx: 400,
    textWidthPx: 360,
    async measure() { return 700; }, // 一行比窗口宽：会左移
    async render(payload) { renders.push(payload); return { fakeImage: true, ...payload }; },
  };
  const controller = createDesktopTray({
    ...fake, platform: 'darwin',
    icons: { macTemplate: '/icons/menuTemplate.png' },
    actions: actions(),
    lyricCanvas: canvas,
    nativeTheme: { shouldUseDarkColors, on() {} },
    now: () => clock,
    schedule: (callback) => { callbacks.push(callback); const handle = { cancelled: false, callback }; handles.push(handle); return handle; },
    cancelSchedule: handle => { handle.cancelled = true; },
  });
  return {
    fake, controller, callbacks, handles, renders,
    advance: ms => { clock += ms; },
    tick: async () => { callbacks.at(-1)?.(); await new Promise(r => setImmediate(r)); },
  };
}

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise(r => setImmediate(r)); };

test('leaving the lyric image restores the template icon instead of vanishing', async () => {
  const t = imageTray();
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '一句歌词', subtitleProgress: 0.4, subtitleSpanMs: 4000, playing: true });
  await settle();
  assert.equal(t.controller.hasImage(), true);

  // 歌曲结束/清空：菜单栏项既没有图也没有标题时，用户看到的是「凭空消失」。
  t.controller.setState({ title: '', textMode: 'lyrics', subtitle: '', playing: false });
  await settle();
  assert.equal(t.controller.hasImage(), false);
  assert.equal(t.fake.tray.image?.isEmpty?.(), false, '必须换回月亮模板图，而不是空图');
  assert.deepEqual(t.fake.tray.image, t.fake.iconImage, '恢复的就是启动时那张模板图');

  // 切回曲名模式同理
  t.controller.setState({ title: '标题', textMode: 'title', playing: false });
  await settle();
  assert.equal(t.fake.tray.image?.isEmpty?.(), false, '曲名模式也要有图标');
  t.controller.destroy();
});

test('a playing lyric renders a two-tone image instead of menu bar text', async () => {
  const t = imageTray();
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '我在人间彷徨 寻不到你的天堂 我在人间等待',
    subtitleProgress: 0.1, subtitleSpanMs: 8000, playing: true });
  await settle();
  assert.equal(t.fake.tray.title, '', '图像模式下不写系统文字');
  assert.equal(t.controller.hasImage(), true, '菜单栏项吃的是渲染出来的图');
  const first = t.renders.at(-1);
  assert.equal(first.shift, 0, '开头从窗口左缘开始');
  assert.ok(first.clipRight > 0 && first.clipRight < 360, '只染到进度点（窗口已扣掉左侧图标位）');
  assert.equal(first.palette.bright, '#ffffff', '深色菜单栏用白字');
  assert.equal(t.callbacks.length, 1, '播放中排了帧定时器');

  // 时间前进 → 进度插值 → 染色变长 → 到右缘后整行左移
  t.advance(2400); // 0.1 + 2400/8000 = 0.4
  await t.tick();
  const second = t.renders.at(-1);
  assert.ok(second.clipRight > first.clipRight, '染色区变长');
  t.advance(3200); // 0.8 → 越过右缘，开始左移
  await t.tick();
  assert.ok(t.renders.at(-1).shift > 0, '进度到右缘后整行左移');
  t.controller.destroy();
});

test('a new line switches immediately and restarts from the left edge', async () => {
  const t = imageTray();
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '第一句很长的歌词第一句很长的歌词', subtitleProgress: 0.9, subtitleSpanMs: 4000, playing: true });
  await settle();
  t.advance(3600);
  await t.tick();
  assert.ok(t.renders.at(-1).shift > 0);

  // 换句：立刻回到左缘、染色从 0 开始，不等旧句唱完
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '第二句', subtitleProgress: 0, subtitleSpanMs: 3000, playing: true });
  await settle();
  const switched = t.renders.at(-1);
  assert.equal(switched.text, '第二句');
  assert.equal(switched.shift, 0, '换句立刻归位');
  assert.equal(switched.clipRight, 0, '新句从零开始染');
  t.controller.destroy();
});

test('a paused lyric paints once and does not tick', async () => {
  const t = imageTray();
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '一句歌词', subtitleProgress: 0.4, subtitleSpanMs: 4000, playing: false });
  await settle();
  assert.equal(t.controller.hasImage(), true, '暂停时仍显示这一句');
  assert.equal(t.callbacks.length, 0, '暂停不排帧定时器');
  t.controller.destroy();
});

test('without a known span the line stays fully lit and does not animate', async () => {
  const t = imageTray();
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '一句歌词', subtitleProgress: null, subtitleSpanMs: null, playing: true });
  await settle();
  assert.equal(t.renders.at(-1).clipRight, 360, '不知道跨度就整窗全亮，不猜速度');
  assert.equal(t.callbacks.length, 0);
  t.controller.destroy();
});

test('the light menu bar gets the dark palette', async () => {
  const t = imageTray({ shouldUseDarkColors: false });
  t.controller.setState({ title: 'T', textMode: 'lyrics', subtitle: '一句歌词', subtitleProgress: 0.5, subtitleSpanMs: 4000, playing: true });
  await settle();
  assert.equal(t.renders.at(-1).palette.bright, '#17171a');
  t.controller.destroy();
});

test('title mode never renders an image', async () => {
  const t = imageTray();
  t.controller.setState({ title: '标题', textMode: 'title', subtitle: '一句歌词', playing: true });
  await settle();
  assert.equal(t.renders.length, 0);
  assert.equal(t.controller.hasImage(), false);
  assert.equal(t.fake.tray.title, '标题');
  t.controller.destroy();
});
