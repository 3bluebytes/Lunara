// radiohostView.js — 「认识一位新伙伴」面板。
//
// 两个正交维度（见 change keyless-voice-and-persona 的 D13–D15）：
//   - **性格**：来自预令人设，决定它是谁；自带名字候选。
//   - **声音**：决定它怎么念；不参与人格，也不推导名字。
//
// 旧实现是语音优先的：先选声音，再从音色的 displayName / styleTags 反推名字与人格。
// 那条路径在本地音色上会崩——`zf_002` 没有语义标签，只能从编号瞎猜——而且
// 把人设绑死在音色上，使「同一性格换一把声音」变成「换一个人」。现在两者可任意组合。

import { escapeHtml } from '../chat/chatMarkup.js';

const MAX_RADIOHOST_NAME_LENGTH = 80;
const MAX_RADIOHOST_PERSONA_LENGTH = 1000;

function pick(values, random) {
  if (!Array.isArray(values) || values.length === 0) return '';
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

/**
 * 从人设的名字候选中挑一个。
 *
 * 名字只来自人设——音色不再参与命名。这是与 `suggestRadiohostName(voice)` 的契约差别：
 * 后者会按音色的性别选名、按音色名反推人名，在无标签音色上退化成通用名。
 */
export function suggestNameFromPreset(preset, random = Math.random) {
  const candidates = Array.isArray(preset?.nameCandidates) ? preset.nameCandidates : [];
  return pick(candidates, random) || String(preset?.displayName || '').trim();
}

function voiceHue(id) {
  if (!id) return 22;
  return (id.charCodeAt(0) * 37 + (id.charCodeAt(1) || 0) * 73) % 360;
}

function personName(person) {
  return String(person?.displayName || person?.name || person?.id || '—');
}

function validateText(value, label, maxLength, { allowMultiline = false, required = true } = {}) {
  let text = String(value ?? '').trim();
  if (allowMultiline) text = text.replace(/\r\n?/g, '\n');
  if (!text) {
    return required ? { value: text, error: `请填写${label}。` } : { value: '', error: null };
  }
  if (text.length > maxLength) return { value: text, error: `${label}不能超过 ${maxLength} 个字符。` };
  const controls = allowMultiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (controls.test(text)) return { value: text, error: `${label}中不能包含控制字符。` };
  return { value: text, error: null };
}

/**
 * 校验创建草稿。
 *
 * 两个维度都必须选定；补充说明**可选**（性格本身已经是完整人格，不再是必填的空白文本框）。
 * 缺少任一维度时阻止保存并指明缺什么，而不是用默认值静默补齐。
 */
export function validateRadiohostDraft({ displayName, personaHint, voiceProfile, personaPreset } = {}) {
  if (!String(personaPreset?.id || '').trim()) return { valid: false, error: '请选择一个性格。' };
  if (!String(voiceProfile?.id || '').trim()) return { valid: false, error: '请选择一把声音。' };
  const name = validateText(displayName, '名字', MAX_RADIOHOST_NAME_LENGTH);
  if (name.error) return { valid: false, error: name.error };
  const persona = validateText(personaHint, '补充说明', MAX_RADIOHOST_PERSONA_LENGTH,
    { allowMultiline: true, required: false });
  if (persona.error) return { valid: false, error: persona.error };
  return { valid: true, displayName: name.value, personaHint: persona.value };
}

export function createRadiohostView({
  controller,
  store,
  documentLike = globalThis.document,
  onToast = () => {},
  onRenderMeta = () => {},
  onLoaded = () => {},
  onStationMemoryEvent = () => {},
  onCreateChat = () => {},
  onListenWith = () => {},
  autoLoad = true,
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancelSchedule = globalThis.clearTimeout?.bind(globalThis),
  random = Math.random,
  previewText = '接下来是陈奕迅的《富士山下》。深夜听这首歌，可以留意副歌之前那段压着的情绪。',
} = {}) {
  if (!controller || !store) throw new TypeError('radiohost view dependencies are required');
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let initialized = false;
  let loadTimer = null;
  let selectedVoice = null;
  let selectedPreset = null;
  let presets = [];
  let creating = false;
  let createdPerson = null;
  let previewUrl = null;

  const snapshot = () => controller.getSnapshot();

  function listen(element, type, listener) {
    element?.addEventListener?.(type, listener);
    if (element) cleanups.push(() => element.removeEventListener?.(type, listener));
  }

  function render() { onRenderMeta(); }

  async function load() {
    try { await controller.load(); render(); await onLoaded(snapshot()); return true; }
    catch (error) { onToast('error', '伙伴加载失败', error.message); return false; }
  }

  function resetCastInputs() {
    selectedVoice = null;
    selectedPreset = null;
    for (const selector of ['#cast-persona', '#cast-name']) {
      const input = $(selector);
      if (!input) continue;
      input.value = '';
      delete input.dataset.userEdited;
    }
    previewUrl = null;
    const audio = $('#cast-preview-audio');
    if (audio) { audio.hidden = true; audio.removeAttribute?.('src'); }
    const go = $('#cast-go');
    if (go) go.disabled = true;
    const preview = $('#cast-preview');
    if (preview) preview.disabled = true;
  }

  function renderPersonas() {
    const grid = $('#cast-persona-grid');
    if (!grid) return;
    const count = $('#cast-persona-count');
    if (count) count.textContent = String(presets.length);
    grid.innerHTML = presets.map(preset => `
      <button type="button" class="cast-persona" data-preset-id="${escapeHtml(preset.id)}" aria-pressed="false">
        <span class="cast-persona-name">${escapeHtml(preset.displayName)}</span>
        <span class="cast-persona-summary">${escapeHtml(preset.summary || '')}</span>
      </button>`).join('') || '<div class="cast-voice-loading">暂时没有可选的人设。</div>';
    grid.querySelectorAll?.('[data-preset-id]')?.forEach(element => {
      element.addEventListener?.('click', () => {
        if (creating) return;
        grid.querySelectorAll?.('.cast-persona')?.forEach(button => {
          button.classList.remove('selected');
          button.setAttribute?.('aria-pressed', 'false');
        });
        element.classList.add('selected');
        element.setAttribute?.('aria-pressed', 'true');
        selectedPreset = presets.find(preset => preset.id === element.dataset.presetId) || null;
        applyPreset(selectedPreset);
        validateCast();
      });
    });
  }

  /**
   * 选定性格时给出名字候选。
   *
   * 只在用户没有亲手改过名字时填入——选择声音不再触发这件事，
   * 因此不会再出现「换个声音，名字被改掉」。
   */
  function applyPreset(preset) {
    if (!preset) return;
    const name = $('#cast-name');
    if (name && !name.dataset.userEdited) name.value = suggestNameFromPreset(preset, random);
    const hint = $('#cast-name-hint');
    if (hint) {
      const candidates = (preset.nameCandidates || []).join('、');
      hint.textContent = candidates ? `必填 · 候选：${candidates}` : '必填 · 最多 80 字';
    }
  }

  function renderVoices() {
    const grid = $('#cast-voice-grid');
    if (!grid) return;
    const voices = snapshot().voices;
    const count = $('#cast-voice-count');
    if (count) count.textContent = String(voices.length);
    if (!voices.length) {
      grid.innerHTML = '<div class="cast-voice-loading">还没有可选声音：先到「设置 → 声音」配置自定义 TTS 接口，试听并保留至少一把声音。</div>';
      return;
    }
    grid.innerHTML = voices.map(voice => {
      // 不可用标注：该声音的来源已失效（例如系统语音已关闭）。不标注就会让人以为还能用。
      const fallback = voice.unavailable
        ? '<span class="cast-tag tag-fallback">当前不可用</span>'
        : voice.isFallback ? '<span class="cast-tag tag-fallback">音色已变化</span>' : '';
      // 来源标签：自定义接口 / 本地系统。
      const sourceTag = voice.sourceLabel
        ? `<span class="cast-tag tag-source">${escapeHtml(voice.sourceLabel)}</span>` : '';
      const tags = (voice.styleTags || []).map(tag => `<span class="cast-tag tag-${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join('');
      return `<button type="button" class="cast-voice" data-vp-id="${escapeHtml(voice.id)}" aria-pressed="false"${voice.unavailable ? ' disabled' : ''}>
        <div class="radiohost-avatar" style="--radiohost-hue:${voiceHue(voice.id)}"><span class="radiohost-avatar-letter">${escapeHtml((voice.displayName || '?')[0].toUpperCase())}</span></div>
        <div class="cast-voice-meta">
          <span class="cast-voice-name">${escapeHtml(voice.displayName)}</span>
          <span class="cast-voice-desc">${escapeHtml(voice.description || '')}</span>
          ${fallback || sourceTag || tags ? `<div class="cast-voice-tags">${sourceTag}${fallback}${tags}</div>` : ''}
        </div>
      </button>`;
    }).join('');
    grid.querySelectorAll?.('[data-vp-id]')?.forEach(element => {
      element.addEventListener?.('click', () => {
        if (creating) return;
        grid.querySelectorAll?.('.cast-voice')?.forEach(button => {
          button.classList.remove('selected');
          button.setAttribute?.('aria-pressed', 'false');
        });
        element.classList.add('selected');
        element.setAttribute?.('aria-pressed', 'true');
        selectedVoice = voices.find(voice => voice.id === element.dataset.vpId) || null;
        // 刻意不填名字或人格：声音只决定怎么念。
        previewUrl = null;
        const audio = $('#cast-preview-audio');
        if (audio) { audio.hidden = true; audio.removeAttribute?.('src'); }
        validateCast();
      });
    });
  }

  function validateCast() {
    const go = $('#cast-go');
    const draft = validateRadiohostDraft({
      voiceProfile: selectedVoice,
      personaPreset: selectedPreset,
      displayName: $('#cast-name')?.value,
      personaHint: $('#cast-persona')?.value,
    });
    if (go) go.disabled = creating || !draft.valid;
    const preview = $('#cast-preview');
    if (preview) preview.disabled = creating || !selectedVoice;
    const message = $('#cast-msg');
    if (message && !creating) {
      // 不可用时写明原因，而不是只报名字让人以为还能用。
      const fallbackNote = selectedVoice?.unavailable ? '（当前不可用，请重新选择）'
        : selectedVoice?.isFallback ? '（音色已变化）' : '';
      message.textContent = draft.valid
        ? `已选：${selectedPreset.displayName} · ${selectedVoice.displayName}${fallbackNote}`
        : draft.error;
    }
    return draft;
  }

  async function openCast() {
    if (creating) return;
    const overlay = $('#cast-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.setAttribute?.('aria-hidden', 'false');
    const message = $('#cast-msg');
    if (message) message.textContent = '';
    resetCastInputs();
    const personaGrid = $('#cast-persona-grid');
    if (personaGrid) personaGrid.innerHTML = '<div class="cast-voice-loading">读取人设…</div>';
    const voiceGrid = $('#cast-voice-grid');
    if (voiceGrid) voiceGrid.innerHTML = '<div class="cast-voice-loading">读取声音库…</div>';
    // 两个维度各自独立加载：任何一个失败都不应让另一个不可用。
    const [personaResult, voiceResult] = await Promise.allSettled([
      controller.loadPersonaPresets(),
      controller.loadVoices(),
    ]);
    presets = personaResult.status === 'fulfilled' ? personaResult.value : [];
    if (personaResult.status === 'rejected') {
      if (personaGrid) personaGrid.innerHTML = `<div class="cast-voice-loading">人设加载失败：${escapeHtml(personaResult.reason?.message || '未知错误')}</div>`;
    } else {
      renderPersonas();
    }
    if (voiceResult.status === 'rejected') {
      if (voiceGrid) voiceGrid.innerHTML = `<div class="cast-voice-loading">声音加载失败：${escapeHtml(voiceResult.reason?.message || '未知错误')}</div>`;
    } else {
      renderVoices();
    }
  }

  function closeCast(force = false) {
    if (creating && !force) return;
    const overlay = $('#cast-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.setAttribute?.('aria-hidden', 'true');
    }
    const go = $('#cast-go');
    if (go) {
      go.disabled = true;
      go.textContent = '保存伙伴';
      go.classList?.remove?.('casting');
    }
    resetCastInputs();
  }

  /** 试听走真实的 provider 合成路径，因此与实际串词一致。 */
  async function previewVoice() {
    if (!selectedVoice) return;
    const button = $('#cast-preview');
    const message = $('#cast-msg');
    const audio = $('#cast-preview-audio');
    if (button) button.disabled = true;
    if (message) message.textContent = '正在合成试听…';
    try {
      const result = await controller.previewVoice(selectedVoice.id, previewText);
      if (result?.ok === false) throw new Error(result.error || '试听失败');

      if (!result?.url) throw new Error('试听没有返回音频');
      previewUrl = result.url;
      if (audio) {
        audio.src = result.url;
        audio.hidden = false;
        // 播放失败（例如浏览器策略）不应被当成合成失败。
        try { await audio.play?.(); } catch { /* 用户可手动点播放 */ }
      }
      if (message) message.textContent = `试听：${selectedVoice.displayName}`;
    } catch (error) {
      if (message) message.textContent = `试听失败：${error.message}`;
      onToast('error', '试听失败', error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openCreatedPerson(person) {
    createdPerson = person || null;
    const name = $('#radiohost-created-name');
    if (name) name.textContent = personName(createdPerson);
    const dialog = $('#radiohost-created-dialog');
    if (dialog?.showModal) dialog.showModal();
    else if (dialog) dialog.open = true;
    $('#radiohost-created-chat')?.focus?.();
  }

  function closeCreatedPerson() {
    const dialog = $('#radiohost-created-dialog');
    if (dialog?.close) dialog.close();
    else if (dialog) dialog.open = false;
    createdPerson = null;
    $('#nav-create')?.focus?.();
  }

  async function runFollowup(callback) {
    if (!createdPerson || typeof callback !== 'function') return;
    const person = createdPerson;
    closeCreatedPerson();
    try { await callback(person); }
    catch (error) { onToast('error', '暂时无法继续', error.message); }
  }

  async function createSelectedRadiohost() {
    if (creating) return false;
    const draft = validateCast();
    if (!draft.valid) {
      const message = $('#cast-msg');
      if (message) message.textContent = draft.error;
      return false;
    }
    creating = true;
    const button = $('#cast-go');
    const fields = [$('#cast-name'), $('#cast-persona'), $('#cast-close')];
    if (button) { button.disabled = true; button.classList?.add?.('casting'); button.textContent = '创建中…'; }
    fields.forEach(field => { if (field) field.disabled = true; });
    const message = $('#cast-msg');
    if (message) message.textContent = '正在保存伙伴…';
    let failed = false;
    try {
      const result = await controller.createRadiohost({
        voiceProfileId: selectedVoice.id,
        personaPresetId: selectedPreset.id,
        personaHint: draft.personaHint,
        displayName: draft.displayName,
      });
      closeCast(true);
      render();
      openCreatedPerson(result.person);
      onToast('success', '已保存这位伙伴', `${personName(result.person)} 已创建；当前聊天和播放没有改变。`);
      return true;
    } catch (error) {
      failed = true;
      onToast('error', '创建失败', error.message);
      if (message) message.textContent = error.message;
      return false;
    } finally {
      creating = false;
      if (button) {
        button.classList?.remove?.('casting');
        button.textContent = '保存伙伴';
      }
      fields.forEach(field => { if (field) field.disabled = false; });
      if ($('#cast-overlay')?.style?.display !== 'none') {
        const currentDraft = validateRadiohostDraft({
          voiceProfile: selectedVoice,
          personaPreset: selectedPreset,
          displayName: $('#cast-name')?.value,
          personaHint: $('#cast-persona')?.value,
        });
        if (button) button.disabled = !currentDraft.valid;
        if (!failed) validateCast();
      }
    }
  }

  async function refresh() {
    try {
      await controller.load();
      render();
    } catch {}
  }

  function handleServerEvent(message) {
    if (message.type === 'RADIOHOST_CREATED') {
      onToast('info', '新伙伴上线', '一位伙伴加入了电台');
      void refresh();
    } else if (message.type === 'RADIOHOST_ACTIVATED') {
      void refresh();
    } else if (message.type === 'STATION_MEMORY_UPDATED') {
      onStationMemoryEvent(message);
    }
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    listen($('#radiohost-cast-new'), 'click', openCast);
    // 人物列表标题旁的「+」是新增伙伴的常驻入口；与创建器里的同一动作共用一个打开函数。
    listen($('#people-list-create'), 'click', openCast);
    listen($('#cast-name'), 'input', event => { event.currentTarget.dataset.userEdited = '1'; validateCast(); });
    listen($('#cast-persona'), 'input', event => { event.currentTarget.dataset.userEdited = '1'; validateCast(); });
    listen($('#cast-form'), 'submit', event => { event.preventDefault(); return createSelectedRadiohost(); });
    listen($('#cast-preview'), 'click', () => previewVoice());
    listen($('#cast-close'), 'click', closeCast);
    listen($('#cast-overlay'), 'click', event => {
      if (event.target === event.currentTarget) closeCast();
    });
    listen($('#radiohost-created-chat'), 'click', () => runFollowup(onCreateChat));
    listen($('#radiohost-created-listen'), 'click', () => runFollowup(onListenWith));
    listen($('#radiohost-created-done'), 'click', closeCreatedPerson);
    listen($('#radiohost-created-dialog'), 'cancel', event => {
      event.preventDefault();
      closeCreatedPerson();
    });
    if (autoLoad) {
      loadTimer = schedule?.(() => {
        loadTimer = null;
        void load();
      }, 300) ?? null;
    }
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    if (loadTimer != null) cancelSchedule?.(loadTimer);
    loadTimer = null;
    cleanups.splice(0).forEach(cleanup => cleanup());
  }

  const api = Object.freeze({
    init,
    destroy,
    load,
    refresh,
    render,
    openCast,
    closeCast,
    validateCast,
    createSelectedRadiohost,
    closeCreatedPerson,
    handleServerEvent,
    previewVoice,
    getSelection: () => ({ preset: selectedPreset, voice: selectedVoice }),
  });
  return api;
}