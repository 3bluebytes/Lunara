import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_CHOICES, MATERIAL_CHOICES, appearanceMarkup, createAppearancePopover } from './appearancePop.js';

function element(id = null) {
  const attributes = new Map();
  const listeners = new Map();
  const styleValues = new Map();
  return {
    id, hidden: false, innerHTML: '', isConnected: true, dataset: {}, offsetHeight: 220, offsetWidth: 268,
    style: {
      setProperty: (name, value) => styleValues.set(name, value),
      removeProperty: name => styleValues.delete(name),
      getPropertyValue: name => styleValues.get(name) ?? '',
    },
    hovered: null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch: (type, event) => listeners.get(type)?.(event),
    focus() { fixture.active = this; },
    closest: () => null,
    querySelector: selector => (selector === '[aria-checked="true"]' ? fixture.checkedOption : null),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 96, bottom: 130, right: 940, left: 880, width: 60, height: 34 }),
  };
}

let fixture;
function setup({ theme = 'modernist', layout = 'stage', wired = {} } = {}) {
  const nodes = new Map();
  for (const id of ['#appearance-pop', '#appearance-quick', '#top-bar']) nodes.set(id, element(id));
  nodes.get('#appearance-pop').hidden = true;
  const docListeners = new Map();
  const viewListeners = new Map();
  fixture = {
    active: null,
    nodes,
    checkedOption: { focused: 0, focus() { this.focused += 1; fixture.active = this; } },
    documentLike: {
      documentElement: { dataset: { layout } },
      body: element('body'),
      defaultView: {
        innerWidth: 1024,
        innerHeight: 720,
        addEventListener: (type, fn) => viewListeners.set(type, fn),
        removeEventListener: type => viewListeners.delete(type),
      },
      get activeElement() { return fixture.active; },
      querySelector: selector => nodes.get(selector) || null,
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => { docListeners.get(type)?.delete(fn); },
      dispatch: (type, event) => { for (const fn of [...(docListeners.get(type) || [])]) fn(event); },
      scroll: () => { for (const fn of [...(docListeners.get('scroll') || [])]) fn({}); },
      resize: () => { viewListeners.get('resize')?.({}); },
    },
  };
  const calls = [];
  const state = { theme, material: 'flat', base: 'paper', artwork: false };
  const appearance = {
    themes: () => [
      { id: 'moonlight', name: '月色', swatch: 'moon' },
      { id: 'modernist', name: '素色', swatch: 'paper' },
      { id: 'nocturne', name: '时间线', swatch: 'night' },
    ],
    theme: () => state.theme,
    setTheme: id => { calls.push(['theme', id]); state.theme = id; wired.afterTheme?.(id, state); },
    material: () => state.material,
    setMaterial: name => { calls.push(['material', name]); state.material = name; },
    base: () => state.base,
    setBase: name => { calls.push(['base', name]); state.base = name; },
    artwork: () => state.artwork,
    setArtwork: enabled => { calls.push(['artwork', enabled]); state.artwork = enabled; },
  };
  const opened = [];
  const popover = createAppearancePopover({
    documentLike: fixture.documentLike,
    appearance,
    beforeOpen: () => opened.push('before'),
    onOpenChange: () => opened.push(popover.isOpen()),
    onSettings: () => calls.push(['settings']),
  }).init();
  return { popover, pop: nodes.get('#appearance-pop'), trigger: nodes.get('#appearance-quick'), calls, state, opened };
}

const clickOn = (target, attribute = 'data-look-theme', dataset = {}) => ({
  isConnected: true,
  closest: selector => (selector === `[${attribute}]` ? { dataset } : null),
});

test('appearanceMarkup：主题一组；材质只给夜场，底色只给素色，跟色只给读封面的主题', () => {
  const themes = [{ id: 'moonlight', name: '月色' }, { id: 'modernist', name: '素色' }, { id: 'nocturne', name: '时间线' }];
  const plain = appearanceMarkup({ themes, theme: 'moonlight' });
  assert.match(plain, /role="radiogroup" aria-labelledby="appearance-theme-cap"/);
  assert.equal((plain.match(/role="radio"/g) || []).length, 3);
  for (const text of ['材质', '底色', '封面跟色', 'data-look-artwork']) assert.doesNotMatch(plain, new RegExp(text));

  assert.match(appearanceMarkup({ themes, theme: 'nocturne', material: 'glass' }), /data-look-material="glass" aria-checked="true" tabindex="0"/);
  assert.deepEqual(MATERIAL_CHOICES.map(item => item.id), ['flat', 'glass']);

  const modernist = appearanceMarkup({ themes, theme: 'modernist', base: 'indigo' });
  assert.match(modernist, /data-look-base="indigo" aria-checked="true" tabindex="0"/);
  assert.doesNotMatch(modernist, /data-look-material|data-look-artwork/);
  assert.deepEqual(BASE_CHOICES.map(item => item.id), ['paper', 'indigo']);

  // 跟色是开 / 关，用 aria-pressed 表达，出现在读封面的两个主题里；没接线时不画（不摆无效操作）。
  assert.match(appearanceMarkup({ themes, theme: 'moonlight', artwork: true }), /data-look-artwork aria-pressed="true"/);
  assert.match(appearanceMarkup({ themes, theme: 'nocturne', artwork: false }), /data-look-artwork aria-pressed="false"/);
  assert.doesNotMatch(appearanceMarkup({ themes, theme: 'modernist', artwork: true }), /data-look-artwork/);
});

