// providers/freeEdge.js — 免费声音：微软 Edge「大声朗读」的公开网页接口（非官方授权）。
//
// 只有用户在设置里知情确认后才注册（见 ttsFallbackConfig）；未启用时不请求、不发送任何文字。
// 协议（2026-10 核对社区实现 msedge-tts 2.1.1 / node-edge-tts 1.2.12，均 MIT）：
//   声音  GET  https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=…
//   合成  WSS  …/readaloud/edge/v1?TrustedClientToken=…&Sec-MS-GEC=…&Sec-MS-GEC-Version=…&ConnectionId=…
//         先发 speech.config（mp3 输出），再发 SSML；二进制帧 = 2 字节头长 + 头 + 音频，收到 turn.end 结束。
//   鉴权  Sec-MS-GEC v2 = "<CS64 校验>-<SHA-256>"，SHA-256 覆盖固定版权行 + v1 的「5 分钟取整 Windows 时间刻度 + token」。
// 微软改协议时只改下面的常量块与 secMsGecV2；失败如实上报，不重试、不伪装规避。

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createTtsAudio, TtsSynthesisError } from '../TtsProvider.js';
import { NO_PERFORMANCE_CAPABILITY } from '../performance/capabilities.js';
import { normalizePerformance } from '../performance/markers.js';
import { renderSpeech } from '../performance/render.js';

export const FREE_EDGE_PROVIDER_ID = 'free-edge';
export const FREE_EDGE_LABEL = '免费声音（Edge）';
export const FREE_EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

// ---- 协议常量（微软改动时只改这里）----
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.96';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const WINDOWS_EPOCH_SECONDS = 11644473600n;
const GEC_PREFIX = Buffer.from('Q29weXJpZ2h0IChDKSBNaWNyb3NvZnQgQ29ycG9yYXRpb24uIEFsbCByaWdodHMgcmVzZXJ2ZWQu', 'base64');
const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];

const SYNTH_TIMEOUT_MS = 30_000;
const VOICES_TIMEOUT_MS = 15_000;
const VOICES_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEGMENT_CHARS = 1000;
const PACE_RATE = Object.freeze({ slow: '-15%', fast: '+15%' });

// 中文声音的显示名（声音列表只有英文 FriendlyName）。
const ZH_NAMES = Object.freeze({
  'zh-CN-XiaoxiaoNeural': '晓晓', 'zh-CN-XiaoyiNeural': '晓伊', 'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希', 'zh-CN-YunxiaNeural': '云夏', 'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（东北话）', 'zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西话）',
  'zh-HK-HiuGaaiNeural': '曉佳（粤语）', 'zh-HK-HiuMaanNeural': '曉曼（粤语）', 'zh-HK-WanLungNeural': '雲龍（粤语）',
  'zh-TW-HsiaoChenNeural': '曉臻（台湾）', 'zh-TW-YunJheNeural': '雲哲（台湾）', 'zh-TW-HsiaoYuNeural': '曉雨（台湾）',
});

export const freeEdgeVoiceName = voiceId => ZH_NAMES[voiceId] || String(voiceId || '').replace(/Neural$/, '');

export const FREE_EDGE_PERFORMANCE_CAPABILITY = Object.freeze({ ...NO_PERFORMANCE_CAPABILITY, id: 'edge-readaloud', pace: true });

const mul = Math.imul;
const rol16 = x => ((x << 16) | (x >>> 16)) >>> 0;

function cs64Digest(data, sha) {
  const keyA = (sha.readUInt32LE(0) | 1) >>> 0;
  const keyB = (sha.readUInt32LE(4) | 1) >>> 0;
  const factors = [mul(keyA, 0x82893933) >>> 0, mul(keyB, 0x82893933) >>> 0];
  const terms = CS64_COEFFICIENTS.map(([coefficient], i) => mul(coefficient, factors[i % 2]) >>> 0);
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8);
  padded.set(data, 1);
  for (let i = 0; i < padded.length / 4; i++) {
    const word = padded.readUInt32LE(i * 4);
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) {
      term = (term + mul(0xF2F90B1A, factors[0])) >>> 0;
      offset = (offset + 0x0B1A0000) >>> 0;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = mul(t, 0x76F50F34);
    swapAcc += (mul(rol16(q), 0xC3EFEA97) + q) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = mul(t, 0x1881CE3C);
    swapLast = (mul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (mul(state, keyA) + x) >>> 0;
    for (const k of [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]) state = mul(rol16(state), k) >>> 0;
    acc += state;
    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xA27416F5) >>> 0;
    t = mul(rol16(t), 0xD38396FF) >>> 0;
    state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  const result = Buffer.allocUnsafe(8);
  result.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  result.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return result;
}

