// synthesisTiming.js — 一次合成的分段耗时，随失败的错误对象一起交给失败记录。
//
// provider 在 synth 失败时调用 attachSynthesisTiming(error, timing)；记录方用
// synthesisTimingOf(error) 读取，并沿 cause 链查找（网关会把 provider 的错误包一层）。
// 用 WeakMap 而不是往错误上加字段：预算超时抛出的是调用方共享的 abort reason，不该被改写。
//
// timing: { phase: 'queue'|'request'|'retry-wait'|'read', elapsedMs, queueMs, retryWaitMs,
//           requestMs（发出到收到响应头）, readMs（收到响应头后接收音频）, attempts, statuses: [httpStatus…] }

const timings = new WeakMap();
const MAX_CAUSE_DEPTH = 5;
const isKey = value => value !== null && (typeof value === 'object' || typeof value === 'function');

export function attachSynthesisTiming(error, timing) {
  if (isKey(error) && timing) timings.set(error, Object.freeze({ ...timing, statuses: Object.freeze([...(timing.statuses || [])]) }));
}

export function synthesisTimingOf(error) {
  let current = error;
  for (let depth = 0; isKey(current) && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const timing = timings.get(current);
    if (timing) return timing;
    current = current.cause;
  }
  return null;
}

/**
 * 分段计时器：enter(phase) 结算上一段并进入下一段；snapshot() 结算到现在但不换段，
 * 失败时的 phase 就是卡住的那一段。等响应与接收音频分开计：厂商已回 200 却没传完，和迟迟不回是两种慢。
 */
export function createSynthesisClock(now = Date.now) {
  const startedAt = now();
  const timing = { phase: 'queue', queueMs: 0, retryWaitMs: 0, requestMs: 0, readMs: 0, attempts: 0, statuses: [] };
  const field = { queue: 'queueMs', 'retry-wait': 'retryWaitMs', request: 'requestMs', read: 'readMs' };
  let phaseStartedAt = startedAt;
  const settle = () => {
    const at = now();
    timing[field[timing.phase]] += Math.max(0, at - phaseStartedAt);
    phaseStartedAt = at;
    return at;
  };
  return {
    enter(phase) {
      settle();
      timing.phase = phase;
      if (phase === 'request') timing.attempts += 1;
    },
    status(code) { timing.statuses.push(Number(code)); },
    snapshot() {
      const at = settle();
      return { ...timing, statuses: [...timing.statuses], elapsedMs: Math.max(0, at - startedAt) };
    },
  };
}
