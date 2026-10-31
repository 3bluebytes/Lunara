// protocols/recipe.js — 声明式请求配方（recipe v1）的固定解释器。
//
// 内置三种协议之外的普通 HTTP+JSON TTS，用一份 JSON 配方描述「怎么发请求、从哪取音频」，
// 由这里的固定代码执行；配方里没有任何可执行的东西，解释器的全部「逻辑」是占位符替换：
//
//   { version: 1,
//     synth:  { method: 'GET'|'POST', path: '/v1/tts/{voice}', query: {...}, headers: {...}, body: {...} },
//     audio:  { kind: 'binary' } | { kind: 'json', audioPath, encoding: 'hex'|'base64' }
//           | { kind: 'url', audioPath },
//     error:  { messagePath },                       // 可选：错误文字所在的 JSON 路径
//     voices: { method, path, query, headers, body, itemsPath, idPath, namePath } }  // 可选
//
// Python 伪代码：
//   def render(template, values):          # 递归遍历 dict/list，只对 str 做替换，不 eval
//       if isinstance(template, str): return PLACEHOLDER.sub(lambda m: values[m[1]], template)
//       ...
//
// 安全边界（design D1–D3）：
//   - 占位符白名单 {text} {voice} {model} {apiKey}；{apiKey} 只能写在请求头的值里。
//   - 配方的 path 是相对路径，主机只来自用户填写的接口地址；除 localhost 外必须 HTTPS。
//   - 一律不跟随重定向（比「只拒绝跨 origin」更严），Key 不会被带到别的主机。
//   - 响应限 20MB；音频链接（kind:'url'）只用不带任何凭据的 GET 下载，http 链接升级为 https。
//   - 音频按文件头识别；HTTP 200 但内容是 JSON 错误不算成功。
//   - 错误文字先抹掉 Key、Bearer 串和长 token，再截断。

import { createTtsAudio } from '../../TtsProvider.js';
import { synthesisError, unavailable } from './shared.js';

export const RECIPE_VERSION = 1;
export const MAX_RECIPE_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_VOICE_LIST_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_RECIPE_JSON_CHARS = 16 * 1024;
const MAX_VOICES = 500;
const SUMMARY_CHARS = 300;

const PLACEHOLDERS = new Set(['text', 'voice', 'model', 'apiKey']);
const VOICE_LIST_PLACEHOLDERS = new Set(['model', 'apiKey']);
const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g;
const JSON_PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
// 由传输层决定、配方不能改写的请求头。
const RESERVED_HEADERS = new Set(['host', 'cookie', 'content-length', 'transfer-encoding', 'connection', 'origin', 'referer']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Lunara 下游（缓存、响度、浏览器播放）目前只接 mp3/wav；其余格式能识别但不能用。
const PLAYABLE_FORMATS = new Set(['mp3', 'wav']);
const REDIRECT_MESSAGE = '接口返回了重定向，已拒绝跟随（配方请求不会把 Key 带到别的地址）';

/**
 * 试合成遇到重定向时给起草模型看的说明：同一主机只给目标路径（不含查询串），
 * 让它改 path；其他主机只给主机名。仍然一律不跟随。
 */
function redirectMessage(response, requestUrl, secrets) {
  let target = null;
  try { target = new URL(response.headers?.get?.('location') || '', requestUrl); } catch { }
  if (!target || !response.headers?.get?.('location')) return REDIRECT_MESSAGE;
  const from = new URL(requestUrl);
  const detail = target.origin === from.origin
    ? `从 ${from.pathname} 重定向到同一主机的 ${target.pathname}；请把配方 path 改成直接请求这个路径（注意末尾斜杠）`
    : `重定向到其他主机 ${target.host}`;
  return redactSecrets(`接口返回了 ${response.status} 重定向，已拒绝跟随（配方请求不会把 Key 带到别的地址）：${detail}`, secrets);
}

function invalid(message) {
  return unavailable(`配方不合法：${message}`, 'TTS_RECIPE_INVALID');
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 遍历模板里的每个字符串叶子：visit(string, where)；对象的键不允许写占位符。 */
function walkStrings(value, where, visit) {
  if (typeof value === 'string') { visit(value, where); return; }
  if (Array.isArray(value)) { value.forEach(item => walkStrings(item, where, visit)); return; }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/[{}]/.test(key)) throw invalid(`${where} 的键「${key}」里不能写占位符，占位符只能写在值里（{apiKey} 只能写在请求头的值里）`);
      walkStrings(item, where, visit);
    }
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  throw invalid(`${where} 只能包含 JSON 值`);
}

