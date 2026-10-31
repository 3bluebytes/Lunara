import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

import { createAppearancePopover } from './appearancePop.js';
import { OVERLAY_CLASS, TOP_BAR_DESTINATIONS, createTopBarView } from './topBarView.js';

function element(id = null) {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    id, hidden: false, inert: true, isConnected: true, offsetParent: {}, dataset: {}, innerHTML: '', clicks: 0,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) { (force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch(type, event) { return listeners.get(type)?.(event); },
    click() { this.clicks += 1; },
    focus() { fixture.active = this; },
    closest() { return null; },
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

let fixture;
function setup({ layout = 'timeline', page = 'rooms', appearance = null } = {}) {
  const nodes = new Map();
  for (const id of ['#top-bar', '#conversation-sidebar', '#room-search', '#room-list', '#people-list', '#room-row-menu', '#nav-conversations',
    '#nav-radio', '#nav-today', '#nav-people', '#nav-settings', '#person-detail', '#person-detail-name', '#person-detail-switch', '#people-list-create', '#appearance-pop']) nodes.set(id, element(id));
  nodes.get('#appearance-pop').hidden = true;
  nodes.get('#room-row-menu').hidden = true;
  nodes.get('#conversation-sidebar').classList.add('expanded');
  if (page !== 'rooms') nodes.get(`#nav-${page}`).setAttribute('aria-current', 'page');
  const docListeners = new Map();
  fixture = {
    active: null,
    nodes,
    documentLike: {
      documentElement: { dataset: { layout } },
      body: element('body'),
      get activeElement() { return fixture.active; },
      querySelector: selector => nodes.get(selector) || null,
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => { docListeners.get(type)?.delete(fn); },
      dispatch: (type, event) => { for (const fn of [...(docListeners.get(type) || [])]) fn(event); },
    },
  };
  const rooms = [
    { sessionId: 'a', title: '周日下午', lastTurnAt: 3 },
    { sessionId: 'b', title: '三人行', lastTurnAt: 2 },
  ];
  const browsed = [];
  const controllerListeners = new Set();
  const link = { view: null };
  const appearanceApi = typeof appearance === 'function' ? appearance(fixture.documentLike, link) : appearance;
  const view = createTopBarView({
    documentLike: fixture.documentLike,
    controller: {
      snapshot: () => ({ rooms, sessionId: 'b' }),
      roomName: room => room.title,
      subscribe: fn => { controllerListeners.add(fn); return () => controllerListeners.delete(fn); },
    },
    store: {
      getState: () => ({ runtimeState: { activeListeningSessionId: 'a' } }),
      subscribe: () => () => {},
    },
    browse: id => browsed.push(id),
    appearance: appearanceApi,
  }).init();
  link.view = view;
  return { view, nodes, browsed, bar: nodes.get('#top-bar'), link };
}

const clickOn = (bar, attribute, value) => bar.dispatch('click', {
  target: { closest: selector => (selector === `[${attribute}]` ? { dataset: value, classList: { contains: () => false } } : null) },
});

test('the top bar marks the viewed chat with an underline and the listening chat with a dot', () => {
  const { bar } = setup();
  assert.equal(bar.hidden, false);
  assert.match(bar.innerHTML, /data-top-room="a" aria-current="false" data-listening="true"><span class="top-bar-dot"/);
  assert.match(bar.innerHTML, /data-top-room="b" aria-current="page"/);
  assert.ok(bar.innerHTML.indexOf('data-top-room="a"') < bar.innerHTML.indexOf('data-top-room="b"'), 'listening chat first');
});

test('on a destination page no chat tab is underlined but the dot stays', () => {
  const { bar } = setup({ page: 'settings' });
  assert.doesNotMatch(bar.innerHTML, /data-top-room="[^"]+" aria-current="page"/);
  assert.match(bar.innerHTML, /data-top-dest="settings" aria-current="page"/);
  assert.match(bar.innerHTML, /data-listening="true"/);
});

test('clicking a tab only browses; it sends no playback command', () => {
  const { bar, browsed, nodes } = setup();
  clickOn(bar, 'data-top-room', { topRoom: 'a' });
  assert.deepEqual(browsed, ['a']);
  for (const nav of ['#nav-radio', '#nav-today', '#nav-people', '#nav-settings']) assert.equal(nodes.get(nav).clicks, 0);
});

test('destinations forward to the existing navigation buttons', () => {
  const { bar, nodes, browsed } = setup();
  assert.deepEqual(TOP_BAR_DESTINATIONS.map(item => item.id), ['today', 'people', 'settings']);
  assert.doesNotMatch(bar.innerHTML, /data-top-dest="radio"/);
  clickOn(bar, 'data-top-dest', { topDest: 'today' });
  assert.equal(nodes.get('#nav-today').clicks, 1);
  clickOn(bar, 'data-top-dest', { topDest: 'radio' });
  assert.equal(nodes.get('#nav-radio').clicks, 0, '旧目标不能重新打开已撤下页面');
  assert.deepEqual(browsed, []);
});

test('the full list opens as an overlay, Esc closes it and returns focus, the sidebar state is restored', () => {
  const { view, bar, nodes } = setup();
  const sidebar = nodes.get('#conversation-sidebar');
  sidebar.classList.remove('expanded');
  const trigger = { classList: { contains: name => name === 'top-bar-all' }, dataset: {}, focus() { fixture.active = this; } };
  bar.dispatch('click', { target: { closest: selector => (selector === '[data-top-all]' ? trigger : null) } });
  assert.equal(view.isOverlayOpen(), true);
  assert.equal(fixture.documentLike.body.classList.contains(OVERLAY_CLASS), true);
  assert.equal(sidebar.classList.contains('expanded'), true, 'the overlay shows the full list');
  assert.equal(sidebar.inert, false);
  assert.equal(fixture.active, nodes.get('#room-search'));
  let prevented = false;
  fixture.documentLike.dispatch('keydown', { key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(view.isOverlayOpen(), false);
  assert.equal(fixture.documentLike.body.classList.contains(OVERLAY_CLASS), false);
  assert.equal(sidebar.classList.contains('expanded'), false, 'the collapsed state comes back');
  assert.equal(fixture.active, trigger);
});

test('Esc belongs to the row menu while it is open', () => {
  const { view, nodes } = setup();
  view.openOverlay(null);
  nodes.get('#room-row-menu').hidden = false;
  fixture.documentLike.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(view.isOverlayOpen(), true);
});

test('opening a chat from the overlay closes it', () => {
  const { view, nodes } = setup();
  view.openOverlay(null);
  nodes.get('#room-list').dispatch('click', { target: { closest: selector => (selector === '[data-room]' ? {} : null) } });
  assert.equal(view.isOverlayOpen(), false);
});

test('人物详情已打开也能从顶栏找到完整人物列表', () => {
  const { view, bar, nodes, browsed } = setup();
  nodes.get('#nav-people').click = function () {
    this.clicks += 1;
    this.setAttribute('aria-current', 'page');
    nodes.get('#person-detail').open = true;
  };
  const person = element('mio');
  nodes.get('#conversation-sidebar').querySelector = selector => selector === '#people-list button' ? person : null;
  clickOn(bar, 'data-top-dest', { topDest: 'people' });
  assert.equal(nodes.get('#person-detail').open, true);
  assert.equal(view.isOverlayOpen(), true, '打开详情不能吞掉列表入口');
  assert.equal(fixture.active, person);
  assert.deepEqual(browsed, []);
  view.closeOverlay();
  clickOn(bar, 'data-top-dest', { topDest: 'people' });
  assert.equal(view.isOverlayOpen(), true);
  assert.equal(nodes.get('#nav-people').clicks, 1, '再次打开不把当前资料重置成第一位');
  assert.match(bar.innerHTML, /data-top-dest="people"[^>]*aria-expanded="true"/);
});

test('资料页切换人物：取消仍保留资料，Esc 还焦点，空列表可新增', () => {
  const { view, nodes } = setup({ page: 'people' });
  const button = nodes.get('#person-detail-switch');
  nodes.get('#top-bar').querySelector = selector => selector === '.top-bar-all' ? element('all-trigger') : null;
  nodes.get('#person-detail').open = true;
  const originalQuery = fixture.documentLike.querySelector;
  fixture.documentLike.querySelector = selector => selector === 'dialog[open]' ? nodes.get('#person-detail') : originalQuery(selector);
  assert.equal(button.hidden, false);
  button.dispatch('click', { currentTarget: button });
  assert.equal(view.isOverlayOpen(), true);
  assert.equal(fixture.active, nodes.get('#people-list-create'), '空列表可直达新增');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  fixture.documentLike.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(view.isOverlayOpen(), false);
  assert.equal(nodes.get('#person-detail').open, true);
  assert.equal(fixture.active, button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('人物新增面板有键盘优先权，点新增先收起列表', () => {
  const { view, nodes } = setup({ page: 'people' });
  view.openOverlay(null);
  const query = fixture.documentLike.querySelector;
  fixture.documentLike.querySelector = selector => selector === 'dialog[open]:not(#person-detail)' ? element('create-dialog') : query(selector);
  let prevented = false;
  fixture.documentLike.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  fixture.documentLike.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(view.isOverlayOpen(), true);
  nodes.get('#people-list-create').dispatch('click', {});
  assert.equal(view.isOverlayOpen(), false);
});

test('人物页正文也属于列表外部；切换按钮本身不会立即把列表关掉', () => {
  const { view } = setup({ page: 'people' });
  view.openOverlay(null);
  fixture.documentLike.dispatch('click', { target: {
    isConnected: true,
    closest: selector => selector.includes('#person-detail-switch') ? {} : null,
  } });
  assert.equal(view.isOverlayOpen(), true);
  fixture.documentLike.dispatch('click', { target: {
    isConnected: true,
    closest: selector => selector.endsWith(', dialog') ? {} : null,
  } });
  assert.equal(view.isOverlayOpen(), false);
});

test('时间线人物列表明确启用新增按钮且长名字可折行', async () => {
  const css = await readFile(new URL('./timeline.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-layout="timeline"\] #people-list-create \{[^}]*display: inline-flex/);
  assert.match(css, /#people-list \.person-row > span:last-child \{[^}]*overflow-wrap: anywhere/);
});

test('非时间线隐藏切换入口，切主题时恢复隐藏', () => {
  const { view, nodes } = setup();
  assert.equal(nodes.get('#person-detail-switch').hidden, false);
  fixture.documentLike.documentElement.dataset.layout = 'stage';
  view.sync();
  assert.equal(nodes.get('#person-detail-switch').hidden, true);
  assert.equal(setup({ layout: 'stage' }).nodes.get('#person-detail-switch').hidden, true);
});

test('opening a person page from the overlay closes it', () => {
  const { view, nodes } = setup();
  view.openOverlay(null);
  nodes.get('#person-detail').open = true;
  nodes.get('#people-list').dispatch('click', { target: { closest: selector => (selector === '[data-person]' ? {} : null) } });
  assert.equal(view.isOverlayOpen(), false);
  assert.equal(fixture.active, nodes.get('#person-detail-name'), '选中后焦点不能留在已隐藏列表');
});

test('outside the timeline layout the bar hides and the overlay closes', () => {
  const { view, bar } = setup();
  view.openOverlay(null);
  fixture.documentLike.documentElement.dataset.layout = 'stage';
  view.sync();
  assert.equal(bar.hidden, true);
  assert.equal(view.isOverlayOpen(), false);
  assert.equal(fixture.documentLike.body.classList.contains(OVERLAY_CLASS), false);
});

// 顶栏的「外观」按钮接到共享浮层（appearancePop.js）：打开时先收起顶栏的「全部」，关掉后重画按钮。
function lookSetup(theme = 'nocturne') {
  const calls = [];
  const state = { theme, material: 'flat', base: 'paper', artwork: false };
  const appearance = {
    themes: () => [{ id: 'cike', name: '此刻', swatch: '#111' }, { id: 'nocturne', name: '夜场', swatch: '#222' }],
    theme: () => state.theme,
    setTheme: id => { calls.push(['theme', id]); state.theme = id; },
    material: () => state.material,
    setMaterial: name => { calls.push(['material', name]); state.material = name; },
    base: () => state.base,
    setBase: name => { calls.push(['base', name]); state.base = name; },
    artwork: () => state.artwork,
    setArtwork: enabled => { calls.push(['artwork', enabled]); state.artwork = enabled; },
  };
  const built = setup({
    appearance: (documentLike, link) => createAppearancePopover({
      documentLike,
      appearance,
      beforeOpen: () => link.view?.closeOverlay({ restoreFocus: false }),
      onOpenChange: () => link.view?.sync(),
    }).init(),
  });
  return { ...built, calls, state };
}
const target = (attribute, dataset) => ({ isConnected: true, closest: selector => (selector === `[${attribute}]` ? { dataset } : null) });

test('「外观」紧挨在「设置」左边；没有接外观时不出现', () => {
  const { bar } = lookSetup();
  assert.match(bar.innerHTML, /<button type="button" class="top-bar-dest-item top-bar-look" data-top-look aria-haspopup="dialog" aria-expanded="false" aria-controls="appearance-pop">外观<\/button><button type="button" class="top-bar-dest-item" data-top-dest="settings"/);
  assert.doesNotMatch(setup().bar.innerHTML, /data-top-look/);
});

test('「外观」打开浮层：当前主题与材质已选中，Esc 关闭；打开「全部」会先收起它', () => {
  const { view, bar, nodes } = lookSetup();
  const pop = nodes.get('#appearance-pop');
  bar.dispatch('click', { target: target('data-top-look', {}) });
  assert.equal(view.isAppearanceOpen(), true);
  assert.equal(pop.hidden, false);
  assert.match(bar.innerHTML, /data-top-look aria-haspopup="dialog" aria-expanded="true"/);
  assert.match(pop.innerHTML, /data-look-theme="nocturne" aria-checked="true" tabindex="0"/);
  assert.match(pop.innerHTML, /data-look-material="flat" aria-checked="true"/);
  fixture.documentLike.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(view.isAppearanceOpen(), false);
  assert.equal(pop.hidden, true);
  bar.dispatch('click', { target: target('data-top-look', {}) });
  bar.dispatch('click', { target: { closest: selector => (selector === '[data-top-all]' ? { classList: { contains: () => true }, dataset: {} } : null) } });
  assert.equal(view.isAppearanceOpen(), false);
  assert.equal(view.isOverlayOpen(), true);
});

test('浮层里的选择交给主题 / 材质控制器；「更多外观设置」去设置页', () => {
  const { bar, nodes, calls, view } = lookSetup();
  const pop = nodes.get('#appearance-pop');
  bar.dispatch('click', { target: target('data-top-look', {}) });
  pop.dispatch('click', { target: target('data-look-material', { lookMaterial: 'glass' }) });
  assert.match(pop.innerHTML, /data-look-material="glass" aria-checked="true"/);
  pop.dispatch('click', { target: target('data-look-theme', { lookTheme: 'cike' }) });
  assert.deepEqual(calls, [['material', 'glass'], ['theme', 'cike']]);
  assert.doesNotMatch(pop.innerHTML, /data-look-material/, '材质只在夜场出现');
  pop.dispatch('click', { target: target('data-look-settings', {}) });
  assert.equal(view.isAppearanceOpen(), false, '「更多外观设置」先收起浮层');
});

test('点在浮层和顶栏之外收起「外观」', () => {
  const { bar, view } = lookSetup();
  bar.dispatch('click', { target: target('data-top-look', {}) });
  fixture.documentLike.dispatch('click', { target: { isConnected: true, closest: () => null } });
  assert.equal(view.isAppearanceOpen(), false);
});

// 外观选项的标记本身在 appearancePop.test.js 里覆盖；这里只测顶栏按钮与浮层的接线。

test('窄屏去处收进菜单，「外观」仍留在顶栏', async () => {
  const css = await readFile(new URL('./timeline.css', import.meta.url), 'utf8');
  const narrow = css.slice(css.indexOf('@media (max-width: 767px)'));
  assert.match(narrow, /\.top-bar-dest-item:not\(\.top-bar-look\) \{ display: none; \}/);
  assert.match(narrow, /#drag-bar \{ display: none; \}/, '窄屏桌面拖动条不能盖住菜单');
  assert.match(css, /\.appearance-pop:not\(\[hidden\]\) \{[^}]*position: fixed;/);
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="appearance-pop" id="appearance-pop" role="dialog" aria-label="外观" hidden><\/div>/);
});

test('浮层里方向键只挪焦点不换主题：不会一按就被带出时间线布局', () => {
  const { nodes, calls, view, bar } = lookSetup();
  const pop = nodes.get('#appearance-pop');
  bar.dispatch('click', { target: target('data-top-look', {}) });
  const group = ['cike', 'nocturne'].map(id => ({ id, tabIndex: id === 'nocturne' ? 0 : -1, focus() { fixture.active = this; }, click() { calls.push(['click', id]); } }));
  const parent = { querySelectorAll: () => group };
  group.forEach(item => { item.parentElement = parent; });
  let prevented = false;
  fixture.documentLike.dispatch('keydown', { key: 'ArrowLeft', preventDefault: () => { prevented = true; }, target: { closest: () => group[1] } });
  assert.equal(prevented, true);
  assert.equal(fixture.active, group[0]);
  assert.deepEqual(group.map(item => item.tabIndex), [0, -1]);
  assert.deepEqual(calls, []);
  assert.equal(view.isAppearanceOpen(), true, '只挪焦点不关浮层');
});
