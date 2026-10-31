// 配方接口向导：协议选择器里的「千问 / 豆包」预设和「其他（让助手接入）」。
//
// 调用顺序（design D9）：
//   选协议（或粘贴地址按域名预选）
//     → 预设：直接载入随软件发布的配方
//     → 其他：「读文档」POST /api/tts/custom/recipe-draft（只调模型，不发厂商请求、不需要 Key）
//   → 接口格式卡片：从配方结构确定性生成，逐项标出「已确定 / 需要填 / 配方错误」
//   → 补齐 Key、model、音色后「试合成」POST /api/tts/custom/recipe-test（一次厂商请求，固定试听句）
//     → 失败：显示脱敏原因；「其他」可以点「让助手按失败原因修订」（再调一次模型，回到卡片）
//     → 通过：显示试听；用户听过后点接口表单里的「保存接口」（服务端再核一次「刚通过」）
//   → 保存后用表单上的「获取声音列表」进发现结果，或手动填音色，再保存声音池。
//
// Python 伪代码：
//   recipe = preset.recipe if preset else draft(doc)             # 不花厂商请求
//   card = describe_recipe(recipe, form)                          # 缺什么一目了然
//   if not card.missing: result = test(recipe)                    # 用户点击才发
//   if result.passed and user_clicks_save: save(endpoint, recipe)
//
// 只读写自定义接口的配置视图，不碰播放状态；每个会发请求的动作都由点击触发，不自动重试或修订。

export const RECIPE_PROTOCOL = 'recipe';
const CHOICE_SEP = ':';
const PLACEHOLDER = /\{(text|voice|model|apiKey)\}/g;

/** 协议选择器的值 → { protocol, presetId }。`recipe:qwen-tts` 是预设，`recipe` 是「其他」。 */
export function parseProtocolChoice(value) {
  const [protocol, presetId = ''] = String(value || '').split(CHOICE_SEP);
  return { protocol, presetId: protocol === RECIPE_PROTOCOL ? presetId : '' };
}

/** 已保存的接口 → 选择器的值。 */
export function protocolChoiceOf(endpoint) {
  if (endpoint?.protocol !== RECIPE_PROTOCOL) return endpoint?.protocol || 'openai';
  return endpoint.presetId ? `${RECIPE_PROTOCOL}${CHOICE_SEP}${endpoint.presetId}` : RECIPE_PROTOCOL;
}

