import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWithin, synthesisReason, synthesisElapsed } from './boundedSynthesis.js';
import { NARRATION_EXECUTION_LIMITS } from '../llmTasks.js';

test('a sixteen-second high-quality provider fits the default thirty-second synthesis budget', async t => {
  assert.equal(NARRATION_EXECUTION_LIMITS.synthesisBudgetMs, 30000);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let signal;
  const pending = synthesizeWithin(async (_text, opts) => {
    signal = opts.signal;
    await new Promise(resolve => setTimeout(resolve, 16000));
    return { url: '/slow.wav' };
  }, '高质量声音', {}, { budgetMs: NARRATION_EXECUTION_LIMITS.synthesisBudgetMs });
  await Promise.resolve();
  t.mock.timers.tick(16000);
  const result = await pending;
  assert.equal(result.audio.url, '/slow.wav');
  assert.equal(result.reason, null);
  assert.equal(result.elapsedMs, 16000);
  assert.equal(signal.aborted, false);
});

test('a timed-out synthesis aborts the underlying call and discards its late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let signal, finish;
  const pending = synthesizeWithin((_text, opts) => {
    signal = opts.signal;
    return new Promise(resolve => { finish = resolve; });
  }, 'text', {}, { budgetMs: 30000 });
  await Promise.resolve();
  t.mock.timers.tick(30000);
  const result = await pending;
  assert.equal(result.reason, 'timeout');
  assert.equal(signal.aborted, true);
  finish({ url: '/late.wav' });
  await Promise.resolve();
  assert.equal(result.audio, null);
});

test('already-expired work does not start synthesis; closed values cannot leak errors', async () => {
  let calls = 0;
  const result = await synthesizeWithin(() => { calls++; }, 'text', {}, { budgetMs: 30000, deadlineMs: 0 });
  assert.equal(result.reason, 'timeout');
  assert.equal(calls, 0);
  assert.equal(synthesisReason('sk-secret'), null);
  assert.equal(synthesisElapsed(null), null);
  assert.equal(synthesisElapsed('bad'), null);
  assert.equal(synthesisElapsed(-1), null);
  assert.equal(synthesisElapsed(4.4), 4);
});

test('provider error codes map to closed synthesis reasons; unknown codes stay generic', async () => {
  const failWith = code => () => { throw Object.assign(new Error(`upstream said ${code} sk-secret`), { code }); };
  const reasons = {};
  for (const code of ['TTS_CREDIT_EXHAUSTED', 'TTS_AUTH_FAILED', 'TTS_RATE_LIMITED', 'TTS_UPSTREAM_BUSY', 'TTS_TIMEOUT', 'TTS_PROVIDER_UNAVAILABLE', 'WEIRD']) {
    reasons[code] = (await synthesizeWithin(failWith(code), 'text', {}, { budgetMs: 1000 })).reason;
  }
  assert.deepEqual(reasons, {
    TTS_CREDIT_EXHAUSTED: 'credit-exhausted', TTS_AUTH_FAILED: 'auth-failed', TTS_RATE_LIMITED: 'rate-limited',
    TTS_UPSTREAM_BUSY: 'busy', TTS_TIMEOUT: 'timeout', TTS_PROVIDER_UNAVAILABLE: 'not-configured', WEIRD: 'failed',
  });
  for (const reason of Object.values(reasons)) assert.equal(synthesisReason(reason), reason);
});
