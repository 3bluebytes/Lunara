// replyBeats.js — 结构化分拍表达协议（deliver_reply 与音乐提交工具共用 beats 槽位）。
//
// 职责：
//   - 按会话相处模式与是否群聊物理隔离 tool schema（仅单人 roleplay 开放 action）；
//   - 纯归一化（零正则拆括号、零正则语气猜测）与防伪造/泄露校验；
//   - 投影显示文本、TTS 发音文本、SpeechPerformance 映射与短距离过去时发声回显。

import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';
import {
  assertsArrangement,
  assertsPlayback,
  validateMusicLineTitles,
} from './committedLine.js';
import { stripPeerMarkers } from './peerMessage.js';
import { stripSpeakerLabel } from './speakerLabel.js';
import { unsafeDiagnosticText } from './turnFailure.js';
import { parseSpokenText, toPlainText } from '../tts/performance/markers.js';
import { parseRoleplaySegments, sanitizeSpeechForTts } from './roleplaySpeech.js';

export const REPLY_CAPABILITY = 'reply.structured';
export const DELIVER_REPLY_TOOL_NAME = 'deliver_reply';

export const DEFAULT_BEAT_PAUSE_MS = 650;
export const MIN_BEAT_PAUSE_MS = 300;
export const MAX_BEAT_PAUSE_MS = 1800;
export const MAX_VOICE_DIRECTION_CHARS = 25;

export const BEAT_PACES = Object.freeze(['slow', 'steady', 'lively', 'normal', 'fast']);
export const BEAT_INTENSITIES = Object.freeze(['soft', 'warm', 'bright', 'calm', 'normal', 'strong']);

const INTERNAL_FIELD_OR_TOOL_RE = /\b(?:deliver_reply|select_music|commit_music_selection|presence_respond|write_track_lines|pauseAfterMs|voiceProfileId|sourceTurnId|queueItemId|tool_calls|guidance_scale|voice_settings|interactionMode|beatProgress)\b/iu;
const JSON_KEY_LEAK_RE = /\{\s*"(?:say|action|spoken|voice|beats|pauseAfterMs|direction|pace|intensity|tool_calls)"\s*:/iu;
const VOICE_DIRECTION_DISALLOWED_RE = /(https?:\/\/|www\.|[{}[\]])/iu;
const BOOK_TITLE_SPAN_RE = /《[^》\n]{1,120}》|〈[^〉\n]{1,120}〉/gu;
const PAREN_STAGE_RE = /[（(]([^()（）\n]{1,500})[）)]/gu;
const ASTERISK_STAGE_RE = /\*([^\s*\n][^*\n]{0,498}[^\s*\n]|[^\s*\n])\*/gu;
const STAGE_SKIP_PAREN_RE = /^(?:[\d\s\-–—/.,:年月日号版]+|(?:[A-Za-z]|[一二三四五六七八九十百]+)|(?:feat\.?|ft\.?|live|remix|ver\.?|demo|instrumental|acoustic)[^）)]*)$/iu;

function protectBookTitles(text) {
  const saved = [];
  const masked = String(text ?? '').replace(BOOK_TITLE_SPAN_RE, token => {
    const key = `\uE000T${saved.length}\uE000`;
    saved.push(token);
    return key;
  });
  return { masked, saved };
}

function restoreBookTitles(text, saved) {
  return String(text ?? '').replace(/\uE000T(\d+)\uE000/g, (_, idx) => saved[Number(idx)] ?? '');
}

/** 识别书名号（《…》）和年份/feat 标注以外的舞台动作描写（（…）、(…)、*…*）。 */
export function hasUnquotedStageDirection(text) {
  const { masked } = protectBookTitles(text);
  if (!masked) return false;
  ASTERISK_STAGE_RE.lastIndex = 0;
  if (ASTERISK_STAGE_RE.test(masked)) return true;
  PAREN_STAGE_RE.lastIndex = 0;
  let match;
  while ((match = PAREN_STAGE_RE.exec(masked)) !== null) {
    const inner = String(match[1] || '').trim();
    if (inner && !STAGE_SKIP_PAREN_RE.test(inner)) return true;
  }
  return false;
}

