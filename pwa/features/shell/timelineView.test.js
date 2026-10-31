import assert from 'node:assert/strict';
import test from 'node:test';

import { chineseOrdinal, createTimelineView } from './timelineView.js';

function node(id) {
  const listeners = new Map();
  const props = new Map();
  const children = { '[data-timeline-hm]': { textContent: '' }, '[data-timeline-ss]': { textContent: '' } };
  return {
    id, hidden: true, textContent: '', innerHTML: '', props,
    style: { setProperty: (name, value) => props.set(name, value) },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch: (type, event) => listeners.get(type)?.(event),
    querySelector: selector => children[selector] || null,
    children,
  };
}

const queue = ['甲', '乙', '丙', '丁', '戊', '己'].map((title, i) => ({
  queueItemId: `q${i}`, title, artist: '某人', durationSeconds: 200, pic_url: i % 2 ? '' : `/art/${i}.jpg`,
}));

const views = [];
test.afterEach(() => { while (views.length) views.pop().destroy(); });

function setup({ layout = 'timeline', runtime = { queue, currentIndex: 3, phase: 'playing', activeListeningSessionId: 's1' }, focused = 's1', clock = { at: new Date(2026, 9, 18, 14, 32, 8).getTime() } } = {}) {
  const nodes = new Map(['#timeline-cap', '#timeline-past', '#timeline-next', '#timeline-rail'].map(id => [id, node(id)]));
  const bar = { now: '50', getAttribute(name) { return ({ 'aria-valuenow': this.now, 'aria-valuemax': '200' })[name] ?? null; } };
  nodes.set('#progress-bar', bar);
  let state = { runtimeState: runtime };
  const storeListeners = new Set();
  const store = {
    getState: () => state,
    subscribe: fn => { storeListeners.add(fn); return () => storeListeners.delete(fn); },
    set(next) { const previous = state; state = { ...state, ...next }; for (const fn of storeListeners) fn(state, previous); },
  };
  const selected = [];
  const view = createTimelineView({
    store,
    controller: { snapshot: () => ({ sessionId: focused }), subscribe: () => () => {} },
    runtimeClient: () => ({ selectQueueItem: id => { selected.push(id); return Promise.resolve(); } }),
    documentLike: { documentElement: { dataset: { layout } }, activeElement: null, querySelector: selector => nodes.get(selector) || null },
    now: () => clock.at,
  });
  views.push(view);
  return { view, nodes, store, selected, bar, clock };
}

const firstAt = html => html.match(/class="timeline-at">([^<]*)</)?.[1];
const jumpTarget = id => ({ target: { closest: () => ({ dataset: { timelineJump: id } }) } });

test('中文序数：一到十、十几、几十几，过百用阿拉伯数字', () => {
  assert.equal(chineseOrdinal(1), '一');
  assert.equal(chineseOrdinal(10), '十');
  assert.equal(chineseOrdinal(13), '十三');
  assert.equal(chineseOrdinal(20), '二十');
  assert.equal(chineseOrdinal(47), '四十七');
  assert.equal(chineseOrdinal(120), '120');
  assert.equal(chineseOrdinal(0), '');
});

test('非时间线布局或没有当前歌时整条时间线隐藏', () => {
  for (const options of [{ layout: 'columns' }, { runtime: { queue, currentIndex: -1 } }, { runtime: null }]) {
    const { view, nodes } = setup(options);
    view.init();
    for (const id of ['#timeline-cap', '#timeline-past', '#timeline-next', '#timeline-rail']) assert.equal(nodes.get(id).hidden, true, id);
    view.destroy();
  }
});

test('渲染：标签、已放计数、待播时刻、横线进度与本机时间', () => {
  const { view, nodes, store } = setup();
  view.init();
  assert.equal(nodes.get('#timeline-cap').textContent, '正在播放 · 第四首');
  assert.match(nodes.get('#timeline-past').innerHTML, /已放 · 03/);
  assert.match(nodes.get('#timeline-past').innerHTML, /data-timeline-jump="q0"/);
  const next = nodes.get('#timeline-next').innerHTML;
  assert.match(next, /<strong>戊<\/strong>/);
  assert.match(next, /约 14:3\d/);
  assert.match(next, /timeline-tile-initial[^>]*>己</, '没有封面就用首字方块');
  const rail = nodes.get('#timeline-rail');
  assert.equal(rail.hidden, false);
  assert.equal(rail.props.get('--timeline-p'), '25.00%');
  assert.equal(rail.children['[data-timeline-hm]'].textContent, '14:32');
  assert.equal(rail.children['[data-timeline-ss]'].textContent, '08');
  store.set({ runtimeState: { ...store.getState().runtimeState, phase: 'paused' } });
  assert.equal(nodes.get('#timeline-cap').textContent, '正在播放 · 第四首 · 已暂停');
  view.destroy();
});

