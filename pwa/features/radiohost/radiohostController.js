import { countUsableVoices } from '../../core/usableVoice.js';

const ROOT_VIRTUAL_PERSON_ID = 'lunara';
export const NO_USABLE_VOICE = 'NO_USABLE_VOICE';

function styleTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') return value.split(',').map(tag => tag.trim()).filter(Boolean);
  return [];
}

export function normalizeVoiceProfiles(voices) {
  if (!Array.isArray(voices)) return [];
  return voices.map(voice => ({
    id: String(voice?.id || voice?.voiceProfileId || voice?.voice_id || '').trim(),
    displayName: String(voice?.displayName || voice?.name || voice?.id || voice?.voice_id || '').trim(),
    description: String(voice?.description || voice?.desc || '').trim(),
    styleTags: styleTags(voice?.styleTags ?? voice?.tags),
    source: String(voice?.source || voice?.provider || 'unknown'),
    sourceProvider: String(voice?.sourceProvider || ''),
    resolvedProviderId: voice?.resolvedProviderId ?? null,
    endpointId: String(voice?.endpointId || ''),
    // 原生 provider 不可用时，这个名字实际对应本地回落声音——界面必须如实标注，
    // 否则用户以为选的是原生声线（tts-provider spec 的回落告知要求）。
    sourceLabel: String(voice?.sourceLabel || '').trim(),
    isFallback: voice?.isFallback === true,
    unavailable: voice?.unavailable === true,
  })).filter(voice => voice.id && voice.displayName);
}

export function normalizeVirtualPerson(person) {
  if (!person?.id) return null;
  const displayName = String(person.displayName || person.name || person.id).trim();
  return Object.freeze({
    ...person,
    id: String(person.id),
    displayName,
    name: displayName,
    kind: person.kind || (person.id === ROOT_VIRTUAL_PERSON_ID ? 'root' : 'radiohost'),
  });
}

