// Independent failover policy editor. Separate persisted policy: never part of the model settings draft.
const ENDPOINT = '/api/llm/failover';
const SEP = '\u0001';
const MAX_TARGETS = 2;
const PREFIX = 'llm-failover-';
const CROSS_HINT =
  '允许跨供应商：对话上下文可能发送给选定供应商，并增加请求费用。未允许时，来自其它供应商的备用模型会在切换时被跳过。';
const LOAD_ERROR = '暂时读不到故障切换设置。已保存的策略仍在生效，可以重试。';

export function createLlmFailoverSettings({
  apiClient,
  documentLike = globalThis.document,
  hostSelector = '#llm-failover-settings',
  // 保存成功后的轻提示；页面里的状态行仍然写着完整的备用顺序。
  showToast = () => {},
} = {}) {
  let providers = [];
  let activeModel = null;
  let confirmed = null;
  let loadFailed = false;
  let busy = false;
  let generation = 0;
  let lastRequest = { providers: [], activeModel: null };

  const host = () => documentLike?.querySelector?.(hostSelector) || null;
  const q = (selector) => host()?.querySelector?.(selector) || null;
  const status = (text) => {
    const node = q('#' + PREFIX + 'status');
    if (node) node.textContent = text;
  };

  function make(tag, { text, id, className, attrs } = {}) {
    const node = documentLike.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (id) node.id = id;
    if (className) node.className = className;
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const encode = (target) => target.providerId + SEP + target.model;

  function providerName(providerId) {
    const match = providers.find((provider) => String(provider?.id) === String(providerId));
    return match?.name ? String(match.name) : String(providerId);
  }

  // Candidates come only from enabled providers and their enabled models.
  function candidates() {
    const list = [];
    for (const provider of providers) {
      if (!provider?.enabled) continue;
      const disabled = new Set(
        Array.isArray(provider.disabledModels) ? provider.disabledModels.map(String) : [],
      );
      const models = Array.isArray(provider.models) ? provider.models : [];
      for (const model of models) {
        if (model === undefined || model === null) continue;
        if (disabled.has(String(model))) continue;
        list.push({ providerId: String(provider.id), model: String(model) });
      }
    }
    return list;
  }

  function normalize(policy) {
    if (!policy || typeof policy.enabled !== 'boolean') return null;
    const targets = Array.isArray(policy.targets)
      ? policy.targets
          .filter((target) => target && target.providerId != null && target.model != null)
          .map((target) => ({ providerId: String(target.providerId), model: String(target.model) }))
      : [];
    return {
      enabled: policy.enabled,
      allowCrossProvider: policy.allowCrossProvider === true,
      targets: targets.slice(0, MAX_TARGETS),
    };
  }

  function labelled(input, text) {
    const label = make('label', { className: 'setting-field' });
    label.appendChild(input);
    label.appendChild(make('span', { text }));
    return label;
  }

  function targetField(index, saved) {
    const selectId = PREFIX + 'target-' + index;
    const label = make('label', { className: 'setting-field' });
    label.appendChild(make('span', { text: index === 0 ? '第一备用' : '第二备用' }));
    const select = make('select', { id: selectId });
    const none = make('option', { text: '不选择', attrs: { value: '' } });
    select.appendChild(none);
    const list = candidates();
    const savedValue = saved ? encode(saved) : '';
    const known = saved
      ? list.some((c) => c.providerId === saved.providerId && c.model === saved.model)
      : false;
    let selectedOption = none;
    if (saved && !known) {
      // Keep a removed/disabled saved target visible instead of silently dropping it.
      const stale = make('option', {
        text: providerName(saved.providerId) + ' · ' + saved.model + '（未生效）',
        attrs: { value: savedValue },
      });
      stale.disabled = true;
      select.appendChild(stale);
      selectedOption = stale;
    }
    for (const candidate of list) {
      const value = encode(candidate);
      const option = make('option', {
        text: providerName(candidate.providerId) + ' · ' + candidate.model,
        attrs: { value },
      });
      if (known && value === savedValue) selectedOption = option;
      select.appendChild(option);
    }
    selectedOption.selected = true;
    label.appendChild(select);
    return label;
  }

  function renderBusy() {
    const root = host();
    if (!root) return;
    const value = busy ? 'true' : 'false';
    root.setAttribute('aria-busy', value);
    const button = q('#' + PREFIX + 'save');
    if (button) button.setAttribute('aria-busy', value);
  }

  function render() {
    const root = host();
    if (!root) return;
    clear(root);
    if (loadFailed) {
      root.appendChild(make('p', { id: PREFIX + 'status', text: LOAD_ERROR, attrs: { role: 'status' } }));
      const retry = make('button', { id: PREFIX + 'retry', className: 'quiet-button', text: '重试' });
      retry.setAttribute('type', 'button');
      retry.addEventListener('click', () => void refresh(lastRequest));
      root.appendChild(retry);
      renderBusy();
      return;
    }
    const form = make('form', { className: 'llm-failover-form' });
    form.addEventListener('submit', (event) => event?.preventDefault?.());

    const enabledInput = make('input', { id: PREFIX + 'enabled', attrs: { type: 'checkbox' } });
    enabledInput.checked = confirmed?.enabled === true;
    form.appendChild(labelled(enabledInput, '启用故障切换'));

    const savedTargets = confirmed?.targets || [];
    for (let index = 0; index < MAX_TARGETS; index += 1) {
      form.appendChild(targetField(index, savedTargets[index]));
    }

    const crossInput = make('input', {
      id: PREFIX + 'allow-cross',
      attrs: { type: 'checkbox' },
    });
    crossInput.checked = confirmed?.allowCrossProvider === true;
    form.appendChild(labelled(crossInput, '允许跨供应商'));
    form.appendChild(make('small', { className: 'field-hint', text: CROSS_HINT }));

    const saveButton = make('button', { id: PREFIX + 'save', className: 'quiet-button', text: '保存' });
    saveButton.setAttribute('type', 'button');
    saveButton.addEventListener('click', () => void submit());
    form.appendChild(saveButton);

    const statusNode = make('p', { id: PREFIX + 'status' });
    statusNode.setAttribute('role', 'status');
    form.appendChild(statusNode);

    root.appendChild(form);
    renderBusy();
  }

  function readTarget(index) {
    const value = q('#' + PREFIX + 'target-' + index)?.value || '';
    if (!value) return null;
    const cut = value.indexOf(SEP);
    if (cut < 0) return null;
    return { providerId: value.slice(0, cut), model: value.slice(cut + 1) };
  }

  function readDraft() {
    return {
      enabled: q('#' + PREFIX + 'enabled')?.checked === true,
      allowCrossProvider: q('#' + PREFIX + 'allow-cross')?.checked === true,
      targets: [readTarget(0), readTarget(1)].filter(Boolean),
    };
  }

  function validate(policy) {
    if (!policy.enabled) return '';
    if (policy.enabled && policy.targets.length === 0) {
      return '启用故障切换前，至少选择一个备用模型。';
    }
    if (
      policy.targets.length === 2 &&
      policy.targets[0].providerId === policy.targets[1].providerId &&
      policy.targets[0].model === policy.targets[1].model
    ) {
      return '第一备用和第二备用不能是同一个模型。';
    }
    if (!policy.allowCrossProvider) {
      const activeProviderId = activeModel ? String(activeModel.providerId) : null;
      if (activeProviderId === null) {
        return '暂时无法确认当前使用的供应商。请先允许跨供应商，或稍后重试。';
      }
      if (policy.targets.some((target) => target.providerId !== activeProviderId)) {
        return '所选备用模型来自其它供应商。请先允许跨供应商，否则切换时会跳过该来源。';
      }
    }
    return '';
  }

  function describe(policy) {
    if (!policy.enabled) return '已保存：故障切换已关闭。';
    const names = policy.targets.map((t) => providerName(t.providerId) + ' · ' + t.model).join('、');
    return (
      '已保存：故障切换已启用，备用顺序 ' +
      names +
      (policy.allowCrossProvider ? '；允许跨供应商。' : '；只使用当前供应商。')
    );
  }

  async function submit() {
    if (busy || loadFailed) return;
    const draft = readDraft();
    const problem = validate(draft);
    if (problem) {
      status(problem);
      return;
    }
    busy = true;
    const own = ++generation;
    status('正在保存…');
    renderBusy();
    try {
      const response = await apiClient.put(ENDPOINT, draft);
      if (own !== generation) return;
      const saved = normalize(response?.policy);
      if (response?.ok === false || !saved) throw Error('write rejected');
      confirmed = saved;
      busy = false;
      const focusId = documentLike.activeElement?.id;
      render();
      status(describe(saved));
      showToast('success', '故障切换已保存',
        saved.enabled ? `已设 ${saved.targets.length} 个备用；网络、限流、服务异常或认证/权限失败时按顺序尝试。` : '已关闭；不会尝试任何备用模型。',
        { curated: true });
      if (focusId) q('#' + focusId)?.focus?.();
    } catch {
      if (own !== generation) return;
      // Keep the draft in the form so the user can retry.
      busy = false;
      status('未保存：表单中的选择已保留，可以重试。');
      renderBusy();
    } finally {
      busy = false;
    }
  }

  async function refresh(request = {}) {
    if (!host()) return;
    lastRequest = {
      providers: Array.isArray(request.providers) ? request.providers : [],
      activeModel:
        request.activeModel && typeof request.activeModel === 'object' ? request.activeModel : null,
    };
    providers = lastRequest.providers;
    activeModel = lastRequest.activeModel;
    const own = ++generation;
    try {
      const response = await apiClient.get(ENDPOINT);
      if (own !== generation) return;
      const policy = normalize(response?.policy);
      if (response?.ok === false || !policy) throw Error('invalid policy');
      confirmed = policy;
      loadFailed = false;
      busy = false;
      render();
      status(describe(policy));
    } catch {
      if (own !== generation) return;
      confirmed = null;
      loadFailed = true;
      busy = false;
      render();
    }
  }

  return Object.freeze({ refresh });
}
