import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceHealthWiring } from './createSourceHealthWiring.js';
import { reportSourceHealth, resetSourceHealthReporter } from '../music/sourceHealthSignal.js';
import { createProviderRegistry } from '../music/providerRegistry.js';

function fixture(t, options = {}) {
  const wiring = createSourceHealthWiring(options);
  const events = [];
  const unsubscribe = wiring.subscribe(event => events.push(event));
  t.after(() => { unsubscribe(); resetSourceHealthReporter(); });
  return { wiring, events };
}

test('future providers use registry metadata and the same closed failure notification contract', t => {
  const registry = createProviderRegistry({ declarations: [{ id: 'future-source', displayName: '未来播放源',
    playable: true, authMode: 'cookie', priority: 1, capabilities: ['search', 'url'] }] });
  const { wiring, events } = fixture(t, { registry });
  reportSourceHealth('future-source', 'timeout');
  assert.deepEqual(wiring.sourceIssues(), [{ source: 'future-source', displayName: '未来播放源', code: 'timeout' }]);
  reportSourceHealth('future-source', 'timeout');
  assert.equal(events.length, 1);
  reportSourceHealth('future-source', null);
  assert.deepEqual(wiring.sourceIssues(), []);
  assert.equal(events.at(-1).code, null);
});

test('source authentication incidents are deduplicated and replayable without private data', t => {
  const { wiring, events } = fixture(t);
  reportSourceHealth('qq', 'requires-auth');
  reportSourceHealth('qq', 'requires-auth');
  assert.deepEqual(events, [{ type: 'music-source-status', source: 'qq', displayName: 'QQ 音乐', code: 'requires-auth' }]);
  assert.deepEqual(wiring.authFailures(), [{ source: 'qq', code: 'requires-auth' }]);
  const snapshot = wiring.authFailures();
  snapshot[0].source = 'changed';
  assert.equal(wiring.authFailures()[0].source, 'qq', 'replay is a copy');
  assert.equal(JSON.stringify(events).includes('cookie'), false);
});

test('public playback success and transient failures do not reset or invent an auth incident', t => {
  const { wiring, events } = fixture(t);
  for (const code of ['timeout', 'unavailable', 'rate-limited', 'not-playable']) reportSourceHealth('qq', code);
  assert.deepEqual(events.map(event => event.code), ['timeout', 'unavailable', 'rate-limited']);
  reportSourceHealth('qq', 'requires-auth');
  reportSourceHealth('qq', null);
  reportSourceHealth('qq', 'requires-auth');
  assert.equal(events.length, 4);
  assert.equal(wiring.authFailures().length, 1);
});

test('explicit verified login resets deduplication for only the recovered provider', t => {
  const { wiring, events } = fixture(t);
  wiring.recordFailure('qq', 'requires-auth');
  wiring.recordFailure('ncm', 'requires-auth');
  wiring.recordAuthenticated('qq');
  assert.deepEqual(events.at(-1), { type: 'music-source-status', source: 'qq', displayName: 'QQ 音乐', code: null });
  assert.deepEqual(wiring.authFailures(), [{ source: 'ncm', code: 'requires-auth' }]);
  reportSourceHealth('qq', 'requires-auth');
  assert.equal(events.length, 4);
});

test('empty audio resources trigger one bounded background auth verification, not guessed expiry', async t => {
  let finish;
  let calls = 0;
  let clock = 1000;
  const { wiring, events } = fixture(t, { now: () => clock, providers: { qq: {
    getCookie: () => 'fixture-credential',
    loginStatus: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
  } } });
  reportSourceHealth('qq', 'not-playable');
  reportSourceHealth('qq', 'not-playable');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(events, [], 'empty URL is not proof of expiry');
  finish({ loggedIn: false, code: 'requires-auth' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wiring.authFailures().length, 1);
  wiring.recordAuthenticated('qq');
  clock += 31000;
  reportSourceHealth('qq', 'not-playable');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish({ loggedIn: false, code: 'timeout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(wiring.authFailures(), []);
});

test('a timed-out background check cannot spawn overlapping checks or report a late guessed expiry', async t => {
  let clock = 1;
  let calls = 0;
  let finish;
  const { wiring } = fixture(t, { now: () => clock, authCheckTimeoutMs: 5, providers: { qq: {
    getCookie: () => 'fixture', loginStatus: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
  } } });
  reportSourceHealth('qq', 'not-playable');
  await new Promise(resolve => setTimeout(resolve, 15));
  clock += 31000;
  reportSourceHealth('qq', 'not-playable');
  assert.equal(calls, 1, 'unabortable provider work is still in flight');
  finish({ loggedIn: false, code: 'requires-auth' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(wiring.authFailures(), [], 'result after the check deadline is ignored');
});

test('an old background auth check cannot overwrite explicit login recovery', async t => {
  let finish;
  const { wiring } = fixture(t, { providers: { qq: { getCookie: () => 'fixture',
    loginStatus: () => new Promise(resolve => { finish = resolve; }),
  } } });
  reportSourceHealth('qq', 'not-playable');
  await new Promise(resolve => setImmediate(resolve));
  wiring.recordAuthenticated('qq');
  finish({ loggedIn: false, code: 'requires-auth' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(wiring.authFailures(), []);
});

test('unknown providers and broken subscribers cannot affect the resolution signal', t => {
  const { wiring, events } = fixture(t);
  wiring.subscribe(() => { throw new Error('UI unavailable'); });
  reportSourceHealth('unknown', 'requires-auth');
  wiring.recordAuthenticated('unknown');
  assert.deepEqual(events, []);
  assert.doesNotThrow(() => reportSourceHealth('qq', 'requires-auth'));
  assert.equal(events.length, 1);
});
