// A bounded host policy around the existing transport, never a second protocol loop.
import { resolveModelFailoverTargets } from './llmProviders.js';

export const DEFAULT_FAILOVER_TIMEOUT_MS = 90_000;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null;
const identity = endpoint => ({ providerId: endpoint?.providerId || null, model: endpoint?.model || null });
const sameTarget = (a, b) => a?.providerId === b?.providerId && a?.model === b?.model;
const timeoutError = () => Object.assign(new Error('LLM request deadline exceeded'), { name: 'TimeoutError', code: 'LLM_TIMEOUT' });
const abortError = signal => signal?.reason instanceof Error && signal.reason.name !== 'AbortError'
  ? signal.reason : Object.assign(new Error('LLM request cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });

export function isEligibleFailoverError(error, { outerAborted = false, deadlineReached = false,
  allowAuthFailover = false } = {}) {
  if (outerAborted || deadlineReached) return false;
  // An abort is not evidence of a transient provider outage.
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return false;
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'LLM_TIMEOUT'].includes(error?.code)) return true;
  if (error?.code !== 'LLM_API_ERROR') return false;
  // Explicit transport evidence distinguishes network failures from unknown provider errors.
  if (error.transportFailure === true && error.status == null) return true;
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status)
    && ((allowAuthFailover && (status === 401 || status === 403))
      || status === 408 || status === 429 || (status >= 500 && status <= 599));
}

// 同端点重试的门槛：剩余时间不够首 token 的话，再试只会推迟失败（bound-model-attempt-timeout D3）。
export const MIN_RETRY_MS = 8_000;

export function createFailoverChat({ chat, resolveEndpoint, resolveFallbacks = resolveModelFailoverTargets,
  resolveTimeout = () => DEFAULT_FAILOVER_TIMEOUT_MS, resolveAttemptTimeout = () => null,
  minRetryMs = MIN_RETRY_MS, now = Date.now } = {}) {
  if (typeof chat !== 'function' || typeof resolveEndpoint !== 'function' || typeof resolveFallbacks !== 'function') {
    throw new TypeError('failover requires chat and endpoint resolvers');
  }
  return async function chatWithFailover(messages, tools = null, options = {}) {
    const startedAt = now();
    const outer = options.signal;
    if (outer?.aborted) throw abortError(outer);
    const primary = options.endpoint || await resolveEndpoint(options);
    const readTargets = async () => {
      if (options.failover === false || options.endpoint) return [];
      try {
        const list = await resolveFallbacks(primary, options);
        return Array.isArray(list) ? list.filter(item => item?.baseUrl && item?.model).slice(0, 2) : [];
      } catch { return []; } // unreadable consent never authorizes another destination
    };
    const targets = await readTargets();
    if (outer?.aborted) throw abortError(outer);
    const totalMs = positive(options.timeoutMs) || positive(resolveTimeout(options)) || DEFAULT_FAILOVER_TIMEOUT_MS;
    const limitMs = Math.min(totalMs, positive(options.failoverTimeoutMs) || totalMs);
    const deadline = Math.min(startedAt + limitMs, positive(options.deadlineMs) || Infinity);
    // A per-attempt cap lets a hung request fail early inside the same deadline; it never extends it.
    let capMs = null;
    try { capMs = positive(resolveAttemptTimeout(options)); } catch { capMs = null; }
    // Without consented alternatives, the only extra request is one retry of the same endpoint;
    // callers that pin an endpoint or opt out of failover (probes, model tests) get exactly one request.
    const retryOnly = !targets.length;
    const retryAllowed = options.failover !== false && !options.endpoint;
    const endpoints = retryOnly ? (retryAllowed ? [primary, primary] : [primary]) : [primary, ...targets];
    let exposedText = false;
    let lastError;
    for (let index = 0; index < endpoints.length; index++) {
      if (outer?.aborted) throw abortError(outer);
      if (now() >= deadline) throw lastError || timeoutError();
      let endpoint = endpoints[index];
      if (index && retryOnly) {
        if (deadline - now() < minRetryMs) throw lastError;
      } else if (index) {
        // Revalidate consent, enabled status, identity and fresh credentials immediately before use.
        endpoint = (await readTargets()).find(item => sameTarget(item, endpoint));
        if (outer?.aborted) throw abortError(outer);
        if (!endpoint) continue;
        try { options.onFailover?.({ fromProviderId: identity(endpoints[index - 1]).providerId,
          fromModel: identity(endpoints[index - 1]).model, ...identity(endpoint),
          attempt: index + 1, remainingMs: Math.max(0, deadline - now()) }); } catch { /* observation only */ }
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw lastError || timeoutError();
      // Reserve time for explicitly selected alternatives; no multiplied total timeout.
      const shareMs = retryOnly ? remaining : Math.floor(remaining / (endpoints.length - index));
      const attemptMs = Math.max(1, Math.min(shareMs, capMs || Infinity));
      const controller = new AbortController();
      const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
      let active = true;
      let succeeded = false;
      let timer;
      let onAbort;
      const cancellation = new Promise((_, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => controller.abort(timeoutError()), attemptMs);
      });
      // Callbacks pass the low-level payload through, preserving its own attempt identity.
      const callOptions = { ...options, endpoint, signal, timeoutMs: attemptMs,
        onTextDelta: payload => {
          if (!active || signal.aborted) return;
          const text = typeof payload === 'string' ? payload : payload?.text;
          if (text) exposedText = true;
          options.onTextDelta?.(typeof payload === 'string' ? { text } : payload);
        },
        onStreamReset: payload => { if (active && !signal.aborted) options.onStreamReset?.(payload); },
      };
      try {
        const result = await Promise.race([Promise.resolve().then(() => {
          signal.throwIfAborted();
          return chat(messages, tools, callOptions);
        }), cancellation]);
        if (signal.aborted) throw abortError(signal);
        succeeded = true;
        const failover = { used: !retryOnly && index > 0, ...identity(endpoint) };
        return { ...result, failover: retryOnly && index > 0 ? { ...failover, retried: true } : failover };
      } catch (error) {
        lastError = error;
        if (outer?.aborted) throw abortError(outer);
        // 聚合网关的某条上游授权失效不代表其他已选模型不可用；但不要重试同一失效端点。
        if (exposedText || !isEligibleFailoverError(error, { deadlineReached: now() >= deadline,
          allowAuthFailover: !retryOnly })) throw error;
      } finally {
        active = false;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        // Invalidate an uncooperative failed attempt without extending the deadline; a returned result is left intact.
        if (!succeeded) controller.abort();
      }
    }
    throw lastError || timeoutError();
  };
}

export default createFailoverChat;