function checkPlaceholders(value, where, { allowed = PLACEHOLDERS, allowKey = false } = {}) {
  walkStrings(value, where, string => {
    for (const [, name] of string.matchAll(PLACEHOLDER_PATTERN)) {
      if (!PLACEHOLDERS.has(name)) throw invalid(`未知占位符 {${name}}（只允许 {text} {voice} {model} {apiKey}）`);
      if (name === 'apiKey' && !allowKey) throw invalid(`{apiKey} 只能写在请求头的值里，不能出现在 ${where}`);
      if (!allowed.has(name)) throw invalid(`${where} 里不能用 {${name}}`);
    }
  });
}

function checkPath(path, where) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('//')
    || /(^|\/)\.\.?(\/|$)/.test(path) || /[\s\\?#%]/.test(path) || path.includes('://') || path.length > 512) {
    throw invalid(`${where} 的路径必须是以 / 开头的相对路径，不能写主机、//、..、空白、? 或 #`);
  }
}

function checkJsonPath(path, where, required) {
  if (path === undefined && !required) return;
  if (typeof path !== 'string' || !JSON_PATH_PATTERN.test(path)) throw invalid(`${where} 必须是形如 data.audio 的 JSON 路径`);
}

/** 校验并规范化一段请求描述（synth 或 voices）。 */
function normalizeRequest(raw, where, allowed) {
  if (!isPlainObject(raw)) throw invalid(`缺少 ${where}`);
  const method = String(raw.method || (where === 'voices' ? 'GET' : 'POST')).toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw invalid(`${where} 的方法只能是 GET 或 POST`);
  checkPath(raw.path, where);
  checkPlaceholders(raw.path, `${where}.path`, { allowed });
  const request = { method, path: raw.path };
  if (raw.query !== undefined) {
    if (!isPlainObject(raw.query) || Object.values(raw.query).some(value => isPlainObject(value) || Array.isArray(value))) {
      throw invalid(`${where}.query 必须是「名字: 值」的对象`);
    }
    checkPlaceholders(raw.query, `${where}.query`, { allowed });
    request.query = Object.fromEntries(Object.entries(raw.query).map(([key, value]) => [key, String(value ?? '')]));
  }
  if (raw.headers !== undefined) {
    if (!isPlainObject(raw.headers)) throw invalid(`${where}.headers 必须是对象`);
    for (const [name, value] of Object.entries(raw.headers)) {
      if (!HEADER_NAME_PATTERN.test(name)) throw invalid(`请求头名字「${name}」不合法（{apiKey} 只能写在请求头的值里）`);
      if (RESERVED_HEADERS.has(name.toLowerCase())) throw invalid(`请求头 ${name} 由传输层决定，配方不能设置`);
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw invalid(`请求头 ${name} 的值必须是单行字符串`);
    }
    checkPlaceholders(raw.headers, `${where}.headers`, { allowed, allowKey: true });
    request.headers = { ...raw.headers };
  }
  if (raw.body !== undefined) {
    if (method === 'GET') throw invalid(`${where} 用 GET 时不能带 body`);
    if (!isPlainObject(raw.body) && !Array.isArray(raw.body)) throw invalid(`${where}.body 只支持 JSON 对象或数组`);
    checkPlaceholders(raw.body, `${where}.body`, { allowed });
    request.body = JSON.parse(JSON.stringify(raw.body));
  }
  return request;
}

