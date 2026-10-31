import assert from 'node:assert/strict';
import test from 'node:test';
import { createTodayView } from './todayView.js';

function element(tag = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  return {
    tagName: tag, hidden: false, innerHTML: '', checked: false, value: '',
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) { for (const listener of listeners.get(type) || []) listener({ type, target: this, ...event }); },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

function harness({ api = {} } = {}) {
  const calls = [];
  const toasts = [];
  const panel = element('section');
  const documentLike = {
    querySelector: selector => (selector === '#today-panel' ? panel : element()),
  };
  const apiClient = {
    get: async path => {
      calls.push(['GET', path]);
      if (path === '/api/life/routine') return api.routine || { routine: { configured: false, workDays: [], revision: 0 } };
      if (path === '/api/life/entries') return api.entries || { entries: [] };
      if (path === '/api/life/scene-defaults') return api.sceneDefaults || { sceneDefaults: [] };
      const date = path.match(/\/api\/life\/days\/(.+)$/)?.[1];
      return api.days?.[date] || { date, override: null, day: { dayType: 'unknown' } };
    },
    post: async (path, body) => { calls.push(['POST', path, body]); return { ok: true }; },
    request: async (path, options = {}) => { calls.push([options.method || 'GET', path, options.body]); return { ok: true }; },
    delete: async (path, body) => { calls.push(['DELETE', path, body]); return { ok: true }; },
  };
  const view = createTodayView({
    apiClient, documentLike,
    showToast: (kind, title, message) => toasts.push([kind, title, message]),
    onError: error => toasts.push(['error', '今日加载失败', error.message]),
  });
  return { view, panel, calls, toasts, viewApi: apiClient };
}

test('D timeline has dated groups, a current-time line and preserves entry controls', async () => {
  const date = new Intl.DateTimeFormat('en-CA').format(new Date());
  const h = harness({api:{entries:{entries:[
    {id:'past',type:'todo',title:'早上的事',localDate:date,startTime:'00:00',revision:1},
    {id:'later',type:'todo',title:'晚上的事',localDate:date,startTime:'23:59',revision:1},
    {id:'untimed',type:'note',title:'一页随笔',localDate:date,revision:1},
  ]}}});
  h.view.init(); await h.view.load();
  assert.match(h.panel.innerHTML,/today-timeline-heading">今天/);
  assert.match(h.panel.innerHTML,/today-timeline-heading">没定时间/);
  assert.equal((h.panel.innerHTML.match(/data-now-line/g)||[]).length,1);
  assert.match(h.panel.innerHTML,/data-action="toggle-done"/);
  assert.ok(!h.calls.some(([method])=>method==='POST'));
});

test('the list and the editor are separated by a draggable splitter, not a fixed column', async () => {
  const h = harness();
  h.view.init(); await h.view.load();
  assert.match(h.panel.innerHTML, /class="today-split" role="separator" aria-orientation="vertical" tabindex="0"/);
  assert.match(h.panel.innerHTML, /aria-label="调整列表与编辑器的宽度"/);
  assert.equal((h.panel.innerHTML.match(/class="today-split"/g) || []).length, 1);
});

test('untimed entries drop the reserved time column; quick-add is a single-line field', async () => {
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const h = harness({api:{entries:{entries:[
    {id:'no-time',type:'todo',title:'没定时间的待办',localDate:today,revision:1},
    {id:'with-time',type:'todo',title:'有时间的待办',localDate:today,startTime:'08:59',revision:1},
  ]}}});
  h.view.init(); await h.view.load();
  const rows = h.panel.innerHTML.split('<li class="today-entry').slice(1).map(chunk => chunk.split('</li>')[0]);
  const untimed = rows.find(row => row.includes('data-id="no-time"'));
  const timed = rows.find(row => row.includes('data-id="with-time"'));
  assert.match(untimed, /^[^>]*is-untimed/, 'untimed row carries the compact class');
  assert.doesNotMatch(untimed, /today-timeline-time">—/, 'no placeholder dash in the time column');
  assert.doesNotMatch(timed, /is-untimed/);
  assert.match(timed, /today-timeline-time">08:59</);
  // 占位文字必须能在一行里放下：多行说明移到日期行。
  assert.match(h.panel.innerHTML, /placeholder="＋ 添加待办，回车确认"/);
  assert.match(h.panel.innerHTML, /换行可一次多条/);
  assert.match(h.panel.innerHTML, /<textarea name="quick-todo" data-action="quick-add" rows="1"/);
});

test('today view renders entries only; routine belongs to settings and scene defaults stay unmounted', async () => {
  const { view, panel, calls } = harness({
    api: {
      routine: { routine: { configured: true, timeZone: 'Asia/Shanghai', workDays: [1, 2], workStartTime: '09:00', workEndTime: '18:00', revision: 2 } },
      entries: { entries: [{ id: 'life:a', type: 'todo', title: '买咖啡', localDate: '2026-09-22', done: false,
        revision: 1, useForCompanionship: false, allowedPersonIds: [], yearlyRepeat: false, noteUsesTitle: false }] },
      sceneDefaults: { sceneDefaults: [{ sceneTag: '骑车回家', modeId: 'music_only', revision: 1 }] },
    },
  });
  view.init();
  await view.load();
  assert.ok(panel.innerHTML.includes('买咖啡'));
  assert.ok(panel.innerHTML.includes('已授权陪伴') === false, '未授权条目不显示授权标记');
  assert.ok(!panel.innerHTML.includes('每周作息'), '作息编辑在设置 → 常规');
  assert.ok(!panel.innerHTML.includes('骑车回家'), '场景默认不再有界面入口');
  assert.ok(!calls.some(([, path]) => path === '/api/life/routine' || path === '/api/life/scene-defaults'),
    '手记页不再加载作息与场景');
});

test('adding an authorized entry without persons fails with actionable guidance', async () => {
  const { view, panel, calls, toasts } = harness();
  view.init();
  await view.load();
  clickAction(panel, { action: 'new-entry' });
  const field = (name, value) => [name, typeof value === 'boolean' ? { checked: value } : { value }];
  panel.querySelector = selector => Object.fromEntries([
    field('[name="entry-companion"]', true), field('[name="entry-persons"]', ''),
    field('[name="entry-title"]', '跑步'), field('[name="entry-type"]', 'event'),
    field('[name="entry-date"]', '2026-09-22'), field('[name="entry-start"]', ''),
    field('[name="entry-end"]', ''), field('[name="entry-note"]', ''),
    field('[name="entry-scene"]', ''), field('[name="entry-note-uses-title"]', false),
    field('[name="entry-yearly"]', false),
  ])[selector] || null;
  panel.querySelectorAll = () => [];
  panel.emit('click', { target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'add-entry' } } : null) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(toasts.some(([, title]) => title === '还差一步'), '至少选择一位伙伴的引导');
  assert.ok(!calls.some(([method, path]) => path === '/api/life/entries' && method === 'POST'), '未发请求');
});

test('failed loads keep rendered inputs and stay retryable', async () => {
  const { view, panel, calls, toasts, viewApi } = harness();
  view.init();
  await view.load();
  const before = panel.innerHTML;
  // 之后的加载失败不清空面板：输入保留，可再次打开或重试。
  const originalGet = viewApi.get;
  viewApi.get = async () => { throw new Error('network down'); };
  await view.load();
  viewApi.get = originalGet;
  assert.match(panel.innerHTML, /条目加载失败/);
  assert.match(panel.innerHTML, /data-action="retry-load"/);
  assert.match(before, /生活手记与日程/);
  assert.ok(calls.length > 0);
});

test('changing the date reloads that date without requiring save or any mutation', async () => {
  const { view, panel, calls } = harness();
  view.init(); await view.load();
  assert.match(panel.innerHTML, /name="day-date" data-action="change-date"/);
  calls.length = 0;
  const target = { dataset: { action: 'change-date' }, value: '2026-10-01' };
  panel.emit('change', { target: { closest: () => target } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.innerHTML, /value="2026-10-01"/);
  assert.ok(calls.every(([method]) => method === 'GET'));
});

test('life notes workspace supports filter tabs and entry selection without settings drawer', async () => {
  const { view, panel } = harness({
    api: {
      entries: {
        entries: [
          { id: 'note:1', type: 'note', title: '雨天随笔', content: '今天窗外下暴雨，写完代码想泡茶。', localDate: '2026-09-22', revision: 1 },
          { id: 'todo:1', type: 'todo', title: '买咖啡豆', localDate: '2026-09-22', done: false, revision: 1 },
        ],
      },
    },
  });
  view.init();
  await view.load();

  // 1. 验证工作台多栏与标题
  assert.ok(panel.innerHTML.includes('生活手记与日程'));
  assert.ok(panel.innerHTML.includes('雨天随笔'));
  assert.ok(panel.innerHTML.includes('买咖啡豆'));

  // 2. 点击分类 Tab 切换过滤视图到 "待办"
  panel.emit('click', {
    target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'switch-view', view: 'todo' } } : null) },
  });
  assert.ok(panel.innerHTML.includes('买咖啡豆'));
  // 随笔被过滤隐藏
  assert.ok(!panel.innerHTML.includes('今天窗外下暴雨，写完代码想泡茶'));

  // 3. 切换回全部并选择某一条目进入编辑区
  panel.emit('click', {
    target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'switch-view', view: 'all' } } : null) },
  });
  panel.emit('click', {
    target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'select-entry', id: 'note:1' } } : null) },
  });
  assert.ok(panel.innerHTML.includes('value="雨天随笔"'));
  assert.ok(panel.innerHTML.includes('今天窗外下暴雨，写完代码想泡茶。'));

  // 4. 作息与场景抽屉已移除：不再提供 toggle-drawer 入口，页面只剩手记与编辑区
  assert.ok(!panel.innerHTML.includes('data-action="toggle-drawer"'));
  assert.ok(!panel.innerHTML.includes('today-companion-drawer'));
  assert.ok(!panel.innerHTML.includes('每周作息'));
});