/** Sec-MS-GEC v2：时间按 5 分钟取整，所以同一窗口内结果稳定（测试用固定时间锁住）。 */
export function secMsGecV2(unixSeconds = Date.now() / 1000) {
  const epochSeconds = BigInt(Math.floor(unixSeconds)) + WINDOWS_EPOCH_SECONDS;
  const ticks = (epochSeconds - (epochSeconds % 300n)) * 10_000_000n;
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const sha = createHash('sha256').update(GEC_PREFIX).update(data).digest();
  return `${cs64Digest(data, sha).toString('hex').toUpperCase()}-${sha.toString('hex').toUpperCase()}`;
}

export function synthesisUrl({ now = Date.now(), connectionId = randomUUID().replace(/-/g, '') } = {}) {
  return `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGecV2(now / 1000)}`
    + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
}

const escapeXml = text => String(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

const VOICE_ID_PATTERN = /^[a-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]+)*Neural$/;

export function buildSsml(text, { voice, rate = '+0%' }) {
  const lang = String(voice).split('-').slice(0, 2).join('-');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>`
    + `<voice name='${voice}'><prosody rate='${rate}' pitch='+0Hz' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
}

function speechConfigMessage() {
  return `X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
    + JSON.stringify({ context: { synthesis: { audio: {
      metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT,
    } } } });
}

function ssmlMessage(ssml) {
  return `X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n`
    + `X-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

/** 二进制帧：前 2 字节是头长度（大端），其后是头，剩下是音频。格式不对返回 null。 */
export function audioOfFrame(frame) {
  if (!frame || frame.length < 2) return null;
  const offset = frame.readUInt16BE(0) + 2;
  if (offset > frame.length) return null;
  return frame.subarray(offset);
}

/** 按句末标点切段，每段不超过 MAX_SEGMENT_CHARS；单句过长时硬切。 */
export function splitSegments(text, max = MAX_SEGMENT_CHARS) {
  const sentences = String(text).match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) || [];
  const segments = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > max && current) {
      segments.push(current);
      current = '';
    }
    let rest = sentence;
    while (rest.length > max) {
      segments.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    current += rest;
  }
  if (current.trim()) segments.push(current);
  return segments.map(segment => segment.trim()).filter(Boolean);
}

const failure = (message, code, cause) => new TtsSynthesisError(message, { providerId: FREE_EDGE_PROVIDER_ID, code, cause });

function loadWebSocket() {
  return createRequire(import.meta.url)('ws');
}

/** 一段文本 → mp3 字节。握手被拒（403 等）如实报出，便于声音健康显示"免费声音暂时不可用"。 */
function synthSegment({ WebSocketImpl, text, voice, rate, signal, timeoutMs, now }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(synthesisUrl({ now: now() }), {
      headers: { Origin: ORIGIN, 'User-Agent': USER_AGENT, Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
    });
    const chunks = [];
    let settled = false;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try { error ? ws.terminate?.() : ws.close?.(); } catch { /* 连接已断 */ }
      error ? reject(error) : resolve(bytes);
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(failure('免费声音合成超时', 'TTS_TIMEOUT')), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    ws.on('open', () => {
      ws.send(speechConfigMessage());
      ws.send(ssmlMessage(buildSsml(text, { voice, rate })));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const audio = audioOfFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
        if (audio === null) return finish(failure('免费声音返回了无法解析的数据', 'TTS_SYNTHESIS_FAILED'));
        if (audio.length) chunks.push(audio);
        return undefined;
      }
      if (String(data).includes('Path:turn.end')) finish(null, Buffer.concat(chunks));
      return undefined;
    });
    ws.on('unexpected-response', (_request, response) => {
      const status = response?.statusCode;
      finish(failure(`免费声音暂时不可用（HTTP ${status}）`, status === 429 ? 'TTS_RATE_LIMITED' : 'TTS_SYNTHESIS_FAILED'));
    });
    ws.on('error', error => finish(failure('免费声音连接失败', 'TTS_SYNTHESIS_FAILED', error)));
    ws.on('close', () => finish(failure('免费声音连接提前断开', 'TTS_SYNTHESIS_FAILED')));
  });
}

