// Provider-neutral, non-modal source warnings. Only closed codes and registry names cross the boundary.
const COPY = Object.freeze({
  'requires-auth': { title: '需要重新登录', detail: '登录状态已失效，后续选歌可能受影响。', action: '重新登录' },
  'requires-member': { title: '部分歌曲需要会员', detail: '部分音源需要会员权限，其他可用歌曲不受影响。', action: '检查音乐源' },
  timeout: { title: '响应超时', detail: '暂时没有及时取得音源，请检查连接或稍后重试。', action: '检查音乐源' },
  unavailable: { title: '暂时无法连接', detail: '后续选歌可能受影响，请检查连接或稍后重试。', action: '检查音乐源' },
  'rate-limited': { title: '请求暂时受限', detail: '请稍后重试，不需要因此重新登录。', action: '检查音乐源' },
});
// 声音接口（TTS）故障：串词与语音回复没出声时告诉用户为什么；只陈述没出声，不声称别处已补上。
// 只有服务端明确带来 fallback（用户开启的代读确实念出来了）时，才改说由谁代读。
const SILENT = '串词和语音回复暂时没有声音';
const VOICE_COPY = Object.freeze({
  'credit-exhausted': { title: '额度已用尽', detail: `${SILENT}，充值后会自动恢复。`, action: '检查声音设置' },
  'auth-failed': { title: '密钥无效', detail: `${SILENT}，请检查 API key。`, action: '检查声音设置' },
  'rate-limited': { title: '同时合成太多', detail: '同时要合成的声音超过了接口上限，部分串词没能出声。', action: '检查声音设置' },
  busy: { title: '暂时容量不足', detail: '供应商暂时容量不足，部分串词没能出声。', action: '检查声音设置' },
  timeout: { title: '合成超时', detail: '有一段声音没能及时合成，这次没有出声。', action: '检查声音设置' },
  'not-configured': { title: '声音不可用', detail: `${SILENT}，请检查接口与所选声音。`, action: '检查声音设置' },
  failed: { title: '合成失败', detail: '有一段声音没能合成，这次没有出声。', action: '检查声音设置' },
});
// 主声音失败但已由用户开启的代读声音念出：如实说明谁在代读，不说"没有出声"。
const VOICE_REASON = Object.freeze({
  'credit-exhausted': '额度用尽', 'auth-failed': '密钥无效', 'rate-limited': '同时合成太多', busy: '容量不足',
  timeout: '合成超时', 'not-configured': '不可用', failed: '合成失败',
});
const substituteDetail = (code, fallbackName) => `主声音${VOICE_REASON[code]}，这段由「${fallbackName}」代读；恢复后自动换回。`;
const KINDS = Object.freeze({
  'music-source-status': { kind: 'music', copy: COPY, idOf: message => message.source, recovered: '连接已恢复',
    recoveredDetail: '可以继续使用这个来源，确认后可关闭此提示。' },
  'voice-endpoint-status': { kind: 'voice', copy: VOICE_COPY, idOf: message => message.endpoint, recovered: '声音已恢复',
    recoveredDetail: '合成已经正常，确认后可关闭此提示。' },
});
const validSource = source => typeof source === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(source);

