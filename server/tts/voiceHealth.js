// voiceHealth.js — 声音接口的派生健康状态与用户可见提醒。
//
// 伙伴的每次发声（聊天语音、串词）在 synthesizeForPerson 里上报结果：
// 可归因的失败按稳定错误码映射成封闭原因，只在原因变化时广播一次
// { type:'voice-endpoint-status', endpoint, displayName, code }；之后成功广播 code=null。
// 调用方取消（串词过期、切聊天）不是声音故障，不提醒；预算超时算 timeout。
// 主声音失败但已由代读声音念出时，提醒再带 fallback:{endpoint, displayName}，界面据此改说"正在代读"。
// 不落库、不带上游原文/key/文本，进程重启即清空。
// 另外每次可归因的失败（不去重）都交给 record 写本地失败记录，带 provider 的分段耗时；
// 判定取消/超时的规则与提醒一致。record 出错不影响提醒与发声。

import { synthesisReasonOfError } from './boundedSynthesis.js';
import { synthesisTimingOf } from './synthesisTiming.js';

const isTimeout = reason => reason?.name === 'TimeoutError';

export function createVoiceHealth({ displayNameOf = () => null, record = null } = {}) {
  const issues = new Map();
  const incidents = new Map();
  const listeners = new Set();
  const nameOf = endpoint => String(displayNameOf(endpoint) || endpoint).slice(0, 120);
  const emit = (endpoint, code, fallback = null) => {
    const message = { type: 'voice-endpoint-status', endpoint, displayName: nameOf(endpoint), code };
    if (fallback) message.fallback = { endpoint: fallback, displayName: nameOf(fallback) };
    for (const listener of listeners) {
      try { listener(message); } catch { /* 提醒不影响发声 */ }
    }
  };

  /** 一次合成的结果：error 为空表示成功。 */
  function observe(endpoint, { error = null, signal = null, fallback = null, elapsedMs = null } = {}) {
    if (!endpoint) return;
    if (!error) {
      if (issues.delete(endpoint)) {
        incidents.delete(endpoint);
        emit(endpoint, null);
      }
      return;
    }
    let code;
    if (signal?.aborted) {
      if (!isTimeout(signal.reason)) return;
      code = 'timeout';
    } else if (error.name === 'AbortError') {
      return;
    } else {
      code = synthesisReasonOfError(error);
    }
    const fallbackEndpoint = fallback?.endpoint || null;
    try {
      record?.({ endpoint, code, fallback: fallbackEndpoint, timing: synthesisTimingOf(error), elapsedMs });
    } catch { /* 记录不影响提醒 */ }
    const incident = `${code}|${fallbackEndpoint || ''}`;
    if (incidents.get(endpoint) === incident) return;
    issues.set(endpoint, code);
    incidents.set(endpoint, incident);
    emit(endpoint, code, fallbackEndpoint);
  }

  return Object.freeze({
    observe,
    issues: () => [...issues].map(([endpoint, code]) => {
      const fallback = incidents.get(endpoint)?.split('|')[1];
      return { endpoint, displayName: nameOf(endpoint), code, ...(fallback ? { fallback: { endpoint: fallback, displayName: nameOf(fallback) } } : {}) };
    }),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export default createVoiceHealth;
