// narrationTools.js — 串词受限任务的两个 typed 工具（一切皆 tool）。
//
// 合同：
// - get_track_narration_brief（只读、非终端）：返回锁定任务的确定性素材与写作要求，
//   包括场合（situation）、按优先级排列的知识（knowledge）、表达偏好、最近串词、聊天是否已介绍本曲，以及提交必须满足的
//   acceptanceRules（兜底规避事实）。不调模型，不改任何状态。
// - submit_track_narration（终端）：用既有的机械校验（narrationDefect）校验正文，
//   只有通过校验的正文才会被接受。拒绝是可纠正的 typed 失败，modelContext 点名
//   违反的规则 id；接受后登记 facts.text，由 NarrationAgent 经 onMessage 捕获。
//   工具自身不调模型、不写播放状态、不写记忆、不代表已经出声。
// - 表演意图（speech-performance）：任务锁定时按当前声音的能力写入 task.performance
//   （NONE 为 null）。素材只列这份能力里的中立标记；提交的 text 可以带白名单标记、
//   可选 performance 风格。标记按能力校验（超限/未知/越权/原生语法都可纠正地拒绝），
//   机械校验与 facts.text 一律用剥离标记后的纯文本，带标记原文另存 facts.spokenText。

import { createToolOutcome, ToolOutcomeKind } from '../virtual-person/VirtualPersonTypes.js';
import { narrationDefect, narrationRuleFeedback, sentenceCount } from './ProgramNarrationComposer.js';
import {
  EVENT_MARKERS, MAX_DIRECTION_CHARS, PERFORMANCE_EMOTIONS, PERFORMANCE_INTENSITIES, PERFORMANCE_PACES,
  hasPerformance, normalizePerformance, parseSpokenText, toPlainText,
} from '../tts/performance/markers.js';

export const NARRATION_CAPABILITY = 'narration';
export const NARRATION_BRIEF_TOOL_NAME = 'get_track_narration_brief';
export const NARRATION_SUBMIT_TOOL_NAME = 'submit_track_narration';
export const NARRATION_TASK_TOOLS = Object.freeze([NARRATION_BRIEF_TOOL_NAME, NARRATION_SUBMIT_TOOL_NAME]);

const brief = state => createToolOutcome({
  kind: ToolOutcomeKind.BUSINESS_FAILURE,
  code: 'NARRATION_TASK_UNAVAILABLE',
  modelContext: '这次没有可用的串词任务素材，请不要重试提交；本任务到此结束。',
  presentation: { displayText: '', speak: false, retryable: false },
  internal: { correlationId: state?.correlationId },
});

/**
 * 写作补充：只放随本次素材变化的提醒。按场合的写法、知识的用法和“始终如此”的原则都在
 * NarrationAgent 的 TASK_SYSTEM_PROMPT 里（稳定段落），这里不重复，也不再堆逐条禁令。
 */
function narrationWritingGuide(task) {
  const guide = [];
  if (task.chatAlreadyIntroducedCurrent === true) {
    guide.push('chatAlreadyIntroducedCurrent 为 true：聊天里最近已经介绍过这首歌，不要重复专辑、歌手背景等基础信息，简短带过。');
  }
  if (task.previousTrack) {
    guide.push('说“上一首/刚才那首”时只能指 previousTrack；用不用它由你决定，点名点歌时通常不必提。');
  }
  if (task.tasteProbe) {
    guide.push('situation.probe 存在：这首是特意安排的试听。可以一句带过想试试对方对这类歌的感觉，不能说成对方已经喜欢这类，也不提内部键名或验证机制。');
  }
  if (task.lifeScene) {
    guide.push('lifeScene 是用户授权的生活场景线索（是计划，不是正在发生的事实）：最多一句带过氛围，不念具体事项、时间或备注原文，不断言对方正在做什么。');
  }
  if (task.recommendation) {
    guide.push('recommendation 存在：用你自己的话交代这首来自 recommendation.recommender；理由只能概括 publicNote 里对方公开说过的内容，publicNote 为空就不替对方编理由；不要说成是你挑的。');
  }
  return guide;
}