test('drafts survive filters, entry changes and refresh without crossing entries', async () => {
  const entries = [{ id: 'note:1', type: 'note', title: '原文', content: '已存正文', localDate: '2026-09-22', revision: 1 },
    { id: 'note:2', type: 'note', title: '第二篇', content: '', localDate: '2026-09-22', revision: 1 }];
  const { view, panel, calls } = harness({ api: { entries: { entries } } });
  const click = dataset => panel.emit('click', { target: { closest: () => ({ dataset }) } });
  view.init(); await view.load();
  click({ action: 'select-entry', id: 'note:1' });
  panel.emit('input', { target: { name: 'entry-title', value: '未保存标题' } });
  panel.emit('input', { target: { name: 'entry-content', value: '第一篇草稿' } });
  click({ action: 'switch-view', view: 'note' });
  assert.match(panel.innerHTML, /value="未保存标题"/);
  assert.match(panel.innerHTML, /第一篇草稿/);
  click({ action: 'select-entry', id: 'note:2' });
  assert.doesNotMatch(panel.innerHTML, /第一篇草稿/);
  panel.emit('input', { target: { name: 'entry-content', value: '第二篇草稿' } });
  click({ action: 'select-entry', id: 'note:1' });
  click({ action: 'switch-view', view: 'todo' });
  entries[0] = { ...entries[0], revision: 2, content: '其他窗口更新' };
  await view.load();
  assert.match(panel.innerHTML, /第一篇草稿/);
  assert.match(panel.innerHTML, /data-action="add-entry"[^>]*data-revision="1"/);
  assert.ok(calls.every(([method]) => method === 'GET'), 'draft navigation never mutates playback or data');
});