test('打开浮层：先收起宿主别的浮层，画当前状态，焦点落在已选项；关闭还原', () => {
  const { popover, pop, calls, opened } = setup();
  assert.equal(pop.hidden, true);
  popover.open();
  assert.deepEqual(opened, ['before', true]);
  assert.equal(pop.hidden, false);
  assert.match(pop.innerHTML, /data-look-theme="modernist" aria-checked="true" tabindex="0"/);
  assert.match(pop.innerHTML, /data-look-base="paper" aria-checked="true"/);
  assert.equal(fixture.checkedOption.focused, 1, '焦点落在当前选中项');
  popover.close();
  assert.equal(pop.hidden, true);
  assert.equal(popover.isOpen(), false);
  assert.deepEqual(calls, [], '开关浮层不写任何偏好');
});

test('触发器来回切换：开→关→开，不重复叠面板', () => {
  const { popover, pop } = setup();
  popover.toggle(); assert.equal(pop.hidden, false);
  popover.toggle(); assert.equal(pop.hidden, true);
  popover.toggle(); assert.equal(pop.hidden, false);
});

test('选项点击交给各自的控制器；换主题后按新主题重画分组', () => {
  const { popover, pop, calls, state } = setup();
  popover.open();
  pop.dispatch('click', { target: clickOn({}, 'data-look-base', { lookBase: 'indigo' }) });
  assert.deepEqual(calls, [['base', 'indigo']]);
  assert.match(pop.innerHTML, /data-look-base="indigo" aria-checked="true"/);

  pop.dispatch('click', { target: clickOn({}, 'data-look-theme', { lookTheme: 'nocturne' }) });
  assert.deepEqual(state.theme, 'nocturne');
  assert.match(pop.innerHTML, /data-look-material="flat" aria-checked="true"/, '夜场多出材质组');
  assert.doesNotMatch(pop.innerHTML, /data-look-base/);
});

test('跟色开关按当前状态取反，不靠 DOM 属性猜', () => {
  const { popover, pop, calls, state } = setup({ theme: 'moonlight' });
  popover.open();
  assert.match(pop.innerHTML, /data-look-artwork aria-pressed="false"/);
  pop.dispatch('click', { target: clickOn({}, 'data-look-artwork') });
  assert.deepEqual(calls, [['artwork', true]]);
  assert.equal(state.artwork, true);
  assert.match(pop.innerHTML, /data-look-artwork aria-pressed="true"/);
});

test('「更多外观设置」先收起浮层再交给宿主跳转', () => {
  const { popover, pop, calls } = setup();
  popover.open();
  pop.dispatch('click', { target: clickOn({}, 'data-look-settings') });
  assert.equal(popover.isOpen(), false);
  assert.deepEqual(calls, [['settings']]);
});

test('Esc 关闭并把焦点还给触发按钮（现取节点）；方向键只挪焦点', () => {
  const { popover, trigger } = setup();
  const focused = [];
  popover.open({ returnFocus: () => { focused.push('trigger'); trigger.focus(); } });
  fixture.documentLike.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(popover.isOpen(), false);
  assert.deepEqual(focused, ['trigger']);

  const group = ['paper', 'indigo'].map(id => ({ id, tabIndex: id === 'paper' ? 0 : -1, focus() { this.focused = true; }, click() { throw new Error('方向键不能选中'); } }));
  const parent = { querySelectorAll: () => group };
  group.forEach(item => { item.parentElement = parent; });
  popover.open();
  let prevented = false;
  fixture.documentLike.dispatch('keydown', { key: 'ArrowRight', preventDefault: () => { prevented = true; }, target: { closest: () => group[0] } });
  assert.equal(prevented, true);
  assert.deepEqual(group.map(item => item.tabIndex), [-1, 0]);
  assert.equal(popover.isOpen(), true);
});

test('点到浮层和两个触发器之外才收起；顶栏里重绘掉的节点不算点在外面', () => {
  const { popover } = setup();
  popover.open();
  assert.equal(fixture.checkedOption.focused >= 1, true);
  fixture.documentLike.dispatch('click', { target: { isConnected: false, closest: () => null } });
  assert.equal(popover.isOpen(), true, '脱离文档的 target 是顶栏重绘，不是外部点击');
  fixture.documentLike.dispatch('click', { target: { isConnected: true, closest: () => ({}) } });
  assert.equal(popover.isOpen(), true);
  fixture.documentLike.dispatch('click', { target: { isConnected: true, closest: () => null } });
  assert.equal(popover.isOpen(), false);
});

