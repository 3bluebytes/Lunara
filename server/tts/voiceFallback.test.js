// 代读兜底：只在主声音技术性失败、用户开启且目标不是主声音本身时，用目标声音念剥掉标记的同一段文字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWithFallback } from './voiceFallback.js';
import { createVoiceHealth } from './voiceHealth.js';
import { TtsSynthesisError } from './TtsProvider.js';

const primary = { providerId: 'custom-breeze', voiceId: 'v-main', params: { model: 'm1' } };
const edgeTarget = { providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural' };
const failure = code => new TtsSynthesisError('upstream said no', { code, providerId: 'custom-breeze' });

function harness({ primaryError = null, fallbackError = null, target = edgeTarget, resolved = edgeTarget } = {}) {
  const calls = [];
  const messages = [];
  const voiceHealth = createVoiceHealth({ displayNameOf: id => id });
  voiceHealth.subscribe(message => messages.push(message));
  const synth = async (text, options) => {
    calls.push({ text, ...options });
    const error = options.providerId === primary.providerId ? primaryError : fallbackError;
    if (error) throw error;
    return { url: `/tts/${options.providerId}.mp3`, providerId: options.providerId };
  };
  const run = (options = {}) => synthesizeWithFallback('{叹气}晚了。听首歌吧。', {
    voice: primary, synth, voiceHealth, performance: { pace: 'slow' },
    fallbackTarget: () => target, resolveFallback: () => resolved, ...options,
  });
  return { run, calls, messages };
}

test('主声音成功：只调一次，结果标为 primary', async () => {
  const { run, calls } = harness();
  const audio = await run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { model: 'm1' });
  assert.deepEqual(audio.voiceSource, { kind: 'primary', providerId: 'custom-breeze' });
});

test('主声音超时：用目标声音念剥掉标记的同一段文字，结果标为 fallback 并带原因', async () => {
  const { run, calls, messages } = harness({ primaryError: failure('TTS_TIMEOUT') });
  const audio = await run();
  assert.equal(calls.length, 2);
  assert.deepEqual({ text: calls[1].text, providerId: calls[1].providerId, voiceId: calls[1].voiceId, performance: calls[1].performance },
    { text: '晚了。听首歌吧。', providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural', performance: null });
  assert.equal(audio.url, '/tts/free-edge.mp3', '缓存与 URL 来自实际出声的 provider');
  assert.deepEqual(audio.voiceSource, { kind: 'fallback', providerId: 'free-edge', reason: 'timeout' });
  assert.deepEqual(messages.map(message => [message.endpoint, message.code, message.fallback?.endpoint ?? null]), [['custom-breeze', 'timeout', 'free-edge']]);
});

test('网络/5xx、限流、额度、鉴权都算技术性失败', async () => {
  for (const code of ['TTS_SYNTHESIS_FAILED', 'TTS_RATE_LIMITED', 'TTS_UPSTREAM_BUSY', 'TTS_CREDIT_EXHAUSTED', 'TTS_AUTH_FAILED']) {
    const { run } = harness({ primaryError: failure(code) });
    assert.equal((await run()).voiceSource.kind, 'fallback', code);
  }
});

test('没开代读、接口未配置、目标就是主声音、目标解析不出来：都不代读，照原样抛出', async () => {
  const cases = [
    harness({ primaryError: failure('TTS_TIMEOUT'), target: null }),
    harness({ primaryError: failure('TTS_PROVIDER_UNAVAILABLE') }),
    harness({ primaryError: failure('TTS_TIMEOUT'), target: { profileId: 'vp_cx_00000001' }, resolved: { ...primary } }),
    harness({ primaryError: failure('TTS_TIMEOUT'), target: { profileId: 'vp_cx_00000001' }, resolved: { unavailable: true } }),
  ];
  for (const { run, calls, messages } of cases) {
    await assert.rejects(run(), error => error.message === 'upstream said no');
    assert.equal(calls.length, 1);
    assert.equal(messages[0]?.fallback, undefined);
  }
});

test('调用方取消（含预算超时）后不再发起代读', async () => {
  const controller = new AbortController();
  const { run, calls } = harness({ primaryError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  controller.abort();
  await assert.rejects(run({ signal: controller.signal }), error => error.name === 'AbortError');
  const budget = new AbortController();
  budget.abort(new DOMException('synthesis budget expired', 'TimeoutError'));
  const timed = harness({ primaryError: failure('TTS_TIMEOUT') });
  await assert.rejects(timed.run({ signal: budget.signal }));
  assert.equal(calls.length + timed.calls.length, 2);
});

test('代读也失败：抛出主声音的原错误，健康状态同时记下两边', async () => {
  const { run, calls, messages } = harness({ primaryError: failure('TTS_AUTH_FAILED'), fallbackError: new TtsSynthesisError('edge 403', { providerId: 'free-edge' }) });
  await assert.rejects(run(), error => error.code === 'TTS_AUTH_FAILED');
  assert.equal(calls.length, 2);
  assert.deepEqual(messages.map(message => [message.endpoint, message.code, message.fallback ?? null]), [
    ['free-edge', 'failed', null],
    ['custom-breeze', 'auth-failed', null],
  ]);
});

test('目标是声音池里的声音时带上它自己的参数', async () => {
  const pooled = { providerId: 'custom-qwen', voiceId: 'Cherry', params: { model: 'qwen-tts' } };
  const { run, calls } = harness({ primaryError: failure('TTS_TIMEOUT'), target: { profileId: 'vp_cx_0000abcd' }, resolved: pooled });
  const audio = await run();
  assert.deepEqual(calls[1].params, { model: 'qwen-tts' });
  assert.deepEqual(audio.voiceSource, { kind: 'fallback', providerId: 'custom-qwen', reason: 'timeout' });
});
