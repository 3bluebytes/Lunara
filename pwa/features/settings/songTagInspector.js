// songTagInspector.js — 「设置 → 歌曲标签」：已入库歌曲标签的查看与手动修正。
//
// 标签（song_tags）是推歌过滤（语言/人声/情绪/能量）与播客背景"确证纯音乐"底线
// 的数据源，由自动打标写入、属于启发式结论。这里给用户一个和「共享记忆」同级的
// 手动入口：浏览、搜索、逐字段修正、删除标签行。
//
// 契约（openspec/changes/add-song-tag-inspector）：
//   - GET  /api/songtags          搜索 + 分页（只读）
//   - PUT  /api/songtags          白名单补丁；服务端写入 source='user'/confidence=1
//   - DELETE /api/songtags        删除一行；下次 resolve/backfill 自动重新打标
//   - 用户改过的行是权威数据，自动打标（含强制重打）不再覆盖
//
// 失败语义：加载/保存/删除失败都写进行内状态行（role=status），不影响播放，
// 不打断设置面板。

import { escapeHtml } from '../chat/chatMarkup.js';

const PROVIDER_LABELS = { ncm: '网易云', qq: 'Q音', legacy: '本地' };
const SOURCE_LABELS = { user: '手动修改' };
const TEMPO_LABELS = { slow: '慢', mid: '中', fast: '快' };
const TEMPO_OPTIONS = [['', '未知'], ['slow', '慢'], ['mid', '中'], ['fast', '快']];
const VOCAL_OPTIONS = [['', '未知'], ['true', '有人声'], ['false', '纯音乐']];
const PAGE_SIZE = 200;

const keyOf = item => `${item.provider}:${item.song_id}`;