test('待播时刻随播放进度刷新：切歌那一刻读到上一首的进度，下一秒就改正', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { view, nodes, bar, clock } = setup();
  // 切歌瞬间：runtime 已换到新歌，进度条还停在上一首的 3:10。
  bar.now = '190';
  view.init();
  assert.equal(firstAt(nodes.get('#timeline-next').innerHTML), '约 14:32');
  // 新歌的媒体进度回到 0:01：下一首应在约 3 分 19 秒后。
  bar.now = '1';
  clock.at += 1000;
  t.mock.timers.tick(1000);
  assert.equal(firstAt(nodes.get('#timeline-next').innerHTML), '约 14:35');
  view.destroy();
});

test('暂停时待播时刻跟着本机时间往后推', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { view, nodes, clock } = setup({ runtime: { queue, currentIndex: 3, phase: 'paused', activeListeningSessionId: 's1' } });
  view.init();
  assert.equal(firstAt(nodes.get('#timeline-next').innerHTML), '约 14:34');
  clock.at += 10 * 60 * 1000;
  t.mock.timers.tick(1000);
  assert.equal(firstAt(nodes.get('#timeline-next').innerHTML), '约 14:44');
  view.destroy();
});

test('待播为空时说明还在路上，不留空白', () => {
  const { view, nodes } = setup({ runtime: { queue, currentIndex: 5, activeListeningSessionId: 's1' } });
  view.init();
  assert.match(nodes.get('#timeline-next').innerHTML, /下一首还在路上/);
  view.destroy();
});

test('点两次已放的歌才回到那首；第一次只是待确认', async () => {
  const { view, nodes, selected } = setup();
  view.init();
  const past = nodes.get('#timeline-past');
  await past.dispatch('click', jumpTarget('q1'));
  assert.deepEqual(selected, []);
  assert.match(past.innerHTML, /data-armed="true"/);
  // 提示落在这首自己的歌名位置，不再另起一个会盖住相邻元素的浮层。
  assert.match(past.innerHTML, /<span class="timeline-title">再点一次播放<\/span>/);
  assert.doesNotMatch(past.innerHTML, /timeline-armed/);
  await past.dispatch('click', jumpTarget('q1'));
  assert.deepEqual(selected, ['q1']);
  assert.doesNotMatch(past.innerHTML, /data-armed/);
  view.destroy();
});

test('已放输出队列里全部已放的歌（横排由 CSS 只露最近几首，竖排滚动），每首都能点两次跳回', async () => {
  const long = Array.from({ length: 12 }, (_, i) => ({ queueItemId: `p${i}`, title: `第${i}`, durationSeconds: 200 }));
  const { view, nodes, selected } = setup({ runtime: { queue: long, currentIndex: 10, phase: 'playing', activeListeningSessionId: 's1' } });
  view.init();
  const past = nodes.get('#timeline-past');
  assert.match(past.innerHTML, /已放 · 10/);
  assert.equal(past.innerHTML.match(/data-stop="p\d+"/g).length, 10);
  assert.match(past.innerHTML, /data-timeline-jump="p0"/);
  await past.dispatch('click', jumpTarget('p0'));
  await past.dispatch('click', jumpTarget('p0'));
  assert.deepEqual(selected, ['p0']);
  view.destroy();
});

test('回听较早歌曲后，原队尾仍在待播区，而不是只剩四首', async () => {
  const long = Array.from({ length: 60 }, (_, i) => ({ queueItemId: `p${i}`, title: `第${i + 1}首`, durationSeconds: 200 }));
  const { view, nodes, selected, store } = setup({ runtime: { queue: long, currentIndex: 42, phase: 'playing', activeListeningSessionId: 's1' } });
  view.init();
  const past = nodes.get('#timeline-past');
  await past.dispatch('click', jumpTarget('p5'));
  await past.dispatch('click', jumpTarget('p5'));
  assert.deepEqual(selected, ['p5']);
  // 只有权威 runtime 接受点播后才改变当前项。
  store.set({ runtimeState: { ...store.getState().runtimeState, currentIndex: 5 } });
  const next = nodes.get('#timeline-next');
  assert.equal(next.innerHTML.match(/data-stop="p\d+"/g).length, 54);
  assert.match(next.innerHTML, /data-timeline-jump="p59"/);
  assert.deepEqual(selected, ['p5'], '重新渲染不发额外播放命令');
});

function withVerticalLayout(fn) {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = query => ({ matches: query === '(min-width: 1200px)' });
  return Promise.resolve().then(fn).finally(() => { globalThis.matchMedia = previous; });
}

