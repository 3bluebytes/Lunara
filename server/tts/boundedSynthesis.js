// 音频准备的有界等待：超时真正取消工作，外部取消不降级成“没有声音”。
const SYNTHESIS_REASONS = Object.freeze(['timeout', 'failed', 'not-configured', 'credit-exhausted', 'auth-failed', 'rate-limited', 'busy']);
// 稳定错误码 → 封闭原因；未登记的码一律 failed，上游原文不进入诊断。
const REASON_BY_CODE = Object.freeze({
  TTS_CREDIT_EXHAUSTED: 'credit-exhausted',
  TTS_AUTH_FAILED: 'auth-failed',
  TTS_RATE_LIMITED: 'rate-limited',
  TTS_UPSTREAM_BUSY: 'busy',
  TTS_TIMEOUT: 'timeout',
  TTS_PROVIDER_UNAVAILABLE: 'not-configured',
});
export const synthesisReason = value => SYNTHESIS_REASONS.includes(value) ? value : null;
export const synthesisReasonOfError = error => REASON_BY_CODE[error?.code] || 'failed';
export const synthesisElapsed = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0
  ? Math.round(Number(value)) : null;

export async function synthesizeWithin(synthesize, text, options = {}, { budgetMs, deadlineMs = Infinity } = {}) {
  const startedAt = Date.now();
  const result = (audio, reason) => ({ audio, reason, elapsedMs: Date.now() - startedAt });
  const outer = options.signal;
  outer?.throwIfAborted();
  if (typeof synthesize !== 'function') return result(null, 'not-configured');
  const allowedMs = Math.min(Number(budgetMs) || 0, deadlineMs - startedAt);
  if (allowedMs <= 0) return result(null, 'timeout');
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(outer.reason);
  outer?.addEventListener('abort', forwardAbort, { once: true });
  let expired = false;
  let onAbort;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException('synthesis budget expired', 'TimeoutError'));
  }, allowedMs);
  try {
    const audio = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return synthesize(text, { ...options, signal: controller.signal });
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    outer?.throwIfAborted();
    return result(audio || null, audio?.url ? null : 'failed');
  } catch (error) {
    outer?.throwIfAborted();
    return result(null, expired ? 'timeout' : synthesisReasonOfError(error));
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