/** 提交必须同时满足的机械规则；违反会被拒绝并按规则修改重试，超预算则使用确定性兜底。 */
function narrationAcceptanceRules(task) {
  const rules = [
    `至少 ${task.minChars} 个字符、${task.minSentences} 句，最多 ${task.maxChars} 个字符、${task.maxSentences} 句（中英文句末标点都计句）；平时按 lengthTarget 写。`,
    `必须准确出现歌名「${task.track?.title || ''}」与艺人「${task.track?.artist || ''}」的核心形式。`,
    '只能陈述素材中已核实的信息：不得出现未提供的年份，不得声称获奖、榜单、创作背景、改编关系、出道经历或不匹配的专辑归属。',
    '不得与 recentIntroductions 的句式骨架重复。',
    '不得复述听众说过的话（连续 8 个字符以上；歌名、歌手名和歌词本身除外）。',
    '歌词只能支撑你自己的判断，不能当内容：连续 30 个字符以上与歌词相同会被拒绝；两段以上歌词合计 12 字以上、或单段 16 字以上同样会被拒绝（成串复述歌词）。',
    '关于听众的记忆要用自己的话说；连续 12 个字符以上照抄记忆原文会被拒绝。',
    '不得出现链接、缓存/预热/命中等技术词，或声称刚刚搜索过；不得念出 occasion、voiceOfTurn、knowledge 等字段名或场合名。',
    task.previousTrack
      ? `承接“上一首/刚才那首”时只能指「${task.previousTrack.title}」；跨曲联想允许，但不能把别的歌说成刚播完的那一首。`
      : '本次没有实际前曲：不得承接“上一首/刚才那首”。',
  ];
  if (task.chatAlreadyIntroducedCurrent === true && task.facts?.album) {
    rules.push(`聊天已介绍过本曲和专辑《${task.facts.album}》：不要重复报道同一张专辑。`);
  }
  if (task.recommendation) {
    rules.push(`这首是「${task.recommendation.recommender}」推荐的：必须出现推荐人的名字并交代来源；不得自称挑选或推荐了它，不得把推荐归给其他成员。`);
  }
  return rules;
}

const SOUND_TAG_NOTE = '仅供参考，最多一句带过';

// 听感标签排在知识的最后：全部给出，但标明只作参考，不再按随机维度裁剪。
function soundTagsOf(facts = {}) {
  const list = value => (Array.isArray(value) ? value : []);
  return {
    note: SOUND_TAG_NOTE,
    genre: facts.genre || null, mood: facts.mood || null, tempo: facts.tempo || null, language: facts.language || null,
    instruments: list(facts.instruments), themes: list(facts.themes), scenes: list(facts.scenes),
    artistGenre: facts.artistGenre || null, artistRegion: facts.artistRegion || null,
  };
}

/** 表演段落：只在当前声音有能力时出现，列中立标记与上限，不暴露任何供应商原生语法。 */
function narrationPerformanceBrief(task) {
  const capability = task.performance;
  if (!capability) return null;
  const guide = ['表演是可选的：只在情绪需要时用，大多数句子不需要任何标记。'];
  if (capability.limits.maxInlineEvents) {
    guide.push(`语气标记直接写在正文里对应的位置，每段最多 ${capability.limits.maxInlineEvents} 个语气词`
      + (capability.limits.maxPauses ? `、${capability.limits.maxPauses} 个停顿` : '') + '；只能用 markers 里列出的写法。');
  } else if (capability.limits.maxPauses) {
    guide.push(`只能用 {停顿:秒数} 标记停顿，每段最多 ${capability.limits.maxPauses} 个。`);
  }
  if (capability.limits.pauseSeconds) {
    guide.push(`停顿秒数在 ${capability.limits.pauseSeconds[0]}–${capability.limits.pauseSeconds[1]} 之间，前后都要有要说的字。`);
  }
  guide.push('整段的语气用 submit_track_narration 的 performance 参数表达（emotion/pace/intensity'
    + (capability.direction ? '/direction' : '') + '），和这段话的内容相称，不要为了表演而表演。');
  return { ...capability, guide: guide.join('') };
}