function fakePanel() {
  const panel = node('#listening-panel');
  const classes = new Set();
  return Object.assign(panel, {
    scrollTop: 120, scrollHeight: 900, clientHeight: 600, dataset: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    classes,
    querySelectorAll: () => [],
  });
}

test('宽屏竖排：鼠标按住整列拖动就是往回翻时间线；拖过就吞掉这次点击，不会被当成点歌', () => withVerticalLayout(async () => {
  const { view, nodes, selected } = setup();
  const panel = fakePanel();
  nodes.set('#listening-panel', panel);
  view.init();
  panel.scrollTop = 120;
  const target = { closest: () => null };
  panel.dispatch('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 1, clientY: 100, timeStamp: 0, target });
  panel.dispatch('pointermove', { pointerId: 1, clientY: 102, timeStamp: 10 });
  assert.equal(panel.scrollTop, 120, '没过阈值不算拖');
  panel.dispatch('pointermove', { pointerId: 1, clientY: 140, timeStamp: 20 });
  assert.equal(panel.scrollTop, 80, '往下拖，整列往回翻');
  assert.ok(panel.classes.has('is-dragging'));
  panel.dispatch('pointerup', { pointerId: 1, clientY: 140, timeStamp: 400 });
  assert.ok(!panel.classes.has('is-dragging'));
  const past = nodes.get('#timeline-past');
  await past.dispatch('click', jumpTarget('q1'));
  await past.dispatch('click', jumpTarget('q1'));
  assert.deepEqual(selected, [], '拖完的那次点击被吞掉，第二次只是待确认');
  view.destroy();
}));

test('拖过顶端只有阻尼位移，松手回弹到 0；旁白与歌词上按下不接管（还能选字）', () => withVerticalLayout(() => {
  const { view, nodes } = setup();
  const panel = fakePanel();
  nodes.set('#listening-panel', panel);
  view.init();
  panel.scrollTop = 10;
  panel.dispatch('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 2, clientY: 100, timeStamp: 0, target: { closest: () => null } });
  panel.dispatch('pointermove', { pointerId: 2, clientY: 300, timeStamp: 20 });
  assert.equal(panel.scrollTop, 0);
  const pull = Number.parseFloat(panel.props.get('--timeline-pull'));
  assert.ok(pull > 0 && pull < 90, `阻尼位移有上限：${pull}`);
  panel.dispatch('pointerup', { pointerId: 2, clientY: 300, timeStamp: 400 });
  assert.equal(panel.props.get('--timeline-pull'), '0.0px');
  assert.ok(panel.classes.has('is-settling'));

  panel.scrollTop = 50;
  panel.dispatch('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 3, clientY: 100, timeStamp: 0, target: { closest: selector => (selector.includes('.listening-narration') ? {} : null) } });
  panel.dispatch('pointermove', { pointerId: 3, clientY: 160, timeStamp: 20 });
  assert.equal(panel.scrollTop, 50, '从旁白上按下不拖');
  view.destroy();
}));

test('待播的歌同样点两次跳过去；第一次只是待确认', async () => {
  const { view, nodes, selected } = setup();
  view.init();
  const next = nodes.get('#timeline-next');
  assert.match(next.innerHTML, /data-timeline-jump="q4"/);
  assert.match(next.innerHTML, /aria-label="待播《戊》，点两次跳到这首"/);
  await next.dispatch('click', jumpTarget('q4'));
  assert.deepEqual(selected, []);
  assert.match(next.innerHTML, /<strong>再点一次播放<\/strong>/);
  await next.dispatch('click', jumpTarget('q4'));
  assert.deepEqual(selected, ['q4']);
  assert.doesNotMatch(next.innerHTML, /data-armed/);
  view.destroy();
});

test('Esc 取消待确认；换一首点击重新开始计数', async () => {
  const { view, nodes, selected } = setup();
  view.init();
  const past = nodes.get('#timeline-past');
  await past.dispatch('click', jumpTarget('q0'));
  await past.dispatch('keydown', { key: 'Escape' });
  assert.doesNotMatch(past.innerHTML, /data-armed/);
  await past.dispatch('click', jumpTarget('q0'));
  await past.dispatch('click', jumpTarget('q2'));
  assert.deepEqual(selected, []);
  view.destroy();
});

test('正在看的聊天不是正在听的聊天时，已放只是图，不能点回', async () => {
  const { view, nodes, selected } = setup({ focused: 'other' });
  view.init();
  const past = nodes.get('#timeline-past');
  assert.doesNotMatch(past.innerHTML, /data-timeline-jump/);
  assert.doesNotMatch(nodes.get('#timeline-next').innerHTML, /data-timeline-jump/, '待播也不能点');
  await past.dispatch('click', jumpTarget('q1'));
  await past.dispatch('click', jumpTarget('q1'));
  assert.deepEqual(selected, []);
  view.destroy();
});
