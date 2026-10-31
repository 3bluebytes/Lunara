// performance/render.js — 中立表演 → 各协议原生语法的翻译器。
//
// 输入：含中立标记的发声文本 + SpeechPerformance + 已解析的能力；
// 输出：{ text, native }。text 是真正发给供应商的文本（绝不残留中立标记），
// native 是该协议要合并进请求体的原生字段（没有表演时为 {}，请求体与现状一致）。
// 能力不支持的一律静默丢弃；违反供应商约束的停顿同样丢弃而不是发出去碰运气。

import {
  MAX_INLINE_EVENTS, MAX_PAUSES, normalizePerformance, parseSpokenText, tidySpacing,
} from './markers.js';
import { NO_PERFORMANCE_CAPABILITY } from './capabilities.js';

const PACE_SPEED = Object.freeze({ slow: 0.9, fast: 1.08 });
// MiniMax voice_modify.intensity：接近 100 更轻柔，接近 -100 更刚劲。
const MINIMAX_INTENSITY = Object.freeze({ soft: 40, strong: -30 });
const BREEZE_PACE = Object.freeze({ slow: '语速放慢', fast: '语速稍快' });
const BREEZE_INTENSITY = Object.freeze({ soft: '声音轻柔', strong: '情绪饱满' });
const BREEZE_GUIDANCE_WITH_INSTRUCTIONS = 4;

const SPEAKABLE = /[\p{L}\p{N}]/u;
const speakableText = segment => segment?.type === 'text' && SPEAKABLE.test(segment.text);
const formatSeconds = seconds => String(Math.round(seconds * 100) / 100);

/** 行内部分：按能力翻译语气词与停顿，超限与违约束的丢弃。 */
function renderInline(text, capability, protocol) {
  const source = String(text ?? '');
  const parsed = parseSpokenText(source);
  const strippedInvalid = parsed.invalid.some(item => item.reason !== 'unknown_marker');
  if (!parsed.eventCount && !parsed.pauseCount && !strippedInvalid) return source.trim();
  const events = capability.events || {};
  let usedEvents = 0;
  let usedPauses = 0;
  const out = parsed.segments.map((segment, index) => {
    if (segment.type === 'text') return segment.text;
    if (segment.type === 'event') {
      const native = events[segment.event];
      if (!native || usedEvents >= MAX_INLINE_EVENTS) return ' ';
      usedEvents += 1;
      return native;
    }
    // 停顿：目前只有 MiniMax 支持，且要求两侧都是可发音文字、不能连续。
    if (!capability.pauses || protocol === 'breeze' || usedPauses >= MAX_PAUSES) return ' ';
    if (!speakableText(parsed.segments[index - 1]) || !speakableText(parsed.segments[index + 1])) return ' ';
    usedPauses += 1;
    return `<#${formatSeconds(segment.seconds)}#>`;
  });
  return tidySpacing(out.join(''));
}

function renderMinimaxStyle(style, capability) {
  const voiceSetting = {};
  const voiceModify = {};
  const emotion = style.emotion ? capability.emotions?.[style.emotion] : null;
  if (emotion) voiceSetting.emotion = emotion;
  if (capability.pace && PACE_SPEED[style.pace]) voiceSetting.speed = PACE_SPEED[style.pace];
  if (capability.intensity && MINIMAX_INTENSITY[style.intensity] !== undefined) voiceModify.intensity = MINIMAX_INTENSITY[style.intensity];
  return {
    ...(Object.keys(voiceSetting).length ? { voice_setting: voiceSetting } : {}),
    ...(Object.keys(voiceModify).length ? { voice_modify: voiceModify } : {}),
  };
}

function renderBreezeStyle(style, capability) {
  const parts = [];
  const emotion = style.emotion ? capability.emotions?.[style.emotion] : null;
  if (emotion) parts.push(`用${emotion}的语气说`);
  if (capability.pace && BREEZE_PACE[style.pace]) parts.push(BREEZE_PACE[style.pace]);
  if (capability.intensity && BREEZE_INTENSITY[style.intensity]) parts.push(BREEZE_INTENSITY[style.intensity]);
  const direction = capability.direction && style.direction ? style.direction : '';
  const instructions = [parts.length ? `${parts.join('，')}。` : '', direction].join('').trim();
  if (!instructions) return {};
  const voiceSettings = { guidance_scale: BREEZE_GUIDANCE_WITH_INSTRUCTIONS };
  if (capability.pace && PACE_SPEED[style.pace]) voiceSettings.speed = PACE_SPEED[style.pace];
  return { instructions, voice_settings: voiceSettings };
}

/**
 * 翻译一段发声。
 * @param {{ protocol?: string, capability?: object }} target protocol 决定原生字段形状；capability 缺省视为 NONE。
 * @param {string} text 含中立标记的发声文本
 * @param {object|null} performance SpeechPerformance
 * @returns {{ text: string, native: object }}
 */
export function renderSpeech({ protocol = '', capability = NO_PERFORMANCE_CAPABILITY } = {}, text, performance) {
  const resolved = capability || NO_PERFORMANCE_CAPABILITY;
  const protocolId = String(protocol || resolved.protocol || '');
  const rendered = renderInline(text, resolved, protocolId);
  const style = normalizePerformance(performance);
  if (!style || resolved.id === 'none') return { text: rendered, native: {} };
  if (protocolId === 'minimax') return { text: rendered, native: renderMinimaxStyle(style, resolved) };
  if (protocolId === 'breeze') return { text: rendered, native: renderBreezeStyle(style, resolved) };
  return { text: rendered, native: {} };
}
