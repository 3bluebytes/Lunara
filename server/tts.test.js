import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createTtsGateway } = await import('./tts.js');
const { TtsProviderRegistry } = await import('./tts/TtsProviderRegistry.js');
const { TtsSynthesisError, TtsProviderUnavailableError } = await import('./tts/TtsProvider.js');

/** 每个用例一个隔离缓存目录，避免污染仓库的 cache/ 与互相命中。 */
function makeGateway(providers, options = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'lunara-tts-gateway-'));
  const warnings = [];
  const gateway = createTtsGateway({
    registry: new TtsProviderRegistry({ providers }),
    cacheDir,
    logger: { warn: message => warnings.push(message) },
    ...options,
  });
  return {
    gateway,
    cacheDir,
    warnings,
    files: () => readdirSync(cacheDir),
    cleanup: () => rmSync(cacheDir, { recursive: true, force: true }),
  };
}

function provider(id, { bytes = Buffer.from(`audio-${id}`), extension = 'wav', configured = true, fail = null } = {}) {
  return {
    id,
    label: id,
    requiresCredentials: false,
    isConfigured: () => configured,
    listVoices: () => [],
    synth: async () => {
      if (fail) throw new Error(fail);
      return {
        bytes,
        extension,
        contentType: extension === 'wav' ? 'audio/wav' : 'audio/mpeg',
        source: id,
      };
    },
  };
}

test('没有可用 provider 时显式失败，且失效的保留身份不落到别的声线', async t => {
  // 系统语音与本地模型都已关闭：只剩自定义接口时，未配置即无可用 provider。
  const h = makeGateway([provider('custom', { configured: false })]);
  t.after(h.cleanup);
  await assert.rejects(h.gateway.synth('你好', { providerId: 'custom' }), TtsProviderUnavailableError);
  h.gateway.setVoiceResolver(() => ({ unavailable: true }));
  await assert.rejects(h.gateway.synth('失效', { voiceId: 'vp_cx_removed' }), TtsProviderUnavailableError);
  assert.deepEqual(h.files(), [], '失败不得写入占位音频');
});

test('旧全局 voice id 不会作为自定义接口的声音被发送', async t => {
  const calls = [];
  const custom = { ...provider('custom'), synth: async (_text, options) => { calls.push(options.voiceRef); return { bytes: Buffer.from('x'), extension: 'wav' }; } };
  const h = makeGateway([custom], { initialVoice: 'legacy-voice' });
  t.after(h.cleanup);
  await h.gateway.synth('默认', { providerId: 'custom', voiceId: null });
  assert.deepEqual(calls, ['legacy-voice']);
});

test('空文本返回 null，不合成也不落盘', async t => {
  const h = makeGateway([provider('a')]);
  t.after(h.cleanup);
  assert.equal(await h.gateway.synth(''), null);
  assert.equal(await h.gateway.synth('   '), null);
  assert.equal(await h.gateway.synth(null), null);
  assert.deepEqual(h.files(), []);
});

test('成功合成写入缓存并以扩展名决定 URL 与 content-type', async t => {
  const h = makeGateway([provider('a', { extension: 'wav' })]);
  t.after(h.cleanup);
  const result = await h.gateway.synth('你好', { voiceId: 'v1' });
  assert.equal(result.providerId, 'a');
  assert.equal(result.extension, 'wav');
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.source, 'a');
  assert.match(result.url, /^\/tts\/[0-9a-f]{64}\.wav$/);
  assert.deepEqual(h.files(), [`${result.hash}.wav`]);
});

test('第二次相同请求命中缓存，不再调用 provider', async t => {
  let calls = 0;
  const counting = {
    ...provider('a'),
    synth: async () => {
      calls += 1;
      return { bytes: Buffer.from('x'), extension: 'wav', contentType: 'audio/wav', source: 'a' };
    },
  };
  const h = makeGateway([counting]);
  t.after(h.cleanup);
  const first = await h.gateway.synth('同一段文本', { voiceId: 'v1' });
  const second = await h.gateway.synth('同一段文本', { voiceId: 'v1' });
  assert.equal(calls, 1, 'provider 只应被调用一次');
  assert.equal(second.source, 'cache');
  assert.equal(second.url, first.url);
});

