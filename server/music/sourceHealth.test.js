import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderRegistry, providerRegistry } from './providerRegistry.js';
import { createSourceHealth, SOURCE_HEALTH_READY, SOURCE_HEALTH_CATALOG_ONLY } from './sourceHealth.js';

function fixture({ loginStatusOf = null, clock = { now: 1_000 } } = {}) {
  const health = createSourceHealth({
    registry: providerRegistry,
    loginStatusOf,
    now: () => clock.now,
    failureTtlMs: 60_000,
    loginTtlMs: 10_000,
  });
  return { health, clock };
}

test('a source with no observed failure is simply ready', async () => {
  const { health } = fixture();
  const qq = await health.read('qq');
  assert.equal(qq.state, SOURCE_HEALTH_READY);
  assert.equal(qq.playable, true);
  assert.equal(qq.authenticated, null, 'no login probe configured means unknown, not false');
  assert.equal(await health.read('nope'), null, 'unknown ids are not invented');
});

test('a catalog-only source never reports ready (synthetic registry)', async () => {
  const registry = createProviderRegistry({ declarations: [{ id: 'catalog', displayName: 'Catalog',
    playable: false, catalogOnly: true, authMode: 'none', priority: 0, capabilities: [] }] });
  const health = createSourceHealth({ registry });
  const catalog = await health.read('catalog');
  assert.equal(catalog.state, SOURCE_HEALTH_CATALOG_ONLY);
  assert.equal(catalog.playable, false);
});

test('a failure is reported for its TTL and then forgotten', async () => {
  const { health, clock } = fixture();
  health.recordFailure('ncm', 'requires-member');
  assert.equal((await health.read('ncm')).state, 'requires-member');

  clock.now += 59_000;
  assert.equal((await health.read('ncm')).state, 'requires-member');

  clock.now += 2_000;
  // 观测过期就回到 ready：三天前的一次失败不能永远说「这个源坏了」。
  assert.equal((await health.read('ncm')).state, SOURCE_HEALTH_READY);
  assert.deepEqual(health.inspect().failures, []);
});

test('a success clears the failure immediately', async () => {
  const { health } = fixture();
  health.recordFailure('qq', 'unavailable');
  assert.equal((await health.read('qq')).state, 'unavailable');
  health.recordSuccess('qq');
  assert.equal((await health.read('qq')).state, SOURCE_HEALTH_READY);
});

test('raw errors are classified and never stored verbatim', async () => {
  const { health } = fixture();
  const leak = 'https://provider.test/x?cookie=SID%3Dsecret';
  health.recordFailure('qq', new Error(`login required ${leak}`));
  const state = await health.read('qq');
  assert.equal(state.state, 'requires-auth');
  assert.doesNotMatch(JSON.stringify({ state, inspect: health.inspect() }), /cookie|secret|https?:/i);
});

test('being logged out is a separate fact, not an unhealthy state', async () => {
  // QQ 与网易云未登录时仍可搜索与播放部分公开内容：把「未登录」直接说成
  // 「不可用」会让用户看到假的故障。
  const { health } = fixture({ loginStatusOf: async () => ({ loggedIn: false }) });
  const qq = await health.read('qq');
  assert.equal(qq.state, SOURCE_HEALTH_READY);
  assert.equal(qq.authenticated, false);

  const { health: loggedIn } = fixture({ loginStatusOf: async () => ({ loggedIn: true, userId: '1' }) });
  assert.equal((await loggedIn.read('qq')).authenticated, true);
});

test('a throwing login probe is not evidence that the source is down', async () => {
  const { health } = fixture({ loginStatusOf: async () => { throw new Error('probe failed'); } });
  const state = await health.read('qq');
  assert.equal(state.state, SOURCE_HEALTH_READY);
  assert.equal(state.authenticated, null);
});

test('login probes are cached briefly instead of hitting the provider on every read', async () => {
  let calls = 0;
  const { health, clock } = fixture({ loginStatusOf: async () => { calls += 1; return { loggedIn: true }; } });
  await health.read('qq');
  await health.read('qq');
  assert.equal(calls, 1);
  clock.now += 11_000;
  await health.read('qq');
  assert.equal(calls, 2);
});

test('the snapshot covers every declared source in registry order', async () => {
  const { health } = fixture({ loginStatusOf: async () => ({ loggedIn: false }) });
  const snapshot = await health.snapshot();
  assert.deepEqual(snapshot.map(item => item.id), providerRegistry.ids());
  assert.deepEqual(snapshot.map(item => item.state), ['ready', 'ready']);
});
