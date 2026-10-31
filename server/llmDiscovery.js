// llmDiscovery.js — 按 provider 的协议拉取可用模型列表（unified-model-providers D5）。
//
// 只读、有界、不落盘：调用方拿到列表后由用户勾选保存。
// 各协议的 models 端点与鉴权：
//   openai-completions / openai-responses → GET {base}/models（Bearer）
//   anthropic-messages                    → GET {base}/models（x-api-key + anthropic-version）
//   google-generative-ai                  → GET {base}/models（x-goog-api-key），过滤支持 generateContent
// 失败如实抛错（含状态码，绝不含 key）。
//
// 返回形状（add-reasoning-effort-controls）：models 是 `{ id, name?, reasoningEfforts?,
// contextWindow?, maxOutputTokens?, modalities? }` 的对象数组，按 id 去重并保持首次出现顺序。
// 元数据只保留 Gateway 真正给出的字段：优先 `reasoning_levels`，否则
// `supported_reasoning_levels[].effort`；容量兼容 snake/camel/Google 字段名。坏值丢弃、不猜测，
// 没有元数据时仍返回 `{ id }`（向后兼容：调用方按 `id` 使用）。

/** 字符串数组归一：trim、去空、去重（保留首次出现顺序）；非字符串一律视为坏值丢弃。 */
function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** 依次尝试多个字段名，返回第一个正整数（容量类字段约定为整数）。 */
function firstPositiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return null;
}

function readDisplayName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 声明的思考档位：优先 reasoning_levels；否则 supported_reasoning_levels[].effort。 */
function readReasoningEfforts(entry = {}) {
  const levels = uniqueStrings(entry?.reasoning_levels);
  if (levels.length) return levels;
  const supported = Array.isArray(entry?.supported_reasoning_levels)
    ? entry.supported_reasoning_levels.map(level => (typeof level === 'string' ? level : level?.effort))
    : [];
  return uniqueStrings(supported);
}

/** 输入模态：`modalities.input`（对象形态）或 `input_modalities`（扁平形态）。 */
function readModalities(entry = {}) {
  const nested = entry?.modalities && typeof entry.modalities === 'object' && Array.isArray(entry.modalities.input)
    ? entry.modalities.input : null;
  return uniqueStrings(nested || entry?.input_modalities);
}

/** 一条 models 响应条目 → `{ id, ...metadata }`；坏元数据丢弃，不把字段变成必填。 */
function toModelEntry(entry = {}, { id, name = null } = {}) {
  const model = { id };
  if (name) model.name = name;
  const reasoningEfforts = readReasoningEfforts(entry);
  if (reasoningEfforts.length) model.reasoningEfforts = reasoningEfforts;
  const contextWindow = firstPositiveInteger(entry?.context_window, entry?.contextWindow, entry?.inputTokenLimit);
  if (contextWindow) model.contextWindow = contextWindow;
  const maxOutputTokens = firstPositiveInteger(entry?.max_output_tokens, entry?.maxOutputTokens, entry?.outputTokenLimit);
  if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
  const modalities = readModalities(entry);
  if (modalities.length) model.modalities = modalities;
  return model;
}

/** 按 id 去重：保留首次出现的条目与元数据。 */
function dedupeById(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

export async function discoverModels({ baseUrl, apiKey = '', api = 'openai-completions',
  fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('discoverModels requires a fetch implementation');
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Base URL 不能为空');

  const headers = {};
  if (api === 'anthropic-messages') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (api === 'google-generative-ai') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: { ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`模型列表请求失败：${String(error?.message || error).slice(0, 200)}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`模型列表请求 ${response.status}：${detail.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('模型列表响应不是合法 JSON');
  }

  if (api === 'google-generative-ai') {
    const models = (Array.isArray(payload?.models) ? payload.models : [])
      .filter(model => !Array.isArray(model?.supportedGenerationMethods)
        || model.supportedGenerationMethods.includes('generateContent'))
      .map(model => {
        const id = (typeof model?.name === 'string' ? model.name : '').replace(/^models\//, '').trim();
        if (!id) return null;
        // Google 的 `name` 是资源路径（已作 id），展示名是 `displayName`。
        return toModelEntry(model, { id, name: readDisplayName(model?.displayName) });
      })
      .filter(Boolean);
    return { ok: true, models: dedupeById(models) };
  }
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .map(entry => {
      const id = String(entry?.id || '').trim();
      if (!id) return null;
      return toModelEntry(entry, { id, name: readDisplayName(entry?.name) });
    })
    .filter(Boolean);
  return { ok: true, models: dedupeById(models) };
}
