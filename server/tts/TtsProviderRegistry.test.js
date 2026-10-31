import test from 'node:test';
import assert from 'node:assert/strict';

const { TtsProviderRegistry } = await import('./TtsProviderRegistry.js');
const { assertTtsProvider } = await import('./TtsProvider.js');

function fakeProvider(id, { configured = true, voices = [], throws = null, onSynth = null } = {}) {
  return {
    id,
    label: `label-${id}`,
    requiresCredentials: false,
    isConfigured: () => {
      if (throws) throw new Error(throws);
      return configured;
    },
    listVoices: () => voices,
    synth: async (text, options) => {
      if (onSynth) return onSynth(text, options);
      return { bytes: Buffer.from('x'), extension: 'wav', contentType: 'audio/wav', source: id };
    },
  };
}

test('register / get / list 保持注册顺序（即优先级）', () => {
  const registry = new TtsProviderRegistry({ providers: [fakeProvider('a'), fakeProvider('b')] });
  assert.deepEqual(registry.list().map(p => p.id), ['a', 'b']);
  assert.equal(registry.get('b').id, 'b');
  assert.equal(registry.get('missing'), null);
  assert.equal(registry.has('a'), true);
  assert.equal(registry.has('missing'), false);
});

test('重复注册同一 id 就地替换而不是追加', () => {
  const registry = new TtsProviderRegistry();
  registry.register(fakeProvider('a', { configured: false }));
  registry.register(fakeProvider('a', { configured: true }));
  assert.equal(registry.list().length, 1);
  assert.equal(registry.available().length, 1);
});

test('缺少必需方法的 provider 被拒绝', () => {
  assert.throws(() => assertTtsProvider({ id: 'x' }), /missing isConfigured/);
  assert.throws(() => assertTtsProvider({ id: '', isConfigured() {}, listVoices() {}, synth() {} }), /non-empty id/);
});

test('available() 过滤未配置的 provider', () => {
  const registry = new TtsProviderRegistry({
    providers: [fakeProvider('ok'), fakeProvider('no', { configured: false })],
  });
  assert.deepEqual(registry.available().map(p => p.id), ['ok']);
});

test('isConfigured() 抛错时视为不可用，且不中断其它 provider', () => {
  const warnings = [];
  const registry = new TtsProviderRegistry({
    providers: [fakeProvider('boom', { throws: 'kaboom' }), fakeProvider('ok')],
    logger: { warn: message => warnings.push(message) },
  });
  assert.deepEqual(registry.available().map(p => p.id), ['ok']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /kaboom/);
});

test('未指定 provider 时按优先级返回全部可用项', () => {
  const registry = new TtsProviderRegistry({
    providers: [fakeProvider('first'), fakeProvider('second'), fakeProvider('third', { configured: false })],
  });
  const { providers, reason } = registry.resolve();
  assert.deepEqual(providers.map(p => p.id), ['first', 'second']);
  assert.equal(reason, 'priority');
});

test('显式指定 provider 时只返回它，不静默换成别的声音源', () => {
  const registry = new TtsProviderRegistry({ providers: [fakeProvider('a'), fakeProvider('b')] });
  assert.deepEqual(registry.resolve({ providerId: 'b' }).providers.map(p => p.id), ['b']);
  // 未注册
  assert.deepEqual(registry.resolve({ providerId: 'nope' }).providers, []);
  assert.equal(registry.resolve({ providerId: 'nope' }).reason, 'unknown-provider');
  // 已注册但不可用
  const limited = new TtsProviderRegistry({ providers: [fakeProvider('a', { configured: false })] });
  assert.deepEqual(limited.resolve({ providerId: 'a' }).providers, []);
  assert.equal(limited.resolve({ providerId: 'a' }).reason, 'provider-unavailable');
});

test('无可用 provider 时 resolve 返回 none-available 而不是抛错', () => {
  const registry = new TtsProviderRegistry({ providers: [fakeProvider('a', { configured: false })] });
  assert.deepEqual(registry.resolve().providers, []);
  assert.equal(registry.resolve().reason, 'none-available');
});

test('status() 报告就绪状态、凭据需求与错误', () => {
  const registry = new TtsProviderRegistry({
    providers: [fakeProvider('ok'), fakeProvider('boom', { throws: 'nope' })],
  });
  const status = registry.status();
  assert.deepEqual(status.map(s => s.id), ['ok', 'boom']);
  assert.equal(status[0].configured, true);
  assert.equal(status[1].configured, false);
  assert.equal(status[1].error, 'nope');
  assert.equal(typeof status[0].requiresCredentials, 'boolean');
});

test('defaultVoiceRef 取第一个可用 provider 的第一个音色', () => {
  const registry = new TtsProviderRegistry({
    providers: [
      fakeProvider('empty', { voices: [] }),
      fakeProvider('has', { voices: [{ id: 'v1' }, { id: 'v2' }] }),
    ],
  });
  assert.deepEqual(registry.defaultVoiceRef(), { providerId: 'has', voiceRef: 'v1' });
});

test('defaultVoiceRef 在没有任何音色时返回 null', () => {
  const registry = new TtsProviderRegistry({ providers: [fakeProvider('empty')] });
  assert.equal(registry.defaultVoiceRef(), null);
});

test('listVoices() 抛错不影响 registry 其它操作', () => {
  const warnings = [];
  const registry = new TtsProviderRegistry({
    providers: [{
      ...fakeProvider('broken'),
      listVoices: () => { throw new Error('voice list exploded'); },
    }],
    logger: { warn: message => warnings.push(message) },
  });
  assert.equal(registry.defaultVoiceRef(), null);
  assert.equal(warnings.length, 1);
});
test('explicitOnly provider 只在显式指定时参与，不进入优先级回落与默认音色', () => {
  const registry = new TtsProviderRegistry({
    providers: [
      { ...fakeProvider('free', { voices: [{ id: 'f1' }] }), explicitOnly: true },
      fakeProvider('mine', { voices: [{ id: 'm1' }] }),
    ],
  });
  assert.deepEqual(registry.resolve().providers.map(p => p.id), ['mine']);
  assert.deepEqual(registry.resolve({ providerId: 'free' }).providers.map(p => p.id), ['free']);
  assert.deepEqual(registry.defaultVoiceRef(), { providerId: 'mine', voiceRef: 'm1' });
  const onlyFree = new TtsProviderRegistry({ providers: [{ ...fakeProvider('free'), explicitOnly: true }] });
  assert.equal(onlyFree.resolve().reason, 'none-available');
});
