// songTagInspector.test.js — 「设置 → 歌曲标签」的浏览 / 搜索 / 修正 / 删除交互。
//
// Run: node --test pwa/features/settings/songTagInspector.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSongTagInspector } from './songTagInspector.js';

/** Minimal DOM stand-in: enough for markup injection, querying and event dispatch. */
function fakeDom() {
  const makeNode = (tag = 'div') => {
    const node = {
      tagName: tag.toUpperCase(), attributes: {}, _listeners: [],
      set innerHTML(value) { this._html = value; this._parsed = parse(value); },
      get innerHTML() { return this._html || ''; },
      querySelector(selector) { return (this._parsed || []).find(item => item.matches(selector)) || null; },
      querySelectorAll(selector) { return (this._parsed || []).filter(item => item.matches(selector)); },
      addEventListener(type, handler) { this._listeners.push({ type, handler }); },
      dispatch(type, payload = {}) {
        for (const entry of [...this._listeners].filter(item => item.type === type)) {
          entry.handler({ preventDefault() {}, ...payload });
        }
      },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
    return node;
  };

  // A deliberately tiny parser: elements with id/data-*/type/value/selected attributes.
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
        addEventListener(type, handler) { this._listeners.push({ type, handler }); },
        dispatch(type, payload = {}) {
          for (const entry of [...this._listeners].filter(item => item.type === type)) {
            entry.handler({ preventDefault() {}, ...payload });
          }
        },
        getAttribute(name) { return attributes[name] ?? null; },
      };
      nodes.push(node);
    }
    return nodes;
  }

  const host = makeNode('div');
  host.attributes.id = 'song-tag-inspector';
  const document = { querySelector: selector => (selector === '#song-tag-inspector' ? host : null) };
  return { document, host };
}

const ROW = {
  provider: 'ncm', song_id: '1', title: '浮夸', artist: '陈奕迅',
  language: 'mandarin', mood: '激昂', tempo: 'fast', has_vocal: true,
  energy: 0.8, valence: 0.4, confidence: 0.8, source: 'llm-knowledge',
  source_text: 'lyrics+llm', updated_at: 1760000000000,
};

function harness({ rows = [ROW], total, failGet = false, refuseWrite = false, removeDeleted = 1 } = {}) {
  const calls = [];
  const toasts = [];
  const apiClient = {
    get: async path => {
      calls.push({ method: 'GET', path });
      if (failGet) throw new Error('offline');
      const url = new URL(path, 'http://x');
      let items = rows;
      const search = url.searchParams.get('search');
      if (search) {
        items = items.filter(item => `${item.title}${item.artist}`.toLowerCase().includes(search.toLowerCase()));
      }
      return { ok: true, items, total: total ?? items.length, limit: 200, offset: Number(url.searchParams.get('offset')) };
    },
    request: async (path, options = {}) => {
      calls.push({ method: options.method, path, body: options.body });
      if (refuseWrite) return { ok: false, error: '服务端拒绝了这次修改' };
      if (options.method === 'PUT') return { ok: true, tags: { ...ROW, ...options.body.patch, source: 'user', confidence: 1 } };
      return { ok: true, deleted: removeDeleted };
    },
  };
  const dom = fakeDom();
  const inspector = createSongTagInspector({
    apiClient, documentLike: dom.document,
    showToast: (...args) => toasts.push(args),
  });
  return { calls, toasts, dom, inspector };
}

test('the inspector lists tagged songs with identity, summary and provenance', async () => {
  const h = harness();
  await h.inspector.refresh();
  const row = h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]');
  assert.ok(row, 'row is rendered with its provider:songId key');
  assert.match(h.dom.host.innerHTML, /浮夸/);
  assert.match(h.dom.host.innerHTML, /陈奕迅/);
  assert.match(h.dom.host.innerHTML, /mandarin · 有人声 · 激昂 · 快/, 'key tags are summarised');
  assert.match(h.dom.host.innerHTML, /置信 80%/, 'confidence is surfaced');
  assert.match(h.dom.host.innerHTML, /llm-knowledge/, 'provenance source is surfaced');
  h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]').dispatch('click');
  assert.match(h.dom.host.innerHTML, /lyrics\+llm/, 'evidence summary shows in the expanded editor');
});

test('the empty and failed states stay inline and explain the re-tag path', async () => {
  const empty = harness({ rows: [] });
  await empty.inspector.refresh();
  assert.match(empty.dom.host.innerHTML, /还没有已入库的歌曲标签/, 'empty library explains itself');

  const failed = harness({ failGet: true });
  await failed.inspector.refresh();
  assert.match(failed.dom.host.innerHTML, /没能读取成功/, 'load failure stays inline');
});

test('search commits on Enter and forwards the query to the API', async () => {
  const h = harness({ rows: [ROW, { ...ROW, song_id: '2', title: 'Love Words', artist: 'Eason Chan', language: 'english', mood: '', tempo: '', has_vocal: null }] });
  await h.inspector.refresh();
  const search = h.dom.host.querySelector('[data-song-tag-search]');
  search.dispatch('input', { target: { value: 'eason' } });
  assert.equal(h.inspector.getState().searchDraft, 'eason', 'typing keeps a draft without refetching');
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 1, 'input alone does not fetch');
  search.dispatch('keydown', { key: 'Enter' });
  await Promise.resolve();
  await Promise.resolve();
  const gets = h.calls.filter(call => call.method === 'GET');
  assert.equal(gets.length, 2, 'Enter triggers a refetch');
  assert.match(gets[1].path, /search=eason/, 'committed search reaches the API');
  assert.equal(h.inspector.getState().items.length, 1, 'only the matching row stays');
});