test('缓存键覆盖 provider：不同 provider 不互相命中', async t => {
  const h = makeGateway([
    provider('a', { bytes: Buffer.from('AAAA') }),
    provider('b', { bytes: Buffer.from('BBBB') }),
  ]);
  t.after(h.cleanup);
  const fromA = await h.gateway.synth('同一段文本', { voiceId: 'v1', providerId: 'a' });
  const fromB = await h.gateway.synth('同一段文本', { voiceId: 'v1', providerId: 'b' });
  assert.notEqual(fromA.hash, fromB.hash, '不同 provider 必须产生不同缓存键');
  assert.equal(fromA.providerId, 'a');
  assert.equal(fromB.providerId, 'b');
  assert.equal(h.files().length, 2);
});

test('缓存键覆盖合成参数：参数变化产生新条目', async t => {
  const h = makeGateway([provider('a')]);
  t.after(h.cleanup);
  const slow = await h.gateway.synth('文本', { voiceId: 'v1', params: { speed: 0.9 } });
  const normal = await h.gateway.synth('文本', { voiceId: 'v1' });
  assert.notEqual(slow.hash, normal.hash);
  // 参数书写顺序不影响键
  const slowAgain = await h.gateway.synth('文本', { voiceId: 'v1', params: { speed: 0.9 } });
  assert.equal(slowAgain.hash, slow.hash);
});

test('缓存键覆盖音色：换音色不命中旧条目', async t => {
  const h = makeGateway([provider('a')]);
  t.after(h.cleanup);
  const one = await h.gateway.synth('文本', { voiceId: 'voice-1' });
  const two = await h.gateway.synth('文本', { voiceId: 'voice-2' });
  assert.notEqual(one.hash, two.hash);
});

test('未指定 provider 时按优先级回落', async t => {
  const h = makeGateway([
    provider('primary', { fail: 'primary is down' }),
    provider('secondary', { bytes: Buffer.from('ok-secondary') }),
  ]);
  t.after(h.cleanup);
  const result = await h.gateway.synth('文本', { voiceId: 'v1' });
  assert.equal(result.providerId, 'secondary');
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /primary is down/);
});

test('显式指定 provider 时不静默换成别的声音源', async t => {
  const h = makeGateway([
    provider('primary', { fail: 'down' }),
    provider('secondary'),
  ]);
  t.after(h.cleanup);
  await assert.rejects(
    () => h.gateway.synth('文本', { voiceId: 'v1', providerId: 'primary' }),
    TtsSynthesisError,
  );
  // 不允许落到 secondary
  assert.deepEqual(h.files(), []);
});

test('只试了一个 provider 时保留它的稳定错误码，便于诊断与提醒', async t => {
  const failing = provider('only', { fail: 'credits' });
  const synth = failing.synth;
  failing.synth = async (...args) => { try { return await synth(...args); } catch (error) { error.code = 'TTS_CREDIT_EXHAUSTED'; throw error; } };
  const h = makeGateway([failing]);
  t.after(h.cleanup);
  await assert.rejects(() => h.gateway.synth('文本', { voiceId: 'v1', providerId: 'only' }), error => {
    assert.equal(error.code, 'TTS_CREDIT_EXHAUSTED');
    assert.equal(error.providerId, 'only');
    return true;
  });
});

test('全部 provider 失败时抛出错误，且不写占位音频', async t => {
  const h = makeGateway([
    provider('a', { fail: 'a down' }),
    provider('b', { fail: 'b down' }),
  ]);
  t.after(h.cleanup);
  await assert.rejects(() => h.gateway.synth('文本', { voiceId: 'v1' }), error => {
    assert.ok(error instanceof TtsSynthesisError);
    assert.equal(error.code, 'TTS_ALL_PROVIDERS_FAILED');
    assert.match(error.message, /a down/);
    assert.match(error.message, /b down/);
    return true;
  });
  assert.deepEqual(h.files(), [], '失败时不得留下任何音频文件');
});

