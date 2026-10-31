// routineSettings.js — 「设置 → 常规 → 作息」：每周作息的查看与保存。
//
// 作息只服务于生活上下文快照（工作日/休息日、是否在上班时间、时区），
// 聊天、选歌与串词都从那里读；这里不开始播放、不生成节目。
// 数据与 API 不变（/api/life/routine）。场景默认已不再有界面入口，
// 表与 /api/life/scene-defaults 只为数据兼容保留（fold-routine-into-general-settings）。
//
// 编辑全部落在本地草稿里：开关/时间/时区变化只局部刷新摘要、作息条和状态，
// 不整段重建，避免打字时丢焦点；只有显式「保存作息」且服务端确认后才算保存。

// 显示顺序从周一开始；值沿用服务端的 0=周日 … 6=周六。
const WEEKDAYS = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
const WEEKEND = new Set([6, 0]);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const FALLBACK_ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore',
  'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC'];
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function detectTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

function listTimeZones() {
  try { return Intl.supportedValuesOf?.('timeZone') || FALLBACK_ZONES; } catch { return FALLBACK_ZONES; }
}

const toMinutes = value => (TIME_PATTERN.test(value || '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null);

/** 周一…周日里连续的工作日合成「周一至周五」，零散的用顿号连接。 */
export function describeWorkDays(days) {
  const picked = WEEKDAYS.filter(([day]) => days.has(day));
  if (!picked.length) return '';
  if (picked.length === 7) return '每天';
  const runs = [];
  for (const [day, label] of WEEKDAYS) {
    if (!days.has(day)) { runs.push(null); continue; }
    const last = runs[runs.length - 1];
    if (last) last.push(label); else runs.push([label]);
  }
  return runs.filter(Boolean).map(run => (run.length >= 3
    ? `周${run[0]}至周${run[run.length - 1]}`
    : run.map(label => `周${label}`).join('、'))).join('、');
}

export function describeRoutine({ workDays, workStartTime, workEndTime }) {
  const days = describeWorkDays(workDays);
  if (!days) return '没有工作日，每天都按休息日理解';
  const start = toMinutes(workStartTime);
  const end = toMinutes(workEndTime);
  if (start == null || end == null) return `${days}上班，上下班时间还没填`;
  return `${days}上班 · ${workStartTime}–${workEndTime}${end <= start ? '（跨夜）' : ''}`;
}

export function createRoutineSettings({
  apiClient,
  documentLike = globalThis.document,
  showToast = () => {},
  hostSelector = '#routine-settings',
  deviceTimeZone = detectTimeZone(),
  timeZones = listTimeZones(),
  now = () => Date.now(),
} = {}) {
  if (!apiClient?.get || !apiClient?.request) throw new TypeError('routine settings requires an api client');
  const $ = selector => documentLike.querySelector(selector);
  const listen = (element, type, handler) => element?.addEventListener?.(type, handler);
  let routine = null;
  let draft = null;
  let loadError = false;
  let loaded = false;
  let busy = false;

  function draftFrom(saved) {
    return {
      // 未配置时预选本机时区，只是草稿，不自动保存。
      timeZone: saved?.configured ? saved.timeZone : (deviceTimeZone || 'UTC'),
      workDays: new Set((saved?.workDays || []).map(Number)),
      workStartTime: saved?.workStartTime || '',
      workEndTime: saved?.workEndTime || '',
    };
  }

  function isDirty() {
    if (!routine?.configured) return true;
    const saved = draftFrom(routine);
    return saved.timeZone !== draft.timeZone
      || saved.workStartTime !== draft.workStartTime || saved.workEndTime !== draft.workEndTime
      || saved.workDays.size !== draft.workDays.size || [...saved.workDays].some(day => !draft.workDays.has(day));
  }

  function stateLabel() {
    if (!routine?.configured) return ['unset', '还没设置'];
    return isDirty() ? ['dirty', '有未保存的修改'] : ['clean', '已保存'];
  }

  /** 在所选时区里「现在」的墙钟分钟数；时区非法时返回 null。 */
  function wallMinutes(zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(now()));
      const pick = type => Number(parts.find(part => part.type === type)?.value);
      return pick('hour') * 60 + pick('minute');
    } catch {
      return null;
    }
  }

  const pct = minutes => `${(minutes / 1440 * 100).toFixed(3)}%`;
  const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  /** 24 小时作息条：上班时段高亮（跨夜拆成两段），竖线标出所选时区的现在。 */
  function barMarkup() {
    const start = toMinutes(draft.workStartTime);
    const end = toMinutes(draft.workEndTime);
    const spans = [];
    if (draft.workDays.size && start != null && end != null && start !== end) {
      if (end > start) spans.push([start, end]);
      else spans.push([start, 1440], [0, end]);
    }
    const nowMinutes = wallMinutes(draft.timeZone);
    return `
      <div class="routine-bar-track">
        ${spans.map(([from, to]) => `<span class="routine-bar-span" style="left:${pct(from)};width:${pct(to - from)}"></span>`).join('')}
        ${nowMinutes == null ? '' : `<span class="routine-bar-now" style="left:${pct(nowMinutes)}" title="当地现在 ${clock(nowMinutes)}"></span>`}
      </div>
      <div class="routine-bar-ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`;
  }

  function zoneOptions() {
    const zones = new Set([deviceTimeZone, draft.timeZone, ...timeZones].filter(Boolean));
    return [...zones].map(zone => `<option value="${esc(zone)}" ${zone === draft.timeZone ? 'selected' : ''}>${
      esc(zone.replace(/_/gu, ' '))}${zone === deviceTimeZone ? '（本机）' : ''}</option>`).join('');
  }

  function localClock() {
    const minutes = wallMinutes(draft.timeZone);
    return minutes == null ? '' : `当地现在 ${clock(minutes)}`;
  }

  function markup() {
    const [state, label] = stateLabel();
    return `
      <div class="routine" data-state="${state}">
        <div class="routine-head">
          <div class="boot-h">作息</div>
          <span class="routine-state" data-routine-state role="status">${esc(label)}</span>
        </div>
        ${loadError ? `<p class="routine-error" role="alert">作息没能读取成功，原来的配置仍然保存着。
          <button type="button" class="quiet-button" data-routine-retry>重试</button></p>` : ''}
        <p class="routine-summary" data-routine-summary>${esc(describeRoutine(draft))}</p>
        <div class="routine-bar" data-routine-bar aria-hidden="true">${barMarkup()}</div>
        <div class="routine-grid">
          <span class="routine-label" id="routine-days-label">工作日</span>
          <div class="routine-days" role="group" aria-labelledby="routine-days-label">
            ${WEEKDAYS.map(([day, text]) => `<button type="button" class="routine-day${WEEKEND.has(day) ? ' routine-day-weekend' : ''}"
              data-routine-day="${day}" aria-pressed="${draft.workDays.has(day)}" aria-label="周${text}">${text}</button>`).join('')}
          </div>
          <span class="routine-label" id="routine-hours-label">上下班</span>
          <div class="routine-hours" role="group" aria-labelledby="routine-hours-label">
            <input id="routine-start" name="routine-start" type="time" aria-label="上班时间" value="${esc(draft.workStartTime)}">
            <span class="routine-dash" aria-hidden="true">—</span>
            <input id="routine-end" name="routine-end" type="time" aria-label="下班时间" value="${esc(draft.workEndTime)}">
          </div>
          <label class="routine-label" for="routine-zone">时区</label>
          <div class="routine-zone">
            <select id="routine-zone" name="routine-zone" class="boot-select">${zoneOptions()}</select>
            <span class="routine-clock" data-routine-clock>${esc(localClock())}</span>
          </div>
        </div>
        <div class="routine-foot">
          <p class="routine-note">只用来判断今天上不上班、现在是不是上班时间，让伙伴说话合时宜；不会自动开始播放。</p>
          <button type="button" class="quiet-button" data-routine-save ${busy || loadError || state === 'clean' ? 'disabled' : ''}>保存作息</button>
        </div>
      </div>`;
  }

  function render() {
    const host = $(hostSelector);
    if (!host) return;
    if (!draft) draft = draftFrom(routine);
    host.innerHTML = markup();
    bind(host);
  }

  /** 草稿变化后的局部刷新：不重建输入框，焦点和光标留在原处。 */
  function refreshDerived() {
    const host = $(hostSelector);
    if (!host) return;
    const [state, label] = stateLabel();
    const root = host.querySelector('.routine');
    root?.setAttribute?.('data-state', state);
    const stateNode = host.querySelector('[data-routine-state]');
    if (stateNode) stateNode.textContent = label;
    const summary = host.querySelector('[data-routine-summary]');
    if (summary) summary.textContent = describeRoutine(draft);
    const bar = host.querySelector('[data-routine-bar]');
    if (bar) bar.innerHTML = barMarkup();
    const clockNode = host.querySelector('[data-routine-clock]');
    if (clockNode) clockNode.textContent = localClock();
    const save = host.querySelector('[data-routine-save]');
    if (save) save.disabled = busy || loadError || state === 'clean';
  }

  function bind(host) {
    for (const button of host.querySelectorAll('[data-routine-day]')) {
      listen(button, 'click', () => {
        const day = Number(button.getAttribute('data-routine-day'));
        if (draft.workDays.has(day)) draft.workDays.delete(day); else draft.workDays.add(day);
        button.setAttribute?.('aria-pressed', String(draft.workDays.has(day)));
        refreshDerived();
      });
    }
    listen(host.querySelector('#routine-start'), 'input', event => { draft.workStartTime = event.target?.value || ''; refreshDerived(); });
    listen(host.querySelector('#routine-end'), 'input', event => { draft.workEndTime = event.target?.value || ''; refreshDerived(); });
    listen(host.querySelector('#routine-zone'), 'change', event => { draft.timeZone = event.target?.value || draft.timeZone; refreshDerived(); });
    listen(host.querySelector('[data-routine-save]'), 'click', save);
    listen(host.querySelector('[data-routine-retry]'), 'click', () => { void load({ force: true }); });
  }

  async function save() {
    // 没读到已保存的作息时不允许保存：否则会用空白草稿盖掉看不见的旧配置。
    if (busy || loadError || !draft) return;
    const hasStart = Boolean(draft.workStartTime);
    if (hasStart !== Boolean(draft.workEndTime)) {
      showToast('error', '上下班时间要成对填写', '只填一个时，没法判断现在是不是上班时间。', { curated: true });
      return;
    }
    busy = true;
    refreshDerived();
    try {
      const result = await apiClient.request('/api/life/routine', { method: 'PUT', body: {
        timeZone: draft.timeZone,
        workDays: WEEKDAYS.map(([day]) => day).filter(day => draft.workDays.has(day)),
        workStartTime: draft.workStartTime || null,
        workEndTime: draft.workEndTime || null,
        expectedRevision: routine?.revision ?? null,
      } });
      if (result?.ok === false) throw new Error(result.error || 'not-confirmed');
      busy = false;
      showToast('success', '作息已保存', '', { curated: true });
      await load({ force: true });
    } catch (error) {
      busy = false;
      refreshDerived();
      showToast('error', '作息没保存成功', String(error?.message || '请稍后重试'), { curated: true });
    }
  }

  async function load({ force = false } = {}) {
    if (loaded && !force) return;
    try {
      const result = await apiClient.get('/api/life/routine');
      if (result?.ok === false) throw new Error('load');
      routine = result?.routine ?? null;
      draft = draftFrom(routine);
      loadError = false;
    } catch {
      loadError = true;
    }
    loaded = true;
    render();
  }

  return {
    /** 设置页打开时调用：首次加载后复用，除非 force。 */
    async refresh({ force = false } = {}) {
      await load({ force });
    },
    render,
    sectionSelector: hostSelector,
    getState: () => ({ routine, loadError, loaded, dirty: draft ? isDirty() : false }),
  };
}

export default createRoutineSettings;