test('new drafts remain separate for each viewed date', async () => {
  const { view, panel } = harness();
  const date = value => panel.emit('change', { target: { closest: () => ({ dataset: { action: 'change-date' }, value }) } });
  view.init(); await view.load();
  date('2026-09-22'); await new Promise(resolve => setImmediate(resolve));
  clickAction(panel, { action: 'new-entry' });
  panel.emit('input', { target: { name: 'entry-content', value: '今天的草稿' } });
  date('2026-09-23'); await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(panel.innerHTML, /今天的草稿/);
  panel.emit('input', { target: { name: 'entry-content', value: '明天的草稿' } });
  date('2026-09-22'); await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.innerHTML, /今天的草稿/);
  assert.doesNotMatch(panel.innerHTML, /明天的草稿/);
});

test('legacy arrangements render as todos; day override entry point stays hidden', async () => {
  const { view, panel } = harness({
    api: {
      entries: { entries: [
        { id: 'event:1', type: 'event', title: '旧安排事项', localDate: '2020-01-01', done: false,
          revision: 1, useForCompanionship: false, allowedPersonIds: [], yearlyRepeat: false, noteUsesTitle: false },
      ] },
    },
  });
  view.init();
  await view.load();
  const html = panel.innerHTML;
  assert.ok(!html.includes('day-type'), '单日覆盖下拉已收起');
  assert.ok(!html.includes('save-day'), '保存标记按钮已收起');
  assert.ok(html.includes('data-action="toggle-done"'), '旧安排显示待办勾选框');
  assert.ok(html.includes('已逾期'), '过期未完成的旧安排显示逾期徽章');
  assert.ok(html.includes('>待办</span>'), '类型标签统一显示为待办');

  panel.emit('click', {
    target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'switch-view', view: 'todo' } } : null) },
  });
  assert.ok(panel.innerHTML.includes('旧安排事项'), '待办过滤视图包含历史安排');
});