test('没有可用 provider 时抛出可识别的不可用错误', async t => {
  const h = makeGateway([provider('a', { configured: false })]);
  t.after(h.cleanup);
  await assert.rejects(() => h.gateway.synth('文本', {}), error => {
    assert.ok(error instanceof TtsProviderUnavailableError);
    assert.equal(error.code, 'TTS_PROVIDER_UNAVAILABLE');
    return true;
  });
});

test('per-call voiceId 不改变进程级默认音色', async t => {
  const h = makeGateway([provider('a')], { initialVoice: 'default-voice' });
  t.after(h.cleanup);
  await h.gateway.synth('文本', { voiceId: 'other-voice' });
  assert.equal(h.gateway.getVoice(), 'default-voice');
  await h.gateway.synth('文本');
  assert.equal(h.gateway.getVoice(), 'default-voice');
});

test('setVoice 影响后续未显式指定音色的合成', async t => {
  const h = makeGateway([provider('a')], { initialVoice: 'first' });
  t.after(h.cleanup);
  const before = await h.gateway.synth('文本');
  h.gateway.setVoice('second');
  assert.equal(h.gateway.getVoice(), 'second');
  const after = await h.gateway.synth('文本');
  assert.notEqual(before.hash, after.hash, '换默认音色后不应命中旧缓存');
});

test('已中止的 signal 不启动合成', async t => {
  let calls = 0;
  const counting = { ...provider('a'), synth: async () => { calls += 1; return { bytes: Buffer.from('x'), extension: 'wav', contentType: 'audio/wav', source: 'a' }; } };
  const h = makeGateway([counting]);
  t.after(h.cleanup);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => h.gateway.synth('文本', { signal: controller.signal }));
  assert.equal(calls, 0);
});

test('providerStatus 汇总就绪状态', async t => {
  const h = makeGateway([provider('a'), provider('b', { configured: false })]);
  t.after(h.cleanup);
  const status = h.gateway.providerStatus();
  assert.deepEqual(status.map(item => item.id), ['a', 'b']);
  assert.deepEqual(status.map(item => item.configured), [true, false]);
});

test('listAllVoices 汇总各 provider 音色并标注来源', async t => {
  const h = makeGateway([
    { ...provider('a'), listVoices: () => [{ id: 'a1' }] },
    { ...provider('b'), listVoices: () => [{ id: 'b1' }, { id: 'b2' }] },
    { ...provider('c', { configured: false }), listVoices: () => [{ id: 'c1' }] },
  ]);
  t.after(h.cleanup);
  const voices = h.gateway.listAllVoices();
  assert.deepEqual(voices.map(v => v.id), ['a1', 'b1', 'b2']);
  assert.equal(voices[0].providerId, 'a');
});