export function createSourceFailureWarning({ documentLike = globalThis.document, onAction = () => {} } = {}) {
  const doc = documentLike;
  const region = doc?.querySelector?.('#source-failure-warnings');
  const entries = new Map();
  const seen = new Map();
  let destroyed = false;

  function remove(source) {
    const entry = entries.get(source);
    if (!entry) return;
    const focused = entry.node.contains(doc.activeElement);
    entry.node.remove();
    entries.delete(source);
    region.hidden = entries.size === 0;
    // Arrival never steals focus; an explicit dismissal returns keyboard users to the app.
    if (focused) doc.querySelector('#compose-input')?.focus?.({ preventScroll: true });
  }

  function render(key, displayName, code, spec, fallbackName = null) {
    const source = key;
    const previous = entries.get(source);
    const node = previous?.node || doc.createElement('section');
    node.className = 'source-failure-warning';
    node.dataset.source = source;
    const message = doc.createElement('div');
    message.className = 'source-warning-message';
    const title = doc.createElement('strong');
    const detail = doc.createElement('span');
    const copy = spec.copy[code];
    title.textContent = `${displayName}${copy ? copy.title : spec.recovered}`;
    detail.textContent = copy && fallbackName ? substituteDetail(code, fallbackName) : (copy?.detail || spec.recoveredDetail);
    message.append(title, detail);
    const controls = doc.createElement('div');
    controls.className = 'source-warning-actions';
    if (copy) {
      const action = doc.createElement('button');
      action.type = 'button'; action.textContent = copy.action;
      action.dataset.sourceWarningAction = source;
      controls.append(action);
    }
    const confirm = doc.createElement('button');
    confirm.type = 'button'; confirm.textContent = '知道了'; confirm.dataset.sourceWarningDismiss = source;
    const close = doc.createElement('button');
    close.type = 'button'; close.className = 'source-warning-close';
    close.dataset.sourceWarningDismiss = source;
    close.setAttribute('aria-label', `关闭${displayName}提示`);
    close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
    controls.append(confirm, close);
    // Preserve the focused control when a live failure/recovery updates the same warning.
    const focusedAction = previous?.node.contains(doc.activeElement) ? doc.activeElement?.dataset?.sourceWarningAction : null;
    const focusedDismiss = previous?.node.contains(doc.activeElement) ? doc.activeElement?.dataset?.sourceWarningDismiss : null;
    node.replaceChildren(message, controls);
    if (!previous) region.append(node);
    entries.set(source, { node, displayName, code, spec, id: previous?.id ?? null });
    region.hidden = false;
    if (focusedAction || focusedDismiss) node.querySelector(focusedAction && copy ? '[data-source-warning-action]' : '[data-source-warning-dismiss]')?.focus?.({ preventScroll: true });
  }

  function consume(message) {
    const spec = KINDS[message?.type];
    const id = spec?.idOf(message);
    if (destroyed || !region || !spec || !validSource(id)) return false;
    // 音乐源沿用源 id 作键；声音接口加前缀，同名 id 不会互相覆盖。
    const key = spec.kind === 'music' ? id : `${spec.kind}:${id}`;
    const { code } = message;
    const fallback = spec.kind === 'voice' && validSource(message.fallback?.endpoint) ? message.fallback : null;
    const fallbackName = fallback ? String(fallback.displayName || fallback.endpoint).slice(0, 120) : null;
    const incident = `${code}|${fallback?.endpoint || ''}`;
    if (code === null) {
      seen.delete(key);
      const entry = entries.get(key);
      // Recovery updates the warning but does not auto-dismiss an unacknowledged notice.
      if (entry) render(key, entry.displayName, null, spec);
      return true;
    }
    if (!Object.hasOwn(spec.copy, code) || seen.get(key) === incident) return false;
    seen.set(key, incident);
    const displayName = String(message.displayName || id).slice(0, 120);
    render(key, displayName, code, spec, fallbackName);
    entries.get(key).id = id;
    return true;
  }

  function click(event) {
    const button = event.target.closest?.('button');
    if (!button || !region.contains(button)) return;
    const source = button.dataset.sourceWarningDismiss || button.dataset.sourceWarningAction;
    const entry = entries.get(source);
    if (!entry) return;
    remove(source);
    if (button.dataset.sourceWarningAction) {
      // Restore focus before opening recovery so its opener is not a detached warning button.
      // The existing login/settings surface owns recovery; arrival itself has no side effects.
      if (entry.spec.kind === 'voice') onAction({ kind: 'voice', source: entry.id, code: entry.code, displayName: entry.displayName });
      else onAction({ source, code: entry.code, displayName: entry.displayName });
    }
  }
  region?.addEventListener('click', click);
  return Object.freeze({ consume, destroy() {
    destroyed = true;
    region?.removeEventListener('click', click);
    for (const source of [...entries.keys()]) remove(source);
    seen.clear();
  } });
}
