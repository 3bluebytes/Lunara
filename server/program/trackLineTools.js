// trackLineTools.js — line pass 里 host 写串词的唯一工具。
//
// 工具不碰队列：它只把通过校验的串词交给 pass 给的 target 保存。逐条校验，合格的立刻存下，
// 不合格的返回可纠正的原因；第二轮之后无论结果如何都结束这次 pass。风格类问题（STYLE_RULES）同一首只退回一次，
// 再交或最后一轮就存下并记 styleKept：风格不该让一首歌安静播放。

import { createToolOutcome, ToolOutcomeKind } from '../virtual-person/VirtualPersonTypes.js';
import { STYLE_RULES, narrationDefect, narrationRuleFeedback, overusedPhrases } from './ProgramNarrationComposer.js';
import {
  EVENT_MARKERS, MAX_DIRECTION_CHARS, PERFORMANCE_EMOTIONS, PERFORMANCE_INTENSITIES, PERFORMANCE_PACES,
  hasPerformance, normalizePerformance, parseSpokenText, toPlainText,
} from '../tts/performance/markers.js';
import { normalizeLineNote } from '../playback/playbackRuntimeTypes.js';

export const TRACK_LINES_CAPABILITY = 'track_lines';
export const TRACK_LINES_TOOL_NAME = 'write_track_lines';
export const TRACK_LINE_MAX_ROUNDS = 2;

const PERFORMANCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '可选：这一条的说话语气。素材没有提到表演就省略。',
  properties: {
    emotion: { type: 'string', enum: [...PERFORMANCE_EMOTIONS] },
    pace: { type: 'string', enum: [...PERFORMANCE_PACES] },
    intensity: { type: 'string', enum: [...PERFORMANCE_INTENSITIES] },
    direction: { type: 'string', maxLength: MAX_DIRECTION_CHARS, description: '一句中文表演提示，如“像在耳边低声说话”。' },
  },
});

const TOOL_DESCRIPTION = '提交你为这批歌写的串词：每条用 ref 指向一首歌，text 是这首歌开始时你会说的话，说多说少随你。可以少写，没写的歌会安静地放。不合格的那条会告诉你原因，可以改了再交一次；说法上的提醒只说一次，再交就存下。已经存下的不用重交。这个工具不改队列，也不代表已经说出口。';

/** 按当前声音的表演能力校验正文里的标记；通过返回 null，否则返回 { rule, feedback }。 */
export function performanceDefect(text, { performance: capability = null, track = null } = {}) {
  const literal = [track?.title, track?.artist].filter(Boolean).map(value => `{${value}}`);
  const parsed = parseSpokenText(text, { literal });
  const available = capability?.markers?.length ? `当前声音可用的标记：${capability.markers.join(' ')}。` : '';
  const fail = (rule, message) => ({ rule, feedback: `${message}${available}` });
  if (parsed.nativeSyntax.length) {
    return fail('performance-native-syntax', `正文里出现了供应商专用的写法（${parsed.nativeSyntax.slice(0, 3).join('、')}），不要使用。`);
  }
  if (!capability) {
    if (parsed.eventCount || parsed.pauseCount || parsed.invalid.length) {
      return fail('performance-unsupported', '当前声音不支持任何语气标记，请去掉所有花括号标记，只提交纯文本。');
    }
    return null;
  }
  const unknown = parsed.invalid.find(item => item.reason === 'unknown_marker');
  if (unknown) return fail('performance-unknown-marker', `${unknown.marker} 不是可用的语气标记。`);
  const badPause = parsed.invalid.find(item => item.reason !== 'unknown_marker');
  if (badPause) {
    if (!capability.limits.maxPauses) return fail('performance-unsupported-marker', '当前声音不支持停顿标记。');
    return fail('performance-invalid-pause', `${badPause.marker} 写法不对：停顿秒数必须在 ${capability.limits.pauseSeconds.join('–')} 之间。`);
  }
  const supported = new Set(capability.markers);
  const outside = parsed.segments.find(segment => (segment.type === 'event' && !supported.has(EVENT_MARKERS[segment.event]))
    || (segment.type === 'pause' && !capability.limits.maxPauses));
  if (outside) {
    return fail('performance-unsupported-marker',
      `当前声音不支持${outside.type === 'pause' ? '停顿标记' : ` ${EVENT_MARKERS[outside.event]} `}。`);
  }
  if (parsed.eventCount > capability.limits.maxInlineEvents) {
    return fail('performance-too-many-events', `语气词用了 ${parsed.eventCount} 个，每条最多 ${capability.limits.maxInlineEvents} 个。`);
  }
  if (parsed.pauseCount > capability.limits.maxPauses) {
    return fail('performance-too-many-pauses', `停顿用了 ${parsed.pauseCount} 个，每条最多 ${capability.limits.maxPauses} 个。`);
  }
  return null;
}

const finished = (code, context, facts = {}, modelContext = '这次串词写作结束。') => createToolOutcome({
  kind: ToolOutcomeKind.SUCCESS, code, terminal: true, facts, modelContext,
  presentation: { displayText: '', speak: false }, internal: { correlationId: context.correlationId },
});

const correctable = (code, context, facts, modelContext) => createToolOutcome({
  kind: ToolOutcomeKind.BUSINESS_FAILURE, code, facts, modelContext,
  presentation: { displayText: '', speak: false, retryable: true }, internal: { correlationId: context.correlationId },
});

/**
 * 这条要和哪些别的串词比重复：最近说过的、待念的、这一批里已经存下的。
 * 同一批的几条之后会挨着念出来，彼此看不见就会撞上同一个说法、同一首对比歌。
 */
