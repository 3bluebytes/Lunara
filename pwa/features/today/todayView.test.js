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

const settle = () => new Promise(resolve => setImmediate(resolve));

function clickAction(panel, dataset, extra = {}) {
  const target = { dataset, ...extra };
  target.closest = selector => (selector === '[data-action]' ? target : null);
  panel.emit('click', { target });
}

function harness({ api = {}, getPeople = () => [{ id: 'lunara', displayName: 'Lunara' }], getNowPlaying = () => null, onTalkAboutEntry = null, undoTimeoutMs = 40 } = {}) {
  const calls = [];
  const toasts = [];
  const panel = element('section');
  const documentLike = {
    querySelector: selector => (selector === '#today-panel' ? panel : element()),
  };
  const apiClient = {
    get: async path => {
      calls.push(['GET', path]);
      if (path === '/api/life/entries') return api.entries || { entries: [] };
      if (path.startsWith('/api/life/day-music')) return api.dayMusic || { ok: true, tracks: [] };
      if (path.startsWith('/api/life/day-quotes')) return api.dayQuotes || { ok: true, quotes: [] };
      if (path === '/api/life/open-loops') return api.openLoops || { ok: true, openLoops: [] };
      return { ok: true };
    },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      if (api.onPost) return api.onPost(path, body);
      return { ok: true };
    },
    request: async (path, options = {}) => {
      calls.push([options.method || 'GET', path, options.body]);
      if (api.onRequest) return api.onRequest(path, options);
      return { ok: true };
    },
  };
  const view = createTodayView({
    apiClient,
    documentLike,
    getPeople,
    getNowPlaying,
    onTalkAboutEntry,
    undoTimeoutMs,
    showToast: (kind, title, message) => toasts.push([kind, title, message]),
    onError: error => toasts.push(['error', '今日加载失败', error.message]),
  });
  return { view, panel, calls, toasts, viewApi: apiClient };
}