/** 物理剥离书名号外误混入台词/spoken 的括号或星号动作描写，绝不误伤《明年今日（2007 Live）》或 {叹气}。 */
export function stripUnquotedStageDirections(text) {
  const { masked, saved } = protectBookTitles(text);
  if (!masked) return '';
  const stripped = masked
    .replace(PAREN_STAGE_RE, (full, inner) => (STAGE_SKIP_PAREN_RE.test(String(inner || '').trim()) ? full : ' '))
    .replace(ASTERISK_STAGE_RE, ' ');
  return restoreBookTitles(stripped, saved)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

const PACE_TO_PERFORMANCE = Object.freeze({
  slow: 'slow',
  steady: 'normal',
  normal: 'normal',
  lively: 'fast',
  fast: 'fast',
});

const INTENSITY_TO_PERFORMANCE = Object.freeze({
  soft: { intensity: 'soft' },
  normal: { intensity: 'normal' },
  strong: { intensity: 'strong' },
  bright: { intensity: 'strong' },
  warm: { emotion: 'warm' },
  calm: { emotion: 'calm' },
});

const PACE_ECHO_LABELS = Object.freeze({
  slow: '语速偏慢',
  steady: '语速平稳',
  normal: '语速平稳',
  lively: '语速偏快',
  fast: '语速偏快',
});

const INTENSITY_ECHO_LABELS = Object.freeze({
  soft: '声音偏轻柔',
  warm: '声线偏温和',
  bright: '声音偏明亮',
  calm: '语气偏沉静',
  normal: '力度平稳',
  strong: '力度偏强',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanFieldText(value) {
  return stripPeerMarkers(stripSpeakerLabel(String(value ?? ''))).text.trim();
}

function wrapActionParen(action) {
  const trimmed = String(action || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('（') && trimmed.endsWith('）')) || (trimmed.startsWith('(') && trimmed.endsWith(')'))) {
    return trimmed;
  }
  return `（${trimmed}）`;
}

function hasInternalLeak(text) {
  const value = String(text || '');
  return unsafeDiagnosticText(value) || INTERNAL_FIELD_OR_TOOL_RE.test(value) || JSON_KEY_LEAK_RE.test(value);
}

function clampPauseMs(value, isLast) {
  if (isLast) return 0;
  if (value === undefined || value === null || value === '') return DEFAULT_BEAT_PAUSE_MS;
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_BEAT_PAUSE_MS;
  return Math.min(MAX_BEAT_PAUSE_MS, Math.max(MIN_BEAT_PAUSE_MS, Math.round(num)));
}

function normalizeVoiceCue(raw) {
  if (!isPlainObject(raw)) return null;
  const pace = BEAT_PACES.includes(raw.pace) ? raw.pace : null;
  const intensity = BEAT_INTENSITIES.includes(raw.intensity) ? raw.intensity : null;
  const direction = typeof raw.direction === 'string'
    ? [...raw.direction.trim()].slice(0, MAX_VOICE_DIRECTION_CHARS).join('')
    : '';
  if (!pace && !intensity && !direction) return null;
  return {
    ...(pace ? { pace } : {}),
    ...(intensity ? { intensity } : {}),
    ...(direction ? { direction } : {}),
  };
}

export function buildBeatItemSchema({ allowAction = false } = {}) {
  const properties = {
    ...(allowAction ? {
      action: {
        type: 'string',
        maxLength: 600,
        description: '可选：简短的动作、神态或场景细节（仅私语独处模式开放；绝不进入 TTS 发音）。',
      },
    } : {}),
    say: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: '必填：这一拍展示在气泡里的干净台词（歌名、书名等括号如《明年今日（2007 Live）》原样保留）。',
    },
    spoken: {
      type: 'string',
      maxLength: 2000,
      description: '可选：专供语音合成的气口断句文本（可用白名单标记 {叹气}{轻笑}{换气}{停顿:0.5}）；省略则直接念 say。绝不放舞台动作。',
    },
    voice: {
      type: 'object',
      additionalProperties: false,
      description: '可选：物理发声控制；平常省略或传 null 锁定原生音色，仅真实发声变化时填写，同状态相邻拍复用完全一致的 voice。',
      properties: {
        pace: { type: 'string', enum: [...BEAT_PACES] },
        intensity: { type: 'string', enum: [...BEAT_INTENSITIES] },
        direction: { type: 'string', maxLength: 80, description: '不超过 25 字的纯物理声学词（音高、音量、气息量、松紧、颗粒感）。' },
      },
    },
    pauseAfterMs: {
      type: 'number',
      minimum: 0,
      maximum: 10000,
      description: '说完这一拍后到下一拍之间的停顿毫秒数（服务端钳制在 300..1800ms，默认约 650ms；最后一拍强制为 0）。',
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['say'],
    properties,
  };
}

export function buildBeatsArraySchema({ allowAction = false, minItems = 1, maxItems = 4 } = {}) {
  return {
    type: 'array',
    minItems,
    maxItems,
    items: buildBeatItemSchema({ allowAction }),
  };
}

/**
 * 在不放行非法 action 的前提下，把模型常传的可选 null 字段剥成缺省，
 * 以便 jsonSchemaValidator 准确校验枚举、字符串与嵌套对象。
 */
export function prepareBeatsArgs(args, { allowAction = false, optionalBeats = false } = {}) {
  if (!isPlainObject(args)) return args;
  const prepared = { ...args };
  if (optionalBeats && prepared.beats === null) {
    delete prepared.beats;
    return prepared;
  }
  if (!Array.isArray(prepared.beats)) return prepared;
  prepared.beats = prepared.beats.map(raw => {
    if (!isPlainObject(raw)) return raw;
    const beat = { ...raw };
    if (allowAction && beat.action === null) delete beat.action;
    if (beat.spoken === null) delete beat.spoken;
    if (beat.pauseAfterMs === null) delete beat.pauseAfterMs;
    if (beat.voice === null) {
      delete beat.voice;
    } else if (isPlainObject(beat.voice)) {
      const voice = { ...beat.voice };
      if (voice.pace === null) delete voice.pace;
      if (voice.intensity === null) delete voice.intensity;
      if (voice.direction === null) delete voice.direction;
      if (Object.keys(voice).length === 0) delete beat.voice;
      else beat.voice = voice;
    }
    return beat;
  });
  return prepared;
}

export function normalizeReplyBeats(rawBeats, { allowAction = false, preserveAudio = false } = {}) {
  if (!Array.isArray(rawBeats) || !rawBeats.length) return [];
  const list = rawBeats.filter(isPlainObject);
  const lastIndex = list.length - 1;
  return list.map((raw, index) => {
    const action = allowAction && typeof raw.action === 'string' ? cleanFieldText(raw.action) : '';
    const say = cleanFieldText(raw.say);
    const spoken = typeof raw.spoken === 'string' ? cleanFieldText(raw.spoken) : '';
    const voice = normalizeVoiceCue(raw.voice);
    const pauseAfterMs = clampPauseMs(raw.pauseAfterMs, index === lastIndex);
    const audioUrl = preserveAudio && typeof raw.audioUrl === 'string' && raw.audioUrl.trim() ? raw.audioUrl.trim() : '';
    const hash = preserveAudio && typeof raw.hash === 'string' && raw.hash.trim() ? raw.hash.trim() : '';
    const durationMs = preserveAudio && Number.isFinite(Number(raw.durationMs)) ? Number(raw.durationMs) : null;
    return {
      index,
      ...(action ? { action } : {}),
      say,
      ...(spoken ? { spoken } : {}),
      ...(voice ? { voice } : {}),
      pauseAfterMs,
      ...(audioUrl ? { audioUrl, ...(hash ? { hash } : {}), ...(durationMs != null ? { durationMs } : {}) } : {}),
    };
  });
}

export function beatsToVisibleText(beats = []) {
  return (Array.isArray(beats) ? beats : [])
    .map(beat => {
      if (!beat || typeof beat !== 'object') return '';
      const action = beat.action ? wrapActionParen(beat.action) : '';
      const say = String(beat.say || '').trim();
      return [action, say].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

export function wrapPlainTextAsBeats(finalText) {
  const say = String(finalText || '').trim();
  if (!say) return [];
  return [{ index: 0, say, pauseAfterMs: 0 }];
}

const MAX_SPLIT_BEATS = 4;
const OUTER_PARENS_RE = /^[（(]([\s\S]*)[）)]$/u;
const SPEECH_QUOTE_RE = /[“”「」"]/gu;

/** 引号包着的台词（可能连着几句「“…”\n“…”」）去掉引号，只留要说的话。 */
function stripSpeechQuotes(content) {
  const text = String(content || '').trim();
  if (!/^[“「"]/u.test(text)) return text;
  return text.split(/\n+/u).map(line => line.replace(SPEECH_QUOTE_RE, '').trim()).filter(Boolean).join('\n');
}

/**
 * 私语纯文本（模型没走 deliver_reply）按现有私语解析器拆成 action/say 分拍：
 * 动作或叙述归 action，引号台词或独立台词归 say；拆不出动作时返回空数组，交给调用方整段一拍。
 * Python 伪代码：
 *   segs = parse_roleplay_segments(text)
 *   if not any(s.type == "action" for s in segs): return []
 *   beats = group_each_action_with_following_speech(segs)[:4]   # 多出的并入最后一拍
 */
function splitRoleplayText(text) {
  const parsed = parseRoleplaySegments(String(text || ''));
  if (!parsed?.hasAction) return [];
  const groups = [];
  let current = null;
  for (const segment of parsed.segments) {
    const content = String(segment?.content || '').trim();
    if (!content) continue;
    if (segment.type === 'action') {
      if (!current || current.say.length) {
        current = { action: [], say: [] };
        groups.push(current);
      }
      current.action.push(content.replace(OUTER_PARENS_RE, '$1').trim());
    } else {
      if (!current) {
        current = { action: [], say: [] };
        groups.push(current);
      }
      current.say.push(stripSpeechQuotes(content));
    }
  }
  if (groups.length > MAX_SPLIT_BEATS) {
    const tail = groups.splice(MAX_SPLIT_BEATS - 1);
    groups.push({ action: tail.flatMap(group => group.action), say: tail.flatMap(group => group.say) });
  }
  const lastIndex = groups.length - 1;
  return groups.map((group, index) => ({
    index,
    ...(group.action.length ? { action: group.action.join('\n') } : {}),
    say: group.say.join('\n'),
    pauseAfterMs: index === lastIndex ? 0 : DEFAULT_BEAT_PAUSE_MS,
  }));
}

/** 模型回纯文本时入账用的分拍：私语单聊按解析器拆开，其余整段一拍；私语里有括号动作却拆不开时返回空数组。 */
export function fallbackBeatsForPlainText(finalText, { allowAction = false } = {}) {
  if (allowAction) {
    const split = splitRoleplayText(finalText);
    if (split.length) return split;
    if (hasUnquotedStageDirection(finalText)) return [];
  }
  return wrapPlainTextAsBeats(finalText);
}

/** 已入账的单拍回合是否把叙述/动作与台词混在一拍 say 里（纯文本兜底的旧产物）。 */
export function isMixedRoleplayBeats(beats) {
  if (!Array.isArray(beats) || beats.length !== 1) return false;
  const beat = beats[0];
  if (!beat || beat.action || beat.spoken || beat.voice) return false;
  const say = String(beat.say || '');
  return hasUnquotedStageDirection(say) || Boolean(parseRoleplaySegments(say)?.hasAction);
}

/**
 * 自己带分拍的历史回复，以「调用 deliver_reply + 已送达」回放给模型，让历史示范真实的交付方式。
 * 参数只含 say（私语单聊另含 action）；发声状态回显放进工具结果。不改账本。
 */
export function replayDeliveredBeatMessages(turn, { allowAction = false, voiceEcho = '' } = {}) {
  const stored = Array.isArray(turn?.message?.beats) ? turn.message.beats : [];
  const source = allowAction && isMixedRoleplayBeats(stored) ? splitRoleplayText(stored[0].say) : stored;
  const beats = source
    .filter(beat => beat && typeof beat === 'object')
    .map(beat => ({
      ...(allowAction && typeof beat.action === 'string' && beat.action.trim() ? { action: beat.action.trim() } : {}),
      say: String(beat.say || '').trim(),
    }))
    .filter(beat => beat.say || beat.action);
  const id = `replay_${String(turn?.turnId || '')}`;
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: DELIVER_REPLY_TOOL_NAME, arguments: JSON.stringify({ beats }) } }] },
    { role: 'tool', tool_call_id: id, content: voiceEcho ? `已送达。${voiceEcho}` : '已送达。' },
  ];
}

export function beatSpokenText(beat) {
  if (!beat || typeof beat !== 'object') return '';
  const source = typeof beat.spoken === 'string' && beat.spoken.trim()
    ? beat.spoken
    : (typeof beat.say === 'string' ? beat.say : '');
  const withoutStage = stripUnquotedStageDirections(source);
  const cleaned = sanitizeSpeechForTts(withoutStage);
  if (!cleaned || !sanitizeSpeechForTts(toPlainText(cleaned))) return '';
  return cleaned;
}

export function toSpeechPerformance(beatVoice) {
  if (!isPlainObject(beatVoice)) return null;
  const pace = PACE_TO_PERFORMANCE[beatVoice.pace] || null;
  const mappedIntensity = INTENSITY_TO_PERFORMANCE[beatVoice.intensity] || {};
  const direction = typeof beatVoice.direction === 'string' ? beatVoice.direction.trim() : '';
  const out = {
    ...(mappedIntensity.emotion ? { emotion: mappedIntensity.emotion } : {}),
    ...(pace ? { pace } : {}),
    ...(mappedIntensity.intensity ? { intensity: mappedIntensity.intensity } : {}),
    ...(direction ? { direction } : {}),
  };
  return Object.keys(out).length ? out : null;
}

export function hasBeatVoiceCue(beatVoice) {
  return Boolean(normalizeVoiceCue(beatVoice));
}

export function formatTurnVoiceEcho(beats = []) {
  if (!Array.isArray(beats) || !beats.length) return '';
  const finalBeat = beats.at(-1);
  const voice = normalizeVoiceCue(finalBeat?.voice);
  if (!voice) return '';
  const parts = [];
  if (voice.direction) parts.push(voice.direction);
  if (voice.pace && PACE_ECHO_LABELS[voice.pace]) parts.push(PACE_ECHO_LABELS[voice.pace]);
  if (voice.intensity && INTENSITY_ECHO_LABELS[voice.intensity]) parts.push(INTENSITY_ECHO_LABELS[voice.intensity]);
  return parts.length ? `[当时你的发声状态：${parts.join('，')}]` : '';
}

export function validateReplyBeats(
  rawBeats,
  {
    allowAction = false,
    minItems = 1,
    maxItems = 4,
    allowMusicClaims = false,
    allowedTitles = null,
    othersTitles = null,
    truncateVoiceDirection = false,
  } = {},
) {
  const fail = (reason, modelContext) => ({ ok: false, reason, modelContext });
  if (!Array.isArray(rawBeats) || rawBeats.length < minItems || rawBeats.length > maxItems) {
    return fail('invalid_beat_count', `beats 必须是包含 ${minItems} 到 ${maxItems} 拍的数组；请按分拍结构重新提交。`);
  }
  const hasAllowedTitles = Array.isArray(allowedTitles) && allowedTitles.length > 0;

  for (let i = 0; i < rawBeats.length; i += 1) {
    const item = rawBeats[i];
    if (!isPlainObject(item)) {
      return fail('invalid_beat_item', `第 ${i + 1} 拍必须是对象；请修正后重新提交。`);
    }
    if (!allowAction && Object.hasOwn(item, 'action')) {
      return fail('action_not_allowed', '当前处于电台伴听或群聊模式，beats 里不允许传 action 字段；请移除 action 后重新提交。');
    }
    if (allowAction && item.action !== undefined && item.action !== null) {
      if (typeof item.action !== 'string') {
        return fail('invalid_action', `第 ${i + 1} 拍的 action 必须是字符串。`);
      }
      const actionText = cleanFieldText(item.action);
      if ([...actionText].length > 600) {
        return fail('action_too_long', `第 ${i + 1} 拍的 action 过长（超过 600 字），请精简动作描写。`);
      }
      if (hasInternalLeak(actionText)) {
        return fail('internal_leak', '动作或台词中包含了内部字段、工具名或系统诊断信息，请去掉后重新提交。');
      }
      if (assertsPlayback(actionText) || (!allowMusicClaims && assertsArrangement(actionText))) {
        return fail('ungrounded_music_claim', '没有已确认的音乐提交时，不要在 action 中宣称正在播放、切歌或已排入队列。');
      }
    }

    const sayText = typeof item.say === 'string' ? cleanFieldText(item.say) : '';
    if (!sayText) {
      return fail('empty_say', `第 ${i + 1} 拍缺少非空的 say 台词内容；请填写这一拍要说的话。`);
    }
    if ([...sayText].length > 2000) {
      return fail('say_too_long', `第 ${i + 1} 拍的 say 超过了 2000 字上限，请拆分或精简。`);
    }
    if (!truncateVoiceDirection && allowAction && hasUnquotedStageDirection(sayText)) {
      return fail(
        'stage_direction_in_say',
        `第 ${i + 1} 拍的 say 里不要夹带括号（…）或星号动作/神态描写；请把动作移到那一拍的 action 字段、发声状态移到 voice，say 只留要念出来的干净台词（《歌名（Live）》照常保留）。`,
      );
    }
    if (hasInternalLeak(sayText)) {
      return fail('internal_leak', '回复内容里出现了内部工具名、字段或 JSON 片段，请改为自然对话后重新提交。');
    }
    if (assertsPlayback(sayText)) {
      return fail('ungrounded_playback_claim', '工具提交或回复不等于扬声器已经出声，不要说“已经在放/正在播/已经切过去”。请修改后重新提交。');
    }
    if (!allowMusicClaims) {
      if (assertsArrangement(sayText)) {
        return fail('ungrounded_arrangement_claim', '没有成功提交选歌工具之前，不要说“已经排好/已经安排/加入队列”；如需放歌请先调用选歌工具。');
      }
    } else if (hasAllowedTitles) {
      const titleCheck = validateMusicLineTitles(sayText, { allowedTitles, othersTitles });
      if (!titleCheck.ok) {
        return fail(
          titleCheck.reason,
          titleCheck.reason === 'others_title_self_claim'
            ? '不要把本轮其他伙伴推荐的歌说成是你自己挑的；请如实归属或只提自己选的歌。'
            : 'beats 中提到的歌名与本轮实际提交的曲目不一致；请只提本轮已提交的歌名。',
        );
      }
    } else if (assertsArrangement(sayText)) {
      return fail('shortfall_arrangement_claim', '本次实际提交曲目不足请求数量，请不要在台词中替系统宣称已全部排好，系统会另附权威回执。');
    }

    if (item.spoken !== undefined && item.spoken !== null) {
      if (typeof item.spoken !== 'string') {
        return fail('invalid_spoken', `第 ${i + 1} 拍的 spoken 必须是字符串。`);
      }
      const spokenText = cleanFieldText(item.spoken);
      if ([...spokenText].length > 2000) {
        return fail('spoken_too_long', `第 ${i + 1} 拍的 spoken 超过了 2000 字上限。`);
      }
      if (!truncateVoiceDirection && hasUnquotedStageDirection(spokenText)) {
        return fail(
          'stage_direction_in_spoken',
          `第 ${i + 1} 拍的 spoken 里不允许出现括号或星号动作描写；spoken 仅写实际念出来的声音和白名单气口标记，请清理后重新提交。`,
        );
      }
      if (hasInternalLeak(spokenText) || assertsPlayback(spokenText) || (!allowMusicClaims && assertsArrangement(spokenText))) {
        return fail('invalid_spoken_content', 'spoken 中出现了未授权的播放宣称或内部字段，请改为纯口语文本。');
      }
      const parsedSpoken = parseSpokenText(spokenText);
      if (parsedSpoken.nativeSyntax.length > 0 || parsedSpoken.invalid.length > 0) {
        return fail(
          'invalid_spoken_markers',
          'spoken 中只能使用受支持的白名单标记 {笑}{轻笑}{叹气}{换气}{清嗓子}{停顿:0.2~2.0}，不能写原生标记或未定义的汉字花括号；请修正后重新提交。',
        );
      }
    }

    if (item.voice !== undefined && item.voice !== null) {
      if (!isPlainObject(item.voice)) {
        return fail('invalid_voice', `第 ${i + 1} 拍的 voice 必须是对象或 null。`);
      }
      if (item.voice.pace !== undefined && item.voice.pace !== null && !BEAT_PACES.includes(item.voice.pace)) {
        return fail('invalid_voice_pace', `voice.pace 只能是 ${BEAT_PACES.join(' / ')}。`);
      }
      if (item.voice.intensity !== undefined && item.voice.intensity !== null && !BEAT_INTENSITIES.includes(item.voice.intensity)) {
        return fail('invalid_voice_intensity', `voice.intensity 只能是 ${BEAT_INTENSITIES.join(' / ')}。`);
      }
      if (item.voice.direction !== undefined && item.voice.direction !== null) {
        if (typeof item.voice.direction !== 'string') {
          return fail('invalid_voice_direction', 'voice.direction 必须是字符串。');
        }
        const direction = item.voice.direction.trim();
        if (!truncateVoiceDirection && [...direction].length > MAX_VOICE_DIRECTION_CHARS) {
          return fail(
            'voice_direction_too_long',
            `voice.direction 不能超过 ${MAX_VOICE_DIRECTION_CHARS} 个字（当前 ${[...direction].length} 字）；请浓缩为纯物理声学特征或留空。`,
          );
        }
        if (hasInternalLeak(direction) || VOICE_DIRECTION_DISALLOWED_RE.test(direction)) {
          return fail('invalid_voice_direction_content', 'voice.direction 不能包含花括号、方括号、网址或内部字段，请只写物理声学描述。');
        }
      }
    }
  }

  return { ok: true, beats: normalizeReplyBeats(rawBeats, { allowAction }) };
}

export function registerDeliverReplyTool(registry) {
  if (!registry || typeof registry.register !== 'function') {
    throw new TypeError('registerDeliverReplyTool requires a tool registry');
  }
  const allowActionFor = ({ interactionMode = 'radio', isGroup = false } = {}) =>
    interactionMode === 'roleplay' && !isGroup;

  return registry.register(DELIVER_REPLY_TOOL_NAME, {
    capability: REPLY_CAPABILITY,
    resolveDefinition: ({ interactionMode = 'radio', isGroup = false } = {}) => {
      const allowAction = allowActionFor({ interactionMode, isGroup });
      return {
        description: allowAction
          ? '以结构化分拍（1..4 拍）交付本轮回复并结束对话。私语独处模式下每拍可将简短动作放进 action、台词放进 say（合法歌名/书名括号原样保留），绝不把动作放进 spoken；平常省略 voice 以保持原生声纹稳定。调用成功后本轮立即结束。'
          : '以结构化分拍（1..4 拍）交付本轮回复并结束对话。电台伴听或群聊模式下只写口语台词 say（合法歌名/书名括号原样保留），不写舞台动作；平常省略 voice 以保持原生声纹稳定。调用成功后本轮立即结束。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['beats'],
          properties: {
            beats: buildBeatsArraySchema({ allowAction, minItems: 1, maxItems: 4 }),
          },
        },
      };
    },
    prepareArgs: (args, { interactionMode = 'radio', isGroup = false } = {}) =>
      prepareBeatsArgs(args, { allowAction: allowActionFor({ interactionMode, isGroup }), optionalBeats: false }),
    handler: async (args, context = {}) => {
      if (context.finishReason === 'length') {
        return createToolOutcome({
          kind: ToolOutcomeKind.BUSINESS_FAILURE,
          code: 'REPLY_TRUNCATED',
          modelContext: '上一条工具调用因输出长度被截断，请精简分拍后重新调用 deliver_reply。',
          presentation: { displayText: '', speak: false, retryable: true },
          internal: { correlationId: context.correlationId },
        });
      }
      const allowAction = allowActionFor({
        interactionMode: context.interactionMode,
        isGroup: Boolean(context.isGroup),
      });
      const validated = validateReplyBeats(args?.beats, {
        allowAction,
        minItems: 1,
        maxItems: 4,
        allowMusicClaims: false,
      });
      if (!validated.ok) {
        return createToolOutcome({
          kind: ToolOutcomeKind.BUSINESS_FAILURE,
          code: 'INVALID_REPLY_BEATS',
          facts: { reason: validated.reason },
          modelContext: validated.modelContext,
          presentation: { displayText: '', speak: false, retryable: true },
          internal: { correlationId: context.correlationId },
        });
      }
      const displayText = beatsToVisibleText(validated.beats);
      return createToolOutcome({
        kind: ToolOutcomeKind.SUCCESS,
        code: 'REPLY_DELIVERED',
        terminal: true,
        facts: { beatCount: validated.beats.length },
        modelContext: '回复已按结构化分拍交付，本轮结束。',
        presentation: {
          displayText,
          speak: false,
          beats: validated.beats,
        },
        internal: { correlationId: context.correlationId },
      });
    },
  });
}
