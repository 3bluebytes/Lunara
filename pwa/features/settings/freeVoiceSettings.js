// 免费声音（Edge 朗读）小节与「主声音失败时代读」设置卡。
//
// 免费声音小节放在声音池卡里、发现结果正上方。开启后「免费声音（Edge）」出现在声音池的
// 「来源接口」下拉里，与其他接口共用「获取声音列表」和发现结果（试听、勾选、加入声音池）；
// 来源下拉由 settingsView 渲染。代读卡在声音池下方，目标从声音池里挑。
//
// 只读写 /api/tts/fallback 与自定义声音配置视图里的 fallback 字段，不碰播放状态。
// 开启免费声音前必须在页内看完固定说明并点「同意并开启」：复选框本身不会直接打开它。
// 说明文字写死在这里，不由模型生成；关闭随时生效（服务端随即注销 free-edge）。
//
// Python 伪代码：
//   on toggle(free=True):  show disclosure; on agree -> POST {freeVoicesEnabled: True, consent: True}
//   on toggle(fallback):   POST {fallbackEnabled}
//   on select(target):     POST {fallbackTarget: {providerId:'free-edge', voiceId} | {profileId}}

export const FREE_EDGE_ENDPOINT_ID = 'free-edge';
export const FREE_EDGE_LABEL = '免费声音（Edge）';
export const FREE_VOICE_DISCLOSURE = '免费声音来自微软 Edge「大声朗读」的公开网页接口，非官方授权，可能随时失效；'
  + '开启后，要朗读的文字（包括串词和聊天回复）会发送给微软。关闭后立即停止发送。';
const DEFAULT_EDGE_VOICE = Object.freeze({ id: 'zh-CN-XiaoxiaoNeural', name: '晓晓' });
const SEP = '\u0001';

const encodeTarget = target => (target?.profileId ? `p${SEP}${target.profileId}` : target?.voiceId ? `e${SEP}${target.voiceId}` : '');
function decodeTarget(value) {
  const [kind, id] = String(value || '').split(SEP);
  if (kind === 'p' && id) return { profileId: id };
  if (kind === 'e' && id) return { providerId: FREE_EDGE_ENDPOINT_ID, voiceId: id };
  return null;
}

