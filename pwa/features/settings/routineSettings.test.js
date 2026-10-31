import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutineSettings, describeWorkDays } from './routineSettings.js';

/** Minimal DOM stand-in: enough for markup injection, querying and click dispatch. */
function fakeDom() {
  const listeners = [];
  const makeNode = (tag = 'div') => {
    const node = {
      tagName: tag.toUpperCase(), children: [], attributes: {}, _listeners: [],
      set innerHTML(value) { this._html = value; this._parsed = parse(value); },
      get innerHTML() { return this._html || ''; },
      querySelector(selector) { return (this._parsed || []).find(item => item.matches(selector)) || null; },
      querySelectorAll(selector) { return (this._parsed || []).filter(item => item.matches(selector)); },
      addEventListener(type, handler) { this._listeners.push({ type, handler }); listeners.push({ node: this, type, handler }); },
      dispatch(type, payload = {}) { for (const item of this._listeners.filter(entry => entry.type === type)) item.handler({ preventDefault() {}, ...payload }); },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
    return node;
  };

  // A deliberately tiny parser: elements with id/data-*/name/type/value/checked.
  function parse(html) {
    const nodes = [];
    const elementPattern = /<(input|button|select|option|label|span|li|div|p|ul)\b([^>]*)>/giu;
    let match;
    while ((match = elementPattern.exec(html))) {
      const [, tag, rawAttrs] = match;
      const attributes = {};
      const attrPattern = /([a-zA-Z-]+)(?:="([^"]*)")?/gu;
      let attr;
      while ((attr = attrPattern.exec(rawAttrs))) attributes[attr[1]] = attr[2] ?? '';
      const node = {
        tagName: tag.toUpperCase(), attributes,
        matches(selector) {
          if (selector.startsWith('#')) return attributes.id === selector.slice(1);
          const bracket = selector.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/u);
          if (!bracket) return false;
          const [, tagName, attrName, attrValue] = bracket;
          if (tagName && tag.toUpperCase() !== tagName.toUpperCase()) return false;
          if (!Object.hasOwn(attributes, attrName)) return false;
          return attrValue === undefined ? true : attributes[attrName] === attrValue;
        },
        checked: Object.hasOwn(attributes, 'checked'), value: attributes.value ?? '',
        _listeners: [],
        addEventListener(type, handler) { this._listeners.push({ type, handler }); listeners.push({ node: this, type, handler }); },
        dispatch(type, payload = {}) { for (const entry of this._listeners.filter(item => item.type === type)) entry.handler({ preventDefault() {}, ...payload }); },
        getAttribute(name) { return attributes[name] ?? null; },
        setAttribute(name, value) { attributes[name] = String(value); },
      };
      nodes.push(node);
    }
    return nodes;
  }

  const host = makeNode('div');
  host.attributes.id = 'routine-settings';
  const document = { querySelector: selector => (selector === '#routine-settings' ? host : null) };
  return { document, host, listeners };
}

function harness({ routine = { timeZone: 'Asia/Shanghai', workDays: [1, 2, 3, 4, 5],
  workStartTime: '09:00', workEndTime: '18:00', revision: 2, configured: true },
failRoutine = false, refuseSave = false, deviceTimeZone = 'Europe/Paris' } = {}) {
  const calls = [];
  const toasts = [];
  const apiClient = {
    get: async path => {
      calls.push({ method: 'GET', path });
      if (failRoutine) throw new Error('offline');
      return { ok: true, routine };
    },
    request: async (path, options = {}) => {
      calls.push({ method: options.method, path, body: options.body });
      if (refuseSave) return { ok: false, error: '服务端拒绝了这次保存' };
      return { ok: true };
    },
  };
  const dom = fakeDom();
  // 2026-10-20 06:30 UTC = 上海 14:30。
  const settings = createRoutineSettings({ apiClient, documentLike: dom.document,
    showToast: (...args) => toasts.push(args), deviceTimeZone,
    timeZones: ['Asia/Shanghai', 'Europe/Paris', 'UTC'], now: () => Date.UTC(2026, 9, 20, 6, 30) });
  return { calls, toasts, dom, settings };
}

const q = (h, selector) => h.dom.host.querySelector(selector);
const day = (h, value) => h.dom.host.querySelectorAll('button[data-routine-day]').find(node => node.getAttribute('data-routine-day') === String(value));

test('describeWorkDays merges consecutive days and keeps scattered ones apart', () => {
  assert.equal(describeWorkDays(new Set([1, 2, 3, 4, 5])), '周一至周五');
  assert.equal(describeWorkDays(new Set([1, 3, 5])), '周一、周三、周五');
  assert.equal(describeWorkDays(new Set([1, 2, 3, 5, 6])), '周一至周三、周五、周六');
  assert.equal(describeWorkDays(new Set([0, 1, 2, 3, 4, 5, 6])), '每天');
  assert.equal(describeWorkDays(new Set()), '');
});