test('布局没变只重画选项；换到别的版式就收起（触发按钮已经随布局消失）', () => {
  const { popover, pop, state } = setup();
  popover.open();
  state.theme = 'nocturne';
  popover.sync();
  assert.equal(popover.isOpen(), true);
  assert.match(pop.innerHTML, /data-look-theme="nocturne" aria-checked="true"/, '同一版式里换主题：跟着重画分组');
  assert.match(pop.innerHTML, /data-look-material/);

  fixture.documentLike.documentElement.dataset.layout = 'timeline';
  popover.sync();
  assert.equal(popover.isOpen(), false);
  assert.equal(pop.hidden, true);
});

test('选主题把布局带走时，点击处理不会再往已关掉的浮层里放焦点', () => {
  let popover = null;
  const built = setup({ wired: { afterTheme: () => {
    fixture.documentLike.documentElement.dataset.layout = 'timeline';
    popover.sync();
  } } });
  popover = built.popover;
  popover.open();
  const focusedBefore = fixture.checkedOption.focused;
  built.pop.dispatch('click', { target: clickOn({}, 'data-look-theme', { lookTheme: 'nocturne' }) });
  assert.equal(popover.isOpen(), false);
  assert.equal(fixture.checkedOption.focused, focusedBefore, '浮层已收起，不再抢焦点');
});

test('贴按钮定位：只写坐标变量，关闭后清掉，免得下次用旧位置', () => {
  const { popover, pop, trigger } = setup();
  popover.open({ anchor: true });
  assert.equal(pop.style.getPropertyValue('--appearance-top'), '138px');
  assert.equal(pop.style.getPropertyValue('--appearance-right'), '84px');

  // 列表 / 页面滚动时跟着按钮走，不悬空。
  trigger.getBoundingClientRect = () => ({ top: 60, bottom: 94, right: 900, left: 840, width: 60, height: 34 });
  fixture.documentLike.scroll();
  assert.equal(pop.style.getPropertyValue('--appearance-top'), '102px');

  popover.close();
  assert.equal(pop.style.getPropertyValue('--appearance-top'), '');
  assert.equal(pop.style.getPropertyValue('--appearance-right'), '');
});

test('不贴按钮时（时间线顶栏）不写坐标，位置仍由 CSS 决定', () => {
  const { popover, pop } = setup({ layout: 'timeline' });
  popover.open();
  assert.equal(pop.style.getPropertyValue('--appearance-top'), '');
  assert.equal(pop.style.getPropertyValue('--appearance-right'), '');
});

test('两套版式各有自己的触发器，共用同一个浮层元素', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../app.js', import.meta.url), 'utf8');
  const stage = await readFile(new URL('./stage.css', import.meta.url), 'utf8');
  const timeline = await readFile(new URL('./timeline.css', import.meta.url), 'utf8');

  assert.equal((html.match(/id="appearance-pop"/g) || []).length, 1, '浮层只有一个，由共享控制器独占');
  // 舞台版式的入口在听歌列页眉的工具组里，和全屏并列；时间线由顶栏「外观」承担。
  assert.match(html, /class="listening-toolbar-actions">[\s\S]*id="appearance-quick"[\s\S]*id="focus-mode-enter"/);
  assert.match(html, /id="appearance-quick"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="appearance-pop"/);
  // 和全屏聆听一样是纯图标按钮：可见文字只有图标，可访问名称来自 aria-label。
  assert.match(html, /aria-label="外观与主题">\s*<svg[\s\S]{0,220}?<\/svg>\s*<\/button>/);
  assert.doesNotMatch(html, /id="appearance-quick"[\s\S]{0,400}?<span>外观<\/span>/);
  // 页眉工具组是并排的一行，两个入口同一尺寸（尺寸复用 conversations.css 的纯图标入口规则）。
  const conversations = await readFile(new URL('../conversations/conversations.css', import.meta.url), 'utf8');
  assert.match(stage, /:root\[data-layout="stage"\] \.listening-toolbar-actions \{ flex-direction: row;/);
  assert.match(conversations, /#app #focus-mode-enter,\n#app #appearance-quick \{/, '两个纯图标入口共用同一份尺寸规则');
  assert.match(timeline, /:root\[data-layout="timeline"\] #app #appearance-quick \{ display: none; \}/, '时间线的隐藏规则要压过纯图标入口的两个 ID');
  assert.match(stage, /:root\[data-layout="stage"\] \.appearance-pop:not\(\[hidden\]\) \{[^}]*position: fixed;/);
  assert.match(stage, /:root\[data-layout="stage"\] \.appearance-pop:not\(\[hidden\]\) \{[^}]*top: var\(--appearance-top/);

  // 两个触发器接的是同一个控制器：舞台页眉贴按钮弹出，顶栏那处由 topBarView 转进来。
  assert.match(app, /appearancePop = createAppearancePopover\(/);
  assert.match(app, /\$\('#appearance-quick'\)\?\.addEventListener\('click', \(\) => appearancePop\.toggle\(\{/);
  assert.match(app, /appearance: appearancePop,/);
  assert.match(app, /appearancePop\?\.sync\(\)/, '换主题后同步浮层（布局变了就收起）');
});
