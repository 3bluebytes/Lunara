import assert from 'node:assert/strict';
import test from 'node:test';
import { LibrarySyncService } from './LibrarySyncService.js';

test('library sync service owns startup and cookie discovery lifecycle idempotently', async () => {
  const calls = [];
  const listeners = {};
  let unsubscribed = 0;
  const coordinator = {
    recoverStaleRuns: () => calls.push('recover'),
    discoverAll: async input => { calls.push(['discoverAll', input]); return []; },
    discover: async (provider, input) => { calls.push(['discover', provider, input]); return { promise: Promise.resolve() }; },
    isRunning: () => false,
    resolveCurrent: async provider => ({ provider, accountUid: provider === 'ncm' ? 'U' : null }),
  };
  const provider = name => ({
    onCookieChange(callback) {
      listeners[name] = callback;
      return () => { unsubscribed += 1; };
    },
  });
  const service = new LibrarySyncService({
    coordinator,
    store: { allSourceStatuses: () => [] },
    providers: { ncm: provider('ncm'), qq: provider('qq') },
    logger: { warn: () => {} },
  });

  assert.deepEqual(service.start(), { started: true, duplicate: false });
  assert.deepEqual(service.start(), { started: true, duplicate: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call === 'recover').length, 1);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'discoverAll').length, 1);
  listeners.ncm();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'discover' && call[1] === 'ncm'));
  assert.deepEqual(service.stop(), { stopped: true, duplicate: false });
  assert.deepEqual(service.stop(), { stopped: true, duplicate: true });
  assert.equal(unsubscribed, 2);
});

test('library import validates provider/login and resumes existing source asynchronously', async () => {
  const coordinator = {
    requestImport: async provider => provider === 'qq'
      ? { accepted: false, running: false, error: 'not logged in' }
      : { accepted: true, running: true, source: { provider: 'ncm', account_uid: 'U', import_status: 'partial' }, promise: Promise.resolve() },
    currentAccountUid: () => null,
  };
  const store = {
    sourceStatus: () => ({ provider: 'ncm', account_uid: 'U', import_status: 'partial' }),
  };
  const service = new LibrarySyncService({ coordinator, store });
  await assert.rejects(service.import({ provider: 'bad' }), error => error.statusCode === 400);
  await assert.rejects(service.import({ provider: 'qq' }), error => error.statusCode === 409);
  const result = await service.import({ provider: 'ncm' });
  assert.equal(result.accepted, true);
  assert.equal(result.running, true);
  assert.equal(result.source.import_status, 'partial');
  assert.equal('promise' in result, false, 'HTTP payload must not expose Promise');
});

test('library status reports current/running/stale without provider credentials', async () => {
  const coordinator = {
    resolveCurrent: async provider => ({ provider, accountUid: provider === 'ncm' ? 'U' : null }),
    isRunning: (_provider, uid) => uid === 'U',
  };
  const store = {
    allSourceStatuses: () => [
      { provider: 'ncm', account_uid: 'U', import_status: 'complete', run_started_at: 1 },
      { provider: 'qq', account_uid: 'Q', import_status: 'partial', run_started_at: 2 },
    ],
  };
  const result = await new LibrarySyncService({ coordinator, store }).status();
  assert.equal(result.sources[0].current_source, true);
  assert.equal(result.sources[0].running, true);
  assert.equal(result.sources[0].stale, false);
  assert.equal(result.sources[1].current_source, false);
  assert.equal(result.sources[1].stale, true);
  assert.equal(JSON.stringify(result).includes('cookie'), false);
});