test('quick-add creates one todo per line; failure keeps remaining lines; IME enter is ignored', async () => {
  const api = {};
  const { view, panel, calls, toasts, viewApi } = harness({ api });
  view.init();
  await view.load();
  let failSecond = false;
  const posted = [];
  viewApi.request = async (path, options = {}) => {
    if (path === '/api/life/entries' && options.method === 'POST') {
      posted.push(options.body);
      if (failSecond && options.body.title === '第五件事') {
        // 模拟响应丢失但服务端实际已保存前一行：核对后不应重复保留。
        api.entries = { entries: [{ id: 'life:4', type: 'todo', title: '第四件事',
          localDate: options.body.localDate, done: false, revision: 1 }] };
        throw new Error('network down');
      }
      return { entry: { id: `todo:${posted.length}`, type: 'todo', title: options.body.title,
        localDate: options.body.localDate, revision: 1 } };
    }
    return { ok: true };
  };
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const quickTarget = value => ({
    dataset: { action: 'quick-add' }, value,
    closest() { return this; },
  });

  // 输入法选词的回车不触发添加。
  panel.emit('keydown', { key: 'Enter', isComposing: true, target: quickTarget('输入法中的事') });
  assert.equal(posted.length, 0, '组合输入中的回车不创建');

  // 成功路径：三行创建三条待办，归属当前查看日期，输入框清空。
  panel.emit('keydown', { key: 'Enter', target: quickTarget('第一件事\n第二件事\n第三件事') });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(posted.map(body => body.title), ['第一件事', '第二件事', '第三件事']);
  assert.ok(posted.every(body => body.type === 'todo' && body.localDate === today), '逐行创建待办并归属当前日期');
  assert.ok(!toasts.some(([kind]) => kind === 'error'), '全部成功无错误提示');
  assert.doesNotMatch(panel.innerHTML, /name="quick-todo"[^>]*>[^<]/, '成功后输入框清空');

  // 部分失败：第二行失败，第一行保留，剩余行留在输入框。
  calls.length = 0;
  failSecond = true;
  panel.emit('keydown', { key: 'Enter', target: quickTarget('第四件事\n第五件事') });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(toasts.some(([, title]) => title === '部分待办没有保存'), '失败给出可理解提示');
  assert.match(panel.innerHTML, /name="quick-todo"[^>]*>第五件事/, '未保存的行保留在输入框');
  assert.ok(posted.every(body => body.clientRequestId), '每行拥有独立请求身份');
});

