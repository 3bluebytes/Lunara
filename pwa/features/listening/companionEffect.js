// companionEffect.js — 页头「陪伴」旁的原因按钮：她现在为什么不怎么主动开口，以及去哪里改。
//
// 主动说多少话由四处决定（陪伴模式 / 在场性格 / 全局开关 / 本次「安静点」），服务端取最严的一档。
// 这里只显示服务端算好的结果（GET /api/presence/effective），不在前端重算规则；读不到就不显示。
//
// 输入：refresh() 被调用（连上、听歌来源或模式变了、「安静点」广播、设置或人物改完）。
// 输出：#companion-effect 按钮的文字 / 可访问名称 / 显隐；点击按原因分流到三个已有动作。
//
// Python 伪代码：
//   async def refresh():
//       effect = await get('/api/presence/effective')      # 失败 -> 隐藏
//       copy = companion_effect_copy(effect, name_of)      # None -> 隐藏
//       button.text, button.label = copy.text, copy.label
//   def on_click(): {'restore': restore_quiet, 'settings': open_settings, 'person': open_person}[action]()
const ENDPOINT = '/api/presence/effective';

/** 原因 → 页头文案；没有需要解释的原因（或没有听歌来源）返回 null。 */
export function companionEffectCopy(effect, { nameOf = () => '' } = {}) {
  if (!effect || !effect.sessionId) return null;
  if (effect.limitedBy === 'listener-quiet') {
    return { action: 'restore', text: '这次已安静', label: '这次一起听已安静，伙伴不主动开口。点击恢复主动说话' };
  }
  if (effect.limitedBy === 'ambient-off') {
    return { action: 'settings', text: '主动说话已关', label: '设置里关闭了「一起听歌时伙伴会主动说话」，所以只在你说话和换歌时开口。点击打开设置' };
  }
  if (effect.limitedBy === 'temperament') {
    const name = String(nameOf(effect.speakerId) || '').trim() || '这位伙伴';
    return { action: 'person', personId: effect.speakerId || null, text: `${name}话少`,
      label: `${name}的在场性格是话少，有真想说的才开口。点击打开人物页` };
  }
  if (effect.limitedBy === 'unavailable') {
    return { action: null, text: '主动说话已停用', label: '主动说话被启动参数关闭了，这里不能修改' };
  }
  return null;
}

export function createCompanionEffect({
  apiClient,
  documentLike = globalThis.document,
  nameOf = () => '',
  restoreQuiet = async () => {},
  openSettings = () => {},
  openPerson = () => {},
} = {}) {
  if (!apiClient?.get) throw new TypeError('companion effect requires an api client');
  const button = () => documentLike?.querySelector?.('#companion-effect') || null;
  let current = null;
  let generation = 0;
  let busy = false;

  function render() {
    const node = button();
    if (!node) return;
    node.hidden = !current;
    if (!current) return;
    if (node.textContent !== current.text) node.textContent = current.text;
    node.setAttribute('aria-label', current.label);
    node.title = current.label;
    node.disabled = busy || !current.action;
  }

  /** 迟到的旧响应不覆盖新的；读取失败时隐藏，不猜。 */
  async function refresh() {
    const mine = ++generation;
    let next = null;
    try { next = companionEffectCopy(await apiClient.get(ENDPOINT), { nameOf }); } catch { next = null; }
    if (mine !== generation) return current;
    current = next;
    render();
    return current;
  }

  async function onClick() {
    if (busy || !current?.action) return;
    const { action, personId } = current;
    if (action === 'settings') return openSettings();
    if (action === 'person') return personId ? openPerson(personId) : undefined;
    busy = true;
    render();
    try { await restoreQuiet(); } finally {
      busy = false;
      await refresh();
    }
  }

  function init() {
    button()?.addEventListener?.('click', onClick);
    return api;
  }
  const api = Object.freeze({
    init, refresh,
    destroy() { generation += 1; button()?.removeEventListener?.('click', onClick); },
  });
  return api;
}
