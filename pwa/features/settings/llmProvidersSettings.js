// llmProvidersSettings.js — 「设置 → 模型」：provider 注册表布局（unified-model-providers）。
//
// 布局：左侧 provider 列表（名称 + 模型数/停用数）+ 添加入口；右侧编辑区（名称 / Base URL /
// API Key / API 四选 / 启用 / 获取模型列表 / 保存 / 删除）。上方独立一张卡选"使用中模型"
// （按 provider 分组，全局生效）。歌曲打标跟随使用中模型，不再单独配置端点。
//
// 模型列表（add-model-row-actions）：每行左侧是模型名 + 能力徽标，右侧四个动作
// 「连接测试 / 编辑 / 删除 / 启用」。编辑在原行展开（模型 id + 手动能力声明 + 探测）；
// 删除把模型移出编辑列表；启用开关只把模型写入 disabledModels（停用但保留在列表），
// 两者都在「保存 Provider」后落盘。停用模型不参与使用中下拉、会话选择器与默认解析。
//
// 用量不在这张卡里：设置另有「使用统计」页（add-usage-dashboard），这里只留一行跳转入口。
//
// key 只写不读：已配置的 provider 显示"留空保持不变"，保存时空值由服务端保留旧值。
//
// 能力档案（agent-budget-and-response-contract）：模型行保留一行能力状态（如"思考开启·
// 可关闭（2026-10-15 探测）"），默认零操作——保存模型后后台自动探测、首次使用惰性补探测；
// 「编辑」里可手动重探或声明覆盖（可选，不设也正确）。

import { createLlmFailoverSettings } from './llmFailoverSettings.js';

const API_OPTIONS = [
  ['openai-completions', 'openai-completions'],
  ['openai-responses', 'openai-responses'],
  ['anthropic-messages', 'anthropic-messages'],
  ['google-generative-ai', 'google-generative-ai'],
];
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** 行内动作图标：内联 SVG，随文字色变化，不新增图标依赖。 */
const ICONS = {
  test: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v4.2L3.4 11a1.6 1.6 0 0 0 1.4 2.4h6.4A1.6 1.6 0 0 0 12.6 11L10 6.2V2"/><path d="M5 2h6"/><path d="M4.6 9.6h6.8"/></svg>',
  edit: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 2.6l2.8 2.8-7.9 7.9-3.3.5.5-3.3 7.9-7.9z"/><path d="M9.4 3.8l2.8 2.8"/></svg>',
  remove: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 4.2h10.8"/><path d="M6.2 4.2V2.6h3.6v1.6"/><path d="M4 4.2l.6 9.2h6.8l.6-9.2"/><path d="M6.8 6.6v4.4M9.2 6.6v4.4"/></svg>',
};

/** 发现结果里可保存的元数据（事实）：只收已知字段，其它键不落盘。 */
function discoveryMeta(entry = {}) {
  const meta = {};
  if (Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length) meta.reasoningEfforts = [...new Set(entry.reasoningEfforts)];
  if (Number.isInteger(entry.contextWindow) && entry.contextWindow > 0) meta.contextWindow = entry.contextWindow;
  if (Number.isInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0) meta.maxOutputTokens = entry.maxOutputTokens;
  if (Array.isArray(entry.modalities) && entry.modalities.length) meta.modalities = [...new Set(entry.modalities)];
  return meta;
}

/** 思考档位的显示名；未知档位原样显示（Provider 可能声明自定义档位）。 */
const EFFORT_LABELS = Object.freeze({
  none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高',
  xhigh: '很高', max: '最高', ultra: '超高',
});
const effortLabel = level => EFFORT_LABELS[level] || String(level || '');

/** 开关轨道的公共标记（行启用与 Provider 启用共用一套样式与语义）。 */
const switchHtml = (id, checked, label) => `
  <button type="button" class="llm-switch" id="${id}" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-label="${esc(label)}" title="${esc(label)}">
    <span class="llm-switch-track"><span class="llm-switch-thumb"></span></span>
  </button>`;