test('delete and revoke buttons reach the delegated handler despite living inside the entry card', async () => {
  const { view, panel, calls } = harness({
    api: {
      entries: { entries: [
        { id: 'life:1', type: 'todo', title: '要删的待办', localDate: '2026-09-23', done: false,
          revision: 2, useForCompanionship: false, allowedPersonIds: [], yearlyRepeat: false, noteUsesTitle: false },
      ] },
    },
  });
  view.init();
  await view.load();
  const li = { dataset: { id: 'life:1', revision: '2' } };
  const button = {
    dataset: { action: 'delete' },
    closest: selector => (selector === '[data-action]' ? button : selector === '.today-entry' ? li : null),
  };
  panel.emit('click', { target: button });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!calls.some(([method]) => method === 'DELETE'), '先确认而非立即删除');
  button.dataset.action = 'delete-confirm';
  panel.emit('click', { target: button });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(([method, path, body]) => method === 'DELETE' && path === '/api/life/entries/life%3A1' && body.expectedRevision === 2),
    '卡片内删除按钮的点击必须到达面板级委托处理');
});

test('quick-add submit button posts every line and clears the box', async () => {
  const { view, panel, toasts, viewApi } = harness();
  view.init();
  await view.load();
  const posted = [];
  viewApi.request = async (path, options = {}) => {
    if (path === '/api/life/entries' && options.method === 'POST') {
      posted.push(options.body);
      return { entry: { id: `todo:${posted.length}`, type: 'todo', title: options.body.title,
        localDate: options.body.localDate, revision: 1 } };
    }
    return { ok: true };
  };
  const box = { value: '按钮加的事' };
  panel.querySelector = selector => (selector === '[name="quick-todo"]' ? box : null);
  panel.emit('click', { target: { closest: selector => (selector === '[data-action]'
    ? { dataset: { action: 'quick-add-submit' } } : null) } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].title, '按钮加的事');
  assert.ok(!toasts.some(([kind]) => kind === 'error'), '成功无错误提示');
  assert.match(panel.innerHTML, /name="quick-todo"[^>]*><\/textarea>/, '添加后输入框清空');
});

