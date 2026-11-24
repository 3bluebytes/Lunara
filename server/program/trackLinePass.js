// trackLinePass.js — 音乐落定之后，host 写串词的那一次模型调用。
//
// 输入：host 现成的 system prompt 和消息历史，以及一组 target（一首歌 + 存/弃它的办法）。
// 输出：没有。写好的串词由 target.save 存到 occurrence 或预热批次，没写成的走 target.fail，
// 这首歌安静播放。pass 自己的任何失败都留在这里，不影响已经提交的音乐。

import { resolveTaskSpec } from '../llmTasks.js';
import { historyForTrackLines } from './trackLineHistory.js';
import { TRACK_LINES_CAPABILITY, TRACK_LINES_TOOL_NAME, TRACK_LINE_MAX_ROUNDS } from './trackLineTools.js';

const reasonOf = error => String(error?.code || error?.name || 'failed').slice(0, 80);

export function createTrackLinePass({ agentLoop, getMaterial, sessionTrace = null, now = Date.now, budgetMs = null } = {}) {
  if (!agentLoop || typeof agentLoop.run !== 'function') throw new TypeError('createTrackLinePass requires agentLoop.run()');
  if (typeof getMaterial !== 'function') throw new TypeError('createTrackLinePass requires getMaterial()');
  const stats = { passes: 0, requested: 0, written: 0, rejected: {}, notWritten: {}, styleKept: {} };
  const countOf = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };

  /**
   * @param input.targets [{ track, save(line) -> boolean|Promise, fail(reason) }]
   * @param input.isCurrent 成员令牌、音乐负责人等写入前要再核对的条件
   */
  async function run({ sessionId, personId, systemPrompt, messages = [], targets = [], listenerAsked = false,
    requestId = '', isCurrent = null, signal = null, onContextUsage = null, playbackGap = null } = {}) {
    if (!targets.length) return { requested: 0, written: 0 };
    const traceContext = { sessionId, requestId, roundId: requestId, virtualPersonId: personId };
    const refs = new Map(targets.map((target, index) => [`t${index + 1}`, target]));
    const taskTargets = new Map();
    const rejected = {};
    const styleKept = {};
    let finish = 'completed';
    try {
      const material = getMaterial([...refs].map(([ref, target]) => ({ ref, track: target.track, note: target.note || null })),
        { sessionId, personId, listenerAsked, playbackGap });
      for (const entry of material.tracks) {
        taskTargets.set(entry.ref, { ...refs.get(entry.ref), checks: entry.checks, saved: false, lastRule: null });
      }
      const task = { targets: taskTargets, performance: material.performance, voiceProfileId: material.voiceProfileId,
        membershipRevision: material.membershipRevision, now,
        // 重复检查要看的别的串词：最近说过的、待念的，加上这一批里已经存下的。
        recentLines: Array.isArray(material.recentLines) ? material.recentLines : [], batchLines: [],
        onRejected: rule => { countOf(rejected, rule); countOf(stats.rejected, rule); },
        // 风格类提醒过一次、再交仍然那样写的：照样存下，只记数，给之后看串词质量用。
        onStyleKept: rule => { countOf(styleKept, rule); countOf(stats.styleKept, rule); } };
      const budget = Number(budgetMs) > 0 ? Number(budgetMs) : resolveTaskSpec('track_lines').timeoutMs;
      const runLoop = () => agentLoop.run({
        systemPrompt,
        // 选歌那一轮的标签、时长、打分和简报不带进写串词：它们会被当成听到过的说出来。
        messages: [...historyForTrackLines(messages), material.trigger],
        capabilities: [TRACK_LINES_CAPABILITY],
        modelProfileId: 'track_lines',
        toolNames: [TRACK_LINES_TOOL_NAME],
        correlationId: requestId,
        sessionId,
        signal,
        onContextUsage,
        profileOverrides: { maxRounds: TRACK_LINE_MAX_ROUNDS, emptyRetry: false, allowEmptyTerminalPresentation: true,
          deadlineMs: now() + budget },
        toolContext: { sessionId, requestId, roundId: requestId, virtualPersonId: personId, signal, isCurrent, trackLineTask: task },
      });
      const result = await (typeof sessionTrace?.enter === 'function' ? sessionTrace.enter(traceContext, runLoop) : runLoop());
      finish = result?.outcomes?.at(-1)?.code || 'text-only';
    } catch (error) {
      finish = reasonOf(error);
    }
    // 没存下的都归位：target 还没进 taskTargets（素材阶段就失败）的也要释放。
    let written = 0;
    const notWritten = {};
    for (const [ref, target] of refs) {
      const entry = taskTargets.get(ref);
      if (entry?.saved) { written += 1; continue; }
      const reason = entry?.lastRule || 'not-written';
      countOf(notWritten, reason);
      countOf(stats.notWritten, reason);
      try { await target.fail(reason); } catch { /* 这首歌反正安静播放，归位失败不影响别的歌 */ }
    }
    stats.passes += 1;
    stats.requested += refs.size;
    stats.written += written;
    try {
      const event = { type: 'track_line_pass_completed', requested: refs.size, written, rejected, notWritten, styleKept, finish };
      if (typeof sessionTrace?.recordScoped === 'function') sessionTrace.recordScoped(sessionId, event, { requestId, virtualPersonId: personId });
      else sessionTrace?.record?.(traceContext, event);
    } catch { /* 诊断失败不影响结果 */ }
    return { requested: refs.size, written, finish };
  }

  return Object.freeze({ run, stats: () => structuredClone(stats) });
}

/** 一轮 agent 里收集“这些歌提交之后要写串词”：提交发生在工具深处，写作在这一轮结束之后。 */
export function createLineCollector() {
  const targets = [];
  return { targets, collect(list = []) { targets.push(...list); } };
}