export function createRadiohostController({
  store,
  apiClient,
  sessionId = 'conversation:primary',
  onChanged = () => {},
} = {}) {
  if (!store || typeof store.update !== 'function') throw new TypeError('radiohost store is required');
  if (!apiClient) throw new TypeError('radiohost api client is required');

  const currentSessionId = () => store.getState().sessionId || sessionId;
  let persons = [];
  let voices = [];
  let voiceFallback = null;
  let activatingId = null;

  function activePerson() {
    return store.getState().activeRadiohost || null;
  }

  function snapshot() {
    const activeRadiohost = activePerson();
    return Object.freeze({
      persons: Object.freeze([...persons]),
      // Temporary alias for older view/settings consumers during the PWA cutover.
      radiohosts: Object.freeze([...persons]),
      voices: Object.freeze([...voices]),
      activeRadiohost,
      currentRadiohostId: activeRadiohost?.id || null,
      sessionId: currentSessionId(),
      activatingId,
    });
  }

  function emit() {
    const next = snapshot();
    onChanged(next);
    return next;
  }

  function personById(id) {
    return persons.find(person => person.id === id) || null;
  }

  async function load() {
    const loadingSession = currentSessionId();
    const result = await apiClient.get(`/api/virtual-persons?sessionId=${encodeURIComponent(currentSessionId())}`);
    if (result?.ok === false) throw new Error(result.error || '虚拟人列表加载失败');
    persons = (Array.isArray(result?.persons) ? result.persons : [])
      .map(normalizeVirtualPerson)
      .filter(Boolean);
    const activeId = result?.session?.activeVirtualPersonId || ROOT_VIRTUAL_PERSON_ID;
    const activeRadiohost = personById(activeId) || personById(ROOT_VIRTUAL_PERSON_ID) || persons[0] || null;
    store.update({
      ...(currentSessionId() === loadingSession ? { activeRadiohost } : {}),
      virtualPersons: persons,
    }, { type: 'virtual-persons.loaded' });
    return emit();
  }

  async function activate(id) {
    const targetId = String(id || '').trim();
    if (!targetId) throw new Error('缺少虚拟人 id');
    if (activatingId) return { accepted: false, activeRadiohost: activePerson(), switched: false };
    const previousId = activePerson()?.id || null;
    const activatingSession = currentSessionId();
    if (previousId === targetId) return { accepted: true, activeRadiohost: activePerson(), switched: false };

    activatingId = targetId;
    emit();
    try {
      const result = await apiClient.post(
        `/api/virtual-persons/${encodeURIComponent(targetId)}/activate`,
        { sessionId: activatingSession },
      );
      if (result?.ok === false) throw new Error(result.error || '切换失败');
      const activeRadiohost = normalizeVirtualPerson(result?.entity || personById(targetId));
      if (!activeRadiohost) throw new Error('服务端没有返回当前虚拟人');
      if (currentSessionId() === activatingSession) store.update({ activeRadiohost }, { type: 'virtual-person.activated' });
      return { accepted: true, activeRadiohost, switched: previousId !== activeRadiohost.id };
    } finally {
      activatingId = null;
      emit();
    }
  }

  async function readVoiceFallback() {
    try {
      const custom = await apiClient.get('/api/tts/custom');
      return custom?.config?.fallback ?? null;
    } catch {
      return null;
    }
  }

  async function loadVoices() {
    const result = await apiClient.get('/api/station/voices');
    if (result?.ok === false) throw new Error(result.error || '声音模型加载失败');
    voices = normalizeVoiceProfiles(result?.voices);
    voiceFallback = await readVoiceFallback();
    if (countUsableVoices(voices, voiceFallback) === 0) {
      emit();
      const error = new Error('还没有可选声音：先到「设置 → 声音」配置自定义 TTS 接口，试听并保留至少一把声音。');
      error.code = NO_USABLE_VOICE;
      throw error;
    }
    emit();
    return [...voices];
  }

  /**
   * 加载可选性格模板。
   *
   * 模板只是起草灵感：列表为空或请求失败都不阻塞手写自定义性格。
   */
  async function loadPersonaPresets() {
    const result = await apiClient.get('/api/persona-presets');
    if (result?.ok === false) throw new Error(result.error || '性格模板加载失败');
    const list = Array.isArray(result?.presets) ? result.presets : [];
    return list.map(preset => Object.freeze({
      id: String(preset.id),
      displayName: String(preset.displayName || preset.id),
      summary: String(preset.summary || ''),
      character: String(preset.character || ''),
      templateText: String(preset.templateText || preset.character || preset.summary || ''),
      defaultTemperament: String(preset.defaultTemperament || 'balanced'),
      nameCandidates: Array.isArray(preset.nameCandidates) ? preset.nameCandidates.map(String) : [],
    }));
  }

  /** 单次请求全局默认模型扩写当前性格草稿；失败原样抛出，由视图保留用户草稿。 */
  async function expandPersonaDraft({ draft = '', displayName = '', presetId = null } = {}) {
    const result = await apiClient.post('/api/persona-presets/expand', {
      draft: String(draft ?? ''),
      displayName: String(displayName ?? '').trim(),
      ...(presetId ? { presetId: String(presetId).trim() } : {}),
    });
    if (result?.ok === false) throw new Error(result.error || '扩写失败');
    return result;
  }

  /** 试听：后端走真实合成路径，因此与实际串词一致。 */
  async function previewVoice(voiceProfileId, text = null) {
    const result = await apiClient.post('/api/tts/preview', {
      voiceProfileId: String(voiceProfileId || '').trim(),
      ...(text ? { text } : {}),
    });
    if (result?.ok === false) throw new Error(result.error || '试听失败');
    return result;
  }

  async function createRadiohost(input) {
    const result = await apiClient.post('/api/virtual-persons', input);
    if (result?.ok === false) throw new Error(result.error || '创建失败');
    await load();
    return { ...result, person: normalizeVirtualPerson(result?.person) };
  }

  async function archivePerson(id) {
    const targetId = String(id || '').trim();
    if (!targetId) throw new Error('缺少虚拟人 id');
    if (targetId === ROOT_VIRTUAL_PERSON_ID) throw new Error('Lunara 主虚拟人不能归档');
    const result = await apiClient.post(`/api/virtual-persons/${encodeURIComponent(targetId)}/archive`, {});
    if (result?.ok === false) throw new Error(result.error || '归档失败');
    await load();
    return result;
  }

  return Object.freeze({
    load,
    activate,
    loadVoices,
    getVoiceFallback: () => voiceFallback,
    loadPersonaPresets,
    expandPersonaDraft,
    previewVoice,
    createRadiohost,
    archivePerson,
    deleteRadiohost: archivePerson,
    getSnapshot: snapshot,
  });
}

export { ROOT_VIRTUAL_PERSON_ID };
