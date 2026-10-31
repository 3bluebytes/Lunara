import test from 'node:test';
import assert from 'node:assert/strict';

const { resolvePerformanceCapability, NO_PERFORMANCE_CAPABILITY, CAPABILITY_TABLE, describeCapability } =
  await import('./capabilities.js');

test('minimax + speech-2.8-hd：支持语气词、停顿、语速与强度；没有 whisper', () => {
  const capability = resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.8-hd' });
  assert.equal(capability.id, 'minimax-speech-2.8');
  assert.ok(capability.events.sigh && capability.events.laugh);
  assert.equal(capability.pauses, true);
  assert.equal(capability.pace, true);
  assert.equal(capability.intensity, true);
  assert.equal(capability.direction, false);
  assert.equal(Object.values(capability.emotions).includes('whisper'), false);
  assert.equal(capability.emotions.sad, 'sad');
  assert.equal(resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.8-turbo' }).id, 'minimax-speech-2.8');
});

test('minimax + speech-2.6-*：有情绪与停顿，但不支持语气词', () => {
  const capability = resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.6-hd' });
  assert.deepEqual(capability.events, {});
  assert.equal(capability.pauses, true);
  assert.equal(capability.emotions.happy, 'happy');
});

test('breeze + breeze-tts-2：支持 direction 与语气词，不支持停顿', () => {
  for (const model of ['breeze-tts-2', 'breeze-tts-2-multilingual']) {
    const capability = resolvePerformanceCapability({ protocol: 'breeze', model });
    assert.equal(capability.direction, true);
    assert.equal(capability.pauses, false);
    assert.equal(capability.events.sigh, '[叹气]');
    assert.equal(capability.events.breath, undefined, 'Breeze 没有换气事件');
  }
});

test('openai 与未登记模型返回 NONE', () => {
  for (const config of [
    { protocol: 'openai', model: 'tts-1' },
    { protocol: 'minimax', model: 'some-future-model' },
    { protocol: 'breeze', model: 'breeze-tts-1' },
    { protocol: 'unknown', model: 'x' },
    {},
  ]) {
    assert.equal(resolvePerformanceCapability(config), NO_PERFORMANCE_CAPABILITY);
  }
  assert.equal(NO_PERFORMANCE_CAPABILITY.id, 'none');
  assert.deepEqual(NO_PERFORMANCE_CAPABILITY.emotions, {});
});

test('每条能力表都注明核实日期与来源文档', () => {
  for (const entry of CAPABILITY_TABLE) {
    assert.equal(entry.verifiedAt, '2026-10-25');
    assert.match(entry.source, /^https:\/\//);
  }
});

test('describeCapability：给写作侧的可用清单；NONE 返回 null', () => {
  assert.equal(describeCapability(NO_PERFORMANCE_CAPABILITY), null);
  const described = describeCapability(resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.8-hd' }));
  assert.deepEqual(described.markers.slice(0, 2), ['{笑}', '{轻笑}']);
  assert.ok(described.markers.includes('{停顿:秒数}'));
  assert.ok(described.emotions.includes('sad'));
  assert.equal(described.limits.maxInlineEvents, 2);
  assert.equal(described.limits.maxPauses, 3);
  assert.equal(described.direction, false);
});
