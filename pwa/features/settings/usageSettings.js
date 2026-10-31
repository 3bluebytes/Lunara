// usageSettings.js — 「设置 → 使用统计」：模型用量的独立页面。
//
// 数据来自只读接口 `GET /api/llm/usage/report?days=7|30`（账本聚合，只含数值与分类）：
// 逐日序列（缺失日已补零）、总量/峰值/连续天数、按模型拆分与失败分类。
// 页面本身不调用模型、不写账本、不改变播放；provider 显示名从注册表补，缺映射时显示 id。
//
// 视觉约定（add-usage-dashboard）：统计卡与热力图沿用设置页字阶（12px 标题 / 12.5px 说明 /
// Geist Mono 数字），四档热度只由主题变量 color-mix 生成，所以 cike / moonlight /
// modernist / organic 切换时自动一致，不写死主题外的色值。短窗口热力图是单行条带、长窗口是
// 周列日历，两者都均分卡片宽度；窄视口放不下最小格宽时横向滚动。

import { escapeHtml as esc } from '../chat/chatMarkup.js';

// 账本保留期决定可选范围（默认 365 天，可用 LLM_USAGE_RETENTION_DAYS 调整）。
// 页面只展示接口实际给出的区间，不伪造更长的历史；超出保留期的档位不提供。
// 默认请求一年：热力图按「周为列」正好铺满 53 周；保留期更短时后端会夹紧，页面随实际窗口回退。
// 无论哪个档位，热力图与趋势都铺满卡片宽度：图的跨度就是所选周期，不留右侧空白。
const RANGE_OPTIONS = Object.freeze([7, 30, 90, 365]);
const DEFAULT_RANGE_DAYS = 365;
const HEATMAP_WEEKDAYS = Object.freeze(['一', '三', '五', '日']);
const WEEKDAY_NAMES = Object.freeze(['日', '一', '二', '三', '四', '五', '六']);
const STRIP_MAX_DAYS = 14;
const HEATMAP_SCROLL_ATTRS = 'tabindex="0" role="group" aria-label="每日 token 热力图，可横向滚动"';