test('provider 抛出 AbortError 时向上传播，不被当作回落实由', async t => {
  const aborting = {
    ...provider('a'),
    synth: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  };
  const h = makeGateway([aborting, provider('b')]);
  t.after(h.cleanup);
  await assert.rejects(() => h.gateway.synth('文本', { voiceId: 'v' }), error => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.deepEqual(h.files(), []);
});
// ---- 表演意图（speech-performance）----

/** 带表演翻译的假 provider：语气词翻成 <tag>，情绪进 native。记录每次 synth 收到的文本与 native。 */
function performingProvider(id, { emotions = true, fail = null } = {}) {
  const calls = [];
  const renders = [];
  return {
    calls,
    renders,
    provider: {
      ...provider(id),
      performanceCapability: () => ({ id: `${id}-cap` }),
      renderPerformance(text, performance) {
        renders.push({ text, performance });
        return {
          text: text.replace(/\{叹气\}/g, `<${id}:sigh>`).replace(/\{停顿:[\d.]+\}/g, ''),
          native: emotions && performance?.emotion ? { emotion: performance.emotion } : {},
        };
      },
      synth: async (text, options) => {
        calls.push({ text, native: options.native });
        if (fail) throw new Error(fail);
        return { bytes: Buffer.from(`${id}:${text}:${JSON.stringify(options.native)}`), extension: 'mp3', source: id };
      },
    },
  };
}

test('synth(text, { performance })：先由 provider 翻译，再用翻译结果合成', async t => {
  const a = performingProvider('a');
  const h = makeGateway([a.provider]);
  t.after(h.cleanup);
  await h.gateway.synth('{叹气}晚安。', { voiceId: 'v', performance: { emotion: 'sad' } });
  assert.deepEqual(a.renders, [{ text: '{叹气}晚安。', performance: { emotion: 'sad' } }]);
  assert.deepEqual(a.calls, [{ text: '<a:sigh>晚安。', native: { emotion: 'sad' } }]);
});

test('没有翻译能力的 provider 收到剥离标记后的纯文本与空 native', async t => {
  const calls = [];
  const plain = { ...provider('plain'), synth: async (text, options) => { calls.push({ text, native: options.native }); return { bytes: Buffer.from('x'), extension: 'mp3' }; } };
  const h = makeGateway([plain]);
  t.after(h.cleanup);
  await h.gateway.synth('{叹气}晚安。{停顿:0.5}好梦。', { voiceId: 'v', performance: { emotion: 'sad' } });
  assert.deepEqual(calls, [{ text: '晚安。好梦。', native: {} }]);
});

test('缓存键基于翻译后的文本与参数：同文本不同情绪各一条，相同翻译结果命中同一条', async t => {
  const a = performingProvider('a');
  const h = makeGateway([a.provider]);
  t.after(h.cleanup);
  const happy = await h.gateway.synth('今晚好。', { voiceId: 'v', performance: { emotion: 'happy' } });
  const sad = await h.gateway.synth('今晚好。', { voiceId: 'v', performance: { emotion: 'sad' } });
  assert.notEqual(happy.hash, sad.hash);
  // 停顿被该 provider 丢弃：翻译结果与无停顿时相同，命中同一条。
  const withPause = await h.gateway.synth('今晚{停顿:0.5}好。', { voiceId: 'v', performance: { emotion: 'sad' } });
  assert.equal(withPause.hash, sad.hash);
  assert.equal(withPause.source, 'cache');
  assert.equal(a.calls.length, 2);
});

test('没有表演时缓存键与旧实现一致（不让已有缓存全部失效）', async t => {
  const a = performingProvider('a');
  const plain = makeGateway([provider('a')]);
  const performing = makeGateway([a.provider]);
  t.after(plain.cleanup);
  t.after(performing.cleanup);
  const before = await plain.gateway.synth('同一句话。', { voiceId: 'v' });
  const after = await performing.gateway.synth('同一句话。', { voiceId: 'v' });
  assert.equal(after.hash, before.hash);
});

test('回落 provider 从中立形式重新翻译，不复用前一个 provider 的结果', async t => {
  const a = performingProvider('a', { fail: 'a down' });
  const b = performingProvider('b');
  const h = makeGateway([a.provider, b.provider]);
  t.after(h.cleanup);
  const result = await h.gateway.synth('{叹气}晚安。', { voiceId: 'v', performance: { emotion: 'calm' } });
  assert.equal(result.providerId, 'b');
  assert.deepEqual(b.renders, [{ text: '{叹气}晚安。', performance: { emotion: 'calm' } }]);
  assert.deepEqual(b.calls, [{ text: '<b:sigh>晚安。', native: { emotion: 'calm' } }]);
});

test('只有标记没有可念文字时返回 null，不合成', async t => {
  const a = performingProvider('a');
  const h = makeGateway([a.provider]);
  t.after(h.cleanup);
  assert.equal(await h.gateway.synth('{叹气}{停顿:0.5}', { voiceId: 'v' }), null);
  assert.equal(a.calls.length, 0);
});

test('performanceCapability(voiceRef)：按声音解析到 provider 后返回其能力；不可用或无声明时为 none', async t => {
  const a = performingProvider('a');
  const h = makeGateway([a.provider, provider('plain')]);
  t.after(h.cleanup);
  h.gateway.setVoiceResolver(ref => (ref === 'vp_plain' ? { providerId: 'plain', voiceId: 'p' }
    : ref === 'vp_gone' ? { unavailable: true } : { providerId: 'a', voiceId: 'x' }));
  assert.equal(h.gateway.performanceCapability('vp_a').id, 'a-cap');
  assert.equal(h.gateway.performanceCapability('vp_plain').id, 'none');
  assert.equal(h.gateway.performanceCapability('vp_gone').id, 'none');
});

test('解析器给出的 params.model 合并进合成参数与缓存键；调用方参数优先', async t => {
  const calls = [];
  const recording = { ...provider('custom-b'), synth: async (_text, options) => {
    calls.push(options.params);
    return { bytes: Buffer.from('x'), extension: 'mp3', contentType: 'audio/mpeg', source: 'b' };
  } };
  const h = makeGateway([recording]);
  t.after(h.cleanup);
  h.gateway.setVoiceResolver(() => ({ providerId: 'custom-b', voiceId: 'v', params: { model: 'm-voice' } }));
  const first = await h.gateway.synth('你好', { voiceId: 'vp_cx_b' });
  const second = await h.gateway.synth('你好', { voiceId: 'vp_cx_b', params: { model: 'm-call' } });
  assert.deepEqual(calls, [{ model: 'm-voice' }, { model: 'm-call' }]);
  assert.notEqual(first.hash, second.hash, '不同 model 不共用缓存');
});

test('syncCustomEndpointProviders：每个接口一个 provider，删除的接口注销，没有接口时保留空 custom', async () => {
  const { syncCustomEndpointProviders } = await import('./tts.js');
  const registry = new TtsProviderRegistry({ providers: [provider('other')] });
  const endpoints = [{ id: 'custom', name: 'MiniMax' }, { id: 'custom-breeze', name: 'Breeze' }];
  const lookup = id => endpoints.find(endpoint => endpoint.id === id) || null;
  syncCustomEndpointProviders(registry, { endpoints, getEndpoint: lookup });
  assert.deepEqual(registry.list().map(item => [item.id, item.label]), [['other', 'other'], ['custom', 'MiniMax'], ['custom-breeze', 'Breeze']]);
  syncCustomEndpointProviders(registry, { endpoints: endpoints.slice(1), getEndpoint: lookup });
  assert.deepEqual(registry.list().map(item => item.id), ['other', 'custom-breeze']);
  syncCustomEndpointProviders(registry, { endpoints: [], getEndpoint: () => null });
  assert.deepEqual(registry.list().map(item => item.id), ['other', 'custom']);
  assert.equal(registry.get('custom').isConfigured(), false);
});

test('syncFreeVoiceProvider：开关关闭时不注册 free-edge，打开时注册且只参与显式指定', async () => {
  const { syncFreeVoiceProvider } = await import('./tts.js');
  const registry = new TtsProviderRegistry({ providers: [provider('custom')] });
  let created = 0;
  const createProvider = () => { created += 1; return { ...provider('free-edge'), explicitOnly: true }; };
  syncFreeVoiceProvider(registry, { enabled: false, createProvider });
  assert.equal(registry.has('free-edge'), false);
  assert.equal(created, 0, '关闭时连 provider 都不创建');
  syncFreeVoiceProvider(registry, { enabled: true, createProvider });
  syncFreeVoiceProvider(registry, { enabled: true, createProvider });
  assert.equal(created, 1, '重复同步复用同一个 provider（保留声音列表缓存）');
  assert.deepEqual(registry.resolve().providers.map(item => item.id), ['custom']);
  assert.deepEqual(registry.resolve({ providerId: 'free-edge' }).providers.map(item => item.id), ['free-edge']);
  syncFreeVoiceProvider(registry, { enabled: false, createProvider });
  assert.equal(registry.has('free-edge'), false);
});

test('storeAudio：厂商给出的样音按内容哈希写入缓存，返回 /tts URL；同内容同一文件', t => {
  const env = makeGateway([]);
  t.after(env.cleanup);
  const first = env.gateway.storeAudio({ bytes: Buffer.from('trial'), extension: 'mp3' });
  const again = env.gateway.storeAudio({ bytes: Buffer.from('trial'), extension: 'mp3' });
  assert.match(first.url, /^\/tts\/[0-9a-f]{40}\.mp3$/);
  assert.equal(again.url, first.url);
  assert.deepEqual(env.files(), [first.url.slice('/tts/'.length)]);
  assert.throws(() => env.gateway.storeAudio({ bytes: Buffer.alloc(0), extension: 'mp3' }), /empty/);
  assert.throws(() => env.gateway.storeAudio({ bytes: Buffer.from('x'), extension: '../evil' }), /extension/);
});