/** brief 工具结果：全部是任务锁定的确定性素材，逐字可核实。 */
export function buildNarrationBrief(task) {
  const knowledge = task.knowledge || {};
  return {
    track: { title: task.track?.title || null, artist: task.track?.artist || null },
    situation: task.situation || null,
    // 顺序就是优先级：先找关于这首歌的事，再看歌词，再看曲库，最后才是听感标签。
    knowledge: {
      aboutThisSong: knowledge.aboutThisSong || { memories: [], liked: null },
      lyrics: knowledge.lyrics || null,
      catalog: knowledge.catalog || { album: task.facts?.album || null, year: task.facts?.year ?? null },
      soundTags: soundTagsOf(task.facts),
    },
    previousTrack: task.previousTrack ? { title: task.previousTrack.title, artist: task.previousTrack.artist } : null,
    recentIntroductions: Array.isArray(task.recentHostIntroductions) ? task.recentHostIntroductions : [],
    recentConversation: Array.isArray(task.recentConversation)
      ? task.recentConversation.map(turn => ({ role: turn.role, text: turn.text })) : [],
    expressionPreferences: Array.isArray(task.expressionPreferences) ? task.expressionPreferences : [],
    chatAlreadyIntroducedCurrent: task.chatAlreadyIntroducedCurrent === true,
    recommendation: task.recommendation
      ? { recommender: task.recommendation.recommender, publicNote: task.recommendation.publicNote || null } : null,
    lifeScene: task.lifeScene || null,
    ...(task.performance ? { performance: narrationPerformanceBrief(task) } : {}),
    lengthTarget: { minChars: task.minChars, maxChars: task.targetMaxChars ?? task.maxChars,
      minSentences: task.minSentences, maxSentences: task.targetMaxSentences ?? task.maxSentences },
    modeGuide: task.modeGuide || '',
    writingGuide: narrationWritingGuide(task),
    acceptanceRules: narrationAcceptanceRules(task),
    fallbackAvoidance: '正文必须同时满足上面的 acceptanceRules；不满足会被拒绝并要求修改后重试，超过重试预算时系统会改用一句确定性的简短兜底。不要向听众提及兜底机制，也不要直接索要或复述兜底句。',
  };
}

export const NARRATION_BRIEF_TOOL_DESCRIPTION = '读取本次串词任务的全部确定性素材：此刻的场合（situation）、按优先级排列的知识（关于这首歌的记忆与收藏、歌词节选、曲库事实、听感标签）、表达偏好、最近已说过的串词、长度目标与提交必须满足的 acceptanceRules。任务提示词末尾已附同样的素材；只在需要重读时调用。';
export const NARRATION_SUBMIT_TOOL_DESCRIPTION = '提交本次串词的唯一正文（没有引号、标题或舞台说明；只有素材里有 performance 段时，才可以使用其中列出的语气标记与 performance 参数）。正文会按素材里的 acceptanceRules 逐条机械校验：歌名与艺人必须准确出现，不得编造未提供的事实、复述听众原话、成串复述歌词、照抄记忆原文、重复最近串词的句式或重复聊天已介绍过的专辑信息。被拒绝时会告知违反的规则，按提示修改后重新提交一次完整正文；接受即结束本任务，不代表已经出声。';

const PERFORMANCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '可选：整段的说话语气。只有素材里有 performance 段时才有效，没有就省略。',
  properties: {
    emotion: { type: 'string', enum: [...PERFORMANCE_EMOTIONS] },
    pace: { type: 'string', enum: [...PERFORMANCE_PACES] },
    intensity: { type: 'string', enum: [...PERFORMANCE_INTENSITIES] },
    direction: { type: 'string', maxLength: MAX_DIRECTION_CHARS, description: '一句中文表演提示，如“像在耳边低声说话”。' },
  },
});

/**
 * 按任务锁定的表演能力校验正文里的标记；通过返回 null，否则返回 { rule, feedback }。
 * literal：歌名、艺人名写在花括号里时按原文处理，不算未知标记。
 */
function performanceDefect(text, task) {
  const capability = task.performance;
  const literal = [task.track?.title, task.track?.artist].filter(Boolean).map(value => `{${value}}`);
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
    return fail('performance-too-many-events', `语气词用了 ${parsed.eventCount} 个，每段最多 ${capability.limits.maxInlineEvents} 个。`);
  }
  if (parsed.pauseCount > capability.limits.maxPauses) {
    return fail('performance-too-many-pauses', `停顿用了 ${parsed.pauseCount} 个，每段最多 ${capability.limits.maxPauses} 个。`);
  }
  return null;
}