test('quick-add lost response retains unknown rows without treating a same title as proof', async () => {
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const { view, panel, toasts, viewApi } = harness();
  view.init();
  await view.load();
  const posted = [];
  viewApi.request = async (path, options = {}) => {
    if (path === '/api/life/entries' && options.method === 'POST') {
      posted.push(options.body);
      if (options.body.title === '已存住的B') throw new Error('response lost');
      return { entry: { id: `todo:${posted.length}`, type: 'todo', title: options.body.title,
        localDate: options.body.localDate, revision: 1 } };
    }
    return { ok: true };
  };
  // 失败后按服务端核对：B 的请求虽然报错，但服务端已保存，不应再留在输入框。
  viewApi.get = async path => {
    if (path === '/api/life/entries') {
      return { entries: [
        { id: 'life:a', type: 'todo', title: '第一件事', localDate: today, done: false, revision: 1 },
        { id: 'life:b', type: 'todo', title: '已存住的B', localDate: today, done: false, revision: 1 },
      ] };
    }
    if (path === '/api/life/routine') return { routine: { configured: false, workDays: [], revision: 0 } };
    if (path === '/api/life/scene-defaults') return { sceneDefaults: [] };
    return { programs: [] };
  };
  panel.emit('keydown', { key: 'Enter', target: {
    dataset: { action: 'quick-add' }, value: '第一件事\n已存住的B\n还没存的事', closest() { return this; },
  } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(posted.map(body => body.title), ['第一件事', '已存住的B']);
  assert.match(panel.innerHTML, /name="quick-todo"[^>]*>已存住的B\n还没存的事<\/textarea>/, '未知提交结果保留身份重试，不按标题猜测');
  assert.ok(toasts.some(([, title]) => title === '部分待办没有保存'));
});

test('successful save keeps newer in-flight input with the acknowledged revision; failure keeps draft', async () => {
  const entries = [{ id: 'note:1', type: 'note', title: '原文', content: '', localDate: '2026-09-22', revision: 1 }];
  const { view, panel, viewApi } = harness({ api: { entries: { entries } } });
  const click = dataset => panel.emit('click', { target: { closest: () => ({ dataset }) } });
  view.init(); await view.load(); click({ action: 'select-entry', id: 'note:1' });
  const fields = { 'entry-title': '第一稿', 'entry-content': '正文', 'entry-type': 'note', 'entry-date': '2026-09-22' };
  panel.querySelector = selector => selector.includes('[name=')
    ? { value: fields[selector.match(/name="([^"]+)"/)?.[1]] || '' } : null;
  panel.emit('input', { target: { name: 'entry-title', value: '第一稿' } });
  let release;
  const requests = [];
  viewApi.request = async (_path, options) => { requests.push(options); return new Promise(resolve => { release = resolve; }); };
  click({ action: 'add-entry', id: 'note:1', revision: '1' });
  panel.emit('input', { target: { name: 'entry-title', value: '继续写第二稿' } });
  entries[0] = { ...entries[0], title: '第一稿', revision: 2 };
  release({ ok: true, entry: entries[0] }); await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.innerHTML, /value="继续写第二稿"/);
  assert.match(panel.innerHTML, /data-action="add-entry"[^>]*data-revision="2"/);
  viewApi.request = async (_path, options) => { requests.push(options); throw new Error('save failed'); };
  fields['entry-title'] = '继续写第二稿';
  click({ action: 'add-entry', id: 'note:1', revision: '2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].body.expectedRevision, 2);
  assert.match(panel.innerHTML, /继续写第二稿/);
  viewApi.request = async () => ({ ok: true, entry: entries[0] = { ...entries[0], title: '最终保存', revision: 3 } });
  click({ action: 'add-entry', id: 'note:1', revision: '2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(panel.innerHTML, /继续写第二稿/);
  assert.match(panel.innerHTML, /最终保存/);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function clickAction(panel, dataset, extra = {}) {
  const target = { dataset, ...extra };
  target.closest = selector => selector === '[data-action]' ? target : null;
  panel.emit('click', { target });
}

test('task controls search notes, separate completed tasks and count without mutating music', async () => {
  const date = new Intl.DateTimeFormat('en-CA').format(new Date());
  const { view, panel, calls } = harness({ api: { entries: { entries: [
    { id: 'open', type: 'todo', title: '准备会议', content: '演示材料', localDate: date, done: false, revision: 1 },
    { id: 'done', type: 'event', title: '已经完成', localDate: date, done: true, revision: 1 },
  ] } } });
  view.init(); await view.load(); calls.length = 0;
  clickAction(panel, { action: 'switch-view', view: 'todo' });
  assert.match(panel.innerHTML, /准备会议/); assert.doesNotMatch(panel.innerHTML, /已经完成/);
  clickAction(panel, { action: 'task-filter', filter: 'completed' });
  assert.match(panel.innerHTML, /已经完成/); assert.doesNotMatch(panel.innerHTML, /准备会议/);
  clickAction(panel, { action: 'task-filter', filter: 'open' });
  panel.emit('input', { target: { name: 'task-search', value: '找不到' } });
  assert.match(panel.innerHTML, /没有找到匹配内容/);
  assert.match(panel.innerHTML, /data-action="clear-filters"/);
  assert.equal(calls.length, 0);
});

test('entries endpoint failure keeps the page retryable without auxiliary requests', async () => {
  const { view, panel, calls, viewApi } = harness();
  view.init(); await view.load();
  calls.length = 0;
  const get = viewApi.get;
  viewApi.get = path => path === '/api/life/entries' ? Promise.reject(new Error('offline')) : get(path);
  await view.load();
  assert.match(panel.innerHTML, /条目加载失败/);
  assert.match(panel.innerHTML, /data-action="retry-load"/);
  assert.ok(calls.every(([, path]) => path === '/api/life/entries'), '重试只请求条目，不扩散到作息/场景');
  viewApi.get = get;
  await view.load();
  assert.doesNotMatch(panel.innerHTML, /条目加载失败/);
});

test('quick retry freezes row identity and date, preserves typing and ignores stale loading', async () => {
  const { view, panel, viewApi } = harness(); view.init(); await view.load();
  let release, count = 0; const posted = [];
  viewApi.request = async (_path, options) => {
    posted.push(options.body); count++;
    if (count === 1) return new Promise((resolve, reject) => { release = reject; });
    return { entry: { ...options.body, id: `row:${count}`, revision: 1 } };
  };
  panel.querySelector = selector => selector === '[name="quick-todo"]' ? { value: '同名\n同名' } : null;
  clickAction(panel, { action: 'quick-add-submit' });
  const originalDate = posted[0].localDate;
  panel.emit('input', { target: { name: 'quick-todo', value: '新输入' } });
  const date = { dataset: { action: 'change-date' }, value: '2027-01-02', closest() { return this; } };
  panel.emit('change', { target: date });
  release(new Error('response lost')); await settle();
  clickAction(panel, { action: 'quick-add-submit' }); await settle();
  assert.equal(posted[0].clientRequestId, posted[1].clientRequestId);
  assert.notEqual(posted[1].clientRequestId, posted[2].clientRequestId);
  assert.ok(posted.every(body => body.localDate === originalDate));
  assert.match(panel.innerHTML, /name="quick-todo"[^>]*>新输入<\/textarea>/);
});

test('reschedule sends only date range and revision, preserving cross-day span', async () => {
  const entry = { id: 'span', type: 'todo', title: '出差', content: '保留正文', localDate: '2026-10-07', endDate: '2026-10-09', revision: 4 };
  const { view, panel, viewApi } = harness({ api: { entries: { entries: [entry] } } });
  view.init(); await view.load(); const requests = [];
  viewApi.request = async (path, options) => { requests.push([path, options]); return { entry: { ...entry, ...options.body, revision: 5 } }; };
  clickAction(panel, { action: 'move-tomorrow', id: entry.id }); await settle();
  assert.equal(requests[0][1].method, 'PATCH');
  assert.deepEqual(Object.keys(requests[0][1].body).sort(), ['endDate', 'expectedRevision', 'localDate']);
  const body = requests[0][1].body;
  assert.equal(Date.parse(body.endDate) - Date.parse(body.localDate), 2 * 86400000);
  assert.match(panel.innerHTML, /保留正文/);
});

test('ordinary editing autosaves while authorization editing waits for explicit save', async () => {
  const entry = { id: 'auto', type: 'note', title: '原文', content: '', localDate: '2026-10-08', revision: 1,
    useForCompanionship: false, allowedPersonIds: [], noteUsesTitle: false, companionNote: null };
  const { view, panel, viewApi } = harness({ api: { entries: { entries: [entry] } } });
  const requests = [];
  viewApi.request = async (_path, options) => { requests.push(options); return { entry: { ...entry, ...options.body, revision: 2 } }; };
  view.init(); await view.load(); clickAction(panel, { action: 'select-entry', id: 'auto' });
  panel.emit('input', { target: { name: 'entry-title', value: '自动保存内容' } });
  await new Promise(resolve => setTimeout(resolve, 740));
  assert.equal(requests.length, 1); assert.equal(requests[0].body.title, '自动保存内容');
  assert.match(panel.innerHTML, /已保存/);
  panel.emit('change', { target: { name: 'entry-companion', checked: true, type: 'checkbox' } });
  panel.emit('input', { target: { name: 'entry-content', value: '仍需显式确认' } });
  await new Promise(resolve => setTimeout(resolve, 740));
  assert.equal(requests.length, 1);
  // 触发一次重渲染，验证保存状态指示器反映「授权变更需点保存」。
  clickAction(panel, { action: 'switch-view', view: 'note' });
  assert.match(panel.innerHTML, /授权变更需点保存/);
});

test('recurring editor exposes daily weekly annual and independent occurrence controls', async () => {
  const date = new Intl.DateTimeFormat('en-CA').format(new Date());
  const entry = { id:'daily', type:'todo', title:'每日阅读', localDate:date, repeatFrequency:'daily', repeatWeekdays:[], completedDates:[], revision:3 };
  const {view,panel,viewApi} = harness({api:{entries:{entries:[entry]}}}); view.init(); await view.load();
  clickAction(panel,{action:'select-entry',id:'daily'});
  assert.match(panel.innerHTML,/value="daily" selected/); assert.match(panel.innerHTML,/value="weekly"/); assert.match(panel.innerHTML,/整个重复系列/);
  panel.emit('change',{target:{name:'entry-repeat',value:'weekly'}});
  assert.match(panel.innerHTML,/class="today-repeat-weekdays"/);
  const requests=[]; viewApi.request = async (path, options) => { requests.push([path,options]); return {entry:{...entry,revision:4}}; };
  clickAction(panel,{action:'switch-view',view:'todo'}); clickAction(panel,{action:'task-filter',filter:'week'});
  assert.equal((panel.innerHTML.match(/data-occurrence-key="daily:/g)||[]).length,7);
  const card={dataset:{id:'daily',occurrenceDate:date}};
  const target={dataset:{action:'toggle-done'},checked:true,closest(selector){return selector === '[data-action]' ? this : selector === '.today-entry' ? card : null;}};
  panel.emit('change',{target}); await settle();
  assert.equal(requests[0][1].body.occurrenceDate,date); assert.equal(requests[0][1].body.expectedRevision,3);
});

test('archived occurrences stay out of all tasks and can restore their own date',async()=>{
  const entry={id:'archived-series',type:'todo',title:'每日散步',localDate:'2026-01-01',repeatFrequency:'daily',completedDates:['2026-01-03','2026-01-04'],revision:2};
  const {view,panel,viewApi}=harness({api:{entries:{entries:[entry]}}});view.init();await view.load();
  clickAction(panel,{action:'switch-view',view:'todo'});clickAction(panel,{action:'task-filter',filter:'completed'});
  assert.match(panel.innerHTML,/已归档/);assert.match(panel.innerHTML,/全部完成记录/);
  assert.match(panel.innerHTML,/data-occurrence-date="2026-01-03"/);assert.match(panel.innerHTML,/data-occurrence-date="2026-01-04"/);
  const requests=[];viewApi.request=async(path,options)=>{requests.push(options.body);return {entry:{...entry,completedDates:['2026-01-04'],revision:3}};};
  const card={dataset:{id:entry.id,occurrenceDate:'2026-01-03'}};
  const target={dataset:{action:'toggle-done'},checked:false,closest(selector){return selector==='[data-action]'?this:selector==='.today-entry'?card:null;}};
  panel.emit('change',{target});await settle();assert.deepEqual(requests[0],{done:false,occurrenceDate:'2026-01-03',expectedRevision:2});
});