/**
 * 校验配方并返回规范化副本；不合法时抛 TTS_RECIPE_INVALID（不可用错误，消息可直接给用户和起草模型看）。
 */
export function validateRecipe(raw) {
  if (!isPlainObject(raw)) throw invalid('配方必须是 JSON 对象');
  let size;
  try { size = JSON.stringify(raw).length; } catch { throw invalid('配方必须是 JSON 对象'); }
  if (size > MAX_RECIPE_JSON_CHARS) throw invalid('配方过长');
  if (raw.version !== RECIPE_VERSION) throw invalid(`version 必须是 ${RECIPE_VERSION}`);
  const recipe = { version: RECIPE_VERSION, synth: normalizeRequest(raw.synth, 'synth', PLACEHOLDERS) };

  const audio = raw.audio;
  if (!isPlainObject(audio) || !['binary', 'json', 'url'].includes(audio.kind)) {
    throw invalid('audio.kind 必须是 binary、json 或 url');
  }
  recipe.audio = { kind: audio.kind };
  if (audio.kind !== 'binary') {
    checkJsonPath(audio.audioPath, 'audio.audioPath', true);
    recipe.audio.audioPath = audio.audioPath;
  }
  if (audio.kind === 'json') {
    if (audio.encoding !== 'hex' && audio.encoding !== 'base64') throw invalid('audio.encoding 必须是 hex 或 base64');
    recipe.audio.encoding = audio.encoding;
  }

  if (raw.error !== undefined) {
    if (!isPlainObject(raw.error)) throw invalid('error 必须是对象');
    checkJsonPath(raw.error.messagePath, 'error.messagePath', true);
    recipe.error = { messagePath: raw.error.messagePath };
  }

  if (raw.voices !== undefined) {
    const voices = normalizeRequest(raw.voices, 'voices', VOICE_LIST_PLACEHOLDERS);
    checkJsonPath(raw.voices.itemsPath, 'voices.itemsPath', false);
    checkJsonPath(raw.voices.idPath, 'voices.idPath', true);
    checkJsonPath(raw.voices.namePath, 'voices.namePath', false);
    recipe.voices = {
      ...voices,
      ...(raw.voices.itemsPath ? { itemsPath: raw.voices.itemsPath } : {}),
      idPath: raw.voices.idPath,
      ...(raw.voices.namePath ? { namePath: raw.voices.namePath } : {}),
    };
  }
  return recipe;
}

/** 用户填写的接口地址 → { origin, prefix }；除 localhost 外必须 HTTPS。 */
export function recipeBase(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl || '').trim()); } catch { throw invalid('接口地址不是合法的 URL'); }
  if (url.username || url.password || url.search || url.hash) throw invalid('接口地址不能带账号、查询参数或 #');
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw invalid('接口地址必须是 HTTPS（只有 localhost 可以用 http）');
  }
  return { origin: url.origin, prefix: url.pathname.replace(/\/+$/, '') };
}

function substitute(string, values, encode) {
  return string.replace(PLACEHOLDER_PATTERN, (_, name) => encode(String(values[name] ?? '')));
}

// 整段值是 . 或 .. 时把点也编码，路径里不会出现可解析的上跳段。
const encodeSegment = value => (/^\.{1,2}$/.test(value) ? value.replace(/\./g, '%2E') : encodeURIComponent(value));

function renderJson(template, values) {
  if (typeof template === 'string') return substitute(template, values, value => value);
  if (Array.isArray(template)) return template.map(item => renderJson(item, values));
  if (isPlainObject(template)) return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, renderJson(item, values)]));
  return template;
}