test('renders the saved routine as a summary, pressed weekdays, a work span and the local clock', async () => {
  const h = harness();
  await h.settings.refresh();
  const html = h.dom.host.innerHTML;
  assert.match(html, /周一至周五上班 · 09:00–18:00/u);
  assert.match(html, /已保存/u);
  assert.match(html, /当地现在 14:30/u);
  assert.match(html, /routine-bar-span" style="left:37\.500%;width:37\.500%"/u);
  assert.equal(day(h, 1).getAttribute('aria-pressed'), 'true');
  assert.equal(day(h, 6).getAttribute('aria-pressed'), 'false');
  assert.equal(q(h, 'select[name="routine-zone"]') && /value="Asia\/Shanghai" selected/u.test(html), true);
  assert.ok(Object.hasOwn(q(h, '[data-routine-save]').attributes, 'disabled'), 'nothing to save yet');
});

test('only the routine is requested; scene defaults have no UI any more', async () => {
  const h = harness();
  await h.settings.refresh();
  await h.settings.refresh();
  assert.deepEqual(h.calls, [{ method: 'GET', path: '/api/life/routine' }]);
  assert.doesNotMatch(h.dom.host.innerHTML, /场景/u);
});

test('an unconfigured routine preselects the device time zone without saving it', async () => {
  const h = harness({ routine: { timeZone: null, workDays: [], workStartTime: null, workEndTime: null, revision: 0, configured: false } });
  await h.settings.refresh();
  const html = h.dom.host.innerHTML;
  assert.match(html, /value="Europe\/Paris" selected>Europe\/Paris（本机）/u);
  assert.match(html, /还没设置/u);
  assert.match(html, /没有工作日，每天都按休息日理解/u);
  assert.equal(h.calls.filter(call => call.method !== 'GET').length, 0);
});

test('toggling a weekday and editing hours refresh the summary and dirty state in place', async () => {
  const h = harness();
  await h.settings.refresh();
  const summary = q(h, '[data-routine-summary]');
  day(h, 6).dispatch('click');
  assert.equal(day(h, 6).getAttribute('aria-pressed'), 'true');
  assert.equal(summary.textContent, '周一至周六上班 · 09:00–18:00');
  assert.equal(q(h, '[data-routine-state]').textContent, '有未保存的修改');
  assert.equal(q(h, '[data-routine-save]').disabled, false);
  q(h, '#routine-end').dispatch('input', { target: { value: '02:00' } });
  assert.equal(summary.textContent, '周一至周六上班 · 09:00–02:00（跨夜）');
  assert.equal((q(h, '[data-routine-bar]').innerHTML.match(/routine-bar-span/gu) || []).length, 2, 'an overnight span wraps');
  day(h, 6).dispatch('click');
  q(h, '#routine-end').dispatch('input', { target: { value: '18:00' } });
  assert.equal(q(h, '[data-routine-state]').textContent, '已保存', 'reverting the edits is clean again');
});

test('saving sends the draft with the expected revision and reloads after confirmation', async () => {
  const h = harness();
  await h.settings.refresh();
  day(h, 5).dispatch('click');
  q(h, '#routine-zone').dispatch('change', { target: { value: 'UTC' } });
  q(h, '#routine-start').dispatch('input', { target: { value: '10:00' } });
  await q(h, '[data-routine-save]').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  const put = h.calls.find(call => call.method === 'PUT');
  assert.equal(put.path, '/api/life/routine');
  assert.deepEqual(put.body, { timeZone: 'UTC', workDays: [1, 2, 3, 4], workStartTime: '10:00',
    workEndTime: '18:00', expectedRevision: 2 });
  assert.equal(h.toasts.at(-1)[1], '作息已保存');
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 2);
});

test('half-filled working hours fail closed before any request', async () => {
  const h = harness();
  await h.settings.refresh();
  q(h, '#routine-end').dispatch('input', { target: { value: '' } });
  await q(h, '[data-routine-save]').dispatch('click');
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(h.toasts.at(-1)[1], '上下班时间要成对填写');
});

test('a refused save is not reported as saved and keeps the draft', async () => {
  const h = harness({ refuseSave: true });
  await h.settings.refresh();
  day(h, 6).dispatch('click');
  await q(h, '[data-routine-save]').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.toasts.at(-1)[1], '作息没保存成功');
  assert.equal(h.settings.getState().dirty, true);
  assert.equal(q(h, '[data-routine-state]').textContent, '有未保存的修改');
});

test('a failed load offers a retry and refuses to save over the unseen config', async () => {
  const h = harness({ failRoutine: true });
  await h.settings.refresh();
  assert.match(h.dom.host.innerHTML, /作息没能读取成功/u);
  assert.ok(q(h, '[data-routine-retry]'));
  await q(h, '[data-routine-save]').dispatch('click');
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
  q(h, '[data-routine-retry]').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 2);
});

test('saving the routine never starts playback or generates a program', async () => {
  const h = harness();
  await h.settings.refresh();
  day(h, 6).dispatch('click');
  await q(h, '[data-routine-save]').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.map(call => call.path).filter(path => !path.startsWith('/api/life/routine')), []);
});