test('a row expands into an editor preloaded with current values, and saving issues a whitelisted PUT', async () => {
  const h = harness();
  await h.inspector.refresh();
  h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]').dispatch('click');
  assert.equal(h.inspector.getState().expandedKey, 'ncm:1', 'row expands');
  const language = h.dom.host.querySelector('[data-song-tag-field="language"]');
  assert.equal(language.value, 'mandarin', 'editor is preloaded with the current value');
  assert.ok(h.dom.host.querySelector('[data-song-tag-field="energy"]'), 'affect fields are editable');
  assert.match(h.dom.host.innerHTML, /不会再被自动覆盖|以你的修改为准|删除标签行/, 'editor explains authority and deletion');

  language.value = 'cantonese';
  h.dom.host.querySelector('[data-song-tag-field="energy"]').value = '0.3';
  h.dom.host.querySelector('[data-song-tag-field="mood"]').value = '';
  h.dom.host.querySelector('[data-song-tag-save]').dispatch('click');
  await Promise.resolve();
  await Promise.resolve();
  const put = h.calls.find(call => call.method === 'PUT');
  assert.ok(put, 'save issues a PUT');
  assert.deepEqual(put.body, { provider: 'ncm', songId: '1', patch: {
    language: 'cantonese', genre: '', mood: '', tempo: 'fast', has_vocal: 'true',
    energy: '0.3', valence: '0.4', vocal_softness: null, year: null,
    themes: '', instruments: '', scenes: '',
  } }, 'identity is explicit; the whole form is sent and numeric empties are cleared');
  assert.equal(h.inspector.getState().items[0].language, 'cantonese', 'list reflects the saved value');
  assert.equal(h.inspector.getState().items[0].source, 'user', 'saved row is authoritative');
  assert.match(h.inspector.getState().status.text, /以你的修改为准/);
});

test('a rejected save surfaces the server error inline and keeps the editor open', async () => {
  const h = harness({ refuseWrite: true });
  await h.inspector.refresh();
  h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]').dispatch('click');
  h.dom.host.querySelector('[data-song-tag-save]').dispatch('click');
  await Promise.resolve();
  await Promise.resolve();
  const state = h.inspector.getState();
  assert.match(state.status.text, /保存失败/);
  assert.equal(state.status.kind, 'error');
  assert.equal(state.expandedKey, 'ncm:1', 'editor stays open after failure');
});

test('delete asks for confirmation, removes the row and explains the re-tag path', async () => {
  const h = harness();
  await h.inspector.refresh();
  h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]').dispatch('click');
  h.dom.host.querySelector('[data-song-tag-delete]').dispatch('click');
  assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 0, 'first click only arms the confirmation');
  assert.equal(h.inspector.getState().confirmingKey, 'ncm:1');
  assert.match(h.dom.host.innerHTML, /确认删除/, 'the armed button says so');

  h.dom.host.querySelector('[data-song-tag-delete]').dispatch('click');
  await Promise.resolve();
  await Promise.resolve();
  const remove = h.calls.find(call => call.method === 'DELETE');
  assert.deepEqual(remove.body, { provider: 'ncm', songId: '1' }, 'delete carries the explicit identity');
  assert.equal(h.inspector.getState().items.length, 0, 'row leaves the list');
  assert.match(h.inspector.getState().status.text, /重新自动打标/, 'user is told how re-tagging happens');
});

test('deleting an already-absent row reports honestly instead of failing', async () => {
  const h = harness({ removeDeleted: 0 });
  await h.inspector.refresh();
  h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]').dispatch('click');
  h.dom.host.querySelector('[data-song-tag-delete]').dispatch('click');
  h.dom.host.querySelector('[data-song-tag-delete]').dispatch('click');
  await Promise.resolve();
  await Promise.resolve();
  const state = h.inspector.getState();
  assert.match(state.status.text, /已经不存在/);
  assert.equal(state.status.kind, 'error');
});

test('a merged recording shows one row with both sources, a 已合并 mark and its members', async () => {
  const merged = {
    ...ROW, merged: true, recordingId: 'rec-1', sources: ['ncm', 'qq'],
    members: [
      { provider: 'ncm', songId: '1', title: '夜曲' },
      { provider: 'qq', songId: 'q1', title: '夜曲' },
    ],
  };
  const h = harness({ rows: [merged] });
  await h.inspector.refresh();
  assert.equal(h.inspector.getState().items.length, 1, 'one row per recording, not one per source');
  const html = h.dom.host.innerHTML;
  assert.match(html, /已合并/);
  assert.match(html, /网易云<\/span>/, 'both source chips render');
  assert.match(html, /q1|Q音/);
  h.dom.host.querySelector('[data-song-tag-toggle="ncm:1"]').dispatch('click');
  const expanded = h.dom.host.innerHTML;
  assert.match(expanded, /改一次标签对全部来源生效/);
  assert.match(expanded, /<li><span>Q音<\/span>/, 'members list names each source recording');
  // 编辑仍按代表身份提交：合并后的写入由服务端解析到整组。
  h.dom.host.querySelector('[data-song-tag-save]').dispatch('click');
  await Promise.resolve();
  const put = h.calls.find(call => call.method === 'PUT');
  assert.deepEqual(put.body.provider, 'ncm');
});