function renderRequest(request, base, values) {
  // 地址已经是完整合成地址时 path 写 "/"：不再追加末尾斜杠（不少厂商对 /x/ 回重定向）。
  const path = request.path === '/' && base.prefix ? '' : substitute(request.path, values, encodeSegment);
  const url = new URL(`${base.origin}${base.prefix}${path}`);
  if (url.origin !== base.origin) throw invalid('请求地址偏离了接口地址');
  for (const [key, value] of Object.entries(request.query || {})) url.searchParams.append(key, substitute(value, values, v => v));
  const headers = {};
  for (const [name, value] of Object.entries(request.headers || {})) {
    const rendered = substitute(value, values, v => v);
    if (/[\r\n]/.test(rendered)) throw invalid(`请求头 ${name} 替换后含换行`);
    headers[name] = rendered;
  }
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.body !== undefined) {
    init.body = JSON.stringify(renderJson(request.body, values));
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  return { url: url.toString(), init };
}

/** 渲染合成请求：{ url, init }。init.redirect 固定为 manual。 */
export function renderRecipeRequest({ baseUrl, recipe, values }) {
  const normalized = validateRecipe(recipe);
  return renderRequest(normalized.synth, recipeBase(baseUrl), values || {});
}

/** 按文件头识别音频格式：mp3 | wav | ogg | aac | flac | null。 */
export function sniffAudioFormat(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const ascii = (start, length) => bytes.subarray(start, start + length).toString('latin1');
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (ascii(0, 4) === 'RIFF' && bytes.length >= 12 && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (bytes.length >= 8 && ascii(4, 4) === 'ftyp') return 'aac';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac'; // ADTS：layer 位为 00
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return 'mp3'; // MPEG 帧同步
  return null;
}

/** 抹掉 Key、Bearer 串和长 token 样式的串，再压空白、截断。 */
export function redactSecrets(text, secrets = [], limit = SUMMARY_CHARS) {
  let result = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value.length >= 4) result = result.split(value).join('***');
  }
  return result
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '***')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function getPath(value, path) {
  let current = value;
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(segment) ? current[Number(segment)] : current[segment];
  }
  return current;
}

const contentTypeOf = response => String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();

function tooLarge(limit) {
  return synthesisError(`响应过大（超过 ${Math.round(limit / 1024 / 1024)}MB）`, { code: 'TTS_RECIPE_TOO_LARGE' });
}

/** 有上限地读完响应体：先看 content-length，再边读边数。 */
async function readCapped(response, limit) {
  const declared = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch?.(() => {});
    throw tooLarge(limit);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw tooLarge(limit);
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge(limit);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

/** 错误响应里给人看的那句话：优先 error.messagePath，否则响应开头（已脱敏）。 */
function upstreamMessage(bytes, recipe, secrets) {
  const payload = parseJson(bytes);
  const picked = recipe?.error?.messagePath && payload !== undefined ? getPath(payload, recipe.error.messagePath) : undefined;
  const text = typeof picked === 'string' || typeof picked === 'number' ? String(picked) : bytes.subarray(0, 2048).toString('utf8');
  return redactSecrets(text, secrets) || '（响应为空）';
}

/** 读取阶段的失败：带上给起草模型看的 { status, contentType, message } 细节。 */
function audioFailure(message, detail, code = 'TTS_RECIPE_NO_AUDIO') {
  const error = synthesisError(message, { code });
  error.recipeDetail = { ...detail, message };
  return error;
}

function decodeAudioField(value, encoding) {
  const text = String(value).trim().replace(/^data:[^,]*;base64,/, '');
  if (encoding === 'hex') {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) return null;
    return Buffer.from(text, 'hex');
  }
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(text)) return null;
  return Buffer.from(text, 'base64');
}

