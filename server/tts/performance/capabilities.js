// performance/capabilities.js — 按 (协议, 模型) 声明的表演能力静态表。
//
// 合同（见 openspec speech-performance）：
// - 能力只来自这张代码内的表，不向供应商发试探请求；未命中的组合一律 NONE。
// - 每条记录注明核实日期与来源文档；供应商改了能力要回到文档重新核实再改表。
// - emotions：中立情绪 → 原生值（minimax 写 voice_setting.emotion；breeze 写进中文 instructions）。
//   events：中立事件 → 原生行内语法。没登记的情绪/事件在翻译时直接丢弃。

import { EVENT_MARKERS, MAX_INLINE_EVENTS, MAX_PAUSES, PAUSE_RANGE } from './markers.js';

export const NO_PERFORMANCE_CAPABILITY = Object.freeze({
  id: 'none',
  emotions: Object.freeze({}),
  events: Object.freeze({}),
  pauses: false,
  pace: false,
  intensity: false,
  direction: false,
});

const MINIMAX_SOURCE = 'https://platform.minimaxi.com/docs/api-reference/speech-t2a-http';
const BREEZE_SOURCE = 'https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech';

// MiniMax 情绪：warm/serious 没有对应原生值，不硬凑——不传时模型会按文本自动匹配情绪。
const MINIMAX_EMOTIONS = Object.freeze({ calm: 'calm', happy: 'happy', playful: 'happy', sad: 'sad', surprised: 'surprised' });

export const CAPABILITY_TABLE = Object.freeze([
  Object.freeze({
    id: 'minimax-speech-2.8',
    protocol: 'minimax',
    model: /^speech-2\.8-(?:hd|turbo)$/,
    // speech-2.8 不支持 whisper（2026-10-25 实测返回 invalid params，文档同样注明）。
    emotions: MINIMAX_EMOTIONS,
    events: Object.freeze({
      laugh: '(laughs)', chuckle: '(chuckle)', sigh: '(sighs)', breath: '(breath)', clear_throat: '(clear-throat)',
    }),
    pauses: true,
    pace: true,
    intensity: true,
    direction: false,
    verifiedAt: '2026-10-25',
    source: MINIMAX_SOURCE,
  }),
  Object.freeze({
    id: 'minimax-speech-legacy',
    protocol: 'minimax',
    // 语气词标签仅 speech-2.8 支持；停顿与情绪参数对这些模型生效。
    model: /^speech-(?:2\.6|02|01)-(?:hd|turbo)$/,
    emotions: MINIMAX_EMOTIONS,
    events: Object.freeze({}),
    pauses: true,
    pace: true,
    intensity: true,
    direction: false,
    verifiedAt: '2026-10-25',
    source: MINIMAX_SOURCE,
  }),
  Object.freeze({
    id: 'breeze-tts-2',
    protocol: 'breeze',
    model: /^breeze-tts-2(?:-multilingual)?$/,
    // Breeze 没有情绪枚举：所有风格都合成一句中文 instructions。
    emotions: Object.freeze({
      calm: '平静', warm: '温暖亲切', happy: '开心', playful: '俏皮轻快', sad: '低落伤感', surprised: '惊喜', serious: '认真',
    }),
    // 中文声音事件用方括号；没有“换气”，轻笑并入笑。
    events: Object.freeze({ laugh: '[笑]', chuckle: '[笑]', sigh: '[叹气]', clear_throat: '[清嗓子]' }),
    pauses: false,
    pace: true,
    intensity: true,
    direction: true,
    verifiedAt: '2026-10-25',
    source: BREEZE_SOURCE,
  }),
]);

/** 解析一个 (protocol, model) 的表演能力；未登记返回 NONE。 */
export function resolvePerformanceCapability({ protocol = '', model = '' } = {}) {
  const protocolId = String(protocol || '').trim();
  const modelId = String(model || '').trim();
  return CAPABILITY_TABLE.find(entry => entry.protocol === protocolId && entry.model.test(modelId))
    || NO_PERFORMANCE_CAPABILITY;
}

/** 能力是否允许任何表演。 */
export function capabilitySupportsPerformance(capability) {
  if (!capability || capability.id === 'none') return false;
  return Boolean(Object.keys(capability.emotions || {}).length || Object.keys(capability.events || {}).length
    || capability.pauses || capability.pace || capability.intensity || capability.direction);
}

/**
 * 给写作侧（串词素材）的可用清单：只列中立形式，不暴露任何原生语法。
 * NONE 返回 null，素材里就不出现表演段落。
 */
export function describeCapability(capability) {
  if (!capabilitySupportsPerformance(capability)) return null;
  const markers = Object.keys(capability.events || {}).map(event => EVENT_MARKERS[event]).filter(Boolean);
  if (capability.pauses) markers.push('{停顿:秒数}');
  return {
    markers,
    emotions: Object.keys(capability.emotions || {}),
    pace: Boolean(capability.pace),
    intensity: Boolean(capability.intensity),
    direction: Boolean(capability.direction),
    limits: {
      maxInlineEvents: Object.keys(capability.events || {}).length ? MAX_INLINE_EVENTS : 0,
      maxPauses: capability.pauses ? MAX_PAUSES : 0,
      pauseSeconds: capability.pauses ? [PAUSE_RANGE.min, PAUSE_RANGE.max] : null,
    },
  };
}
