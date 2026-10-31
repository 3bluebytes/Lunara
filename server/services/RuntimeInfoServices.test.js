import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthService, SettingsHttpService } from './RuntimeInfoServices.js';

test('SettingsHttpService preserves public current/options shape and delegates updates', async () => {
  const calls = [];
  const voices = [{ id: 'voice-a', name: 'A' }];
  const service = new SettingsHttpService({
    state: { id: 'state' },
    tts: { id: 'tts' },
    voices,
    getSnapshot: async deps => { calls.push(['snapshot', deps]); return { source: 'qq', voice: 'voice-a' }; },
    update: async (input, deps) => { calls.push(['update', input, deps]); return { current: input, ready: true }; },
  });

  assert.deepEqual(await service.snapshot(), {
    current: { source: 'qq', voice: 'voice-a' },
    options: {
      source: [
        { id: 'ncm', name: '网易云音乐', ready: true, note: '已接入' },
        { id: 'qq', name: 'QQ 音乐', ready: true, note: '已内置（支持扫码登录）' },
      ],
      tts: voices,
      // 新增：声音 provider 的就绪状态，供设置页展示与下载入口判断。
      // 未传入 providerStatus 时为空数组。
      ttsProviders: [],
    },
  });
  assert.deepEqual(await service.update({ source: 'ncm' }), {
    current: { source: 'ncm' }, ready: true,
  });
  assert.deepEqual(calls[1][2].ttsVoiceIds, ['voice-a']);
});

test('HealthService checks providers concurrently and exposes only public LLM configuration', async () => {
  const service = new HealthService({
    providers: {
      ncm: { ping: async () => true, loginStatus: async () => ({ loggedIn: false }), getCookie: () => '' },
      qq: { ping: async () => false, loginStatus: async () => ({ loggedIn: true, userId: '1' }), getCookie: () => 'uin=1' },
    },
    getLlmConfig: async () => ({ ready: true, model: 'model-x', apiKey: 'must-not-leak' }),
    getNow: () => ({ slot: 'night' }),
    env: { MINIMAX_API_KEY: 'configured' },
    getLastBudgetRejection: () => ({ ts: 1, taskId: 'song_tag', reason: 'daily_tokens', cap: 100, used: 120 }),
  });
  assert.deepEqual(await service.snapshot(), {
    ncm: true,
    ncmLogin: { loggedIn: false, cookieStored: false },
    qq: false,
    qqLogin: { loggedIn: true, userId: '1', cookieStored: true },
    minimax: true,
    llm: { ready: true, model: 'model-x',
      lastBudgetRejection: { ts: 1, taskId: 'song_tag', reason: 'daily_tokens', cap: 100, used: 120 } },
    now: { slot: 'night' },
    // 播放失败计数在未接线时为 null：界面据此不显示这一块，而不是显示全 0。
    trackFailures: null,
  });
  assert.doesNotMatch(JSON.stringify(await service.snapshot()), /must-not-leak|Bearer/u);
});

test('HealthService 不泄漏凭据内容：cookieStored 只取布尔，且 provider 缺 getCookie 时为 false', async () => {
  const service = new HealthService({
    providers: {
      ncm: { ping: async () => true, loginStatus: async () => ({ loggedIn: false, reason: 'upstream 500' }) },
      qq: { ping: async () => true, loginStatus: async () => ({ loggedIn: false, reason: '获取用户歌单失败' }), getCookie: () => 'secret-cookie' },
    },
    getLlmConfig: async () => ({ ready: true, model: 'model-x' }),
    getNow: () => ({ slot: 'night' }),
    env: {},
  });
  const snapshot = await service.snapshot();
  assert.equal(snapshot.ncmLogin.cookieStored, false);
  assert.equal(snapshot.qqLogin.cookieStored, true);
  assert.equal(snapshot.qqLogin.loggedIn, false);
  assert.ok(!JSON.stringify(snapshot).includes('secret-cookie'));
});

test('声音列表与 provider 状态支持函数形式，每次都重新求值', async () => {
  let voices = [{ id: 'vp_a' }];
  let providers = [{ id: 'system', configured: true }];
  const service = new SettingsHttpService({
    state: {}, tts: {},
    getVoices: () => voices,
    providerStatus: () => providers,
    getSnapshot: async () => ({}),
    update: async () => ({ current: {} }),
  });
  const first = await service.snapshot();
  assert.deepEqual(first.options.tts, [{ id: 'vp_a' }]);
  assert.deepEqual(first.options.ttsProviders, [{ id: 'system', configured: true }]);
  // 用户填入付费 key 后原生声音变得可用，设置页必须立刻反映而不是停留在旧回落状态。
  voices = [{ id: 'vp_b' }];
  providers = [{ id: 'custom', configured: true }, { id: 'system', configured: true }];
  const second = await service.snapshot();
  assert.deepEqual(second.options.tts, [{ id: 'vp_b' }], '不应缓存旧的声音列表');
  assert.equal(second.options.ttsProviders.length, 2, '不应缓存旧的 provider 状态');
});

test('声音选项或 provider 状态取数抛错时不拖垮设置页', async () => {
  const service = new SettingsHttpService({
    state: {}, tts: {},
    getVoices: () => { throw new Error('voice list exploded'); },
    providerStatus: () => { throw new Error('status exploded'); },
    getSnapshot: async () => ({}),
    update: async () => ({ current: {} }),
    logger: { warn() {} },
  });
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.options.tts, []);
  assert.deepEqual(snapshot.options.ttsProviders, []);
});

test('更新时声音校验沿用当前选项集合', async () => {
  const service = new SettingsHttpService({
    state: {}, tts: {},
    getVoices: () => [{ id: 'vp_x' }],
    getSnapshot: async () => ({}),
    update: async (input, deps) => ({ current: input, deps }),
  });
  const result = await service.update({ voice: 'vp_x' });
  assert.deepEqual(result.deps.ttsVoiceIds, ['vp_x']);
});

test('source options carry derived health without changing the base shape', async () => {
  const build = sourceHealth => new SettingsHttpService({
    state: {}, tts: {},
    getSnapshot: async () => ({ source: 'qq' }),
    update: async () => ({}),
    sourceHealth,
  });

  const withHealth = await build(async () => [
    { id: 'ncm', state: 'requires-member', since: 123, authenticated: true },
    { id: 'qq', state: 'ready', since: null, authenticated: false },
    { id: 'apple', state: 'catalog-only', since: null, authenticated: null },
  ]).sourceOptions();

  assert.deepEqual(withHealth, [
    // 失败原因码配一句用户话术；`ready` 与 `catalog-only` 都不是故障，不配文案。
    { id: 'ncm', name: '网易云音乐', ready: true, note: '已接入', state: 'requires-member', stateText: '网易云音乐需要会员才能听这首歌', since: 123, authenticated: true },
    { id: 'qq', name: 'QQ 音乐', ready: true, note: '已内置（支持扫码登录）', state: 'ready', authenticated: false },
  ]);

  // 健康探测缺失或抛错时退回原形状：前端不需要为「没接探测」写第二套分支。
  const plain = [
    { id: 'ncm', name: '网易云音乐', ready: true, note: '已接入' },
    { id: 'qq', name: 'QQ 音乐', ready: true, note: '已内置（支持扫码登录）' },
  ];
  assert.deepEqual(await build(null).sourceOptions(), plain);
  assert.deepEqual(await build(async () => { throw new Error('probe down'); }).sourceOptions(), plain);
});