/** 下载音频链接：不带任何请求头、Cookie 或 Key，不跟随重定向，限 20MB。 */
async function downloadAudioLink(link, { fetchImpl, signal, detail }) {
  let url;
  try { url = new URL(String(link)); } catch { url = null; }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw audioFailure('响应里的音频链接不是 http(s) 地址', detail);
  }
  // 只走 HTTPS：对象存储的签名链接常给 http，同一主机换成 https 下载（不支持 https 就如实失败）。
  if (url.protocol === 'http:') url.protocol = 'https:';
  let response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', headers: {}, credentials: 'omit', redirect: 'manual', signal });
  } catch (error) {
    throw audioFailure(`下载音频链接失败：${redactSecrets(error?.message)}`, detail, 'TTS_RECIPE_DOWNLOAD_FAILED');
  }
  const linkDetail = { status: response.status, contentType: contentTypeOf(response) };
  if (response.status >= 300 && response.status < 400) throw audioFailure(`音频链接${REDIRECT_MESSAGE.slice(2)}`, linkDetail, 'TTS_RECIPE_REDIRECT');
  if (!response.ok) throw audioFailure(`下载音频链接失败（HTTP ${response.status}）`, linkDetail, 'TTS_RECIPE_DOWNLOAD_FAILED');
  try {
    return await readCapped(response, MAX_RECIPE_AUDIO_BYTES);
  } catch (error) {
    throw audioFailure(error.message, linkDetail, error.code);
  }
}

/** 合成成功（2xx）的响应 → TtsAudio；任何「不是音频」都如实失败。 */
async function readRecipeAudio(response, { model = '', config = {}, fetchImpl = globalThis.fetch, signal = null } = {}) {
  const recipe = validateRecipe(config.recipe);
  const secrets = [config.apiKey];
  const detail = { status: response.status, contentType: contentTypeOf(response) };
  let body;
  try {
    body = await readCapped(response, MAX_RECIPE_AUDIO_BYTES);
  } catch (error) {
    throw audioFailure(error.message, detail, error.code);
  }
  let bytes = body;
  if (recipe.audio.kind !== 'binary') {
    const payload = parseJson(body);
    const value = payload === undefined ? undefined : getPath(payload, recipe.audio.audioPath);
    if (typeof value !== 'string' || !value.trim()) {
      throw audioFailure(`响应里没有找到音频字段 ${recipe.audio.audioPath}：${upstreamMessage(body, recipe, secrets)}`, detail);
    }
    if (recipe.audio.kind === 'json') {
      bytes = decodeAudioField(value, recipe.audio.encoding);
      if (!bytes) throw audioFailure(`音频字段 ${recipe.audio.audioPath} 不是 ${recipe.audio.encoding} 编码`, detail);
    } else {
      bytes = await downloadAudioLink(value, { fetchImpl, signal, detail });
    }
  }
  const format = sniffAudioFormat(bytes);
  if (!format) {
    const hint = recipe.audio.kind === 'binary' ? `：${upstreamMessage(body, recipe, secrets)}` : '';
    throw audioFailure(`返回的内容不是可识别的音频${hint}`, detail);
  }
  if (!PLAYABLE_FORMATS.has(format)) {
    throw audioFailure(`识别到 ${format} 音频，但 Lunara 目前只能播放 mp3/wav；请在请求里要 mp3（或 wav）格式`, detail, 'TTS_UNSUPPORTED_FORMAT');
  }
  return createTtsAudio({ bytes, extension: format, source: model ? `custom:recipe:${model}` : 'custom:recipe' });
}

const FAILURE_CODES = Object.freeze({ 401: 'TTS_AUTH_FAILED', 403: 'TTS_AUTH_FAILED', 429: 'TTS_RATE_LIMITED', 503: 'TTS_UPSTREAM_BUSY' });

function describeRecipeFailure(status, body, config = {}) {
  if (status >= 300 && status < 400) return { message: REDIRECT_MESSAGE, code: 'TTS_RECIPE_REDIRECT' };
  let recipe = null;
  try { recipe = validateRecipe(config.recipe); } catch { }
  const message = upstreamMessage(Buffer.from(String(body || ''), 'utf8'), recipe, [config.apiKey]);
  return { message: `custom tts responded ${status}: ${message}`, code: FAILURE_CODES[status] || null };
}

/**
 * 试合成：校验 → 渲染 → 请求 → 取音频。不重试、不抛错，返回
 *   { ok: true, audio, recipe } 或 { ok: false, stage, summary: { status, contentType, message } }。
 * summary 已脱敏、截到 300 字符，可以直接交给起草模型做下一轮修订。
 */
