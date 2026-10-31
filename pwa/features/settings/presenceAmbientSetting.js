// presenceAmbientSetting.js — 「设置 → 常规 → 陪伴」里的两个开关：
//   「一起听歌时伙伴会主动说话」（add-companion-heartbeat 4.2 / D7）
//   「打开 app 时伙伴可以打招呼」（add-app-open-greeting D7），两者互相独立，共用同一个接口。
//
// 只显示服务端确认过的值：点一下先发写入（只带被点的那个开关），成功后才把勾选改过去；保存中仍显示旧值
// （不禁用控件，键盘焦点留在原处），失败时回显旧值和可重试的说明，不回显底层错误。
// 环境总开关 PRESENCE_AUTO=0 时控件只读。关掉不影响普通聊天和换歌串词。
//
// Python 伪代码：
//   async def on_change(key, checked):
//       if saving or not confirmed.available: render(confirmed); return
//       render(confirmed, busy=key)                     # 仍是旧值
//       try: confirmed = await post('/api/presence/preferences', {key: checked})
//       except: note[key] = f'没能保存，仍然是{old}'
//       render(confirmed)
const ENDPOINT = '/api/presence/preferences';
// 文案不指定伙伴的性别：伙伴可能是任何性别，只说「伙伴」。
const SWITCHES = Object.freeze([
  Object.freeze({ key: 'ambientEnabled', toggle: '#presence-ambient-toggle', note: '#presence-ambient-note',
    on: '一起听歌时，伙伴偶尔会接着你们聊过的事说一两句，也常常只是安静陪着。',
    off: '关闭后，伙伴只在你说话和换歌串词时开口。' }),
  Object.freeze({ key: 'greetingEnabled', toggle: '#presence-greeting-toggle', note: '#presence-greeting-note',
    on: '离开一阵再打开 app 时，伙伴可能在最近的聊天里接一句上次没聊完的事，只出文字；你先开口或开始打字就不说了。',
    off: '关闭后，打开 app 时伙伴不会先开口。' }),
]);
const NOTE_LOCKED = '这个功能被启动参数关闭了（PRESENCE_AUTO=0），这里不能修改。';
const NOTE_SAVING = '正在保存…';
const NOTE_LOAD_FAILED = '暂时读不到这个开关的状态，稍后重新打开设置再试。';
const failedNote = enabled => `没能保存，仍然是${enabled ? '打开' : '关闭'}的。可以再试一次。`;
const normalize = result => ({
  ambientEnabled: result?.ambientEnabled === true,
  greetingEnabled: result?.greetingEnabled === true,
  available: result?.available !== false,
});

export function createPresenceAmbientSetting({
  apiClient,
  documentLike = globalThis.document,
  // 保存成功后的轻提示；内联说明仍然写着「现在是开还是关」。
  showToast = () => {},
} = {}) {
  if (!apiClient?.get || !apiClient?.post) throw new TypeError('presence ambient setting requires an api client');
  const $ = selector => documentLike?.querySelector?.(selector) || null;
  let confirmed = null;
  let saving = null; // 正在保存的开关 key
  const notes = new Map();

  function defaultNote(item) {
    if (!confirmed) return '';
    if (!confirmed.available) return NOTE_LOCKED;
    return confirmed[item.key] ? item.on : item.off;
  }

  function render() {
    for (const item of SWITCHES) {
      const input = $(item.toggle);
      const status = $(item.note);
      if (input) {
        input.checked = confirmed?.[item.key] === true;
        input.disabled = !confirmed || confirmed.available === false;
        input.setAttribute?.('aria-busy', saving === item.key ? 'true' : 'false');
      }
      if (status) status.textContent = notes.get(item.key) || defaultNote(item);
    }
  }

  async function refresh() {
    if (saving) return confirmed;
    try {
      confirmed = normalize(await apiClient.get(ENDPOINT));
      notes.clear();
    } catch {
      if (!confirmed) for (const item of SWITCHES) notes.set(item.key, NOTE_LOAD_FAILED);
    }
    render();
    return confirmed;
  }

  async function setSwitch(key, next) {
    const item = SWITCHES.find(entry => entry.key === key);
    if (!item || saving || !confirmed || !confirmed.available) {
      render();
      return confirmed;
    }
    const previous = confirmed[key];
    saving = key;
    notes.set(key, NOTE_SAVING);
    render();
    try {
      const result = await apiClient.post(ENDPOINT, { [key]: next === true });
      if (result?.ok === false) throw new Error('write rejected');
      confirmed = normalize(result);
      notes.delete(key);
      notes.set(key, `已保存。${defaultNote(item)}`);
      showToast('success', '陪伴设置已保存', item.key === 'ambientEnabled'
        ? (next === true ? '一起听歌时伙伴可能会主动接一两句。' : '一起听歌时不再主动说话；普通聊天不受影响。')
        : (next === true ? '打开 app 时伙伴可以打招呼。' : '打开 app 时伙伴不会先开口。'), { curated: true });
    } catch {
      notes.set(key, failedNote(previous));
    } finally {
      saving = null;
      render();
    }
    return confirmed;
  }

  for (const item of SWITCHES) {
    const input = $(item.toggle);
    input?.addEventListener?.('change', () => { void setSwitch(item.key, input.checked === true); });
  }
  render();
  return Object.freeze({
    refresh,
    setEnabled: next => setSwitch('ambientEnabled', next),
    setGreetingEnabled: next => setSwitch('greetingEnabled', next),
  });
}

export default createPresenceAmbientSetting;