function summaryOf(item) {
  const parts = [];
  if (item.language) parts.push(item.language);
  if (item.has_vocal === true) parts.push('有人声');
  else if (item.has_vocal === false) parts.push('纯音乐');
  if (item.mood) parts.push(item.mood);
  if (item.tempo && TEMPO_LABELS[item.tempo]) parts.push(TEMPO_LABELS[item.tempo]);
  return parts.join(' · ');
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function provenanceOf(item) {
  const bits = [`置信 ${item.confidence == null ? '—' : Math.round(Number(item.confidence) * 100)}%`];
  bits.push(SOURCE_LABELS[item.source] || item.source || '自动打标');
  bits.push(formatDate(item.updated_at));
  return bits.join(' · ');
}

export function createSongTagInspector({
  apiClient,
  documentLike = globalThis.document,
  showToast = () => {},
  hostSelector = '#song-tag-inspector',
} = {}) {
  if (!apiClient?.get || !apiClient?.request) throw new TypeError('song tag inspector requires an api client');
  const $ = selector => documentLike.querySelector(selector);
  const listen = (element, type, handler) => {
    // 测试注入的 documentLike 只有 querySelector；没有事件目标时安静跳过。
    if (typeof element?.addEventListener !== 'function') return;
    element.addEventListener(type, handler);
  };

  let items = [];
  let total = 0;
  // 搜索词分两份：searchDraft 跟随输入框（不触发重渲染，保住焦点），
  // committed 在回车/刷新时才生效。
  let searchDraft = '';
  let committedSearch = '';
  let loading = false;
  let loadError = false;
  let busy = false;
  let loaded = false;
  // 展开的行（provider:songId）与两步删除确认的目标行。
  let expandedKey = null;
  let confirmingKey = null;
  // 行内状态：{ kind: 'info' | 'error', text }
  let status = null;

  function setStatus(kind, text) {
    status = text ? { kind, text } : null;
  }

  /** 统一请求语义：只有服务端确认 ok 才算成功。 */
  async function send(method, path, body) {
    const result = method === 'GET'
      ? await apiClient.get(path)
      : await apiClient.request(path, { method, ...(body === undefined ? {} : { body }) });
    if (result?.ok === false) throw new Error(result.error || '服务端没有确认这次操作');
    return result;
  }

  async function loadList({ append = false } = {}) {
    if (loading) return;
    loading = true;
    if (!append) setStatus('info', '');
    render();
    try {
      const offset = append ? items.length : 0;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (committedSearch) params.set('search', committedSearch);
      const result = await send('GET', `/api/songtags?${params.toString()}`);
      items = append ? items.concat(result.items || []) : (result.items || []);
      total = Number(result.total) || 0;
      loadError = false;
      loaded = true;
    } catch {
      if (!append) {
        loadError = true;
        items = [];
        total = 0;
      }
    } finally {
      loading = false;
      render();
    }
  }

  function fieldLabel(key, text) {
    return `<label class="boot-field song-tag-field"><span>${text}</span>`;
  }

  function textInput(key, field, value, placeholder) {
    return `${fieldLabel(key, field)}<input data-song-tag-field="${key}" type="text" autocomplete="off" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder || '')}"></label>`;
  }

  function numberInput(key, field, value, step) {
    return `${fieldLabel(key, field)}<input data-song-tag-field="${key}" type="number" step="${step}" min="0" max="1" autocomplete="off" value="${value == null ? '' : escapeHtml(String(value))}"></label>`;
  }

  /** select 的 value 属性只服务测试桩读取；真实浏览器按 option[selected] 生效。 */
  function selectInput(key, field, options, current) {
    const currentText = String(current ?? '');
    const optionsHtml = options.map(([value, label]) =>
      `<option value="${value}" ${value === currentText ? 'selected' : ''}>${label}</option>`).join('');
    return `${fieldLabel(key, field)}<select data-song-tag-field="${key}" value="${escapeHtml(currentText)}">${optionsHtml}</select></label>`;
  }

  function listInput(key, field, list, placeholder) {
    return textInput(key, field, (list || []).join(', '), placeholder);
  }

  function editorHtml(item) {
    return `
      <div class="song-tag-editor">
        <div class="song-tag-fields">
          ${textInput('language', '语言', item.language, '如 cantonese / mandarin / english')}
          ${textInput('genre', '流派', item.genre, '如 流行 / 纯音乐')}
          ${textInput('mood', '情绪', item.mood, '如 平静 / 激昂')}
          ${selectInput('tempo', '节奏', TEMPO_OPTIONS, item.tempo ?? '')}
          ${selectInput('has_vocal', '人声', VOCAL_OPTIONS, item.has_vocal == null ? '' : String(item.has_vocal))}
          ${numberInput('energy', '能量 0–1', item.energy, '0.1')}
          ${numberInput('valence', '愉悦 0–1', item.valence, '0.1')}
          ${numberInput('vocal_softness', '声线软 0–1', item.vocal_softness, '0.1')}
          ${textInput('year', '年份', item.year ?? '', '来自音源元数据')}
          ${listInput('themes', '主题（逗号分隔）', item.themes, '如 夜晚, 雨')}
          ${listInput('instruments', '乐器（逗号分隔）', item.instruments, '如 钢琴, 吉他')}
          ${listInput('scenes', '场景（逗号分隔）', item.scenes, '可选，仅作参考')}
        </div>
        <p class="song-tag-provenance">来源：${escapeHtml(provenanceOf(item))}${item.source_text ? ` · ${escapeHtml(item.source_text)}` : ''}</p>
        <div class="song-tag-editor-actions">
          <button type="button" class="quiet-button" data-song-tag-save="${escapeHtml(keyOf(item))}" ${busy ? 'disabled' : ''}>保存修改</button>
          <button type="button" class="quiet-button song-tag-danger" data-song-tag-delete="${escapeHtml(keyOf(item))}" ${busy ? 'disabled' : ''}>${confirmingKey === keyOf(item) ? '确认删除？' : '删除标签行（之后会重新自动打标）'}</button>
        </div>
      </div>`;
  }

  /** 合并过的歌：一个源一个短名，作为留痕显示；未合并时仍显示当前源。 */
  function sourceChips(item) {
    const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.provider];
    return sources.filter(Boolean)
      .map(source => `<span class="song-tag-chip">${escapeHtml(PROVIDER_LABELS[source] || source)}</span>`)
      .join('');
  }

  function mergedHtml(item) {
    if (!item.merged) return '';
    const members = (item.members || [])
      .map(member => `<li><span>${escapeHtml(PROVIDER_LABELS[member.provider] || member.provider)}</span>${escapeHtml(member.title || member.songId)}</li>`)
      .join('');
    return `<div class="song-tag-merged-note">这几行已经按「同一首歌」合并：改一次标签对全部来源生效，删除也只删这一份。
      <ul class="song-tag-merged-members">${members}</ul></div>`;
  }

  function rowHtml(item) {
    const key = keyOf(item);
    const expanded = expandedKey === key;
    return `
      <div class="song-tag-item${expanded ? ' expanded' : ''}${item.merged ? ' merged' : ''}">
        <button type="button" class="song-tag-row" data-song-tag-toggle="${escapeHtml(key)}" aria-expanded="${expanded ? 'true' : 'false'}">
          <span class="song-tag-title">${escapeHtml(item.title || item.song_id)}</span>
          <span class="song-tag-artist">${escapeHtml(item.artist || '—')}</span>
          <span class="song-tag-source">${sourceChips(item)}${item.merged ? '<span class="song-tag-merged-mark">已合并</span>' : ''}</span>
          <span class="song-tag-summary">${escapeHtml(summaryOf(item) || '暂无关键标签')}</span>
          <span class="song-tag-conf">${escapeHtml(provenanceOf(item))}</span>
        </button>
        ${expanded ? `${mergedHtml(item)}${editorHtml(item)}` : ''}
      </div>`;
  }

  function markup() {
    const rows = items.length
      ? items.map(rowHtml).join('')
      : `<p class="song-tag-empty">${loadError
        ? '标签库没能读取成功，可以稍后重试。'
        : (committedSearch ? '没有匹配的歌曲标签。' : '还没有已入库的歌曲标签。播放命中或点"补全候选池标签"之后，这里就会出现内容。')}</p>`;
    const more = items.length < total
      ? `<button type="button" class="quiet-button song-tag-more" data-song-tag-more ${loading || busy ? 'disabled' : ''}>显示更多（已显示 ${items.length}/${total}）</button>`
      : '';
    return `
      <div class="song-tag-inspector">
        <p class="song-tag-note" role="status">标签由自动打标写入，直接影响选歌过滤与播客背景的"确证纯音乐"底线；
          在这里修正写错的标签，改过的行不会再被自动覆盖；删除一行后，下次播放命中或手动补全会重新打标。</p>
        <div class="song-tag-toolbar">
          <input class="song-tag-search" data-song-tag-search type="search" autocomplete="off"
            placeholder="搜标题或艺人…" aria-label="搜索歌曲标签" value="${escapeHtml(searchDraft)}">
          <button type="button" class="quiet-button" data-song-tag-refresh ${loading || busy ? 'disabled' : ''}>${loading ? '读取中…' : '刷新'}</button>
        </div>
        <p class="song-tag-status ${status?.kind === 'error' ? 'song-tag-status-error' : ''}" role="status">${status ? escapeHtml(status.text) : ''}</p>
        <div class="song-tag-list" aria-label="歌曲标签列表">${rows}</div>
        ${more}
      </div>`;
  }

  function render() {
    const host = $(hostSelector);
    if (!host) return;
    host.innerHTML = markup();
    bind(host);
  }

  function readPatch(host, item) {
    const patch = {};
    for (const node of host.querySelectorAll('[data-song-tag-field]')) {
      const key = node.getAttribute('data-song-tag-field');
      const raw = typeof node.value === 'string' ? node.value : '';
      patch[key] = raw;
    }
    // 数字字段留空表示"清除"，与文本字段一致交给服务端归一化。
    for (const key of ['energy', 'valence', 'vocal_softness', 'year']) {
      if (patch[key] != null) patch[key] = patch[key].trim() === '' ? null : patch[key];
    }
    return patch;
  }

  async function saveRow(key) {
    if (busy) return;
    const host = $(hostSelector);
    const item = items.find(row => keyOf(row) === key);
    if (!host || !item) return;
    const patch = readPatch(host, item);
    busy = true;
    setStatus('info', '正在保存…');
    render();
    try {
      const result = await send('PUT', '/api/songtags', { provider: item.provider, songId: item.song_id, patch });
      Object.assign(item, result.tags || {});
      setStatus('info', '已保存。这个标签现在以你的修改为准，不会再被自动打标覆盖。');
      showToast('success', '标签已保存', '', { curated: true });
    } catch (error) {
      setStatus('error', `保存失败：${error.message}`);
    } finally {
      busy = false;
      render();
    }
  }

  async function deleteRow(key) {
    if (busy) return;
    const item = items.find(row => keyOf(row) === key);
    if (!item) return;
    // 两步确认：第一次点变成"确认删除？"，再点才真的删。
    if (confirmingKey !== key) {
      confirmingKey = key;
      render();
      return;
    }
    busy = true;
    confirmingKey = null;
    render();
    try {
      const result = await send('DELETE', '/api/songtags', { provider: item.provider, songId: item.song_id });
      if (Number(result?.deleted) > 0) {
        items = items.filter(row => keyOf(row) !== key);
        total = Math.max(0, total - 1);
        if (expandedKey === key) expandedKey = null;
        setStatus('info', '已删除。下次播放命中这首歌或手动补全时，会重新自动打标。');
      } else {
        setStatus('error', '这行标签已经不存在，可能已被删除。');
      }
    } catch (error) {
      setStatus('error', `删除失败：${error.message}`);
    } finally {
      busy = false;
      render();
    }
  }

  function toggleRow(key) {
    confirmingKey = null;
    expandedKey = expandedKey === key ? null : key;
    render();
  }

  function bind(host) {
    const search = host.querySelector('[data-song-tag-search]');
    listen(search, 'input', event => { searchDraft = event?.target?.value ?? ''; });
    listen(search, 'keydown', event => {
      if (event?.key === 'Enter') {
        event.preventDefault();
        committedSearch = searchDraft.trim();
        void loadList();
      }
    });
    listen(host.querySelector('[data-song-tag-refresh]'), 'click', () => {
      committedSearch = searchDraft.trim();
      void loadList();
    });
    listen(host.querySelector('[data-song-tag-more]'), 'click', () => { void loadList({ append: true }); });
    for (const node of host.querySelectorAll('[data-song-tag-toggle]')) {
      listen(node, 'click', () => toggleRow(node.getAttribute('data-song-tag-toggle')));
    }
    for (const node of host.querySelectorAll('[data-song-tag-save]')) {
      listen(node, 'click', () => { void saveRow(node.getAttribute('data-song-tag-save')); });
    }
    for (const node of host.querySelectorAll('[data-song-tag-delete]')) {
      listen(node, 'click', () => { void deleteRow(node.getAttribute('data-song-tag-delete')); });
    }
  }

  return {
    /** 设置弹层打开时调用：首次加载后复用，除非 force。 */
    async refresh({ force = false } = {}) {
      if (loaded && !force) { render(); return; }
      await loadList();
    },
    render,
    sectionSelector: hostSelector,
    getState: () => ({ items, total, searchDraft, committedSearch, expandedKey, confirmingKey, status, loading, busy, loaded, loadError }),
  };
}

export default createSongTagInspector;