export async function testRecipe({
  baseUrl, apiKey = '', model = '', voice = '', recipe, text, fetchImpl = globalThis.fetch, signal = null,
} = {}) {
  const secrets = [apiKey];
  const fail = (stage, { status = null, contentType = null, message }) => ({
    ok: false, stage, summary: { status, contentType, message: redactSecrets(message, secrets) },
  });
  let normalized;
  let request;
  try {
    normalized = validateRecipe(recipe);
    request = renderRecipeRequest({ baseUrl, recipe: normalized, values: { text, voice, model, apiKey } });
  } catch (error) {
    return fail('validate', { message: error.message });
  }
  let response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal });
  } catch (error) {
    return fail('request', { message: `请求失败：${error?.message || error}` });
  }
  const contentType = contentTypeOf(response);
  if (response.status >= 300 && response.status < 400) return fail('request', { status: response.status, contentType, message: redirectMessage(response, request.url, secrets) });
  if (!response.ok) {
    let body = Buffer.alloc(0);
    try { body = await readCapped(response, MAX_ERROR_BODY_BYTES); } catch { }
    return fail('request', { status: response.status, contentType, message: upstreamMessage(body, normalized, secrets) });
  }
  try {
    const audio = await readRecipeAudio(response, { model, config: { recipe: normalized, apiKey }, fetchImpl, signal });
    return { ok: true, audio, recipe: normalized };
  } catch (error) {
    return fail('audio', error.recipeDetail || { status: response.status, contentType, message: error.message });
  }
}

export const recipeProtocol = Object.freeze({
  id: 'recipe',
  // 配方自己决定要不要 {model}；不强制填写。
  modelOptional: true,
  synthRequest({ base, config, model, voiceId, text }) {
    return renderRecipeRequest({
      baseUrl: config.baseUrl || base,
      recipe: config.recipe,
      values: { text, voice: voiceId, model, apiKey: config.apiKey },
    });
  },
  describeFailure: describeRecipeFailure,
  readAudio: readRecipeAudio,
  async fetchModels() {
    throw unavailable('配方接口不提供模型列表；按厂商文档手动填写 model（配方不用 {model} 时可留空）', 'TTS_CUSTOM_MODELS_UNAVAILABLE');
  },
  async fetchVoices({ base, config, fetchImpl, signal }) {
    const recipe = validateRecipe(config.recipe);
    if (!recipe.voices) {
      throw unavailable('这个配方没有声音列表请求；可改用手动填写 voice', 'TTS_CUSTOM_VOICES_UNAVAILABLE');
    }
    const { url, init } = renderRequest(recipe.voices, recipeBase(config.baseUrl || base), {
      model: config.model || '', apiKey: config.apiKey,
    });
    const response = await fetchImpl(url, { ...init, signal });
    if (!response.ok) {
      const body = await readCapped(response, MAX_ERROR_BODY_BYTES).catch(() => Buffer.alloc(0));
      const reason = response.status >= 300 && response.status < 400 ? REDIRECT_MESSAGE : upstreamMessage(body, recipe, [config.apiKey]);
      throw unavailable(`获取声音列表失败（HTTP ${response.status}）：${reason}`, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
    }
    const payload = parseJson(await readCapped(response, MAX_VOICE_LIST_BYTES));
    const rows = recipe.voices.itemsPath ? getPath(payload, recipe.voices.itemsPath) : payload;
    if (!Array.isArray(rows)) {
      throw unavailable(`声音列表响应里没有找到数组 ${recipe.voices.itemsPath || '（顶层）'}`, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
    }
    const seen = new Set();
    const voices = [];
    for (const row of rows) {
      const id = getPath(row, recipe.voices.idPath);
      if ((typeof id !== 'string' && typeof id !== 'number') || seen.has(String(id))) continue;
      seen.add(String(id));
      const name = recipe.voices.namePath ? getPath(row, recipe.voices.namePath) : null;
      voices.push({ id: String(id), name: typeof name === 'string' && name.trim() ? name.trim() : String(id) });
      if (voices.length >= MAX_VOICES) break;
    }
    return voices;
  },
});
