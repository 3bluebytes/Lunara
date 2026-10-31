// 「一起听歌时伙伴会主动说话」开关：写入成功才确认，失败回显旧值与可恢复提示，环境总开关时只读
// （add-companion-heartbeat 4.2）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresenceAmbientSetting } from './presenceAmbientSetting.js';

function fakeDom() {
  const element = extra => ({ attributes: {}, listeners: [], ...extra,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    dispatch(type) { for (const entry of this.listeners.filter(item => item.type === type)) entry.handler({ target: this }); } });
  const nodes = { '#presence-ambient-toggle': element({ checked: false, disabled: true }),
    '#presence-ambient-note': element({ textContent: '' }),
    '#presence-greeting-toggle': element({ checked: false, disabled: true }),
    '#presence-greeting-note': element({ textContent: '' }) };
  return { querySelector: selector => nodes[selector] || null, toggle: nodes['#presence-ambient-toggle'], note: nodes['#presence-ambient-note'],
    greeting: nodes['#presence-greeting-toggle'], greetingNote: nodes['#presence-greeting-note'] };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('loads the confirmed value and enables the control', async () => {
  const dom = fakeDom();
  const setting = createPresenceAmbientSetting({ documentLike: dom,
    apiClient: { get: async path => { assert.equal(path, '/api/presence/preferences'); return { ok: true, ambientEnabled: true, available: true }; }, post: async () => assert.fail() } });
  await setting.refresh();
  assert.equal(dom.toggle.checked, true);
  assert.equal(dom.toggle.disabled, false);
  assert.match(dom.note.textContent, /安静/);
});

test('the change is confirmed only after the write succeeds', async () => {
  const dom = fakeDom();
  const write = deferred();
  const posts = [];
  const setting = createPresenceAmbientSetting({ documentLike: dom, apiClient: {
    get: async () => ({ ok: true, ambientEnabled: true, available: true }),
    post: async (path, body) => { posts.push([path, body]); return write.promise; } } });
  await setting.refresh();
  dom.toggle.checked = false;           // 用户点了一下：浏览器先翻转
  dom.toggle.dispatch('change');
  assert.deepEqual(posts, [['/api/presence/preferences', { ambientEnabled: false }]]);
  assert.equal(dom.toggle.checked, true, '写入成功之前仍显示旧值');
  assert.equal(dom.toggle.attributes['aria-busy'], 'true');
  assert.equal(dom.toggle.disabled, false, '保存中不禁用：键盘焦点留在控件上');
  dom.toggle.checked = true;            // 保存中又点一次：忽略并回到已确认的值
  dom.toggle.dispatch('change');
  assert.equal(posts.length, 1);
  write.resolve({ ok: true, ambientEnabled: false, available: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.toggle.checked, false);
  assert.equal(dom.toggle.attributes['aria-busy'], 'false');
  assert.match(dom.note.textContent, /已保存/);
});

test('a failed write shows the previous value and a recoverable message without internals', async () => {
  const dom = fakeDom();
  const setting = createPresenceAmbientSetting({ documentLike: dom, apiClient: {
    get: async () => ({ ok: true, ambientEnabled: true, available: true }),
    post: async () => { throw new Error('SQLITE_BUSY: database is locked'); } } });
  await setting.refresh();
  dom.toggle.checked = false;
  await setting.setEnabled(false);
  assert.equal(dom.toggle.checked, true);
  assert.match(dom.note.textContent, /没能保存.*仍然是打开/);
  assert.doesNotMatch(dom.note.textContent, /SQLITE/);
});

test('the environment switch makes the control read-only', async () => {
  const dom = fakeDom();
  const setting = createPresenceAmbientSetting({ documentLike: dom, apiClient: {
    get: async () => ({ ok: true, ambientEnabled: true, available: false }), post: async () => assert.fail('must not write') } });
  await setting.refresh();
  assert.equal(dom.toggle.disabled, true);
  assert.equal(dom.toggle.checked, true);
  assert.match(dom.note.textContent, /PRESENCE_AUTO=0/);
  await setting.setEnabled(false);
});

test('a failed load keeps the control disabled and says so', async () => {
  const dom = fakeDom();
  const setting = createPresenceAmbientSetting({ documentLike: dom, apiClient: { get: async () => { throw new Error('offline'); }, post: async () => assert.fail() } });
  await setting.refresh();
  assert.equal(dom.toggle.disabled, true);
  assert.match(dom.note.textContent, /读不到/);
});

// ── 「打开 app 时伙伴可以打招呼」（add-app-open-greeting 4.1） ──
test('the greeting switch is its own control: writes only its key and leaves the listening switch alone', async () => {
  const dom = fakeDom();
  const posts = [];
  const setting = createPresenceAmbientSetting({ documentLike: dom, apiClient: {
    get: async () => ({ ok: true, ambientEnabled: false, greetingEnabled: true, available: true }),
    post: async (path, body) => { posts.push([path, body]); return { ok: true, ambientEnabled: false, greetingEnabled: false, available: true }; } } });
  await setting.refresh();
  assert.equal(dom.greeting.checked, true, '默认开');
  assert.equal(dom.greeting.disabled, false);
  assert.equal(dom.toggle.checked, false);
  assert.match(dom.greetingNote.textContent, /只出文字/);
  dom.greeting.checked = false;
  dom.greeting.dispatch('change');
  assert.equal(dom.greeting.attributes['aria-busy'], 'true');
  assert.equal(dom.toggle.attributes['aria-busy'], 'false');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posts, [['/api/presence/preferences', { greetingEnabled: false }]]);
  assert.equal(dom.greeting.checked, false);
  assert.match(dom.greetingNote.textContent, /已保存。关闭后，打开 app 时伙伴不会先开口/);
  assert.doesNotMatch(dom.note.textContent, /已保存/);
});