/** token 数量的人类可读写法（中文数量级；0 也如实显示）。 */
export function formatTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`;
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(Math.round(count));
}

/** '2026-10-20' → '10月20日'；坏值原样返回，不编造日期。 */
export function formatDayLabel(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day || ''));
  if (!match) return String(day || '');
  return `${Number(match[2])}月${Number(match[3])}日`;
}

/** 悬浮提示的两行文案：完整日期 + token/调用（参考 Magpie 的用量浮层，不写正文）。 */
export function tooltipCopy({ day, outputTokens, calls } = {}) {
  const tokens = Number(outputTokens) || 0;
  const count = Number(calls) || 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day || ''));
  const title = match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : String(day || '');
  return {
    title,
    detail: `${String(tokens)} tokens · ${count > 0 ? `${String(count)} 次调用` : '无调用'}`,
  };
}

/** 趋势轴端点：跨年窗口带上年份，避免「10月21日」看不出是哪一年。 */
export function formatAxisDay(day, { currentYear = new Date().getFullYear() } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day || ''));
  if (!match) return String(day || '');
  const year = Number(match[1]);
  const label = `${Number(match[2])}月${Number(match[3])}日`;
  return year === currentYear ? label : `${String(year)}年${label}`;
}

/**
 * 把逐日序列排成「周为列、星期为行」的日历格（周一为一行首）。
 * 首尾用 null 占位，保证每列 7 格；不驱动任何状态。
 */
export function heatmapWeeks(daily = []) {
  const days = Array.isArray(daily) ? daily.filter(item => item && typeof item.day === 'string') : [];
  if (!days.length) return { weeks: [], monthLabels: [] };
  const first = new Date(`${days[0].day}T00:00:00`);
  const offset = Number.isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7;
  const cells = Array.from({ length: offset }, () => null);
  for (const item of days) cells.push(item);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  // 月份标签：标在含该月 1 号的那一列；首列从月中开始时也补上它的月份（否则 30 天看不出前几列是几月）。
  // 列很窄（一年 53 列）且下一列紧接着就有标签时不补，避免两个标签叠在一起。
  const monthOf = cell => `${new Date(`${cell.day}T00:00:00`).getMonth() + 1}月`;
  const monthLabels = weeks.map((week) => {
    const first = week.find(cell => cell && new Date(`${cell.day}T00:00:00`).getDate() === 1);
    return first ? monthOf(first) : '';
  });
  const crowded = weeks.length > 20 && Boolean(monthLabels[1]);
  if (monthLabels.length && !monthLabels[0] && !crowded) {
    const anchor = weeks[0].find(Boolean);
    if (anchor && !Number.isNaN(new Date(`${anchor.day}T00:00:00`).getTime())) monthLabels[0] = monthOf(anchor);
  }
  return { weeks, monthLabels };
}

/** 四档热度：0 为空格；非零按窗口内最大值等比分级。 */
export function heatLevel(outputTokens, max) {
  const value = Number(outputTokens) || 0;
  const ceiling = Number(max) || 0;
  if (value <= 0 || ceiling <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((value / ceiling) * 4)));
}

/**
 * 热力图版式：≤ 14 天用一天一格的单行条带（每格自带「周几 日期」，均分整行宽度）；
 * 更长的窗口排成周列×星期行的日历，列宽同样均分整行。7 天排成日历只有两列，太稀疏。
 */
export function heatmapLayout(dayCount) {
  return Number(dayCount) > STRIP_MAX_DAYS ? 'calendar' : 'strip';
}

/** 条带下方的刻度：每格标「周几 日期」，补回条带没有的星期维度。 */
export function stripLabels(daily = []) {
  const days = Array.isArray(daily) ? daily : [];
  return days.map((item) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(item?.day || ''));
    if (!match) return '';
    const date = new Date(`${item.day}T00:00:00`);
    return `周${WEEKDAY_NAMES[date.getDay()]} ${Number(match[2])}/${Number(match[3])}`;
  });
}

export function createUsageSettings({
  apiClient,
  documentLike = globalThis.document,
  hostSelector = '#usage-settings',
} = {}) {
  if (!apiClient?.get) throw new TypeError('usage settings requires an api client');
  const host = () => documentLike.querySelector(hostSelector);
  /** 事件绑定：测试替身可能没有 addEventListener，安静跳过。 */
  const on = (element, type, handler) => {
    if (typeof element?.addEventListener !== 'function') return;
    element.addEventListener(type, handler);
  };

  let active = false;
  let range = DEFAULT_RANGE_DAYS;
  let report = null;
  let providerNames = new Map();
  let loading = false;
  let error = null;
  let loaded = false;
  // 视口变化时重新贴到最右（窗口从宽拉窄后，滚动位置会停在左端、看不到最近的日期）。
  let layoutCleanup = null;

  const byModelShare = row => {
    const total = Number(report?.totals?.outputTokens) || 0;
    if (!total) return 0;
    return Math.max(1, Math.round((Number(row.outputTokens) || 0) / total * 100));
  };

  function statCards() {
    const totals = report?.totals || {};
    const days = report?.days || range;
    const cards = [
      { label: `累计输出（${String(days)} 天）`, value: formatTokens(totals.outputTokens), hint: `${String(totals.calls || 0)} 次调用` },
      { label: '今日输出', value: formatTokens(totals.todayOutputTokens), hint: totals.activeDays ? `平均 ${formatTokens(totals.avgPerActiveDay)}/活跃日` : '今天还没有调用' },
      // 峰值日的数值与日期分两行，避免窄卡里被省略号截断成「41.9万 · 10…」。
      { label: '峰值日', value: totals.peak ? formatTokens(totals.peak.outputTokens) : '—', hint: totals.peak ? `${formatDayLabel(totals.peak.day)} · 单日最多` : '还没有记录' },
      { label: '连续使用', value: `${String(totals.streakDays || 0)} 天`, hint: totals.activeDays ? `活跃 ${String(totals.activeDays)} 天` : '还没有记录' },
    ];
    return `<div class="usage-stats">${cards.map(card => `
      <div class="usage-stat">
        <span class="usage-stat-label">${esc(card.label)}</span>
        <strong class="usage-stat-value">${esc(card.value)}</strong>
        <span class="usage-stat-hint">${esc(card.hint)}</span>
      </div>`).join('')}</div>`;
  }

  function heatmapHtml() {
    const daily = Array.isArray(report?.daily) ? report.daily : [];
    if (!daily.length) return '';
    const max = daily.reduce((peak, item) => Math.max(peak, Number(item.outputTokens) || 0), 0);
    const cellHtml = (cell) => {
      if (!cell) return '<span class="usage-cell is-empty" aria-hidden="true"></span>';
      const level = heatLevel(cell.outputTokens, max);
      const label = `${String(cell.day)}：${String(Number(cell.outputTokens) || 0)} tokens，${String(Number(cell.calls) || 0)} 次调用`;
      // 悬浮提示用自定义浮层（title 太慢且不随主题）；data-* 提供浮层内容。
      return `<span class="usage-cell lv${String(level)}" role="img" aria-label="${esc(label)}"
        data-usage-day="${esc(cell.day)}" data-usage-tokens="${String(Number(cell.outputTokens) || 0)}"
        data-usage-calls="${String(Number(cell.calls) || 0)}"></span>`;
    };
    const body = heatmapLayout(daily.length) === 'strip'
      ? `<div class="usage-heatmap-scroll" ${HEATMAP_SCROLL_ATTRS}>${stripHtml(daily, cellHtml)}</div>`
      : calendarHtml(daily, cellHtml);
    return `${body}
      <div class="usage-legend" aria-hidden="true">
        <span>少</span>
        <span class="usage-cell lv0"></span><span class="usage-cell lv1"></span>
        <span class="usage-cell lv2"></span><span class="usage-cell lv3"></span><span class="usage-cell lv4"></span>
        <span>多</span>
        <span class="usage-legend-total">峰值 ${esc(formatTokens(max))} / 天</span>
      </div>`;
  }

  /** 短窗口：一天一格的单行条带，格子均分整行宽度，图的跨度就是所选周期。 */
  function stripHtml(daily, cellHtml) {
    const labels = stripLabels(daily).map(label => `<span>${esc(label)}</span>`).join('');
    return `
      <div class="usage-strip" style="--usage-days: ${String(daily.length)}">
        <div class="usage-strip-cells" role="img" aria-label="每日 token 热力图：${String(daily.length)} 天，颜色越深表示输出越多">${daily.map(cellHtml).join('')}</div>
        <div class="usage-strip-axis" aria-hidden="true">${labels}</div>
      </div>`;
  }

  /**
   * 长窗口：周列×星期行的日历，列宽均分整行宽度（方格随宽度缩放）。
   * 星期列放在滚动容器外：格子在它右侧的滚动区里滑动并被边缘裁掉。若放在里面做 sticky，
   * 就得靠不透明背景遮住滑过的格子，而玻璃面板是半透明的，遮不住。
   */
  function calendarHtml(daily, cellHtml) {
    const { weeks, monthLabels } = heatmapWeeks(daily);
    const columns = weeks.map(week => `
      <div class="usage-heatmap-week">${week.map(cellHtml).join('')}</div>`).join('');
    // 月份标签按列序百分比定位：文字比格子宽，做成流式会把滚动宽度撑大。
    const months = monthLabels.map((label, index) => (label
      ? `<span class="usage-heatmap-month" style="left: ${String((index / weeks.length) * 100)}%">${esc(label)}</span>`
      : '')).join('');
    return `
      <div class="usage-calendar">
        <div class="usage-heatmap-weekdays" aria-hidden="true">
          ${HEATMAP_WEEKDAYS.map(day => `<span>${day}</span>`).join('')}
        </div>
        <div class="usage-heatmap-scroll" ${HEATMAP_SCROLL_ATTRS}>
          <div class="usage-heatmap" style="--usage-weeks: ${String(weeks.length)}">
            <div class="usage-heatmap-months" aria-hidden="true">${months}</div>
            <div class="usage-heatmap-weeks" role="img" aria-label="每日 token 热力图：${String(daily.length)} 天，颜色越深表示输出越多">${columns}</div>
          </div>
        </div>
      </div>`;
  }

  function barsHtml() {
    const daily = Array.isArray(report?.daily) ? report.daily : [];
    if (!daily.length) return '';
    const max = daily.reduce((peak, item) => Math.max(peak, Number(item.outputTokens) || 0), 0) || 1;
    const items = daily.map((item) => {
      const value = Number(item.outputTokens) || 0;
      const height = Math.max(value > 0 ? 4 : 0, Math.round((value / max) * 100));
      const label = `${formatDayLabel(item.day)}：${formatTokens(value)} tokens`;
      return `<li class="usage-bar-item" aria-label="${esc(label)}"
        data-usage-day="${esc(item.day)}" data-usage-tokens="${String(value)}" data-usage-calls="${String(Number(item.calls) || 0)}">
        <span class="usage-bar" style="--usage-bar: ${String(height)}%"></span>
      </li>`;
    }).join('');
    // 柱子均分整行宽度；天数越多间距越窄，365 天也能在宽视口一屏放下。
    const gap = daily.length <= 14 ? 10 : daily.length <= 31 ? 4 : daily.length <= 92 ? 2 : 1;
    return `
      <div class="usage-bars-scroll">
        <ol class="usage-bars${daily.length > 92 ? ' is-dense' : ''}" style="--usage-bar-gap: ${String(gap)}px" aria-label="每日输出 token 趋势">${items}</ol>
      </div>
      <div class="usage-bars-axis" aria-hidden="true">
        <span>${esc(formatAxisDay(daily[0].day))}</span>
        <span>${esc(formatAxisDay(daily.at(-1).day))}</span>
      </div>`;
  }

  function modelRowsHtml() {
    const rows = Array.isArray(report?.byModel) ? report.byModel : [];
    if (!rows.length) return '<p class="usage-empty-line">这段时间还没有按模型的记录。</p>';
    const body = rows.map((row) => {
      const name = row.provider ? providerNames.get(row.provider) || row.provider : '未记录 provider';
      const model = row.model || '未知模型';
      const label = `${name} · ${model}`;
      const share = byModelShare(row);
      return `<li class="usage-model">
        <div class="usage-model-head">
          <span class="usage-model-name" title="${esc(label)}">${esc(label)}</span>
          <span class="usage-model-tokens">${esc(formatTokens(row.outputTokens))}</span>
        </div>
        <div class="usage-model-meta">
          <span>${String(Number(row.calls) || 0)} 次调用</span>
          ${Number(row.reasoningTokens) > 0 ? `<span>思考 ${esc(formatTokens(row.reasoningTokens))}</span>` : ''}
        </div>
        <span class="usage-model-bar" aria-hidden="true"><span style="--usage-share: ${String(share)}%"></span></span>
      </li>`;
    }).join('');
    const truncated = report?.byModelTruncated === true
      ? '<p class="usage-note">仅显示输出最多的 12 个模型。</p>' : '';
    return `<ul class="usage-models">${body}</ul>${truncated}`;
  }

  function failuresHtml() {
    const failures = Array.isArray(report?.failingOutcomes) ? report.failingOutcomes : [];
    const estimated = Number(report?.totals?.estimatedCalls) || 0;
    const parts = failures.map(item => `<span class="usage-chip">${esc(item.outcome)} × ${String(Number(item.count) || 0)}</span>`);
    if (estimated > 0) parts.push(`<span class="usage-chip is-muted">估计用量 ${String(estimated)} 次</span>`);
    if (!parts.length) parts.push('<span class="usage-chip is-muted">没有失败记录</span>');
    return `<div class="usage-chips">${parts.join('')}</div>
      <p class="usage-note">失败按分类计数。估计用量是供应方没有返回 token 的请求次数，其 token 按预留额度保守计入上方总量（不虚报为真实值）；账本保留 ${String(report?.retentionDays || 0)} 天。</p>`;
  }

  /** 可选时间范围：不超过账本保留期；同时保证当前实际窗口一定有一个对应按钮。 */
  function availableRanges() {
    const retention = Number(report?.retentionDays) || DEFAULT_RANGE_DAYS;
    const options = RANGE_OPTIONS.filter(days => days <= retention);
    const actual = Number(report?.days);
    if (Number.isInteger(actual) && actual > 0) options.push(actual);
    const unique = [...new Set(options)].sort((left, right) => left - right);
    return unique.length ? unique : [Math.max(1, Math.min(7, retention))];
  }

  function rangeHtml() {
    const days_ = availableRanges();
    const buttons = days_.map(days => `<button type="button" class="usage-range-button${days === range ? ' is-active' : ''}"
      id="usage-range-${String(days)}" data-usage-range="${String(days)}"
      aria-pressed="${days === range ? 'true' : 'false'}">近 ${String(days)} 天</button>`).join('');
    return `<div class="usage-range" role="group" aria-label="时间范围">${buttons}</div>`;
  }

  function render() {
    const root = host();
    if (!root) return;
    if (loading && !loaded) {
      root.innerHTML = '<p class="usage-status" role="status">正在读取用量账本…</p>';
      return;
    }
    if (error) {
      root.innerHTML = `<div class="usage-status is-error" role="status">
        <span>用量读取失败：${esc(error)}</span>
        <button type="button" class="quiet-button" id="usage-retry">重试</button>
      </div>`;
      on(root.querySelector('#usage-retry'), 'click', () => { void refresh(); });
      return;
    }
    if (!report || Number(report?.totals?.calls) === 0) {
      root.innerHTML = `<div class="usage-status" role="status">
        <span>账本还没有记录。对话、选歌或打标产生模型调用后，这里会出现每日热力图。</span>
        <button type="button" class="quiet-button" id="usage-retry">重新读取</button>
      </div>`;
      on(root.querySelector('#usage-retry'), 'click', () => { void refresh(); });
      return;
    }

    root.innerHTML = `
      ${statCards()}
      <section class="settings-card usage-card" aria-label="每日 token 热力图">
        <div class="usage-card-head">
          <div class="usage-card-title">
            <span class="boot-h">Token 活动</span>
            <span class="usage-card-meta">${esc(String(report.coverage?.from || ''))} → ${esc(String(report.coverage?.to || ''))}</span>
          </div>
          ${rangeHtml()}
        </div>
        ${heatmapHtml()}
      </section>
      <section class="settings-card usage-card" aria-label="每日 token 趋势">
        <div class="usage-card-head">
          <div class="usage-card-title"><span class="boot-h">每日趋势</span></div>
          <span class="usage-card-meta">${esc(formatTokens(report.totals?.outputTokens))} tokens</span>
        </div>
        ${barsHtml()}
      </section>
      <section class="settings-card usage-card" aria-label="按模型拆分">
        <div class="usage-card-head">
          <div class="usage-card-title"><span class="boot-h">按模型</span></div>
          <span class="usage-card-meta">输出 token 占比</span>
        </div>
        ${modelRowsHtml()}
      </section>
      <section class="settings-card usage-card" aria-label="失败分类">
        <div class="usage-card-head">
          <div class="usage-card-title"><span class="boot-h">失败与估计</span></div>
        </div>
        ${failuresHtml()}
      </section>
      <div class="usage-tooltip" id="usage-tooltip" role="tooltip" aria-hidden="true" hidden></div>`;

    for (const days of availableRanges()) {
      on(root.querySelector(`#usage-range-${String(days)}`), 'click', () => {
        if (days === range) return;
        range = days;
        void refresh();
      });
    }
    // 热力图与趋势都是「旧在左、新在右」：超出宽度时默认停在最右（最近几天），
    // 用户不必先横向滚到末尾才能看到今天。
    const scrollToNewest = () => {
      for (const selector of ['.usage-heatmap-scroll', '.usage-bars-scroll']) {
        const box = root.querySelector(selector);
        if (box && typeof box.scrollLeft === 'number') box.scrollLeft = box.scrollWidth;
      }
      alignWeekdays(root);
    };
    scrollToNewest();
    // 重新渲染会重建 DOM：只保留一个 resize 监听，避免每次刷新都累积。
    layoutCleanup?.();
    const view = documentLike.defaultView;
    if (view && typeof view.addEventListener === 'function') {
      view.addEventListener('resize', scrollToNewest);
      layoutCleanup = () => view.removeEventListener?.('resize', scrollToNewest);
    }
    wireTooltips(root);
  }

  /**
   * 日历的星期列在滚动容器外，格子随宽度缩放：按格子区实测的位置与高度对齐，
   * 「一 / 三 / 五 / 日」才落在对应行上（月份行高、滚动条占位都不必写死）。
   */
  function alignWeekdays(root) {
    const calendar = root.querySelector('.usage-calendar');
    const weeks = calendar?.querySelector?.('.usage-heatmap-weeks');
    const labels = calendar?.querySelector?.('.usage-heatmap-weekdays');
    if (typeof weeks?.getBoundingClientRect !== 'function' || !labels?.style) return;
    const box = calendar.getBoundingClientRect();
    const rect = weeks.getBoundingClientRect();
    labels.style.marginTop = `${String(Math.round(rect.top - box.top))}px`;
    labels.style.height = `${String(Math.round(rect.height))}px`;
  }

  /**
   * 悬浮提示：指针移到某天格/柱子上时显示「日期 + token + 调用次数」。
   * 用自定义浮层而不是原生 title（原生提示延迟长、不能跟随主题、无法显示两行）。
   * 定位用视口坐标（fixed）：热力图容器可能横向滚动，absolute 会被 overflow 裁掉。
   */
  function wireTooltips(root) {
    const tip = root.querySelector('#usage-tooltip');
    if (!tip) return;
    let currentAnchor = null;
    const hide = () => { tip.hidden = true; currentAnchor = null; };
    const show = (anchor) => {
      currentAnchor = anchor;
      const copy = tooltipCopy({
        day: anchor.getAttribute?.('data-usage-day'),
        outputTokens: anchor.getAttribute?.('data-usage-tokens'),
        calls: anchor.getAttribute?.('data-usage-calls'),
      });
      if (!copy.title) return;
      tip.innerHTML = `<strong class="usage-tooltip-title">${esc(copy.title)}</strong>`
        + `<span class="usage-tooltip-detail">${esc(copy.detail)}</span>`;
      tip.hidden = false;
      const rect = typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
      const view = documentLike.defaultView || globalThis;
      const width = Number(tip.offsetWidth) || 180;
      const height = Number(tip.offsetHeight) || 48;
      const viewportWidth = Number(view.innerWidth) || 1024;
      const viewportHeight = Number(view.innerHeight) || 768;
      if (!rect) {
        tip.style.left = '8px';
        tip.style.top = '8px';
        return;
      }
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2),
        Math.max(8, viewportWidth - width - 8));
      const above = rect.top - height - 10;
      const top = above >= 8 ? above : Math.min(rect.bottom + 10, viewportHeight - height - 8);
      tip.style.left = `${String(Math.round(left))}px`;
      tip.style.top = `${String(Math.round(top))}px`;
    };
    for (const anchor of root.querySelectorAll('[data-usage-tokens]')) {
      on(anchor, 'mouseenter', () => show(anchor));
      on(anchor, 'mouseleave', hide);
      // 触摸端没有 hover：点一下也能看到同一份信息（不改变任何状态）。
      on(anchor, 'click', () => show(anchor));
    }
    // 容器滚动时（例如键盘/触控板横向滚动）不直接隐藏，而是把浮层重新对齐到原锚点：
    // 浏览器把元素滚入视野也会触发 scroll，直接隐藏会让刚出现的提示立刻消失。
    const reposition = () => {
      if (!tip.hidden && currentAnchor) show(currentAnchor);
    };
    for (const selector of ['.usage-heatmap-scroll', '.usage-bars-scroll']) {
      on(root.querySelector(selector), 'scroll', reposition);
    }
  }

  /** 读注册表补 provider 显示名；失败不影响用量展示（回落到 id）。 */
  async function loadProviderNames() {
    try {
      const result = await apiClient.get('/api/llm/providers');
      const providers = Array.isArray(result?.providers) ? result.providers : [];
      providerNames = new Map(providers.map(provider => [provider.id, provider.name || provider.id]));
    } catch {
      providerNames = new Map();
    }
  }

  async function refresh() {
    loading = true;
    error = null;
    render();
    try {
      const [result] = await Promise.all([
        apiClient.get(`/api/llm/usage/report?days=${String(range)}`),
        loadProviderNames(),
      ]);
      if (result?.ok === false) throw new Error(result.error || '用量账本不可用');
      report = result || null;
      // 保留期变小时（例如配置被调低）把已选范围夹回可用档位，避免请求显示为空区间。
      if (report && !availableRanges().includes(range)) range = availableRanges().at(-1);
      loaded = true;
    } catch (caught) {
      error = String(caught?.message || caught || '未知错误').slice(0, 120);
    } finally {
      loading = false;
      render();
    }
  }

  /** 只在分类可见时加载（设置页按需激活；隐藏后不再请求）。 */
  function setActive(value) {
    const next = Boolean(value);
    if (next === active) return;
    active = next;
    if (active) void refresh();
  }

  return Object.freeze({ refresh, setActive, getRange: () => range });
}
