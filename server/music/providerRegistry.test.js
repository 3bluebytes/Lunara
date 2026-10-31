import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderRegistry, providerRegistry, MUSIC_CAPABILITIES,
} from './providerRegistry.js';

function declaration(overrides = {}) {
  return {
    id: 'alpha',
    displayName: 'Alpha 音乐',
    playable: true,
    authMode: 'cookie',
    priority: 0,
    capabilities: ['search', 'url'],
    ...overrides,
  };
}

test('the shipped registry declares the onboarded sources with an explicit playable flag', () => {
  assert.deepEqual(providerRegistry.ids(), ['ncm', 'qq']);
  assert.equal(providerRegistry.isPlayable('qq'), true);
  assert.equal(providerRegistry.isPlayable('ncm'), true);
  assert.equal(providerRegistry.isPlayable('apple'), false);
  assert.equal(providerRegistry.get('apple'), null, 'inactive Apple entry is retired, not a fake integration');
  assert.equal(providerRegistry.get('ncm').displayName, '网易云音乐');
});

test('a catalog-only source never appears where playback is implied', () => {
  assert.deepEqual(providerRegistry.defaultSourceCandidates(), ['ncm', 'qq']);
  assert.deepEqual(providerRegistry.catalogOnlySources().map(s => s.id), []);
  for (const chain of [providerRegistry.orderFor('qq'), providerRegistry.orderFor('ncm'), providerRegistry.orderFor('apple')]) {
    assert.equal(chain.includes('apple'), false, 'a directory source must not enter the resolution chain');
  }
});

test('the resolution chain puts the primary source first and keeps a deterministic tail', () => {
  assert.deepEqual(providerRegistry.orderFor('qq'), ['qq', 'ncm']);
  assert.deepEqual(providerRegistry.orderFor('ncm'), ['ncm', 'qq']);
  // 未知 / 不可播的主源不制造空洞，退回注册表顺序（与历史三元表达式的 else 分支一致）。
  assert.deepEqual(providerRegistry.orderFor('kugou'), ['ncm', 'qq']);
  assert.deepEqual(providerRegistry.orderFor(undefined), ['ncm', 'qq']);
});

test('capability gates answer false instead of guessing', () => {
  assert.equal(providerRegistry.supports('qq', 'discover'), true);
  assert.equal(providerRegistry.supports('ncm', 'discover'), false, 'ncm has no discovery endpoint');
  assert.equal(providerRegistry.supports('ncm', 'url'), true);
  assert.equal(providerRegistry.supports('apple', 'search'), false);
  assert.equal(providerRegistry.supports('nope', 'search'), false);
  assert.equal(providerRegistry.supports('qq', 'not-a-capability'), false);
  for (const capability of MUSIC_CAPABILITIES) {
    assert.equal(typeof providerRegistry.supports('qq', capability), 'boolean');
  }
});

test('a source that forgets playable fails registration instead of defaulting', () => {
  const { playable, ...withoutPlayable } = declaration();
  assert.throws(() => createProviderRegistry({ declarations: [withoutPlayable] }), /playable explicitly/);
});

test('an unplayable source must be declared catalog-only', () => {
  assert.throws(
    () => createProviderRegistry({ declarations: [declaration({ playable: false })] }),
    /must be declared catalogOnly/,
  );
  const registry = createProviderRegistry({
    declarations: [declaration({ playable: false, catalogOnly: true, capabilities: [] })],
  });
  assert.deepEqual(registry.defaultSourceCandidates(), []);
});

test('a playable source must be able to search and to produce a url', () => {
  assert.throws(() => createProviderRegistry({ declarations: [declaration({ capabilities: ['search'] })] }), /must declare "url"/);
  assert.throws(() => createProviderRegistry({ declarations: [declaration({ capabilities: ['url'] })] }), /must declare "search"/);
});

test('registration rejects duplicate ids, unknown capabilities and bad auth modes', () => {
  assert.throws(() => createProviderRegistry({ declarations: [declaration(), declaration()] }), /duplicate source id/);
  assert.throws(() => createProviderRegistry({ declarations: [declaration({ capabilities: ['search', 'url', 'telepathy'] })] }), /unknown capability/);
  assert.throws(() => createProviderRegistry({ declarations: [declaration({ authMode: 'sms' })] }), /invalid authMode/);
  assert.throws(() => createProviderRegistry({ declarations: [declaration({ id: '' })] }), /missing an id/);
  assert.throws(() => createProviderRegistry({ declarations: [declaration({ id: 'Alpha' })] }), /invalid id/);
});

test('lookups are case and whitespace tolerant, and declarations stay immutable', () => {
  assert.equal(providerRegistry.get('  NCM ')?.id, 'ncm');
  assert.equal(providerRegistry.displayName('  NCM '), '网易云音乐');
  assert.equal(providerRegistry.displayName('unknown-source'), 'unknown-source');
  const first = providerRegistry.list()[0];
  assert.throws(() => { first.playable = false; }, TypeError);
  assert.throws(() => { first.capabilities.push('telepathy'); }, TypeError);
});

test('ordering is stable for equal priorities', () => {
  const registry = createProviderRegistry({
    declarations: [
      declaration({ id: 'zulu', priority: 5, capabilities: ['search', 'url'] }),
      declaration({ id: 'alpha', priority: 5, capabilities: ['search', 'url'] }),
    ],
  });
  assert.deepEqual(registry.ids(), ['alpha', 'zulu']);
});