/** 串词工具唯一注册入口；重复注册同名工具时幂等跳过。 */
export function registerNarrationTools(registry) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('registerNarrationTools requires a tool registry');
  const registered = new Set(typeof registry.definitions === 'function'
    ? registry.definitions({ capabilities: [NARRATION_CAPABILITY] }).map(definition => String(definition?.function?.name || ''))
    : []);
  if (!registered.has(NARRATION_BRIEF_TOOL_NAME)) {
    registry.register(NARRATION_BRIEF_TOOL_NAME, {
      capability: NARRATION_CAPABILITY,
      readOnly: true,
      definition: { description: NARRATION_BRIEF_TOOL_DESCRIPTION,
        parameters: { type: 'object', additionalProperties: false, properties: {} } },
      handler: (args, context = {}) => {
        const task = context.narrationTaskRequest;
        if (!task) return brief(context);
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS,
          code: 'NARRATION_BRIEF',
          facts: buildNarrationBrief(task),
          modelContext: '以上是本次串词的全部素材与写作要求。只使用这里列出的信息；写完正文后调用 submit_track_narration 提交。',
          presentation: { displayText: '', speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
  }
  if (!registered.has(NARRATION_SUBMIT_TOOL_NAME)) {
    registry.register(NARRATION_SUBMIT_TOOL_NAME, {
      capability: NARRATION_CAPABILITY,
      definition: { description: NARRATION_SUBMIT_TOOL_DESCRIPTION,
        parameters: { type: 'object', additionalProperties: false, required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 700,
            description: '串词正文，直接可以念出来的话；只有素材有 performance 段时可以带其中列出的语气标记。' },
          performance: PERFORMANCE_SCHEMA } } },
      handler: (args, context = {}) => {
        const task = context.narrationTaskRequest;
        if (!task) return brief(context);
        if (context.signal?.aborted || (typeof context.isCurrent === 'function' && !context.isCurrent())) {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'STALE_NARRATION_TASK',
            modelContext: '这次串词任务已经失效（聊天已切换或输出代次已变化），不要再提交。',
            presentation: { displayText: '', speak: false, retryable: false },
            internal: { correlationId: context.correlationId },
          });
        }
        // 整响应必须完整结束：finishReason=length 等截断时提交的是残句，不能接受。
        if (context.finishReason != null && context.finishReason !== 'tool_calls') {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'NARRATION_TRUNCATED',
            modelContext: `上一次响应没有完整结束（${context.finishReason}），提交的正文可能不完整。请重新提交一次完整正文。`,
            presentation: { displayText: '', speak: false, retryable: true },
            internal: { correlationId: context.correlationId },
          });
        }
        const spoken = String(args.text || '').trim();
        const markerDefect = performanceDefect(spoken, task);
        if (markerDefect) {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'NARRATION_REJECTED',
            facts: { rejectedRule: markerDefect.rule },
            modelContext: `${markerDefect.feedback}\n请按提示修改正文后，用 submit_track_narration 重新提交一次完整正文。`,
            presentation: { displayText: '', speak: false, retryable: true },
            internal: { correlationId: context.correlationId },
          });
        }
        // 机械校验只看人读的纯文本：标记不计入长度、复述与歌词检查。
        const text = toPlainText(spoken);
        const performance = task.performance ? normalizePerformance(args.performance) : null;
        const performed = Boolean(task.performance) && hasPerformance(spoken, performance);
        const rule = narrationDefect(text, {
          track: { title: task.track?.title, artist: task.track?.artist },
          facts: task.facts || {},
          recentIntroductions: task.recentHostIntroductions || [],
          recentConversation: task.recentConversation || [],
          minSentences: task.minSentences ?? 1,
          previousTrack: task.previousTrack || null,
          chatIntroduced: task.chatAlreadyIntroducedCurrent === true,
          minChars: task.minChars ?? 20,
          recommendation: task.recommendation || null,
          lyricExcerpt: task.lyricExcerpt || null,
          memories: task.songMemories || [],
        });
        if (rule) {
          return createToolOutcome({
            kind: ToolOutcomeKind.BUSINESS_FAILURE,
            code: 'NARRATION_REJECTED',
            facts: { rejectedRule: rule },
            modelContext: `${narrationRuleFeedback(rule, task, text)}\n请按提示修改正文后，用 submit_track_narration 重新提交一次完整正文。`,
            presentation: { displayText: '', speak: false, retryable: true },
            internal: { correlationId: context.correlationId },
          });
        }
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS,
          code: 'TRACK_NARRATION_ACCEPTED',
          terminal: true,
          facts: { accepted: true, text, spokenText: performed && spoken !== text ? spoken : null,
            performance: performed ? performance : null, chars: text.length, sentences: sentenceCount(text) },
          modelContext: '正文已通过机械校验并被接受，本次任务结束；不要再提交第二次，也不要声称已经出声。',
          presentation: { displayText: '串词已提交。', speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
  }
  return registry;
}

export default registerNarrationTools;