// 粘贴地址时按域名预选；认不出的不动（design D8）。
const DOMAIN_CHOICES = [
  [host => host.includes('minimax'), 'minimax'],
  [host => host === 'breeze.blue' || host.endsWith('.breeze.blue') || host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io'), 'breeze'],
  [host => host === 'dashscope.aliyuncs.com' || host.endsWith('.dashscope.aliyuncs.com'), 'recipe:qwen-tts'],
  [host => host === 'openspeech.bytedance.com', 'recipe:doubao-tts'],
];

export function guessProtocolChoice(url) {
  let host = '';
  try { host = new URL(String(url || '').trim()).hostname.toLowerCase(); } catch { return null; }
  return DOMAIN_CHOICES.find(([match]) => match(host))?.[1] || null;
}

/** 接口地址 + 配方 path → 最终请求地址（与服务端 renderRequest 同一规则；占位符原样显示）。 */
function finalAddress(baseUrl, path) {
  let url;
  try { url = new URL(String(baseUrl || '').trim()); } catch { return ''; }
  const prefix = url.pathname.replace(/\/+$/, '');
  const tail = path === '/' && prefix ? '' : String(path || '');
  return `${url.origin}${prefix}${tail}`;
}

function placeholdersIn(value, found = new Set()) {
  if (typeof value === 'string') for (const [, name] of value.matchAll(PLACEHOLDER)) found.add(name);
  else if (Array.isArray(value)) value.forEach(item => placeholdersIn(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => placeholdersIn(item, found));
  return found;
}

/** body 的叶子 → [['voice_setting.voice_id', '{voice}'], ...]。 */
function leaves(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) leaves(item, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) {
    out.push([prefix, value]);
  }
  return out;
}

const shown = value => (typeof value === 'string' ? value : JSON.stringify(value));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * 配方 → 接口格式卡片。完全由配方结构推出，不采信模型的自述（design D9）。
 *   form: { baseUrl, model, voice, hasKey }
 * 返回 { rows: [{ id, label, value, state: 'ok'|'missing'|'note'|'error' }], missing: [缺项名] }。
 */
export function describeRecipe(recipe, form = {}) {
  const rows = [];
  const missing = [];
  const row = (id, label, value, state = 'ok') => {
    rows.push({ id, label, value, state });
    if (state === 'missing' || state === 'error') missing.push(label);
  };
  const synth = recipe?.synth;
  if (!synth || typeof synth !== 'object' || typeof synth.path !== 'string') {
    row('synth', '请求', '配方里没有合成请求（synth.path）', 'error');
    return { rows, missing };
  }
  const address = finalAddress(form.baseUrl, synth.path);
  row('synth', '请求', address ? `${synth.method || 'POST'} ${address}` : '先在上方填接口 URL', address ? 'ok' : 'missing');

  const keyHeaders = Object.entries(synth.headers || {}).filter(([, value]) => String(value).includes('{apiKey}'));
  if (!keyHeaders.length) row('auth', 'API Key', '配方不发送 Key（确认这家接口真的不需要鉴权）', 'note');
  else {
    const how = keyHeaders.map(([name, value]) => `请求头 ${name}: ${String(value).replaceAll('{apiKey}', '‹你的 Key›')}`).join('；');
    row('auth', 'API Key', form.hasKey ? how : `${how}——在上方填 API Key`, form.hasKey ? 'ok' : 'missing');
  }

  const used = placeholdersIn([synth.path, synth.query, synth.body]);
  if (!used.has('text')) row('text', '要念的文字', '配方没有放入 {text}，合成不出指定的句子', 'error');
  if (used.has('model')) {
    row('model', 'Model', form.model || '配方用到 {model}——在上方填 Model', form.model ? 'ok' : 'missing');
  }
  if (used.has('voice')) {
    row('voice', '音色', form.voice || '配方用到 {voice}——在下方填试合成用的音色', form.voice ? 'ok' : 'missing');
  } else {
    row('voice', '音色', '配方不带音色参数（厂商默认音色）', 'note');
  }
  const params = [
    ...leaves(synth.body).map(([path, value]) => `${path}=${shown(value)}`),
    ...Object.entries(synth.query || {}).map(([key, value]) => `?${key}=${shown(value)}`),
  ];
  if (params.length) row('params', '请求参数', clip(params.join('，'), 240), 'note');

  const audio = recipe.audio || {};
  const audioText = audio.kind === 'binary' ? '响应本身就是音频字节'
    : audio.kind === 'json' ? `JSON 字段 ${audio.audioPath}（${audio.encoding} 编码）`
      : audio.kind === 'url' ? `JSON 字段 ${audio.audioPath} 是音频链接，取到后再下载`
        : '';
  row('audio', '音频返回', audioText || '配方没有说明怎么取音频（audio.kind）', audioText ? 'ok' : 'error');
  row('error', '报错信息', recipe.error?.messagePath ? `JSON 字段 ${recipe.error.messagePath}` : '未声明，失败时显示响应开头', 'note');
  row('voices', '声音列表', recipe.voices?.path
    ? `${recipe.voices.method || 'GET'} ${finalAddress(form.baseUrl, recipe.voices.path) || recipe.voices.path}——保存接口后可「获取声音列表」`
    : '文档里没有声音列表接口——保存接口后手动填音色', 'note');
  return { rows, missing };
}

const ASSISTANT_NOTE = '把这家 TTS 的接口文档链接或正文给助手：读文档只调你配置的模型，不向厂商发请求。'
  + '读完会把请求格式填成下面的卡片，缺什么一目了然；补齐后再点「试合成」（一次厂商请求）。'
  + '给链接时会优先读文档站的纯文本版；粘贴正文请贴全整节，包括返回示例。Key 只在本机替换进请求头，助手看不到它。';

const STAGE_LABELS = Object.freeze({ validate: '配方不合法', parse: '输出不是配方', request: '请求失败', audio: '没拿到可播放的音频' });
const STATE_LABELS = Object.freeze({ ok: '已确定', missing: '需要填', note: '说明', error: '配方错误' });
// 卡片缺项 → 去哪里补。
const FIX_TARGETS = Object.freeze({ synth: '#tts-custom-url', auth: '#tts-custom-key', model: '#tts-custom-model', voice: '#tts-recipe-voice' });

function describeSummary(summary) {
  if (!summary) return '';
  const parts = [];
  if (summary.status) parts.push(`HTTP ${summary.status}`);
  if (summary.message) parts.push(summary.message);
  return parts.join('：');
}

export function createRecipeSettings({
  controller,
  documentLike = globalThis.document,
  // 当前协议选择（{ protocol, presetId }）与表单里的连接信息（含 endpointId，新增中为空）。
  getChoice = () => ({ protocol: 'openai', presetId: '' }),
  getConnection = () => ({}),
  // 当前编辑中的已保存接口（用于回显已保存的配方、判断 Key 是否已保存）。
  getEndpoint = () => null,
  // 保存：交给 settingsView（它持有接口表单与声音池）；返回 true 表示已保存。
  onSave = async () => false,
  // 地址命中内置协议时，「改用 X」按钮调用它切换协议选择器。
  onSuggestChoice = () => {},
  // 协议选择器里某个值的显示名（用于建议文案）。
  choiceLabel = value => value,
} = {}) {
  const $ = selector => documentLike?.querySelector?.(selector) || null;
  const cleanups = [];
  let presets = [];
  let busy = false;
  // 读文档/修订的进度与结果显示在卡片上方；试合成的进度与结果紧挨在按钮下方（点完就看得到）。
  let statusText = '';
  let testNote = '';
  // 配方 JSON 编辑框里的文字：卡片、试合成和保存都以它为准；dirty 表示用户手改过。
  let jsonText = '';
  let jsonDirty = false;
  // 读文档：暂不支持时的类别与原因。
  let unsupported = null;
  // 最近一次试合成：{ passed, recipe, previewUrl, testText, summary, signature }。
  let test = null;

  const preset = () => presets.find(item => item.id === getChoice().presetId) || null;
  const isRecipe = () => getChoice().protocol === RECIPE_PROTOCOL;
  const assistant = () => isRecipe() && !getChoice().presetId;
  const voiceValue = () => String($('#tts-recipe-voice')?.value || '').trim();

  function parsedJson() {
    if (!jsonText.trim()) return { recipe: null, error: '' };
    try {
      const value = JSON.parse(jsonText);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { recipe: null, error: '配方必须是一个 JSON 对象。' };
      return { recipe: value, error: '' };
    } catch (error) {
      return { recipe: null, error: `配方 JSON 格式有误：${error.message}` };
    }
  }

  function hasKey() {
    const connection = getConnection();
    if (String(connection.apiKey || '').trim()) return true;
    const endpoint = getEndpoint();
    if (!endpoint?.hasKey) return false;
    // 服务端只在地址同 origin 时沿用已保存的 Key。
    try { return new URL(endpoint.baseUrl).origin === new URL(connection.baseUrl).origin; } catch { return false; }
  }

  const form = () => ({ baseUrl: getConnection().baseUrl || '', model: String(getConnection().model || '').trim(), voice: voiceValue(), hasKey: hasKey() });
  const signature = () => JSON.stringify([getConnection().baseUrl || '', String(getConnection().model || '').trim(), voiceValue(), jsonText.trim()]);
  const passed = () => Boolean(test?.passed && test.signature === signature());

  /** 当前配方与已保存接口不同（新接口、换了配方/预设/地址）时为真：保存要走试合成门槛。 */
  function pendingRecipe() {
    if (!isRecipe()) return false;
    const { recipe } = parsedJson();
    if (!recipe) return false;
    const endpoint = getEndpoint();
    if (endpoint?.protocol !== RECIPE_PROTOCOL || !endpoint.recipe) return true;
    if ((endpoint.presetId || '') !== getChoice().presetId) return true;
    if (endpoint.baseUrl !== (getConnection().baseUrl || '')) return true;
    return JSON.stringify(endpoint.recipe) !== JSON.stringify(recipe);
  }

  function renderCard(card) {
    const list = $('#tts-recipe-card');
    if (!list) return;
    list.hidden = !card;
    list.replaceChildren(...(card?.rows || []).map(item => {
      const wrap = documentLike.createElement('div');
      wrap.className = 'tts-recipe-row';
      wrap.dataset.state = item.state;
      wrap.dataset.row = item.id;
      const term = documentLike.createElement('dt');
      term.textContent = item.label;
      const detail = documentLike.createElement('dd');
      const badge = documentLike.createElement('span');
      badge.className = 'tts-recipe-state';
      badge.textContent = STATE_LABELS[item.state];
      const value = documentLike.createElement('span');
      value.className = 'tts-recipe-value';
      value.textContent = item.value;
      detail.append(badge, value);
      wrap.append(term, detail);
      return wrap;
    }));
  }

  function render() {
    const section = $('#tts-recipe');
    if (!section) return;
    section.hidden = !isRecipe();
    if (!isRecipe()) return;
    const current = preset();
    const note = $('#tts-recipe-note');
    if (note) {
      note.textContent = current
        ? `${current.note} 文档：${current.docsUrl}（${current.verifiedAt} 核对）`
        : getChoice().presetId ? '这个预设已下架，请改选其他协议。' : ASSISTANT_NOTE;
    }
    // 选了「其他」但地址认得出：建议直接用内置协议或预设。
    const guess = assistant() ? guessProtocolChoice(getConnection().baseUrl) : null;
    const suggest = $('#tts-recipe-suggest');
    if (suggest) suggest.hidden = !guess;
    const suggestText = $('#tts-recipe-suggest-text');
    if (suggestText) suggestText.textContent = guess ? `这个地址可以直接用内置的「${choiceLabel(guess)}」，不用让助手读文档。` : '';
    const suggestUse = $('#tts-recipe-suggest-use');
    if (suggestUse) {
      suggestUse.textContent = guess ? `改用「${choiceLabel(guess)}」` : '';
      suggestUse.dataset.choice = guess || '';
      suggestUse.disabled = busy;
    }

    const docs = $('#tts-recipe-docs');
    if (docs) docs.hidden = !assistant();
    const { recipe, error: jsonError } = parsedJson();
    const run = $('#tts-recipe-run');
    if (run) {
      run.hidden = !assistant();
      run.textContent = recipe ? '重新读文档' : '读文档';
      run.disabled = busy;
    }
    for (const node of [$('#tts-recipe-voice'), $('#tts-recipe-doc-url'), $('#tts-recipe-doc-text'), $('#tts-recipe-json')]) {
      if (node) node.disabled = busy;
    }
    const voiceField = $('#tts-recipe-voice-field');
    if (voiceField) voiceField.hidden = !recipe;

    const card = recipe ? describeRecipe(recipe, form()) : null;
    renderCard(card);
    const testButton = $('#tts-recipe-test');
    if (testButton) {
      testButton.hidden = !recipe;
      testButton.disabled = busy || !recipe || Boolean(card?.missing.length);
    }
    const missing = $('#tts-recipe-missing');
    if (missing) {
      missing.textContent = jsonError
        || (card?.missing.length ? `还缺：${card.missing.join('、')}。补齐后才能试合成。` : '')
        || (testNote && (busy || !test || test.signature === signature()) ? testNote : '')
        || (recipe && !busy ? '格式齐了：点「试合成」向厂商发一次固定试听句。' : '');
    }
    const revise = $('#tts-recipe-revise');
    if (revise) {
      revise.hidden = !(assistant() && test && !test.passed && test.summary && test.signature === signature());
      revise.disabled = busy;
    }

    const json = $('#tts-recipe-json');
    if (json && json.value !== jsonText) json.value = jsonText;
    const jsonNote = $('#tts-recipe-json-note');
    if (jsonNote) jsonNote.textContent = jsonDirty ? '配方已修改：卡片已按新配方刷新，需要重新试合成。' : '';
    const status = $('#tts-recipe-status');
    if (status) status.textContent = statusText;

    const unsupportedNode = $('#tts-recipe-unsupported');
    if (unsupportedNode) {
      unsupportedNode.hidden = !unsupported;
      unsupportedNode.textContent = unsupported
        ? `暂不支持：${unsupported.label}${unsupported.reason ? `（${unsupported.reason}）` : ''}。这类接口配方 v1 表达不了，换一家或改用 OpenAI 兼容的转接服务。`
        : '';
    }
    const ok = passed();
    const box = $('#tts-recipe-result');
    if (box) box.hidden = !ok;
    const audio = $('#tts-recipe-audio');
    if (audio) {
      const src = ok ? test.previewUrl : '';
      if ((audio.getAttribute?.('src') || '') !== src) {
        if (src) audio.setAttribute('src', src); else audio.removeAttribute?.('src');
      }
    }
    const check = $('#tts-recipe-check');
    if (check) check.textContent = ok ? `确认听到的是「${test.testText}」，再点上方的「保存接口」。听不到或念的不是这句，就不要保存。` : '';
  }

  function loadRecipe(recipe) {
    jsonText = recipe ? JSON.stringify(recipe, null, 2) : '';
    jsonDirty = false;
    test = null;
    testNote = '';
  }

  /** 读完文档后焦点去第一个缺项（没缺就去「试合成」）。 */
  function firstFixTarget() {
    const row = $('#tts-recipe-card [data-state="missing"]') || $('#tts-recipe-card [data-state="error"]');
    if (!row) return $('#tts-recipe-test');
    return $(FIX_TARGETS[row.dataset.row] || '#tts-recipe-json');
  }

  async function runWith(task, focusTarget, { testing = false } = {}) {
    busy = true;
    render();
    try {
      await task();
    } catch (error) {
      if (testing) testNote = `没有完成：${error.message}`; else statusText = `没有完成：${error.message}`;
    } finally {
      busy = false;
      render();
    }
    focusTarget()?.focus?.({ preventScroll: true });
  }

  function connectionPayload() {
    const { endpointId = '', baseUrl = '', apiKey = '', model = '' } = getConnection();
    return { endpointId, baseUrl, apiKey, model, voice: voiceValue() };
  }

  /** 读文档或按失败修订：只调模型；结果进卡片，不发厂商请求。 */
  async function draft({ revise = false } = {}) {
    if (busy || !assistant()) return;
    const previous = revise && test && !test.passed ? { recipe: parsedJson().recipe, summary: test.summary } : null;
    statusText = revise ? '助手正在按失败原因修订（只调模型，不向厂商发请求）…' : '助手正在读文档（只调模型，不向厂商发请求）…';
    // 修订是在按钮下方点的：进度与结果也同步显示在那里。
    testNote = revise ? statusText : '';
    unsupported = null;
    await runWith(async () => {
      const response = await controller.draftRecipe({
        ...connectionPayload(),
        docText: String($('#tts-recipe-doc-text')?.value || ''),
        docUrl: String($('#tts-recipe-doc-url')?.value || '').trim(),
        ...(previous ? { previous } : {}),
      });
      if (response.unsupported) {
        unsupported = response.unsupported;
        loadRecipe(null);
        statusText = '助手判断这个接口暂时接不上。';
        return;
      }
      if (response.recipe) loadRecipe(response.recipe);
      statusText = response.drafted
        ? (revise ? '已修订：上方的接口格式卡片已按新配方刷新，核对后再试合成。' : '已读完文档：请核对下面的接口格式，补齐标着「需要填」的项。')
        : `助手没写出合法的配方：${describeSummary(response.summary) || '原因不明'}。可以补充更完整的文档后重新读，或展开配方 JSON 手改。`;
      if (revise) testNote = statusText;
    }, () => (unsupported ? $('#tts-recipe-run') : firstFixTarget()), { testing: revise });
  }

  async function runTest() {
    const { recipe } = parsedJson();
    if (busy || !recipe || describeRecipe(recipe, form()).missing.length) { render(); return; }
    testNote = '正在试合成（会向厂商发一次固定试听句）…';
    const sig = signature();
    const presetId = getChoice().presetId;
    await runWith(async () => {
      const response = await controller.testRecipe({ ...connectionPayload(), ...(presetId && !jsonDirty ? { presetId } : { recipe }) });
      if (response.passed) {
        test = { passed: true, recipe: response.recipe || recipe, previewUrl: response.previewUrl, testText: response.testText, signature: sig };
        testNote = '试合成通过：先听一下下面的试听。';
        return;
      }
      test = { passed: false, summary: response.summary || { status: null, message: response.error }, signature: sig };
      const stage = STAGE_LABELS[response.stage] ? `${STAGE_LABELS[response.stage]}——` : '';
      testNote = `试合成没有通过：${stage}${describeSummary(response.summary) || response.error}`
        + (assistant() ? '。可以让助手按这个原因修订，或展开配方 JSON 手改。' : '');
    }, () => (passed() ? $('#tts-recipe-audio') : assistant() ? $('#tts-recipe-revise') : $('#tts-recipe-test')), { testing: true });
  }

  /**
   * 表单「保存接口」在配方协议下调用：配方是新的或改过时，必须刚试合成通过。
   * 返回 { handled, saved, message }；handled 为 false 表示没有待保存的配方，按普通接口保存。
   */
  async function save() {
    if (!pendingRecipe()) return { handled: false };
    if (busy) return { handled: true, saved: false, message: '' };
    if (!passed()) {
      return {
        handled: true,
        saved: false,
        message: test && !test.passed && test.signature === signature()
          ? '这份配方的试合成没有通过，不能保存。'
          : '先在下方「接口格式」里试合成并试听，通过后再保存接口。',
      };
    }
    busy = true;
    render();
    try {
      const saved = await onSave({ recipe: test.recipe, presetId: jsonDirty ? '' : getChoice().presetId, voice: voiceValue() });
      if (saved) { test = null; statusText = ''; testNote = ''; }
      return { handled: true, saved };
    } finally {
      busy = false;
      render();
    }
  }

  /** 切换协议或接口时调用：清掉上一次结果，回显已保存的配方或载入预设；预设把空着的地址/model/音色填上默认值。 */
  function reset({ fillDefaults = false } = {}) {
    statusText = '';
    testNote = '';
    unsupported = null;
    const endpoint = getEndpoint();
    const choice = getChoice();
    const sameSaved = endpoint?.protocol === RECIPE_PROTOCOL && (endpoint.presetId || '') === choice.presetId && endpoint.recipe;
    const current = preset();
    loadRecipe(sameSaved ? endpoint.recipe : current?.recipe || null);
    const voice = $('#tts-recipe-voice');
    if (voice) voice.value = fillDefaults && current?.defaults?.voice ? current.defaults.voice : '';
    if (fillDefaults && current) {
      const url = $('#tts-custom-url');
      if (url && !url.value.trim()) url.value = current.defaults.baseUrl;
      const model = $('#tts-custom-model');
      if (model && !model.value.trim()) model.value = current.defaults.model;
    }
    render();
  }

  async function loadPresets() {
    try {
      presets = await controller.loadRecipePresets();
    } catch {
      presets = [];
    }
    // 预设到了以后，空着的配方框补上预设配方。
    if (isRecipe() && !jsonText && preset()) loadRecipe(preset().recipe);
    render();
  }

  function listen(selector, type, listener) {
    const node = $(selector);
    if (!node) return;
    node.addEventListener(type, listener);
    cleanups.push(() => node.removeEventListener(type, listener));
  }
  listen('#tts-recipe-run', 'click', () => void draft());
  listen('#tts-recipe-revise', 'click', () => void draft({ revise: true }));
  listen('#tts-recipe-test', 'click', () => void runTest());
  listen('#tts-recipe-suggest-use', 'click', () => {
    const choice = $('#tts-recipe-suggest-use')?.dataset?.choice;
    if (choice) onSuggestChoice(choice);
  });
  listen('#tts-recipe-json', 'input', event => {
    jsonText = event.target.value;
    jsonDirty = true;
    if (!test) testNote = '';
    render();
  });
  // 音色改了：卡片缺项和「已通过」都要重新算。
  listen('#tts-recipe-voice', 'input', () => { if (!test) testNote = ''; render(); });

  return Object.freeze({
    render,
    reset,
    save,
    pendingRecipe,
    loadPresets,
    presets: () => presets.slice(),
    destroy() { for (const cleanup of cleanups.splice(0)) cleanup(); },
  });
}
