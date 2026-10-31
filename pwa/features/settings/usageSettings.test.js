// usageSettings.test.js — 「设置 → 使用统计」：统计卡 / 热力图 / 范围切换 / 空错态。
// Run: node --test pwa/features/settings/usageSettings.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUsageSettings, formatAxisDay, formatTokens, heatLevel, heatmapLayout, heatmapWeeks, stripLabels, tooltipCopy,
} from './usageSettings.js';

/** Minimal DOM stand-in: markup injection, id lookup, event dispatch. */
function fakeDom() {
  const makeNode = () => {
    const node = {
      tagName: 'DIV', attributes: {}, _listeners: [],
      set innerHTML(value) { this._html = value; this._parsed = parse(value); },
      get innerHTML() { return this._html || ''; },
      querySelector(selector) { return (this._parsed || []).find(item => item.matches(selector)) || null; },
      querySelectorAll(selector) { return (this._parsed || []).filter(item => item.matches(selector)); },
      addEventListener(type, handler) { this._listeners.push({ type, handler }); },
      dispatch(type, payload = {}) {
        for (const entry of this._listeners.filter(item => item.type === type)) entry.handler({ preventDefault() {}, ...payload });
      },
    };
    return node;
  };

  function parse(html) {
    const nodes = [];
    const pattern = /<(input|button|select|option|label|span|li|div|p|ul|ol|section|strong)\b([^>]*)>/giu;
    let match;
    while ((match = pattern.exec(html))) {
      const [, tag, rawAttrs] = match;
      const attributes = {};
      const attrPattern = /([a-zA-Z-]+)(?:="([^"]*)")?/gu;
      let attr;
      while ((attr = attrPattern.exec(rawAttrs))) attributes[attr[1]] = attr[2] ?? '';
      nodes.push({
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
        _listeners: [],
        style: {},
        hidden: Object.hasOwn(attributes, 'hidden'),
        offsetWidth: 180,
        offsetHeight: 48,
        getBoundingClientRect() { return { left: 40, top: 120, right: 52, bottom: 132, width: 12, height: 12 }; },
        addEventListener(type, handler) { this._listeners.push({ type, handler }); },
        dispatch(type, payload = {}) {
          for (const entry of this._listeners.filter(item => item.type === type)) entry.handler({ preventDefault() {}, ...payload });
        },
        getAttribute(name) { return attributes[name] ?? null; },
      });
    }
    return nodes;
  }

  const host = makeNode();
  const documentLike = { querySelector: selector => (selector === '#usage-settings' ? host : null) };
  return { host, documentLike };
}

const settle = async () => {
  for (let index = 0; index < 3; index += 1) await new Promise(resolve => setImmediate(resolve));
};

/** 造一份连续 N 天的报告（第 i 天输出递增，方便断言峰值）。 */
function makeReport({ days = 30, calls = 42 } = {}) {
  const daily = [];
  const start = new Date('2026-09-21T00:00:00');
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const outputTokens = index === days - 1 ? 5000 : index * 100;
    daily.push({
      day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      calls: outputTokens > 0 ? 1 : 0,
      outputTokens,
      promptTokens: 0,
      reasoningTokens: index % 3 === 0 ? 10 : 0,
      estimatedCalls: 0,
      escalated: 0,
      failures: 0,
    });
  }
  const total = daily.reduce((sum, item) => sum + item.outputTokens, 0);
  return {
    ok: true,
    days,
    retentionDays: 30,
    coverage: { from: daily[0].day, to: daily.at(-1).day },
    daily,
    totals: {
      calls,
      outputTokens: total,
      promptTokens: 0,
      reasoningTokens: 0,
      estimatedCalls: 0,
      failures: 1,
      todayOutputTokens: 5000,
      activeDays: daily.filter(item => item.calls > 0).length,
      avgPerActiveDay: Math.round(total / Math.max(1, daily.filter(item => item.calls > 0).length)),
      peak: { day: daily.at(-1).day, outputTokens: 5000 },
      streakDays: 3,
    },
    byModel: [
      { provider: 'prov-1', model: 'deepseek/deepseek-flash', calls: 20, outputTokens: 4000, promptTokens: 0, reasoningTokens: 120 },
      { provider: 'prov-2', model: 'zhipu/glm-5.3-flash', calls: 10, outputTokens: 1000, promptTokens: 0, reasoningTokens: 0 },
    ],
    byModelTruncated: false,
    failingOutcomes: [{ outcome: 'provider_error', count: 1 }],
  };
}