export function createFreeVoiceSettings({
  controller,
  documentLike = globalThis.document,
  // 保存成功后把完整配置视图交回 settingsView（它持有声音池）。
  onConfig = () => {},
  onToast = () => {},
} = {}) {
  const $ = selector => documentLike?.querySelector?.(selector) || null;
  let fallback = { freeVoicesEnabled: false, consentAt: null, fallbackEnabled: false, fallbackTarget: null };
  let poolVoices = [];
  let consentOpen = false;
  let busy = false;
  const cleanups = [];

  // 开关的结果写在免费声音小节里，代读的结果写在代读卡里：提示出现在用户刚点的地方。
  const status = (text, selector) => {
    const node = $(selector);
    if (node) node.textContent = text;
  };

  /** 代读目标选项：Edge 声音（开了免费声音才有）在前，其余为声音池里已保存的声音。 */
  function targetOptions() {
    const options = [];
    if (fallback.freeVoicesEnabled) {
      const edge = [DEFAULT_EDGE_VOICE, ...poolVoices.filter(voice => voice.endpointId === FREE_EDGE_ENDPOINT_ID)
        .map(voice => ({ id: voice.sourceVoiceId, name: voice.displayName }))];
      const seen = new Set();
      for (const voice of edge) {
        if (seen.has(voice.id)) continue;
        seen.add(voice.id);
        options.push({ value: encodeTarget({ voiceId: voice.id }), label: `${voice.name} · 免费声音` });
      }
    }
    for (const voice of poolVoices) {
      if (voice.endpointId === FREE_EDGE_ENDPOINT_ID || !voice.profileId) continue;
      options.push({ value: encodeTarget({ profileId: voice.profileId }), label: `${voice.displayName} · ${voice.endpointName || voice.endpointId}` });
    }
    return options;
  }

  function render() {
    const freeToggle = $('#tts-free-toggle');
    const consent = $('#tts-free-consent');
    const fallbackToggle = $('#tts-fallback-toggle');
    const select = $('#tts-fallback-target');
    const disclosure = $('#tts-free-disclosure');
    if (disclosure) disclosure.textContent = FREE_VOICE_DISCLOSURE;
    if (freeToggle) {
      freeToggle.checked = fallback.freeVoicesEnabled;
      freeToggle.disabled = busy;
      freeToggle.setAttribute('aria-expanded', String(consentOpen));
    }
    if (consent) consent.hidden = !consentOpen;
    for (const button of [$('#tts-free-agree'), $('#tts-free-cancel')]) if (button) button.disabled = busy;
    if (fallbackToggle) {
      fallbackToggle.checked = fallback.fallbackEnabled;
      fallbackToggle.disabled = busy;
    }
    if (select) {
      const options = targetOptions();
      const current = encodeTarget(fallback.fallbackTarget);
      select.replaceChildren();
      const placeholder = documentLike.createElement('option');
      placeholder.value = '';
      placeholder.textContent = options.length ? '选择代读声音…' : '先开启免费声音或保存声音池';
      select.append(placeholder);
      for (const option of options) {
        const node = documentLike.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        node.selected = option.value === current;
        select.append(node);
      }
      select.disabled = busy || !fallback.fallbackEnabled || options.length === 0;
    }
    const note = $('#tts-fallback-note');
    if (note) {
      const target = fallback.fallbackTarget;
      const inert = fallback.fallbackEnabled && target?.providerId === FREE_EDGE_ENDPOINT_ID && !fallback.freeVoicesEnabled;
      note.textContent = inert
        ? '代读目标是免费声音，但免费声音已关闭：现在不会代读。换一把声音池里的声音，或重新开启免费声音。'
        : '只在伙伴自己的声音超时、网络或额度/密钥出错时代读；顶部提醒会说明这段由谁代读。取消、声音被删除时不会代读。';
    }
  }

  /** settingsView 读到或保存配置后调用：同步开关和声音池（只用已保存的声音做目标）。 */
  function apply(config) {
    if (config?.fallback) fallback = { ...fallback, ...config.fallback };
    const names = new Map((config?.endpoints || []).map(endpoint => [endpoint.id, endpoint.name]));
    poolVoices = (config?.voices || []).map(voice => ({ ...voice, endpointName: names.get(voice.endpointId) || null }));
    render();
  }

  async function save(patch, success, statusSelector = '#tts-fallback-status') {
    busy = true;
    render();
    try {
      const config = await controller.saveTtsFallback(patch);
      consentOpen = false;
      apply(config);
      onConfig(config);
      status(success, statusSelector);
      onToast(success);
      return true;
    } catch (error) {
      status(`没有保存：${error.message}`, statusSelector);
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function onFreeToggle(event) {
    if (event.target.checked && !fallback.freeVoicesEnabled) {
      // 复选框不直接开启：先展开说明，等用户点「同意并开启」。
      event.target.checked = false;
      consentOpen = true;
      render();
      $('#tts-free-agree')?.focus?.({ preventScroll: true });
      return;
    }
    if (!event.target.checked && fallback.freeVoicesEnabled) {
      void save({ freeVoicesEnabled: false }, '免费声音已关闭，不再向微软发送文字。', '#tts-free-status');
    }
  }

  function cancelConsent() {
    consentOpen = false;
    render();
    $('#tts-free-toggle')?.focus?.({ preventScroll: true });
  }

  function listen(selector, type, listener) {
    const node = $(selector);
    if (!node) return;
    node.addEventListener(type, listener);
    cleanups.push(() => node.removeEventListener(type, listener));
  }
  listen('#tts-free-toggle', 'change', onFreeToggle);
  listen('#tts-free-agree', 'click', () => void save({ freeVoicesEnabled: true, consent: true }, '免费声音已开启：上方「来源接口」已切到免费声音，点「获取声音列表」后在发现结果里试听。', '#tts-free-status'));
  listen('#tts-free-cancel', 'click', cancelConsent);
  // preventDefault：只收起说明，不让设置面板把同一个 Esc 当成关闭整个面板。
  listen('#tts-free-consent', 'keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    cancelConsent();
  });
  listen('#tts-fallback-toggle', 'change', event => void save({ fallbackEnabled: event.target.checked }, event.target.checked ? '已开启代读。' : '已关闭代读：主声音失败时如实跳过。'));
  listen('#tts-fallback-target', 'change', event => {
    const target = decodeTarget(event.target.value);
    if (target) void save({ fallbackTarget: target }, '代读声音已更新。');
  });
  render();

  return Object.freeze({
    apply,
    destroy() { for (const cleanup of cleanups.splice(0)) cleanup(); },
  });
}
