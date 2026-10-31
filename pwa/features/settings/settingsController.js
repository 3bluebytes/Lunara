export function validateEndpointSelection({ baseUrl, model, apiKey, apiKeySet = false } = {}) {
  const missing = [];
  if (!String(baseUrl || '').trim()) missing.push('baseUrl');
  if (!String(model || '').trim()) missing.push('model');
  if (!String(apiKey || '').trim() && !apiKeySet) missing.push('apiKey');
  return { ready: missing.length === 0, missing };
}

export function createSettingsController({ apiClient, onChanged = () => {} } = {}) {
  if (!apiClient) throw new TypeError('settings api client is required');
  let snapshot = { current: {}, options: { source: [], tts: [] } };
  const listeners = new Set([onChanged]);

  function setSnapshot(value) {
    snapshot = {
      current: value?.current || {},
      options: {
        source: Array.isArray(value?.options?.source) ? value.options.source : [],
        tts: Array.isArray(value?.options?.tts) ? value.options.tts : [],
        ttsProviders: Array.isArray(value?.options?.ttsProviders) ? value.options.ttsProviders : [],
      },
    };
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  async function load() {
    const result = await apiClient.get('/api/settings');
    if (result?.ok === false) throw new Error(result.error || '设置加载失败');
    return setSnapshot(result);
  }

  async function save(input = {}) {
    const payload = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      source: input.source,
      primarySource: input.primarySource,
      ...(input.playbackSourceMode ? { playbackSourceMode: input.playbackSourceMode } : {}),
      // 推荐来源配額：只由设置页的滑块写入，服务端按可播源归一。
      ...(input.recommendationWeights ? { recommendationWeights: input.recommendationWeights } : {}),
      // 不传 voice：设置页没有全局声音控件（遗留默认音色无消费者），
      // 实际声线由每个伙伴的 voiceProfileId 决定。
    };
    const result = await apiClient.post('/api/settings', payload);
    if (result?.ok === false) throw new Error(result.error || '设置保存失败');
    snapshot = { ...snapshot, current: result.current || snapshot.current };
    for (const listener of listeners) listener(snapshot);
    return result;
  }

  /** 声音 provider 的就绪状态。 */
  async function loadTtsStatus() {
    const result = await apiClient.get('/api/tts/status');
    if (result?.ok === false) throw new Error(result.error || '声音服务状态加载失败');
    return { providers: result?.providers || [] };
  }

  /** 设置所在城市：服务端解析为坐标后只存本地，成功返回解析出的完整地名。 */
  async function setLocation(city) {
    const result = await apiClient.post('/api/settings/location', { city });
    if (result?.ok === false) throw new Error(result.error || '位置保存失败');
    const current = { ...snapshot.current, location: result?.location || null };
    snapshot = { ...snapshot, current };
    for (const listener of listeners) listener(snapshot);
    return result;
  }

  /** 清除位置：伙伴不再感知天气，界面隐藏天气角标。 */
  async function clearLocation() {
    const result = await apiClient.delete('/api/settings/location');
    if (result?.ok === false) throw new Error(result.error || '位置清除失败');
    const current = { ...snapshot.current, location: null };
    snapshot = { ...snapshot, current };
    for (const listener of listeners) listener(snapshot);
    return result;
  }

  /** 重新自动定位：解除手动固定并按出口 IP 重测。 */
  async function redetectLocation() {
    const result = await apiClient.post('/api/settings/location/auto');
    if (result?.ok === false) throw new Error(result.error || '自动定位失败');
    const current = { ...snapshot.current, location: result?.location || null };
    snapshot = { ...snapshot, current };
    for (const listener of listeners) listener(snapshot);
    return result;
  }

  /** 自定义声音配置：多个接口 + 统一声音池；发现、试听、删除都按接口 id。 */
  async function loadCustomTtsConfig() {
    const result = await apiClient.get('/api/tts/custom');
    onChanged();
    return result?.config || null;
  }
  async function saveCustomTtsConfig(payload) {
    const result = await apiClient.post('/api/tts/custom', payload);
    onChanged();
    return result?.config || null;
  }
  async function removeCustomTtsEndpoint(endpointId) {
    const result = await apiClient.post('/api/tts/custom/remove-endpoint', { endpointId });
    onChanged();
    return result?.config || null;
  }
  async function discoverCustomModels(endpointId) {
    const result = await apiClient.post('/api/tts/custom/discover-models', { endpointId });
    return result?.models || [];
  }
  async function discoverCustomVoices(endpointId) {
    const result = await apiClient.post('/api/tts/custom/discover-voices', { endpointId });
    return result?.voices || [];
  }
  /** 某个接口最近的发声失败（本地记录：原因、卡住的阶段与分段耗时）。 */
  async function loadTtsFailures(endpointId) {
    const result = await apiClient.get(`/api/tts/failures?endpointId=${encodeURIComponent(endpointId)}&limit=10`);
    return result?.failures || [];
  }
  /** 免费声音开关与代读设置；从关到开必须带 consent:true。返回完整的自定义声音配置视图。 */
  async function saveTtsFallback(patch) {
    const result = await apiClient.post('/api/tts/fallback', patch);
    onChanged();
    return result?.config || null;
  }
  /** 待选声音试听：服务端按 (接口, voice[, model]) 直接合成；失败时 apiClient 抛出带原因的错误。 */
  async function previewCustomVoice({ endpointId, voiceId, model } = {}) {
    const result = await apiClient.post('/api/tts/custom/preview', { endpointId, voiceId, ...(model ? { model } : {}) });
    return result || {};
  }

  // ---- 配方接口：预设、读文档（只调模型）、试合成（一次厂商请求）；没通过都折成带脱敏原因的结果，不抛错 ----
  async function loadRecipePresets() {
    const result = await apiClient.get('/api/tts/custom/recipe-presets');
    return Array.isArray(result?.presets) ? result.presets : [];
  }
  /** 试合成没通过时服务端回 400 + 脱敏摘要：折成 { passed:false, error, summary }，界面照常显示原因。 */
  async function testRecipe(payload) {
    try {
      const result = await apiClient.post('/api/tts/custom/recipe-test', payload);
      return { passed: true, ...(result || {}) };
    } catch (error) {
      if (!error?.body?.summary) throw error;
      return { passed: false, error: error.message, summary: error.body.summary, ...(error.body.stage ? { stage: error.body.stage } : {}) };
    }
  }
  /** 读文档只调模型：没写出合法配方时服务端仍回 ok（drafted:false + 原因），只有输入不合法才抛错。 */
  async function draftRecipe(payload) {
    return (await apiClient.post('/api/tts/custom/recipe-draft', payload)) || {};
  }

  // ---- 声音设计（breeze/minimax）：生成与转正会扣厂商额度，失败由 apiClient 抛出带原因的错误 ----
  async function listPersons() {
    const result = await apiClient.get('/api/virtual-persons');
    return (Array.isArray(result?.persons) ? result.persons : []).map(person => ({ id: person.id, displayName: person.displayName }));
  }
  async function draftVoiceDescription(personId) {
    const result = await apiClient.post('/api/tts/custom/design-draft', { personId });
    return { description: result?.description || '' };
  }
  async function designCustomVoices({ endpointId, description, previewText, count } = {}) {
    const result = await apiClient.post('/api/tts/custom/design', { endpointId, description, previewText, count });
    return { candidates: Array.isArray(result?.candidates) ? result.candidates : [] };
  }
  async function activateDesignedVoice({ endpointId, generatedId, name, description, model } = {}) {
    const result = await apiClient.post('/api/tts/custom/design-activate', { endpointId, generatedId, name, description, model });
    if (!result?.voiceId) throw new Error('转正没有返回 voice id');
    return { voiceId: result.voiceId };
  }

  // ---- 歌曲打标：端点配置（key 只写不读）+ 覆盖率状态 + 有界手动补全 ----
  async function loadSongTagConfig() {
    const result = await apiClient.get('/api/songtags/config');
    onChanged();
    return result?.config || null;
  }
  async function saveSongTagConfig(payload) {
    const result = await apiClient.put('/api/songtags/config', payload);
    onChanged();
    return result?.config || null;
  }
  async function loadSongTagStatus() {
    const result = await apiClient.get('/api/songtags/status');
    return result || null;
  }
  async function runSongTagBackfill(input = {}) {
    const result = await apiClient.post('/api/songtags/backfill', input);
    if (result?.ok === false) throw new Error(result.error || '补全启动失败');
    return result;
  }

  const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return Object.freeze({ load, save, loadTtsStatus, loadCustomTtsConfig, saveCustomTtsConfig, removeCustomTtsEndpoint, discoverCustomModels, discoverCustomVoices, loadTtsFailures, previewCustomVoice, saveTtsFallback, loadRecipePresets, testRecipe, draftRecipe, listPersons, draftVoiceDescription, designCustomVoices, activateDesignedVoice, setLocation, clearLocation, redetectLocation, loadSongTagConfig, saveSongTagConfig, loadSongTagStatus, runSongTagBackfill, subscribe, getSnapshot: () => snapshot });
}