function setup({ report = makeReport(), failOnce = false, providers = null } = {}) {
  const dom = fakeDom();
  const calls = [];
  let failing = failOnce;
  const apiClient = {
    get: async path => {
      calls.push(path);
      if (path.startsWith('/api/llm/usage/report')) {
        if (failing) { failing = false; throw new Error('offline'); }
        return report;
      }
      if (path === '/api/llm/providers') {
        if (providers === 'throw') throw new Error('registry offline');
        return providers ?? { ok: true, providers: [{ id: 'prov-1', name: 'magpie' }, { id: 'prov-2', name: '智谱' }] };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  const view = createUsageSettings({ apiClient, documentLike: dom.documentLike });
  return { dom, view, calls };
}

test('formatTokens / heatLevel / heatmapWeeks 是纯函数', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5K');
  assert.equal(formatTokens(23_400), '2.3万');
  assert.equal(formatTokens(120_000_000), '1.2亿');
  assert.equal(heatLevel(0, 100), 0);
  assert.equal(heatLevel(10, 100), 1);
  assert.equal(heatLevel(60, 100), 3);
  assert.equal(heatLevel(100, 100), 4);
  assert.equal(heatLevel(50, 0), 0);

  assert.equal(formatAxisDay('2026-10-20', { currentYear: 2026 }), '10月20日');
  assert.equal(formatAxisDay('2025-10-21', { currentYear: 2026 }), '2025年10月21日');

  const { weeks, monthLabels } = heatmapWeeks(makeReport({ days: 30 }).daily);
  assert.equal(weeks.every(week => week.length === 7), true, '每列 7 格');
  assert.equal(weeks.flat().filter(Boolean).length, 30);
  assert.equal(monthLabels.length, weeks.length);
});

test('热力图跨度等于所选周期：7 天单行条带，30 天起周列日历', async () => {
  assert.equal(heatmapLayout(7), 'strip');
  assert.equal(heatmapLayout(30), 'calendar', '30 天保留星期维度');
  assert.equal(heatmapLayout(90), 'calendar');
  assert.equal(heatmapLayout(365), 'calendar');

  // 2026-09-21 是周一：条带每格「周几 日期」。
  assert.deepEqual(stripLabels(makeReport({ days: 3 }).daily), ['周一 9/21', '周二 9/22', '周三 9/23']);
  // 30 天从 9/21 开始：首列补上「9月」，之后 10 月在含 10/1 的那一列。
  assert.deepEqual(heatmapWeeks(makeReport({ days: 30 }).daily).monthLabels.filter(Boolean), ['9月', '10月']);

  const week = setup({ report: makeReport({ days: 7 }) });
  week.view.setActive(true);
  await settle();
  const weekHtml = week.dom.host.innerHTML;
  assert.match(weekHtml, /class="usage-strip" style="--usage-days: 7"/u);
  assert.doesNotMatch(weekHtml, /usage-heatmap-week\b/u, '7 天不排周列，避免右侧大片空白');
  assert.equal((weekHtml.match(/usage-cell is-empty/gu) || []).length, 0, '条带不补占位格');
  assert.equal(week.dom.host.querySelectorAll('span[data-usage-day]').length, 7);

  const year = setup({ report: { ...makeReport({ days: 365 }), retentionDays: 365 } });
  year.view.setActive(true);
  await settle();
  const yearHtml = year.dom.host.innerHTML;
  assert.match(yearHtml, /class="usage-heatmap" style="--usage-weeks: \d+"/u);
  // 星期列在滚动容器之外（玻璃面板上 sticky 遮不住滑过的格子）。
  assert.match(yearHtml, /<div class="usage-calendar">\s*<div class="usage-heatmap-weekdays"[^>]*>[\s\S]*?<\/div>\s*<div class="usage-heatmap-scroll"/u);
  assert.match(yearHtml, /class="usage-bars is-dense" style="--usage-bar-gap: 1px"/u);
});

test('激活后读取报告并渲染统计卡、热力图、按模型与失败分类', async () => {
  const { dom, view, calls } = setup();
  view.setActive(true);
  await settle();

  const html = dom.host.innerHTML;
  assert.match(calls[0] ?? '', /^\/api\/llm\/usage\/report\?days=365$/u, '默认请求一年（后端按保留期夹紧）');
  assert.ok(calls.includes('/api/llm/providers'), '用注册表补 provider 显示名');
  // 统计卡
  assert.match(html, /累计输出（30 天）/u, '统计口径跟随报告实际窗口');
  assert.match(html, /连续使用/u);
  assert.match(html, /峰值日/u);
  // 热力图：每天一个可访问格子 + 图例
  const cells = dom.host.querySelectorAll('[role="img"]').filter(node => (node.getAttribute('aria-label') || '').includes('tokens'));
  assert.equal(cells.length >= 30, true, `每天一个格子，实际 ${cells.length}`);
  assert.match(html, /usage-cell lv4/u, '有数据的天有热度档');
  // 按模型：注册表显示名 + 未知 provider 回落 id
  assert.match(html, /magpie · deepseek\/deepseek-flash/u);
  assert.match(html, /智谱 · zhipu\/glm-5\.3-flash/u);
  assert.match(html, /思考 120/u);
  // 失败分类
  assert.match(html, /provider_error × 1/u);
  assert.match(html, /账本保留 30 天/u);
  // 只读：没有写请求的 API 面（apiClient 只有 get）
  assert.equal(typeof view.refresh, 'function');
});

test('时间范围切换重新拉取并更新热力图', async () => {
  const { dom, view, calls } = setup();
  view.setActive(true);
  await settle();
  assert.match(dom.host.innerHTML, /近 30 天/u);

  dom.host.querySelector('#usage-range-7').dispatch('click');
  await settle();
  assert.equal(calls.filter(path => path.startsWith('/api/llm/usage/report')).at(-1), '/api/llm/usage/report?days=7');
  assert.equal(view.getRange(), 7);
  // 按钮状态：7 天按钮带 is-active / aria-pressed=true，30 天按钮不是激活态。
  const seven = dom.host.querySelector('#usage-range-7');
  const thirty = dom.host.querySelector('#usage-range-30');
  assert.match(seven.getAttribute('class'), /\bis-active\b/u);
  assert.equal(seven.getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(thirty.getAttribute('class'), /\bis-active\b/u);
  assert.equal(thirty.getAttribute('aria-pressed'), 'false');
});

test('时间范围档位跟随账本保留期：30 天只有 7/30，调大保留期才出现 90/365', async () => {
  const short = setup();
  short.view.setActive(true);
  await settle();
  assert.ok(short.dom.host.querySelector('#usage-range-7'));
  assert.ok(short.dom.host.querySelector('#usage-range-30'));
  assert.equal(short.dom.host.querySelector('#usage-range-90'), null, '保留期 30 天不提供 90 天档');
  assert.equal(short.view.getRange(), 30, '默认落在报告实际给出的 30 天窗口');

  const long = setup({ report: { ...makeReport({ days: 365 }), retentionDays: 365 } });
  long.view.setActive(true);
  await settle();
  assert.ok(long.dom.host.querySelector('#usage-range-90'));
  assert.ok(long.dom.host.querySelector('#usage-range-365'));
  assert.equal(long.view.getRange(), 365, '保留期够长时默认就是全年（53 周）');
});

test('空账本与失败都有可见文案，失败可重试', async () => {
  const empty = setup({ report: { ok: true, days: 30, retentionDays: 30, coverage: {}, daily: [], totals: { calls: 0 }, byModel: [], failingOutcomes: [] } });
  empty.view.setActive(true);
  await settle();
  assert.match(empty.dom.host.innerHTML, /账本还没有记录/u);
  assert.doesNotMatch(empty.dom.host.innerHTML, /NaN|Infinity/u);

  const broken = setup({ failOnce: true });
  broken.view.setActive(true);
  await settle();
  assert.match(broken.dom.host.innerHTML, /用量读取失败：offline/u);
  broken.dom.host.querySelector('#usage-retry').dispatch('click');
  await settle();
  assert.match(broken.dom.host.innerHTML, /累计输出（30 天）/u, '重试成功后渲染报告');
});

test('隐藏时不请求，重复激活不重复拉取', async () => {
  const { view, calls } = setup();
  view.setActive(false);
  await settle();
  assert.deepEqual(calls, [], '不可见时零请求');
  view.setActive(true);
  await settle();
  const first = calls.filter(path => path.startsWith('/api/llm/usage/report')).length;
  view.setActive(true);
  await settle();
  assert.equal(calls.filter(path => path.startsWith('/api/llm/usage/report')).length, first, '已激活再激活不重复请求');
  view.setActive(false);
  view.setActive(true);
  await settle();
  assert.ok(calls.filter(path => path.startsWith('/api/llm/usage/report')).length > first, '重新进入会刷新');
});

test('注册表不可用时用 provider id 显示，不猜名字', async () => {
  const { dom, view } = setup({ providers: 'throw' });
  view.setActive(true);
  await settle();
  assert.match(dom.host.innerHTML, /prov-1 · deepseek\/deepseek-flash/u);
});

test('悬浮提示：指针移到某天格子/柱子上显示日期与 token，移开隐藏', async () => {
  assert.deepEqual(tooltipCopy({ day: '2026-10-22', outputTokens: 0, calls: 0 }), {
    title: '2026年10月22日',
    detail: '0 tokens · 无调用',
  });
  assert.deepEqual(tooltipCopy({ day: '2026-10-19', outputTokens: 419000, calls: 759 }), {
    title: '2026年10月19日',
    detail: '419000 tokens · 759 次调用',
  });
  assert.deepEqual(tooltipCopy({}), { title: '', detail: '0 tokens · 无调用' });

  const { dom, view } = setup();
  view.setActive(true);
  await settle();
  const tip = dom.host.querySelector('#usage-tooltip');
  assert.ok(tip, '浮层节点存在');
  assert.equal(tip.hidden, true, '默认隐藏');

  const cells = dom.host.querySelectorAll('[data-usage-tokens]');
  assert.equal(cells.length >= 30, true, '格子与柱子都带提示数据');
  const cell = cells[0];
  cell.dispatch('mouseenter');
  assert.equal(tip.hidden, false);
  assert.match(tip.innerHTML, /2026年9月21日/u);
  assert.match(tip.innerHTML, /tokens · /u);
  cell.dispatch('mouseleave');
  assert.equal(tip.hidden, true, '移开后隐藏');

  // 触摸端没有 hover：点击也能看到同一份信息。
  cell.dispatch('click');
  assert.equal(tip.hidden, false);
});