test('scheme B removes top calendar/quick-add clutter while keeping splitter and recency buckets', async () => {
  const now = Date.now();
  const today = new Intl.DateTimeFormat('en-CA').format(new Date(now));
  const sep = '2026-09-23';
  const { view, panel, calls } = harness({
    api: {
      entries: {
        entries: [
          { id: 'sep', type: 'note', title: '九月旧记', content: '秋天开始变凉', localDate: sep, createdAt: now - 40 * 86400000, updatedAt: now - 40 * 86400000, revision: 1 },
          { id: 'pinned', type: 'note', title: '置顶灵感', pinned: true, localDate: sep, updatedAt: now - 10 * 86400000, revision: 1 },
          { id: 'now', type: 'note', title: '今晚随笔', content: '写一页纸', localDate: today, updatedAt: now, revision: 1 },
        ],
      },
    },
  });
  view.init();
  await view.load();

  assert.match(panel.innerHTML, /class="today-split" role="separator" aria-orientation="vertical" tabindex="0"/);
  assert.match(panel.innerHTML, /aria-label="调整列表与编辑器的宽度"/);
  assert.doesNotMatch(panel.innerHTML, /today-workspace-header|quick-todo|每周作息|today-companion-drawer|toggle-drawer/);
  assert.ok(!calls.some(([, path]) => path === '/api/life/routine' || path === '/api/life/scene-defaults'));

  const ids = [...panel.innerHTML.matchAll(/<li class="today-entry[^>]*data-id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['pinned', 'now', 'sep']);
  assert.match(panel.innerHTML, /today-timeline-heading">置顶/);
  assert.match(panel.innerHTML, /today-timeline-heading">今天/);
});

test('unified sheet bridges Enter from firstline to body, Backspace back to title, and isolates search/new drafts', async () => {
  const { view, panel } = harness({
    api: { entries: { entries: [{ id: 'n1', type: 'note', title: '第一篇', content: '雨声', localDate: '2026-11-21', revision: 1 }] } },
  });
  view.init();
  await view.load();
  clickAction(panel, { action: 'select-entry', id: 'n1' });

  let bodyFocused = 0;
  let bodySel = null;
  let titleFocused = 0;
  let titleSel = null;
  const bodyEl = {
    name: 'entry-content',
    selectionStart: 0,
    selectionEnd: 0,
    focus() { bodyFocused += 1; },
    setSelectionRange(a, b) { bodySel = [a, b]; },
  };
  const titleEl = {
    name: 'entry-title',
    value: '第一篇',
    focus() { titleFocused += 1; },
    setSelectionRange(a, b) { titleSel = [a, b]; },
  };
  panel.querySelector = sel => (sel === '[name="entry-content"]' ? bodyEl : sel === '[name="entry-title"]' ? titleEl : null);

  panel.emit('keydown', { key: 'Enter', target: titleEl, shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false });
  assert.equal(bodyFocused, 1);
  assert.deepEqual(bodySel, [0, 0]);

  panel.emit('keydown', { key: 'Backspace', target: bodyEl, shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false });
  assert.equal(titleFocused, 1);
  assert.deepEqual(titleSel, [3, 3]);

  // 搜索与筛选隔离 + clear-filters 恢复
  panel.emit('input', { target: { name: 'task-search', value: '找不到这句' } });
  assert.match(panel.innerHTML, /没有找到匹配内容/);
  clickAction(panel, { action: 'clear-filters' });
  assert.match(panel.innerHTML, /第一篇/);
});

test('entries load failure stays retryable without firing auxiliary endpoints', async () => {
  const { view, panel, calls, viewApi } = harness();
  view.init();
  await view.load();
  calls.length = 0;
  const origGet = viewApi.get;
  viewApi.get = path => (path === '/api/life/entries' ? Promise.reject(new Error('offline')) : origGet(path));
  await view.load();
  assert.match(panel.innerHTML, /条目加载失败/);
  assert.match(panel.innerHTML, /data-action="retry-load"/);
  assert.ok(calls.every(([, p]) => p === '/api/life/entries'));
  viewApi.get = origGet;
  await view.load();
  assert.doesNotMatch(panel.innerHTML, /条目加载失败/);
});

test('interactive checklist, layout cycle preserving prose, and non-occluding fragments/collage never control playback', async () => {
  const nowPlaying = { provider: 'qq', songId: 'np-1', title: 'Endless Story', artist: 'REIRA' };
  const { view, panel, calls } = harness({
    getNowPlaying: () => nowPlaying,
    api: {
      dayMusic: { ok: true, tracks: [{ provider: 'ncm', songId: 'dm-1', title: 'Waltz for Debby', artist: 'Bill Evans', playedAt: '22:10', liked: true }] },
      dayQuotes: { ok: true, quotes: [{ turnId: 't-1', speaker: 'Lunara', time: '22:12', text: '这首夜曲留给下完雨的窗台。' }] },
      openLoops: { ok: true, openLoops: [{ noteId: 'loop-1', partnerName: 'Lunara', text: '周末买一张黑胶', dueDate: '2026-11-22' }] },
      onRequest: async (_path, opts) => ({ entry: { id: 'todo:from-loop', revision: 1, ...opts.body } }),
    },
  });
  view.init();
  await view.load();
  calls.length = 0;

  // 空白页提示真实片段拼贴
  assert.match(panel.innerHTML, /data-action="compose-today-page"/);
  clickAction(panel, { action: 'compose-today-page' });
  assert.match(panel.innerHTML, /class="today-vinyl-stub"/);
  assert.match(panel.innerHTML, /Endless Story/);
  assert.match(panel.innerHTML, /Waltz for Debby/);
  assert.match(panel.innerHTML, /这首夜曲留给下完雨的窗台。/);

  // 切换三态版式不改动已贴入与正文
  panel.emit('input', { target: { name: 'entry-content', value: '写给自己的一段夜话' } });
  clickAction(panel, { action: 'cycle-layout' });
  assert.match(panel.innerHTML, /版式 · 点阵/);
  assert.match(panel.innerHTML, /variant-dotgrid/);
  clickAction(panel, { action: 'cycle-layout' });
  assert.match(panel.innerHTML, /版式 · 刊页/);
  assert.match(panel.innerHTML, /today-playbill-masthead/);
  clickAction(panel, { action: 'cycle-layout' });
  assert.match(panel.innerHTML, /版式 · 素笺/);
  assert.match(panel.innerHTML, /写给自己的一段夜话/);
  assert.match(panel.innerHTML, /Endless Story/);

  // 圆圈清单新增、勾选、编辑、移除
  clickAction(panel, { action: 'add-checklist-item' });
  const chkId = panel.innerHTML.match(/data-check-id="([^"]+)"/)?.[1];
  assert.ok(chkId);
  panel.emit('input', { target: { name: 'entry-check-item', value: '泡乌龙茶', dataset: { checkId: chkId } } });
  clickAction(panel, { action: 'toggle-check', checkId: chkId });
  assert.match(panel.innerHTML, /today-check-row is-done/);
  clickAction(panel, { action: 'remove-check', checkId: chkId });
  assert.doesNotMatch(panel.innerHTML, /today-check-row/);

  // 碎片抽屉切换碎片与收进待办，绝不碰播放控制路由
  clickAction(panel, { action: 'toggle-inspector', inspector: 'fragments' });
  await settle();
  assert.match(panel.innerHTML, /class="today-inspector-drawer"/);
  assert.match(panel.innerHTML, /今日听过的歌（2）/);
  assert.match(panel.innerHTML, /今日聊天原话（1）/);
  assert.match(panel.innerHTML, /伙伴记着（1）/);

  clickAction(panel, { action: 'adopt-open-loop', noteId: 'loop-1' });
  await settle();
  assert.ok(calls.some(([m, p, b]) => m === 'POST' && p === '/api/life/entries' && b.type === 'todo' && b.title === '周末买一张黑胶'));
  assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/api/life/open-loops/loop-1/settle'));
  assert.ok(!calls.some(([, p]) => /\/api\/(next|play|pause|skip|seek)/.test(p)));
});

test('partner drawer generates margin annotations (201), supports inline reply, and fails gracefully on 503', async () => {
  const entries = [{
    id: 'n-ann',
    type: 'note',
    title: '初冬窗口',
    content: '今天外面的风像初冬，路灯亮得很早。',
    localDate: '2026-11-21',
    revision: 1,
    useForCompanionship: false,
    allowedPersonIds: [],
  }];
  let mode = '503';
  const { view, panel } = harness({
    api: {
      entries: { entries },
      onPost: async (path, body) => {
        if (path.endsWith('/annotations')) {
          if (mode === '503') {
            const err = new Error('unconfigured');
            err.status = 503;
            err.body = { ok: false, code: 'annotation_llm_unavailable' };
            throw err;
          }
          const updated = {
            ...entries[0],
            revision: 2,
            useForCompanionship: true,
            allowedPersonIds: [body.personId],
            annotations: [{
              id: 'ann-1',
              personId: 'lunara',
              personName: 'Lunara',
              time: '22:30',
              anchor: '风像初冬',
              text: '路灯早亮的时候，很适合放一首慢板钢琴。',
              reply: '',
            }],
          };
          entries[0] = updated;
          return { ok: true, entry: updated, annotation: updated.annotations[0] };
        }
        return { ok: true };
      },
    },
  });
  view.init();
  await view.load();
  clickAction(panel, { action: 'select-entry', id: 'n-ann' });
  clickAction(panel, { action: 'toggle-inspector', inspector: 'partner' });

  // 1. 503 优雅提示，不崩溃且保留草稿
  clickAction(panel, { action: 'request-annotation' });
  await settle();
  assert.match(panel.innerHTML, /当前未配置可用模型，暂时无法生成伙伴批注/);
  assert.doesNotMatch(panel.innerHTML, /today-margin-card/);

  // 2. 201 成功渲染页边批注卡，并可页边回复与撤下
  mode = 'ok';
  clickAction(panel, { action: 'request-annotation' });
  await settle();
  assert.match(panel.innerHTML, /today-margin-card/);
  assert.match(panel.innerHTML, /「风像初冬」/);
  assert.match(panel.innerHTML, /路灯早亮的时候，很适合放一首慢板钢琴。/);

  clickAction(panel, { action: 'start-ann-reply', annId: 'ann-1' });
  const replyNode = { value: '好呀，就听慢板。' };
  panel.querySelector = sel => (sel.includes('.today-reply-input') ? replyNode : null);
  clickAction(panel, { action: 'submit-ann-reply', annId: 'ann-1' });
  assert.match(panel.innerHTML, /你：好呀，就听慢板。/);

  clickAction(panel, { action: 'remove-ann', annId: 'ann-1' });
  assert.doesNotMatch(panel.innerHTML, /today-margin-card/);
});

test('focused typing, IME composition, in-place autosave, and refreshNowPlaying avoid DOM rebuilds while shareScope waits for confirm', async () => {
  const now = Date.now();
  const panel = element('section');
  let htmlWrites = 0;
  let htmlValue = '';
  Object.defineProperty(panel, 'innerHTML', {
    get: () => htmlValue,
    set: value => { htmlValue = value; htmlWrites += 1; },
  });
  const statusNode = { textContent: '', dataset: {} };
  const saveBtnNode = { textContent: '', dataset: {}, hidden: true };
  const deleteBtnNode = { hidden: true, dataset: {} };
  let listHtmlWrites = 0;
  let listHtmlValue = '';
  const rowTitleEl = { textContent: '' };
  const rowSnippetEl = { textContent: '' };
  const rowTimeEl = { textContent: '' };
  const rowMetaEl = { textContent: '' };
  const listRowNode = {
    dataset: { id: 'created-in-place' },
    previousElementSibling: null,
    classList: { contains: () => false },
    querySelector: sel => {
      if (sel.includes('title')) return rowTitleEl;
      if (sel.includes('snippet')) return rowSnippetEl;
      if (sel.includes('time')) return rowTimeEl;
      if (sel.includes('meta')) return rowMetaEl;
      return null;
    },
  };
  const listNode = {
    scrollTop: 0,
    get children() {
      return listHtmlValue.includes('created-in-place') ? [listRowNode] : [];
    },
    querySelector: sel => (listHtmlValue.includes('created-in-place') && sel.includes('created-in-place') ? listRowNode : null),
  };
  Object.defineProperty(listNode, 'innerHTML', {
    get: () => listHtmlValue,
    set: value => { listHtmlValue = value; listHtmlWrites += 1; },
  });
  const countNode = { textContent: '' };
  const titleInput = {
    tagName: 'INPUT',
    name: 'entry-title',
    value: '',
  };
  const bodyTextarea = {
    tagName: 'TEXTAREA',
    name: 'entry-content',
    value: '',
    style: {},
    clientHeight: 220,
    scrollHeight: 220,
    closest: sel => (sel === '.today-notes-editor-pane' ? {} : null),
  };
  const fragTrackListNode = { innerHTML: '' };
  panel.querySelector = sel => ({
    '.today-save-indicator': statusNode,
    '[data-action="add-entry"]': saveBtnNode,
    '[data-action="soft-delete"]': deleteBtnNode,
    '.today-notes-list': listNode,
    '.today-spine-count': countNode,
    '[name="entry-title"]': titleInput,
    '[name="entry-content"]': bodyTextarea,
    '[data-frag-track-list]': fragTrackListNode,
  })[sel] || null;

  let currentTrack = { provider: 'qq', songId: 'np-1', title: 'Endless Story', artist: 'REIRA' };
  const savedRequests = [];
  let rev = 0;
  const apiClient = {
    get: async path => (path === '/api/life/entries' ? { entries: [] } : { tracks: [], quotes: [], openLoops: [] }),
    post: async () => ({ ok: true }),
    request: async (_path, opts) => {
      savedRequests.push(opts.body);
      rev += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        entry: {
          id: 'created-in-place',
          ...opts.body,
          title: opts.body.title || opts.body.content.slice(0, 12),
          createdAt: now,
          updatedAt: now + rev * 10,
          revision: rev,
        },
      };
    },
  };
  const view = createTodayView({
    apiClient,
    autosaveDelayMs: 50,
    getNowPlaying: () => currentTrack,
    documentLike: { activeElement: bodyTextarea, querySelector: sel => (sel === '#today-panel' ? panel : element()) },
  });
  view.init();
  await view.load();
  const writesBeforeTyping = htmlWrites;

  // 1. IME pre-edit composition does NOT trigger autosave or DOM rebuilds
  panel.emit('compositionstart', { target: bodyTextarea });
  bodyTextarea.value = 'yese';
  panel.emit('input', { target: bodyTextarea, isComposing: true });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(savedRequests.length, 0, 'IME pre-edit must not schedule or fire autosave');

  // 2. compositionend schedules one autosave and updates without destroying panel DOM or overwriting blank title
  bodyTextarea.value = '夜色正浓，键盘连续敲击不卡顿';
  panel.emit('compositionend', { target: bodyTextarea });
  assert.equal(htmlWrites, writesBeforeTyping);
  assert.equal(statusNode.dataset.state, 'dirty');

  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(savedRequests.length, 1);
  assert.equal(htmlWrites, writesBeforeTyping, 'autosave saving/saved must NOT destroy focused editor innerHTML');
  assert.equal(statusNode.dataset.state, 'saved');
  assert.equal(saveBtnNode.dataset.id, 'created-in-place');
  assert.equal(titleInput.value, '', 'derived server title must not backfill empty title input');
  assert.match(listNode.innerHTML, /created-in-place/);

  // 3. Second edit on the already-top entry updates row text in place without rewriting listNode.innerHTML
  const listWritesAfterCreate = listHtmlWrites;
  bodyTextarea.value = '夜色正浓，第二段继续写';
  panel.emit('input', { target: bodyTextarea, isComposing: false });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(savedRequests.length, 2);
  assert.equal(listHtmlWrites, listWritesAfterCreate, 'subsequent edit on top entry must update list row in place');
  assert.equal(htmlWrites, writesBeforeTyping);
  assert.ok(rowTitleEl.textContent || rowSnippetEl.textContent, 'in-place list row text should update');

  // 4. Blur change on text input does not double-save clean draft
  panel.emit('change', { target: bodyTextarea });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(savedRequests.length, 2);

  // 5. refreshNowPlaying with unchanged track key never calls render()
  view.refreshNowPlaying();
  assert.equal(htmlWrites, writesBeforeTyping, 'unchanged track must not trigger render');

  // 6. 共享范围变更须等待手动确认
  panel.emit('change', { target: { name: 'entry-share-scope', value: 'summary' } });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(savedRequests.length, 2, 'shareScope change waits for manual confirm');
});

test('legacy todos/arrangements/recurring entries inside more menu and list checkboxes remain intact and support reschedule & soft-delete undo', async () => {
  const date = new Intl.DateTimeFormat('en-CA').format(new Date());
  const spanEntry = { id: 'span', type: 'event', title: '出差', localDate: '2020-01-01', endDate: '2020-01-03', repeatFrequency: 'none', done: false, revision: 4 };
  const authEntry = { id: 'auth:1', type: 'note', title: '深夜随笔', content: '听雨', localDate: date, revision: 3, useForCompanionship: true, allowedPersonIds: ['lunara'] };
  const recurring = { id: 'daily', type: 'todo', title: '每日阅读', localDate: date, repeatFrequency: 'daily', repeatWeekdays: [], completedDates: [], revision: 2 };
  const entries = [spanEntry, authEntry, recurring];
  const requests = [];
  const { view, panel, viewApi } = harness({
    api: { entries: { entries } },
    undoTimeoutMs: 40,
  });
  viewApi.request = async (path, opts = {}) => {
    requests.push([opts.method || 'GET', path, opts.body]);
    if (path.endsWith('/revoke-companionship')) {
      return { ok: true, entry: { ...authEntry, useForCompanionship: false, allowedPersonIds: [], revision: 4 } };
    }
    if (path.endsWith('/done')) {
      return { ok: true, entry: { ...recurring, revision: 3 } };
    }
    if (opts.method === 'PATCH') {
      return { ok: true, entry: { ...spanEntry, ...opts.body, revision: 5 } };
    }
    return { ok: true };
  };
  view.init();
  await view.load();

  assert.match(panel.innerHTML, /data-action="toggle-done"/);
  assert.match(panel.innerHTML, /已逾期/);

  // ⋯ 更多菜单里支持改期与重复
  clickAction(panel, { action: 'select-entry', id: 'span' });
  clickAction(panel, { action: 'toggle-popover', popover: 'more' });
  assert.match(panel.innerHTML, /name="entry-repeat"/);
  clickAction(panel, { action: 'move-tomorrow' });
  await settle();
  const patchReq = requests.find(([m]) => m === 'PATCH');
  assert.ok(patchReq);
  assert.deepEqual(Object.keys(patchReq[2]).sort(), ['endDate', 'expectedRevision', 'localDate']);

  // 软删除立即撤回授权，5s 撤销窗恢复
  requests.length = 0;
  clickAction(panel, { action: 'select-entry', id: 'auth:1' });
  clickAction(panel, { action: 'soft-delete', id: 'auth:1' });
  await settle();
  assert.ok(requests.some(([m, p]) => m === 'POST' && p === '/api/life/entries/auth%3A1/revoke-companionship'));
  assert.ok(!requests.some(([m]) => m === 'DELETE'));
  clickAction(panel, { action: 'undo-delete' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(!requests.some(([m]) => m === 'DELETE'));

  clickAction(panel, { action: 'soft-delete', id: 'auth:1' });
  await settle();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(requests.some(([m, p, b]) => m === 'DELETE' && p === '/api/life/entries/auth%3A1' && b.expectedRevision === 4));
});

test('60s clock tick updates time text in place without re-rendering innerHTML and Escape closes popovers', async () => {
  let tick = null;
  const panel = element('section');
  let htmlWrites = 0;
  let htmlValue = '';
  Object.defineProperty(panel, 'innerHTML', {
    get: () => htmlValue,
    set: value => { htmlValue = value; htmlWrites += 1; },
  });
  const timeNode = { textContent: '00:00' };
  panel.querySelector = sel => (sel === '[data-now-time]' ? timeNode : null);
  const view = createTodayView({
    apiClient: { get: async () => ({ entries: [] }), post: async () => ({ ok: true }), request: async () => ({ ok: true }) },
    documentLike: { querySelector: sel => (sel === '#today-panel' ? panel : element()) },
    scheduleInterval: fn => { tick = fn; return { unref() {} }; },
  });
  view.init();
  await view.load();
  const writesAfterLoad = htmlWrites;
  tick();
  assert.equal(htmlWrites, writesAfterLoad, '时钟节拍不得重写 panel.innerHTML');
  assert.match(timeNode.textContent, /^\d{2}:\d{2}$/);

  clickAction(panel, { action: 'toggle-inspector', inspector: 'fragments' });
  assert.match(panel.innerHTML, /class="today-inspector-drawer"/);
  panel.emit('keydown', { key: 'Escape', isComposing: false, target: { tagName: 'SECTION' } });
  assert.doesNotMatch(panel.innerHTML, /class="today-inspector-drawer"/);
});

test('today.css maintains accessibility contrast, >=12px text, <=1px left borders, and non-wildcard reduced-motion', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./today.css', import.meta.url), 'utf8');
  assert.match(css, /--ln-accent-ink:\s*#9e1c11/);
  assert.doesNotMatch(css, /\.today-panel \*[\s\S]*transition:\s*none\s*!important/);
  assert.doesNotMatch(css, /border-left:\s*[2-9]px/);
  assert.doesNotMatch(css, /max-height:\s*calc\(100%\s*-\s*60px\)/, 'more menu inside 50px toolbar must not size against 100% parent height');
  for (const [, size] of css.matchAll(/font-size:\s*([0-9.]+)px/g)) {
    assert.ok(Number(size) >= 12, `found undersized font-size: ${size}px`);
  }
});

test('checklist and fragments insert at current cursor position instead of jumping to mid-page bottom', async () => {
  const { view, panel } = harness({
    getNowPlaying: () => ({ provider: 'qq', songId: 'cur-1', title: '夜航船', artist: '陈粒' }),
  });
  view.init();
  await view.load();

  // 1. 仅输入标题时点「清单」，清单直接跟在标题下方（在正文尾段输入框之前），不隔整块空白
  panel.emit('input', { target: { name: 'entry-title', value: '所有未来和你有关的人和事' } });
  clickAction(panel, { action: 'add-checklist-item' });
  const chkPos = panel.innerHTML.indexOf('class="today-checklist"');
  const tailBodyPos = panel.innerHTML.indexOf('id="today-entry-content"');
  assert.ok(chkPos > 0 && chkPos < tailBodyPos, 'checklist on empty body must render before trailing prose textarea');

  // 2. 光标位于两段文字中间时贴入碎片，碎片落在第一段与第二段之间
  view.openNewDraft({ title: '分段测试', content: '第一段雨声\n第二段泡茶', focus: false });
  panel.emit('focusin', {
    target: {
      name: 'entry-content',
      value: '第一段雨声\n第二段泡茶',
      selectionStart: 5,
      dataset: { segStart: '0', segEnd: '2' },
    },
  });
  clickAction(panel, { action: 'toggle-inspector', inspector: 'fragments' });
  clickAction(panel, { action: 'toggle-frag-track', fragIndex: '0' });

  const seg1Pos = panel.innerHTML.indexOf('第一段雨声');
  const stubPos = panel.innerHTML.indexOf('class="today-vinyl-stub"');
  const seg2Pos = panel.innerHTML.indexOf('第二段泡茶');
  assert.ok(seg1Pos > 0 && stubPos > seg1Pos && seg2Pos > stubPos, 'pasted track stub must appear at cursor between paragraph 1 and paragraph 2');
});

test('entryListSummary truncates long prose and attached quote snippets to <= 120 chars', async () => {
  const now = Date.now();
  const today = new Intl.DateTimeFormat('en-CA').format(new Date(now));
  const { view, panel } = harness({
    api: {
      entries: {
        entries: [
          {
            id: 'long-prose',
            type: 'note',
            title: '长文标题',
            content: `  第一段   \n${'春'.repeat(260)}`,
            localDate: today,
            updatedAt: now,
            revision: 1,
          },
          {
            id: 'long-quote',
            type: 'note',
            title: '原话摘录',
            content: '',
            attachedQuotes: [{ speaker: 'Lunara', text: '夏'.repeat(200) }],
            localDate: today,
            updatedAt: now - 1000,
            revision: 1,
          },
        ],
      },
    },
  });
  view.init();
  await view.load();

  const snippets = [...panel.innerHTML.matchAll(/<span class="today-entry-snippet">([^<]+)<\/span>/g)].map(m => m[1]);
  assert.equal(snippets.length, 2);
  assert.equal(snippets[0].length, 120);
  assert.ok(snippets[0].startsWith('第一段 春'));
  assert.equal(snippets[1].length, 120);
  assert.equal(snippets[1], '夏'.repeat(120));
});

test('editing second entry in same recency group moves row via insertBefore without rewriting listNode.innerHTML', async () => {
  const now = Date.now();
  const today = new Intl.DateTimeFormat('en-CA').format(new Date(now));
  const entries = [
    { id: 'e1', type: 'note', title: '第一篇', content: '旧内容一', localDate: today, pinned: false, updatedAt: now - 1000, revision: 1 },
    { id: 'e2', type: 'note', title: '第二篇', content: '旧内容二', localDate: today, pinned: false, updatedAt: now - 5000, revision: 1 },
  ];

  const panel = element('section');
  let htmlWrites = 0;
  let htmlValue = '';
  let listHtmlWrites = 0;
  let listHtmlValue = '';
  let listChildren = [];
  const insertBeforeCalls = [];

  const bindNextSibling = node => {
    Object.defineProperty(node, 'nextSibling', {
      configurable: true,
      get: () => {
        const idx = listChildren.indexOf(node);
        return idx >= 0 ? (listChildren[idx + 1] ?? null) : null;
      },
    });
    return node;
  };

  const buildRowNode = (id, revision, title, time, snippet) => {
    const titleEl = { textContent: title };
    const timeEl = { textContent: time };
    const snipEl = { textContent: snippet, hidden: !snippet };
    return bindNextSibling({
      dataset: { id, revision: String(revision) },
      classList: { contains: cls => cls === 'today-entry' },
      querySelector: sel => {
        if (sel.includes('title')) return titleEl;
        if (sel.includes('time')) return timeEl;
        if (sel.includes('snippet')) return snipEl;
        return null;
      },
    });
  };

  const populateListChildren = markup => {
    const nodes = [];
    const tokenRe = /<li class="today-timeline-heading">([^<]+)<\/li>|<li class="today-entry[^>]*data-id="([^"]+)"[^>]*data-revision="([^"]+)"[\s\S]*?<span class="today-entry-title">([^<]*)<\/span>[\s\S]*?<span class="today-entry-time[^"]*">([^<]*)<\/span>\s*<span class="today-entry-snippet"([^>]*)>([^<]*)<\/span>/g;
    for (const match of markup.matchAll(tokenRe)) {
      if (match[1]) {
        nodes.push(bindNextSibling({
          textContent: match[1],
          classList: { contains: cls => cls === 'today-timeline-heading' },
        }));
      } else {
        nodes.push(buildRowNode(match[2], match[3], match[4], match[5], match[7]));
      }
    }
    listChildren = nodes;
  };

  const listNode = {
    scrollTop: 0,
    get children() { return listChildren; },
    insertBefore(node, refNode) {
      insertBeforeCalls.push({ movedId: node?.dataset?.id ?? null, beforeId: refNode?.dataset?.id ?? null });
      const fromIdx = listChildren.indexOf(node);
      if (fromIdx >= 0) listChildren.splice(fromIdx, 1);
      const toIdx = refNode ? listChildren.indexOf(refNode) : -1;
      if (toIdx >= 0) listChildren.splice(toIdx, 0, node);
      else listChildren.push(node);
      return node;
    },
  };
  Object.defineProperty(listNode, 'innerHTML', {
    get: () => listHtmlValue,
    set: value => {
      listHtmlValue = value;
      listHtmlWrites += 1;
      populateListChildren(value);
    },
  });

  const statusNode = { textContent: '', dataset: {} };
  const saveBtnNode = { textContent: '', dataset: {}, hidden: true };
  const deleteBtnNode = { hidden: true, dataset: {} };
  const countNode = { textContent: '' };
  const titleInput = { tagName: 'INPUT', name: 'entry-title', value: '第二篇' };
  const bodyTextarea = {
    tagName: 'TEXTAREA',
    name: 'entry-content',
    value: '旧内容二',
    style: {},
    clientHeight: 220,
    scrollHeight: 220,
    closest: sel => (sel === '.today-notes-editor-pane' ? {} : null),
  };

  Object.defineProperty(panel, 'innerHTML', {
    get: () => htmlValue,
    set: value => {
      htmlValue = value;
      htmlWrites += 1;
      const ulMatch = value.match(/<ul class="today-notes-list">([\s\S]*?)<\/ul>/);
      if (ulMatch) {
        listHtmlValue = ulMatch[1];
        populateListChildren(ulMatch[1]);
      }
    },
  });
  panel.querySelector = sel => ({
    '.today-save-indicator': statusNode,
    '[data-action="add-entry"]': saveBtnNode,
    '[data-action="soft-delete"]': deleteBtnNode,
    '.today-notes-list': listNode,
    '.today-spine-count': countNode,
    '[name="entry-title"]': titleInput,
    '[name="entry-content"]': bodyTextarea,
  })[sel] || null;

  const documentLike = {
    activeElement: null,
    querySelector: sel => (sel === '#today-panel' ? panel : element()),
  };

  const apiClient = {
    get: async path => (path === '/api/life/entries' ? { entries } : { tracks: [], quotes: [], openLoops: [] }),
    post: async () => ({ ok: true }),
    request: async (path, opts) => {
      const id = path.split('/').pop();
      const prev = entries.find(item => item.id === id);
      const updated = { ...prev, ...opts.body, updatedAt: now + 5000, revision: (prev?.revision || 1) + 1 };
      return { entry: updated };
    },
  };

  const view = createTodayView({
    apiClient,
    autosaveDelayMs: 40,
    documentLike,
  });
  view.init();
  await view.load();
  assert.deepEqual(listChildren.map(n => n.dataset?.id || n.textContent), ['今天', 'e1', 'e2']);

  clickAction(panel, { action: 'select-entry', id: 'e2' });
  documentLike.activeElement = bodyTextarea;
  const writesBeforeEdit = htmlWrites;
  const listWritesBeforeEdit = listHtmlWrites;

  bodyTextarea.value = '第二篇更新后的正文';
  panel.emit('input', { target: bodyTextarea, isComposing: false });
  await new Promise(resolve => setTimeout(resolve, 110));

  assert.equal(htmlWrites, writesBeforeEdit, 'focused edit + autosave must not rewrite panel.innerHTML');
  assert.equal(listHtmlWrites, listWritesBeforeEdit, 'same-group reorder must not rewrite listNode.innerHTML');
  assert.equal(insertBeforeCalls.length, 1);
  assert.deepEqual(insertBeforeCalls[0], { movedId: 'e2', beforeId: 'e1' });
  assert.deepEqual(listChildren.map(n => n.dataset?.id || n.textContent), ['今天', 'e2', 'e1']);
  assert.equal(listChildren[1].dataset.revision, '2');
  assert.equal(listChildren[1].querySelector('.today-entry-snippet').textContent, '第二篇更新后的正文');
});