/**
 * @param {object} options
 * @param {() => Array<{sourceVoiceId:string, displayName:string}>} [options.keptVoices] 声音池里属于免费声音的条目
 */
export function createFreeEdgeProvider({
  WebSocketImpl = null, fetchImpl = globalThis.fetch, now = () => Date.now(),
  keptVoices = () => [], timeoutMs = SYNTH_TIMEOUT_MS,
} = {}) {
  let voicesCache = null;

  async function fetchVoices({ signal } = {}) {
    if (voicesCache && now() - voicesCache.at < VOICES_TTL_MS) return voicesCache.voices;
    const timeout = AbortSignal.timeout(VOICES_TIMEOUT_MS);
    const response = await fetchImpl(VOICES_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw failure(`免费声音列表暂时不可用（HTTP ${response.status}）`, 'TTS_SYNTHESIS_FAILED');
    const rows = await response.json();
    const voices = (Array.isArray(rows) ? rows : [])
      .map(row => ({ id: String(row?.ShortName || ''), locale: String(row?.Locale || ''), gender: String(row?.Gender || '') }))
      .filter(voice => VOICE_ID_PATTERN.test(voice.id))
      .map(voice => ({ ...voice, name: freeEdgeVoiceName(voice.id) }))
      // 中文在前（普通话 → 方言/港台），其余按 id。
      .sort((a, b) => {
        const rank = voice => (voice.locale === 'zh-CN' ? 0 : voice.locale.startsWith('zh-') ? 1 : 2);
        return rank(a) - rank(b) || a.id.localeCompare(b.id);
      });
    voicesCache = { at: now(), voices };
    return voices;
  }

  async function synth(text, { voiceRef, signal = null, native = {} } = {}) {
    const voice = String(voiceRef || FREE_EDGE_DEFAULT_VOICE);
    if (!VOICE_ID_PATTERN.test(voice)) throw failure('这不是一个免费声音的 voice id', 'TTS_SYNTHESIS_FAILED');
    const Impl = WebSocketImpl || loadWebSocket();
    const rate = native.rate || '+0%';
    const parts = [];
    for (const segment of splitSegments(text)) {
      signal?.throwIfAborted?.();
      parts.push(await synthSegment({ WebSocketImpl: Impl, text: segment, voice, rate, signal, timeoutMs, now }));
    }
    // mp3 帧可以直接首尾相接。
    return createTtsAudio({ bytes: Buffer.concat(parts), extension: 'mp3', source: FREE_EDGE_PROVIDER_ID });
  }

  return {
    id: FREE_EDGE_PROVIDER_ID,
    label: FREE_EDGE_LABEL,
    requiresCredentials: false,
    // 只在用户启用后才注册，所以注册即可用。
    isConfigured: () => true,
    // 只参与显式指定（伙伴绑定、试听、代读），不进入"未指定 provider 时的优先级回落"。
    explicitOnly: true,
    listVoices: () => keptVoices().map(voice => ({ id: voice.sourceVoiceId, name: voice.displayName })),
    fetchVoices,
    synth,
    performanceCapability: () => FREE_EDGE_PERFORMANCE_CAPABILITY,
    renderPerformance(text, performance) {
      const rendered = renderSpeech({}, text, performance);
      const rate = PACE_RATE[normalizePerformance(performance)?.pace];
      return { text: rendered.text, native: rate ? { rate } : {} };
    },
  };
}