function checksWithOthers(target, task) {
  const others = [...(Array.isArray(task.recentLines) ? task.recentLines : []), ...(Array.isArray(task.batchLines) ? task.batchLines : [])];
  const given = Array.isArray(target.checks.overusedPhrases) ? target.checks.overusedPhrases : [];
  return { ...target.checks, otherLines: others, overusedPhrases: [...new Set([...given, ...overusedPhrases(others)])] };
}

/** 单条校验：标记先查，机械规则只看人读的纯文本。合格返回要保存的内容，否则返回 { rule, feedback }。 */
function checkLine(entry, target, task, { lastRound = false } = {}) {
  const spoken = String(entry?.text || '').trim();
  const markerDefect = performanceDefect(spoken, { performance: task.performance, track: target.checks.track });
  if (markerDefect) return markerDefect;
  const text = toPlainText(spoken);
  const checks = checksWithOthers(target, task);
  const nudge = !target.styleNudged && !lastRound;
  const rule = narrationDefect(text, { ...checks, styleChecks: nudge });
  if (rule) {
    if (STYLE_RULES.has(rule)) target.styleNudged = true;
    return { rule, feedback: narrationRuleFeedback(rule, checks, text) };
  }
  if (!nudge) {
    const style = narrationDefect(text, checks);
    if (STYLE_RULES.has(style)) task.onStyleKept?.(style);
  }
  const performance = task.performance ? normalizePerformance(entry.performance) : null;
  const performed = Boolean(task.performance) && hasPerformance(spoken, performance);
  return { line: { text, spokenText: performed && spoken !== text ? spoken : null, performance: performed ? performance : null,
    about: normalizeLineNote(entry?.about), voiceProfileId: task.voiceProfileId || null, writtenAt: task.now(),
    membershipRevision: task.membershipRevision ?? null } };
}

export function registerTrackLineTools(registry) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('registerTrackLineTools requires a tool registry');
  const existing = typeof registry.definitions === 'function'
    ? registry.definitions({ capabilities: [TRACK_LINES_CAPABILITY] }).map(definition => String(definition?.function?.name || '')) : [];
  if (existing.includes(TRACK_LINES_TOOL_NAME)) return registry;
  registry.register(TRACK_LINES_TOOL_NAME, {
    capability: TRACK_LINES_CAPABILITY,
    definition: { description: TOOL_DESCRIPTION, parameters: {
      type: 'object', additionalProperties: false, required: ['lines'],
      properties: { lines: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['ref', 'text'],
        properties: {
          ref: { type: 'string', description: '歌的短引用，如 t1。' },
          text: { type: 'string', description: '这首歌开始时你会说的话，直接可以念出来。' },
          // 不设 maxLength：备忘写长了由服务端截断，不该让整次提交变成 schema 错误。
          about: { type: 'string', description: '可选：用一句话记下你聊这首歌的角度，不抄台词、不记听众私事。只留给你自己以后回忆。' },
          performance: PERFORMANCE_SCHEMA,
        } } } },
    } },
    handler: async (args, context = {}) => {
      const task = context.trackLineTask;
      if (!task) return finished('TRACK_LINE_PASS_UNAVAILABLE', context);
      // 成员令牌、取消和音乐负责人都收在 isCurrent 里：失效后这次写作直接结束，不再要模型重写。
      const live = () => !context.signal?.aborted && context.isCurrent?.() !== false;
      if (!live()) return finished('TRACK_LINE_PASS_STALE', context);
      const lastRound = Number(context.round) >= TRACK_LINE_MAX_ROUNDS;
      // 响应被截断时提交的可能是残句，一条都不能存。
      if (context.finishReason != null && context.finishReason !== 'tool_calls') {
        for (const target of task.targets.values()) target.lastRule ||= 'truncated';
        if (lastRound) return finished('TRACK_LINES_TRUNCATED', context);
        return correctable('TRACK_LINES_TRUNCATED', context, { finishReason: context.finishReason },
          `上一次响应没有完整结束（${context.finishReason}），一条都没有存。请再完整交一次。`);
      }
      const written = [];
      const rejected = [];
      const lines = Array.isArray(args?.lines) ? args.lines : [];
      for (const entry of lines) {
        const ref = String(entry?.ref || '').trim();
        const target = task.targets.get(ref);
        if (!target) {
          rejected.push({ ref, rule: 'unknown-ref', feedback: `没有 ${ref || '这个引用'} 这首歌。` });
          continue;
        }
        if (target.saved) continue;
        const checked = checkLine(entry, target, task, { lastRound });
        if (!checked.line) {
          target.lastRule = checked.rule;
          task.onRejected?.(checked.rule);
          rejected.push({ ref, rule: checked.rule, feedback: checked.feedback });
          continue;
        }
        if (!live()) return finished('TRACK_LINE_PASS_STALE', context);
        // 身份或代次对不上时 runtime 拒绝保存：这条静默作废，不要求重写。
        const saved = await target.save(checked.line);
        if (saved === false) { target.lastRule = 'stale'; target.closed = true; continue; }
        target.saved = true;
        (task.batchLines ||= []).push({ text: checked.line.text, title: target.checks.track?.title || '', artist: target.checks.track?.artist || '',
          about: checked.line.about });
        written.push(ref);
      }
      const facts = { written, rejected: rejected.map(({ ref, rule }) => ({ ref, rule })) };
      if (!rejected.length || lastRound) return finished('TRACK_LINES_SAVED', context, facts);
      const feedback = rejected.map(item => `${item.ref}（${item.rule}）：${item.feedback}`).join('\n');
      return correctable('TRACK_LINES_REJECTED', context, facts,
        `${written.length ? `已存下：${written.join('、')}，不用重交。\n` : ''}${feedback}\n可以改了再交一次；不想写的就不用交。`);
    },
  });
  return registry;
}
