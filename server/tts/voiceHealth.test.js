import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceHealth } from './voiceHealth.js';

const harness = () => {
  const messages = [];
  const health = createVoiceHealth({ displayNameOf: id => (id === 'custom' ? 'Breeze' : null) });
  health.subscribe(message => messages.push(message));
  return { health, messages };
};
const coded = code => Object.assign(new Error(`raw upstream body sk-secret ${code}`), { code });

test('an attributable failure broadcasts only endpoint, display name and closed code, once per incident', () => {
  const { health, messages } = harness();
  health.observe('custom', { error: coded('TTS_CREDIT_EXHAUSTED') });
  health.observe('custom', { error: coded('TTS_CREDIT_EXHAUSTED') });
  assert.deepEqual(messages, [{ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'credit-exhausted' }]);
  assert.doesNotMatch(JSON.stringify(messages), /sk-secret|upstream/u);
  assert.deepEqual(health.issues(), [{ endpoint: 'custom', displayName: 'Breeze', code: 'credit-exhausted' }]);
});

test('a changed reason updates the warning and success announces recovery', () => {
  const { health, messages } = harness();
  health.observe('custom', { error: coded('TTS_RATE_LIMITED') });
  health.observe('custom', { error: coded('TTS_UPSTREAM_BUSY') });
  health.observe('custom', {});
  health.observe('custom', {});
  assert.deepEqual(messages.map(message => message.code), ['rate-limited', 'busy', null]);
  assert.deepEqual(health.issues(), []);
});

test('caller cancellation is not a voice failure; a budget timeout is', () => {
  const { health, messages } = harness();
  const cancelled = new AbortController();
  cancelled.abort(new Error('occurrence invalidated'));
  health.observe('custom', { error: Object.assign(new Error('aborted'), { name: 'AbortError' }), signal: cancelled.signal });
  assert.deepEqual(messages, []);
  const expired = new AbortController();
  expired.abort(new DOMException('synthesis budget expired', 'TimeoutError'));
  health.observe('custom', { error: Object.assign(new Error('aborted'), { name: 'AbortError' }), signal: expired.signal });
  assert.deepEqual(messages.map(message => message.code), ['timeout']);
});

test('unattributed failures and listener errors never throw into synthesis', () => {
  const health = createVoiceHealth();
  health.subscribe(() => { throw new Error('socket closed'); });
  assert.doesNotThrow(() => health.observe(null, { error: coded('TTS_RATE_LIMITED') }));
  assert.doesNotThrow(() => health.observe('custom-minimax', { error: coded('TTS_AUTH_FAILED') }));
  assert.deepEqual(health.issues(), [{ endpoint: 'custom-minimax', displayName: 'custom-minimax', code: 'auth-failed' }]);
});

test('代读成功时主声音提醒带上代读声音；代读状态变化会重新提醒', () => {
  const messages = [];
  const health = createVoiceHealth({ displayNameOf: id => ({ custom: 'Breeze', 'free-edge': '免费声音（Edge）' })[id] || null });
  health.subscribe(message => messages.push(message));
  health.observe('custom', { error: coded('TTS_TIMEOUT'), fallback: { endpoint: 'free-edge' } });
  health.observe('custom', { error: coded('TTS_TIMEOUT'), fallback: { endpoint: 'free-edge' } });
  health.observe('custom', { error: coded('TTS_TIMEOUT') });
  assert.deepEqual(messages, [
    { type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'timeout', fallback: { endpoint: 'free-edge', displayName: '免费声音（Edge）' } },
    { type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'timeout' },
  ]);
  assert.deepEqual(health.issues(), [{ endpoint: 'custom', displayName: 'Breeze', code: 'timeout' }]);
});

test('issues() 在重连快照里也带上代读声音', () => {
  const health = createVoiceHealth({ displayNameOf: id => id });
  health.observe('custom', { error: coded('TTS_TIMEOUT'), fallback: { endpoint: 'free-edge' } });
  assert.deepEqual(health.issues(), [{ endpoint: 'custom', displayName: 'custom', code: 'timeout', fallback: { endpoint: 'free-edge', displayName: 'free-edge' } }]);
});

test('every attributable failure is recorded (not deduped) with provider timing; cancellation is not', async () => {
  const { attachSynthesisTiming } = await import('./synthesisTiming.js');
  const records = [];
  const health = createVoiceHealth({ record: entry => records.push(entry) });
  const inner = coded('TTS_RATE_LIMITED');
  attachSynthesisTiming(inner, { phase: 'request', queueMs: 0, retryWaitMs: 4000, requestMs: 900, attempts: 3, statuses: [429, 429, 429], elapsedMs: 4900 });
  const wrapped = Object.assign(new Error('all tts providers failed'), { code: 'TTS_RATE_LIMITED', cause: inner });
  health.observe('custom', { error: wrapped, elapsedMs: 5000 });
  health.observe('custom', { error: wrapped, elapsedMs: 5000 });
  const stale = new AbortController();
  stale.abort(new Error('stale'));
  health.observe('custom', { error: coded('TTS_SYNTHESIS_FAILED'), signal: stale.signal });
  const budget = new AbortController();
  budget.abort(new DOMException('synthesis budget expired', 'TimeoutError'));
  health.observe('custom', { error: budget.signal.reason, signal: budget.signal, elapsedMs: 30000 });
  assert.equal(records.length, 3, '两次限流都记，过期取消不记，预算超时记');
  assert.equal(records[0].code, 'rate-limited');
  assert.deepEqual(records[0].timing.statuses, [429, 429, 429]);
  assert.equal(records[2].code, 'timeout');
  assert.equal(records[2].timing, null);
  assert.equal(records[2].elapsedMs, 30000);
});

test('a throwing recorder does not stop the warning', () => {
  const messages = [];
  const health = createVoiceHealth({ record: () => { throw new Error('disk full'); } });
  health.subscribe(message => messages.push(message));
  health.observe('custom', { error: coded('TTS_CREDIT_EXHAUSTED') });
  assert.equal(messages.length, 1);
});