/** 把 token 数写成徽标文案（1M / 256K / 8192），只用于已有探测结论的模型。 */
function formatTokenBadge(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '';
  const spell = number => String(Math.round(number * 10) / 10).replace(/\.0$/u, '');
  if (count >= 1_000_000) return `${spell(count / 1_000_000)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return String(Math.round(count));
}

export function createLlmProvidersSettings({
  apiClient,
  documentLike = globalThis.document,
  hostSelector = '#llm-providers-settings',
  activeHostSelector = '#llm-active-model-settings',
  // 保存成功后的轻提示；页面内的状态行仍然写着具体结果，toast 只回答「存住了没有」。
  showToast = () => {},
} = {}) {
  if (!apiClient?.get || !apiClient?.post || !apiClient?.put || !apiClient?.delete) throw new TypeError('llm providers settings requires an api client');
  const host = () => documentLike.querySelector(hostSelector);
  const activeHost = () => documentLike.querySelector(activeHostSelector);
  const failoverSettings = createLlmFailoverSettings({ apiClient, documentLike, showToast });
  // 连通性测试结果：[ {model, ok, latencyMs, reply?, error?} ]
  let testResults = null;
  let providers = [];
  let activeModel = null;
  let selectedId = null;        // 当前编辑的 provider；'__new__' = 新建草稿
  let draftModels = new Set();  // 编辑中的已配置模型（保存才落库）
  let draftDisabled = new Set(); // 编辑中的停用模型（models 子集，保存才落库）
  let draftModelInfo = {};      // 编辑中的模型元数据（发现事实；保存才落库）
  let draftModelDefaults = {};  // 编辑中的模型默认思考档（用户偏好；保存才落库）
  let draftProviderId = null;   // 草稿对应的 provider，切换/保存后重新同步
  let discovered = [];          // 最近一次发现的模型（{ id, ...metadata }，含未接入项）
  let expandedModel = null;     // 当前展开编辑面板的模型 id
  let editorDraft = null;       // 编辑区输入草稿：重渲染（如加入模型）不得清掉正在编辑的字段
  let loaded = false;
  let message = '';
  let pendingFocus = null;      // 重渲染后要归还/移入焦点的选择器

  async function refresh({ keepDrafts = false } = {}) {
    try {
      const result = await apiClient.get('/api/llm/providers');
      providers = Array.isArray(result?.providers) ? result.providers : [];
      activeModel = result?.activeModel || null;
      if (!selectedId || (selectedId !== '__new__' && !providers.some(provider => provider.id === selectedId))) {
        selectedId = providers.some(provider => provider.id === activeModel?.providerId)
          ? activeModel.providerId : (providers[0]?.id ?? null);
        draftProviderId = null;
      }
      if (!keepDrafts || draftProviderId !== selectedId) syncDrafts();
      loaded = true;
      render();
      await failoverSettings.refresh({ providers, activeModel });
    } catch (error) {
      loaded = true;
      message = `模型配置读取失败：${error.message}`;
      render();
    }
  }

  const selectedProvider = () => providers.find(provider => provider.id === selectedId) || null;

  /** 把草稿同步到当前选中的 provider（切换 provider、首次读取、保存成功后）。 */
  function syncDrafts() {
    const provider = selectedProvider();
    draftModels = new Set(provider?.models || []);
    draftDisabled = new Set((provider?.disabledModels || []).filter(model => draftModels.has(model)));
    draftModelInfo = Object.fromEntries(Object.entries(provider?.modelInfo || {})
      .filter(([model]) => draftModels.has(model)).map(([model, info]) => [model, { ...info }]));
    draftModelDefaults = Object.fromEntries(Object.entries(provider?.modelDefaults || {})
      .filter(([model]) => draftModels.has(model)).map(([model, value]) => [model, { ...value }]));
    draftProviderId = selectedId;
    discovered = [];
    expandedModel = null;
    testResults = null;
  }

  /** 模型是否仍留在编辑列表里（含停用）。 */
  const isConfigured = model => draftModels.has(model);
  const isDisabled = model => draftDisabled.has(model);

  function testResultFor(model) {
    return (testResults || []).find(item => item.model === model) || null;
  }

  function providerListHtml() {
    const items = providers.map(provider => {
      const disabledCount = Array.isArray(provider.disabledModels) ? provider.disabledModels.length : 0;
      const count = `${provider.modelCount} 模型${disabledCount ? ` · ${disabledCount} 停用` : ''}${provider.enabled ? '' : ' · Provider 已停用'}`;
      return `
      <li>
        <button type="button" class="llm-provider-item${provider.id === selectedId ? ' active' : ''}"
          data-llm-select-provider="${esc(provider.id)}" aria-pressed="${provider.id === selectedId}">
          <span>${esc(provider.name || '未命名 Provider')}</span>
          <span class="llm-provider-count">${count}</span>
        </button>
      </li>`;
    }).join('');
    return `${items}<li><button type="button" class="quiet-button" id="llm-provider-add">＋ 添加 Provider</button></li>`;
  }

  /** 展示用：剥掉思维链（<think>…</think>），只留最终回复。 */
  function displayReply(reply) {
    return String(reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  /** 能力状态一行摘要（design §1 界面定位：默认零操作，只显示一行状态）。 */
  function capabilitySummary(capability) {
    if (!capability) return '未识别（保守额度运行；保存后自动探测，也可在「编辑」里重探）';
    const bits = [];
    bits.push(capability.thinking?.default === 'on' ? '思考开启'
      : capability.thinking?.default === 'off' ? '思考关闭' : '思考未知');
    if (capability.thinking?.canDisable === true) bits.push('可关闭');
    else if (capability.thinking?.canDisable === false) bits.push('不可关闭');
    if (capability.thinking?.budgetKnob) bits.push(`可设思考预算(${capability.thinking.budgetKnob})`);
    if (capability.structuredOutput && capability.structuredOutput !== 'none') bits.push(`结构化 ${capability.structuredOutput}`);
    const sourceText = capability.source === 'user' ? '手动声明'
      : capability.source === 'observed' ? '运行时识别' : '自动探测';
    const when = capability.probedAt ? `（${String(capability.probedAt).slice(0, 10)} ${sourceText}）` : '';
    return `${bits.join('·')}${when}`;
  }

  function capabilityOptions(selected, options) {
    return options.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }

  /** 行为徽标：上下文窗口与默认思考档；缺失信息不猜。 */
  function badgeHtml(model, capability) {
    const badges = [];
    const windowBadge = formatTokenBadge(capability?.caps?.contextWindow ?? draftModelInfo[model]?.contextWindow);
    if (windowBadge) badges.push(`<span class="llm-badge" title="上下文窗口">${esc(windowBadge)}</span>`);
    const effort = draftModelDefaults[model]?.reasoningEffort;
    if (effort) badges.push(`<span class="llm-badge" title="对话默认思考强度">思考·${esc(effortLabel(effort))}</span>`);
    return badges.join('');
  }

  /** 该模型真实可选的思考档：优先 Provider 声明，其次探测证实的旋钮；不硬套。 */
  function effortLevelsFor(model) {
    const declared = draftModelInfo[model]?.reasoningEfforts;
    if (Array.isArray(declared) && declared.length) return declared;
    const knob = selectedProvider()?.capabilities?.[model]?.thinking?.budgetKnob;
    if (knob === 'reasoning_effort') return ['low'];
    if (knob === 'thinking_budget') return ['low', 'medium', 'high'];
    return [];
  }

  /** 模型页默认档选择：模型默认 + 该模型支持档位（当前值失效时保留为选中项以便如实展示）。 */
  function effortSelectHtml(model) {
    const current = draftModelDefaults[model]?.reasoningEffort || '';
    const options = [['', '模型默认'], ...effortLevelsFor(model).map(level => [level, effortLabel(level)])];
    if (current && !options.some(([value]) => value === current)) options.push([current, effortLabel(current)]);
    return capabilityOptions(current, options);
  }

  /** 行内编辑面板：模型 id 与手动能力声明（可选覆盖，不设也正确）。 */
  function modelEditorHtml(model) {
    const provider = selectedProvider();
    const capability = provider?.capabilities?.[model] || {};
    const thinking = capability.thinking || {};
    const canDisable = thinking.canDisable === true ? 'true' : thinking.canDisable === false ? 'false' : '';
    return `
      <div class="llm-model-editor" data-llm-model-editor="${esc(model)}" role="group"
        aria-label="编辑模型 ${esc(model)}" tabindex="-1">
        <label class="llm-model-field">
          <span>模型 id</span>
          <input type="text" autocomplete="off" data-llm-model-rename="${esc(model)}"
            value="${esc(model)}" aria-label="模型 id ${esc(model)}">
        </label>
        <label class="llm-model-field">
          <span>对话思考强度（默认）</span>
          <select class="llm-model-select" data-llm-effort-default="${esc(model)}"
            aria-label="对话思考强度 ${esc(model)}">${effortSelectHtml(model)}</select>
        </label>
        <div class="llm-cap-grid" role="group" aria-label="手动能力声明 ${esc(model)}">
          <label>默认<select data-llm-cap-default="${esc(model)}">${capabilityOptions(thinking.default || 'unknown', [['unknown', '未知'], ['on', '开启'], ['off', '关闭']])}</select></label>
          <label>可关闭<select data-llm-cap-disable="${esc(model)}">${capabilityOptions(canDisable, [['', '未知'], ['true', '是'], ['false', '否']])}</select></label>
          <label>预算旋钮<select data-llm-cap-knob="${esc(model)}">${capabilityOptions(thinking.budgetKnob || '', [['', '无'], ['reasoning_effort', 'reasoning_effort'], ['thinking_budget', 'thinking_budget']])}</select></label>
          <label>结构化<select data-llm-cap-structured="${esc(model)}">${capabilityOptions(capability.structuredOutput || 'none', [['none', '无'], ['json_object', 'json_object'], ['json_schema', 'json_schema'], ['tool_force', 'tool_force']])}</select></label>
        </div>
        <div class="llm-model-editor-actions">
          <button type="button" class="quiet-button" data-llm-probe-model="${esc(model)}">探测能力</button>
          <button type="button" class="quiet-button" data-llm-cap-save="${esc(model)}">保存能力声明</button>
        </div>
        <p class="llm-model-editor-hint">模型 id 与启用状态随「保存 Provider」生效；能力声明单独写入，手动声明优先于自动探测。</p>
      </div>`;
  }

  function modelRowHtml(model) {
    const provider = selectedProvider();
    const savedProvider = selectedId === '__new__' ? null : provider;
    const capability = savedProvider?.capabilities?.[model] || null;
    const configured = isConfigured(model);
    const disabled = configured && isDisabled(model);
    const expanded = expandedModel === model;
    const result = testResultFor(model);
    const badge = disabled
      ? '<span class="llm-badge llm-badge-muted">已停用</span>'
      : '';
    const resultHtml = result
      ? (result.pending
        ? `<p class="llm-model-test" data-llm-test-result="${esc(model)}" role="status">测试中…</p>`
        : result.error
          ? `<p class="llm-model-test is-fail" data-llm-test-result="${esc(model)}" role="status">✗ ${esc(result.error)}</p>`
          : `<p class="llm-model-test is-ok" data-llm-test-result="${esc(model)}" role="status">✓ ${Number(result.latencyMs) || 0}ms${result.reply ? ` · ${esc(result.reply)}` : ''}</p>`)
      : '';
    return `
      <li class="llm-model${disabled ? ' is-disabled' : ''}${configured ? '' : ' is-candidate'}" data-llm-model-row="${esc(model)}">
        <div class="llm-model-body">
          <div class="llm-model-head">
            <span class="llm-model-name" title="${esc(model)}">${esc(model)}</span>
            <span class="llm-model-badges">${badgeHtml(model, capability)}${badge}</span>
          </div>
          <p class="llm-model-meta" data-llm-cap-line="${esc(model)}">${esc(capabilitySummary(capability))}</p>
          ${resultHtml}
        </div>
        <div class="llm-model-actions">
          <button type="button" class="llm-icon-button" data-llm-test-model="${esc(model)}"
            aria-label="连接测试 ${esc(model)}" title="连接测试">${ICONS.test}</button>
          <button type="button" class="llm-icon-button" data-llm-edit-model="${esc(model)}"
            aria-label="编辑 ${esc(model)}" title="编辑" aria-expanded="${expanded ? 'true' : 'false'}">${ICONS.edit}</button>
          <button type="button" class="llm-icon-button llm-icon-danger" data-llm-remove-model="${esc(model)}"
            aria-label="删除 ${esc(model)}" title="删除">${ICONS.remove}</button>
          <button type="button" class="llm-switch" data-llm-model-toggle="${esc(model)}" role="switch"
            aria-checked="${configured && !disabled ? 'true' : 'false'}" aria-label="启用 ${esc(model)}"
            title="${configured && !disabled ? '已启用，点击停用' : '已停用，点击启用'}">
            <span class="llm-switch-track"><span class="llm-switch-thumb"></span></span>
          </button>
        </div>
        ${expanded ? modelEditorHtml(model) : ''}
      </li>`;
  }

  function editorHtml() {
    if (!selectedId) {
      return `<p class="llm-prov-empty" role="status">还没有接入任何模型。点「＋ 添加 Provider」，填入 Base URL 与 API Key 即可开始。${message ? esc(message) : ''}</p>`;
    }
    const isNew = selectedId === '__new__';
    const provider = selectedProvider();
    const draft = editorDraft || {};
    const name = draft.name ?? (isNew ? '' : (provider?.name || ''));
    const baseUrl = draft.baseUrl ?? (isNew ? '' : (provider?.baseUrl || ''));
    const api = draft.api ?? (isNew ? 'openai-completions' : (provider?.api || 'openai-completions'));
    const enabled = draft.enabled ?? (isNew ? true : provider?.enabled !== false);
    const modelIds = [...new Set([...draftModels, ...discovered.map(entry => entry.id)])];
    const disabledCount = [...draftDisabled].filter(model => draftModels.has(model)).length;
    const modelRows = modelIds.map(model => modelRowHtml(model)).join('');
    return `
      <div class="boot-endpoint llm-prov-endpoint">
        <label class="boot-field"><span>Provider 名称</span>
          <input id="llm-prov-name" type="text" autocomplete="off" value="${esc(name)}" placeholder="如 magpie"></label>
        <label class="boot-field"><span>Base URL</span>
          <input id="llm-prov-url" type="url" autocomplete="url" value="${esc(baseUrl)}" placeholder="http://127.0.0.1:3425/v1"></label>
        <label class="boot-field"><span>API Key</span>
          <input id="llm-prov-key" type="password" autocomplete="new-password"
            placeholder="${!isNew && provider?.hasKey ? '已保存（留空保持不变）' : '本地网关可留空'}"></label>
        <label class="boot-field"><span>API</span>
          <select id="llm-prov-api" class="boot-select" value="${esc(api)}">
            ${API_OPTIONS.map(([value, label]) => `<option value="${value}"${value === api ? ' selected' : ''}>${label}</option>`).join('')}
          </select></label>
        <div class="llm-prov-toggle">
          <span>启用 Provider</span>
          ${switchHtml('llm-prov-enabled', enabled, '启用 Provider')}
        </div>
      </div>
      <div class="llm-prov-actions">
        <button type="button" class="quiet-button" id="llm-prov-discover">获取模型列表</button>
        <button type="button" class="boot-go" id="llm-prov-save">保存 Provider</button>
        ${isNew ? '' : '<button type="button" class="quiet-button" id="llm-prov-delete">删除 Provider</button>'}
      </div>
      <p id="llm-prov-status" role="status">${esc(message)}</p>
      <div class="llm-models-card">
        <div class="llm-models-head">
          <div class="llm-models-title">
            <span class="llm-models-title-text">模型列表</span>
            <span class="llm-models-count" id="llm-model-count">${draftModels.size} 启用${disabledCount ? ` · ${disabledCount} 停用` : ''}</span>
          </div>
          <div class="llm-models-head-actions">
            <button type="button" class="quiet-button" id="llm-prov-test">测试全部</button>
          </div>
        </div>
        <ul class="llm-models" id="llm-prov-models">
          ${modelRows || '<li class="llm-prov-empty">还没有模型：点「获取模型列表」，或手动添加模型 id。</li>'}
        </ul>
        <div class="llm-model-add">
          <input id="llm-prov-manual" type="text" autocomplete="off" aria-label="手动添加模型 id"
            placeholder="手动填模型 id，如 deepseek/deepseek-flash">
          <button type="button" class="quiet-button" id="llm-prov-manual-add">添加模型</button>
        </div>
      </div>`;
  }

  function activeModelHtml() {
    const options = [];
    for (const provider of providers.filter(candidate => candidate.enabled)) {
      const disabledModels = Array.isArray(provider.disabledModels) ? provider.disabledModels : [];
      for (const model of provider.models) {
        if (disabledModels.includes(model)) continue;
        const selected = activeModel?.providerId === provider.id && activeModel?.model === model;
        options.push(`<option value="${esc(`${provider.id}::${model}`)}"${selected ? ' selected' : ''}>${esc(provider.name || provider.id)} · ${esc(model)}</option>`);
      }
    }
    const note = activeModel
      ? `当前使用：${esc(providers.find(provider => provider.id === activeModel.providerId)?.name || activeModel.providerId)} · ${esc(activeModel.model)}。切换立即对后续所有调用生效；各聊天可在会话设置里单独覆盖。`
      : '还没有选择使用中的模型。对话、串词与打标都走它。';
    return `
      <label class="boot-field"><span>使用中模型</span>
        <select id="llm-active-model" class="boot-select">${options.length ? options.join('') : '<option value="">（暂无已接入模型）</option>'}</select></label>
      <p id="llm-active-note" class="llm-note" role="status">${note}</p>
      <div class="llm-active-foot">
        <button type="button" class="quiet-button" data-settings-page-link="usage">查看使用统计</button>
      </div>`;
  }

  function render() {
    // 使用中模型卡与 Provider 卡是**同级**两张卡（使用中在上），由两个宿主分别承载。
    const active = activeHost();
    if (active) active.innerHTML = `<div class="llm-providers">${activeModelHtml()}</div>`;
    const root = host();
    if (!root) return;
    root.innerHTML = `
      <div class="llm-providers">
        <div class="llm-providers-body">
          <div class="llm-providers-side">
            <ul class="llm-provider-items" id="llm-provider-list">${providerListHtml()}</ul>
          </div>
          <div class="llm-provider-editor" id="llm-provider-editor">${editorHtml()}</div>
        </div>
        ${loaded ? '' : '<p class="llm-prov-empty" role="status">正在读取模型配置…</p>'}
      </div>`;
    wire();
    if (pendingFocus) {
      const selector = pendingFocus;
      pendingFocus = null;
      host()?.querySelector(selector)?.focus?.();
    }
  }

  function readEditor() {
    const value = selector => host()?.querySelector(selector)?.value?.trim() || '';
    const apiSelect = host()?.querySelector('#llm-prov-api');
    const api = (apiSelect?.value && String(apiSelect.value).trim())
      || (typeof apiSelect?.querySelector === 'function'
        ? apiSelect.querySelector('option[selected]')?.getAttribute?.('value') : null)
      || 'openai-completions';
    const enabledSwitch = host()?.querySelector('#llm-prov-enabled');
    const enabled = enabledSwitch
      ? (enabledSwitch.getAttribute?.('aria-checked') === 'true')
      : Boolean(enabledSwitch?.checked);
    return {
      name: value('#llm-prov-name'),
      baseUrl: value('#llm-prov-url'),
      apiKey: host()?.querySelector('#llm-prov-key')?.value?.trim() || '',
      api,
      enabled,
      models: [...draftModels],
      disabledModels: [...draftDisabled].filter(model => draftModels.has(model)),
      modelInfo: Object.fromEntries(Object.entries(draftModelInfo).filter(([model]) => draftModels.has(model))),
      modelDefaults: Object.fromEntries(Object.entries(draftModelDefaults).filter(([model]) => draftModels.has(model))),
    };
  }

  async function testModels(models, editor) {
    testResults ||= [];
    message = `正在测试 ${models.length} 个模型…`;
    testResults = [
      ...testResults.filter(item => !models.some(model => model === item.model)),
      ...models.map(model => ({ model, ok: false, pending: true })),
    ];
    render();
    for (const model of models) {
      try {
        const result = await apiClient.post('/api/llm/test-model',
          { baseUrl: editor.baseUrl, apiKey: editor.apiKey, api: editor.api, model });
        testResults = testResults.map(item => item.model === model
          ? { model, ok: true, latencyMs: result?.latencyMs ?? 0, reply: displayReply(result?.reply) } : item);
      } catch (error) {
        testResults = testResults.map(item => item.model === model
          ? { model, ok: false, error: String(error.message || '失败').slice(0, 160) } : item);
      }
      render();
    }
    message = '连通性测试完成。';
    render();
  }

  /** 行内编辑面板：保存单个模型的手动能力声明（source user 由服务端落库）。 */
  async function saveRowCapability(model) {
    if (!selectedId || selectedId === '__new__') {
      message = '先保存 Provider 再保存能力声明。';
      render();
      return;
    }
    const provider = selectedProvider();
    const pick = field => host()?.querySelector(`[data-llm-cap-${field}="${model}"]`)?.value ?? '';
    const disableValue = pick('disable');
    const capability = {
      family: provider?.capabilities?.[model]?.family || 'unknown',
      thinking: {
        default: pick('default') || 'unknown',
        canDisable: disableValue === '' ? null : disableValue === 'true',
        budgetKnob: pick('knob') || null,
      },
      structuredOutput: pick('structured') || 'none',
    };
    message = '正在保存能力声明…';
    render();
    try {
      await apiClient.put('/api/llm/capabilities', { providerId: selectedId, model, capability });
      message = '能力声明已保存（手动声明优先于自动探测）。';
      showToast('success', '能力声明已保存', `${model} 的手动声明优先于自动探测。`, { curated: true });
    } catch (error) {
      message = `保存能力声明失败：${error.message}`;
    }
    await refresh({ keepDrafts: true });
  }

  /** 行内编辑：模型改名（草稿），保存 Provider 后落库。 */
  function renameModel(model, rawValue) {
    const next = String(rawValue || '').trim();
    if (!next || next === model) return;
    if (draftModels.has(next) || discovered.some(entry => entry.id === next)) {
      message = '同名模型已经在列表里。';
      render();
      return;
    }
    const wasConfigured = draftModels.delete(model);
    if (wasConfigured) draftModels.add(next);
    discovered = discovered.map(item => item.id === model ? { ...item, id: next } : item);
    if (draftModelInfo[model]) { draftModelInfo[next] = draftModelInfo[model]; delete draftModelInfo[model]; }
    if (draftModelDefaults[model]) { draftModelDefaults[next] = draftModelDefaults[model]; delete draftModelDefaults[model]; }
    if (draftDisabled.delete(model)) draftDisabled.add(next);
    if (expandedModel === model) expandedModel = next;
    if (Array.isArray(testResults)) testResults = testResults.map(item => item.model === model ? { ...item, model: next } : item);
    message = '';
    render();
  }

  /** 行内启用开关：停用只写草稿，保存后保留在列表但不再被使用。 */
  function toggleModel(model) {
    if (isConfigured(model)) {
      if (isDisabled(model)) draftDisabled.delete(model);
      else draftDisabled.add(model);
    } else {
      // 候选行（刚发现或手动添加）：打开即接入。
      draftModels.add(model);
      draftDisabled.delete(model);
    }
    message = '';
    render();
  }

  function removeModel(model) {
    draftModels.delete(model);
    draftDisabled.delete(model);
    delete draftModelInfo[model];
    delete draftModelDefaults[model];
    discovered = discovered.filter(item => item.id !== model);
    if (expandedModel === model) expandedModel = null;
    if (Array.isArray(testResults)) testResults = testResults.filter(item => item.model !== model);
    message = '';
    render();
  }

  function wire() {
    const on = (selector, type, handler) => {
      const element = host()?.querySelector(selector);
      element?.addEventListener(type, event => { event.preventDefault?.(); handler(event); });
    };
    for (const button of host()?.querySelectorAll('[data-llm-select-provider]') || []) {
      button.addEventListener('click', () => {
        selectedId = button.getAttribute('data-llm-select-provider');
        editorDraft = null;
        message = '';
        syncDrafts();
        render();
      });
    }
    on('#llm-provider-add', 'click', () => {
      selectedId = '__new__';
      editorDraft = null;
      message = '';
      syncDrafts();
      render();
    });
    on('#llm-prov-discover', 'click', async () => {
      const editor = readEditor();
      editorDraft = editor;
      if (!editor.baseUrl) { message = '先填 Base URL 再获取模型列表。'; render(); return; }
      message = '正在获取模型列表…';
      render();
      try {
        const result = await apiClient.post('/api/llm/providers/discover-models',
          { baseUrl: editor.baseUrl, apiKey: editor.apiKey, api: editor.api });
        discovered = (Array.isArray(result?.models) ? result.models : [])
          .map(entry => (typeof entry === 'string' ? { id: entry } : entry))
          .filter(entry => typeof entry?.id === 'string' && entry.id.trim());
        for (const entry of discovered) {
          if (entry.id.trim() === '') continue;
          draftModelInfo[entry.id] = { ...(draftModelInfo[entry.id] || {}), ...discoveryMeta(entry) };
        }
        message = discovered.length ? `发现 ${discovered.length} 个模型，勾选后保存。` : '端点返回了空模型列表。';
      } catch (error) {
        message = `获取失败：${error.message}`;
      }
      render();
    });
    on('#llm-prov-test', 'click', async () => {
      const editor = readEditor();
      const models = [...draftModels];
      if (!models.length) { message = '还没有可测试的模型。'; render(); return; }
      await testModels(models, editor);
    });
    on('#llm-prov-manual-add', 'click', () => {
      const manual = host()?.querySelector('#llm-prov-manual')?.value?.trim();
      if (manual && !draftModels.has(manual)) draftModels.add(manual);
      editorDraft = readEditor();
      message = '';
      render();
    });
    on('#llm-prov-enabled', 'click', () => {
      const button = host()?.querySelector('#llm-prov-enabled');
      const current = button?.getAttribute?.('aria-checked') === 'true';
      button?.setAttribute?.('aria-checked', current ? 'false' : 'true');
      // 只切换开关，不整页重渲染：避免把尚未保存的输入框草稿与焦点冲掉。
      editorDraft = { ...(editorDraft || {}), enabled: !current };
    });
    for (const button of host()?.querySelectorAll('[data-llm-model-toggle]') || []) {
      button.addEventListener('click', event => {
        event.preventDefault?.();
        toggleModel(button.getAttribute('data-llm-model-toggle'));
      });
    }
    for (const button of host()?.querySelectorAll('[data-llm-test-model]') || []) {
      button.addEventListener('click', async event => {
        event.preventDefault?.();
        const model = button.getAttribute('data-llm-test-model');
        await testModels([model], readEditor());
      });
    }
    for (const button of host()?.querySelectorAll('[data-llm-edit-model]') || []) {
      button.addEventListener('click', event => {
        event.preventDefault?.();
        const model = button.getAttribute('data-llm-edit-model');
        const wasExpanded = expandedModel === model;
        expandedModel = wasExpanded ? null : model;
        message = '';
        if (!wasExpanded) pendingFocus = `[data-llm-model-editor="${model}"]`;
        render();
      });
    }
    for (const button of host()?.querySelectorAll('[data-llm-remove-model]') || []) {
      button.addEventListener('click', event => {
        event.preventDefault?.();
        removeModel(button.getAttribute('data-llm-remove-model'));
      });
    }
    for (const input of host()?.querySelectorAll('[data-llm-model-rename]') || []) {
      input.addEventListener('change', () => {
        renameModel(input.getAttribute('data-llm-model-rename'), input.value);
      });
    }
    for (const select of host()?.querySelectorAll('[data-llm-effort-default]') || []) {
      select.addEventListener('change', () => {
        const model = select.getAttribute('data-llm-effort-default');
        const value = String(select.value || '').trim();
        if (value) draftModelDefaults[model] = { reasoningEffort: value };
        else delete draftModelDefaults[model];
        message = '';
        pendingFocus = `[data-llm-effort-default="${model}"]`;
        render();
      });
    }
    const editor = host()?.querySelector('[data-llm-model-editor]');
    editor?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault?.();
      const model = editor.getAttribute('data-llm-model-editor');
      expandedModel = null;
      pendingFocus = `[data-llm-edit-model="${model}"]`;
      render();
    });
    for (const button of host()?.querySelectorAll('[data-llm-probe-model]') || []) {
      button.addEventListener('click', async event => {
        event.preventDefault?.();
        const model = button.getAttribute('data-llm-probe-model');
        if (!selectedId || selectedId === '__new__') { message = '先保存 Provider 再探测能力。'; render(); return; }
        message = `正在探测 ${model} 的能力…`;
        render();
        try {
          const result = await apiClient.post('/api/llm/probe-capability', { providerId: selectedId, model });
          message = result?.ok === false
            ? `探测失败：${result?.error || '未知原因'}`
            : `探测完成：${capabilitySummary(result?.capability)}`;
        } catch (error) {
          message = `探测失败：${error.message}`;
        }
        await refresh({ keepDrafts: true });
      });
    }
    for (const button of host()?.querySelectorAll('[data-llm-cap-save]') || []) {
      button.addEventListener('click', async event => {
        event.preventDefault?.();
        await saveRowCapability(button.getAttribute('data-llm-cap-save'));
      });
    }
    on('#llm-prov-save', 'click', async () => {
      const editor = readEditor();
      if (!editor.name || !editor.baseUrl || !editor.models.length) {
        message = '名称、Base URL 与至少一个模型是必填的。';
        render();
        return;
      }
      const isNew = selectedId === '__new__';
      try {
        const saved = isNew
          ? await apiClient.post('/api/llm/providers', editor)
          : await apiClient.put(`/api/llm/providers/${selectedId}`, editor);
        message = '已保存；停用的模型保留在列表但不会被使用，新模型的能力探测在后台进行。';
        showToast('success', isNew ? 'Provider 已添加' : 'Provider 已保存',
          `${editor.name}：${editor.models.length} 个模型；能力探测在后台进行。`, { curated: true });
        selectedId = saved?.provider?.id || selectedId;
        await refresh();
      } catch (error) {
        message = `保存失败：${error.message}`;
        render();
      }
    });
    on('#llm-prov-delete', 'click', async () => {
      if (!selectedId || selectedId === '__new__') return;
      editorDraft = null;
      try {
        await apiClient.delete(`/api/llm/providers/${selectedId}`);
        selectedId = providers.find(provider => provider.id !== selectedId)?.id ?? null;
        draftProviderId = null;
        message = '已删除。';
        showToast('info', 'Provider 已删除', '它下面的模型不会再出现在使用中与聊天覆盖里。', { curated: true });
        await refresh();
      } catch (error) {
        message = `删除失败：${error.message}`;
        render();
      }
    });
    const activeSelect = activeHost()?.querySelector('#llm-active-model');
    activeSelect?.addEventListener('change', async event => {
      const [providerId, model] = String(event.target?.value || '').split('::');
      if (!providerId || !model) return;
      try {
        await apiClient.put('/api/llm/active-model', { providerId, model });
        activeModel = { providerId, model };
        message = '';
        showToast('success', '使用中模型已切换', `之后的对话、串词与打标都走 ${model}。`, { curated: true });
      } catch (error) {
        message = `切换失败：${error.message}`;
      }
      render();
      await failoverSettings.refresh({ providers, activeModel });
    });
  }

  return { refresh };
}
