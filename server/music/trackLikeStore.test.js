import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { TrackLikeStore, MAX_AUTO_ATTEMPTS, REMOTE_STATES, LIKE_ORIGINS } from './trackLikeStore.js';

function store() {
  return new TrackLikeStore({ dbPath: ':memory:', now: () => 1_700_000_000_000 }).initialize();
}

test('no record means "never expressed", not "disliked"', () => {
  const likes = store();
  assert.equal(likes.get('ncm', '186016'), null);
});

test('intent is stored per (provider, song_id) and never merged across sources', () => {
  const likes = store();
  likes.setDesired('ncm', '186016', true, { remoteState: 'pending', requestId: 'r1' });
  likes.setDesired('qq', '186016', false, { remoteState: 'local_only', requestId: 'r2' });

  assert.equal(likes.get('ncm', '186016').desired, true);
  assert.equal(likes.get('qq', '186016').desired, false);
  assert.equal(likes.get('ncm', '186016').remoteState, 'pending');
  assert.equal(likes.get('qq', '186016').remoteState, 'local_only');
});

test('the last intent wins and a changed intent resets the retry budget', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'a' });
  likes.recordFailure('ncm', '1', 'request_failed');
  likes.recordFailure('ncm', '1', 'request_failed');
  assert.equal(likes.get('ncm', '1').attempts, 2);

  likes.setDesired('ncm', '1', false, { requestId: 'b' });
  const after = likes.get('ncm', '1');
  assert.equal(after.desired, false);
  assert.equal(after.attempts, 0, '用户重新表达过，就该重新给一次同步机会');
});

test('repeating the same intent keeps the accumulated attempts', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'a' });
  likes.recordFailure('ncm', '1', 'network');
  likes.setDesired('ncm', '1', true, { requestId: 'a2' });
  assert.equal(likes.get('ncm', '1').attempts, 1);
});

test('failures stop auto-retrying at the cap and land on failed', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'a' });
  for (let i = 0; i < MAX_AUTO_ATTEMPTS; i += 1) likes.recordFailure('ncm', '1', 'network');

  const row = likes.get('ncm', '1');
  assert.equal(row.attempts, MAX_AUTO_ATTEMPTS);
  assert.equal(row.remoteState, 'failed');
  assert.equal(row.desired, true, '技术失败不改写用户意图');
  assert.deepEqual(likes.listPending(), []);
});

test('success clears the budget and marks synced', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'a' });
  likes.recordFailure('ncm', '1', 'network');
  const synced = likes.recordSuccess('ncm', '1');
  assert.equal(synced.remoteState, 'synced');
  assert.equal(synced.attempts, 0);
  assert.equal(synced.lastError, null);
});

test('requestId replay finds the same row', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'req-abc' });
  const replayed = likes.findByRequestId('req-abc');
  assert.equal(replayed.songId, '1');
  assert.equal(replayed.desired, true);
  assert.equal(likes.findByRequestId('req-unknown'), null);
});

test('unknown states and invalid input are rejected instead of silently stored', () => {
  const likes = store();
  assert.throws(() => likes.markState('ncm', '1', 'syncedish'), /unknown remote state/);
  assert.throws(() => likes.setDesired('', '1', true), /requires provider/);
  assert.throws(() => likes.setDesired('ncm', '  ', true), /requires songId/);
  assert.throws(() => likes.setDesired('ncm', '1', 'maybe'), /boolean desired/);
  assert.deepEqual(REMOTE_STATES, ['local_only', 'pending', 'synced', 'failed']);
});

test('last_error only accepts classification codes and redacts anything else', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'a' });
  const row = likes.recordFailure('ncm', '1', `MUSIC_U=secret ${'x'.repeat(200)}`);
  assert.equal(row.lastError, 'unknown_error', '凭据形状的东西一律不落库');

  const coded = store();
  coded.setDesired('ncm', '2', true, { requestId: 'b' });
  assert.equal(coded.recordFailure('ncm', '2', 'code:500').lastError, 'code:500');
});

test('an existing database gets the origin column without losing rows', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE song_likes (
      provider TEXT NOT NULL, song_id TEXT NOT NULL, desired INTEGER NOT NULL,
      remote_state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, request_id TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, song_id)
    );
    INSERT INTO song_likes VALUES ('ncm', '1398654758', 1, 'synced', 0, NULL, 'r', 1);
  `);

  const likes = new TrackLikeStore({ db, now: () => 1_700_000_000_000 }).initialize();
  const row = likes.get('ncm', '1398654758');
  assert.equal(row.desired, true);
  assert.equal(row.origin, 'user', '旧行都是用户在 UI 上点出来的');
  assert.deepEqual(LIKE_ORIGINS, ['user', 'adopted']);
  assert.throws(() => likes.setDesired('ncm', 'x', true, { origin: 'remote' }), /unknown like origin/);
});

test('initialize is idempotent and keeps existing rows', () => {
  const likes = store();
  likes.setDesired('ncm', '1', true, { requestId: 'a' });
  likes.initialize();
  assert.equal(likes.get('ncm', '1').desired, true);
});

test('pending listing honours the batch limit', () => {
  const likes = store();
  for (const id of ['1', '2', '3']) likes.setDesired('ncm', id, true, { requestId: `r${id}` });
  assert.equal(likes.listPending({ limit: 2 }).length, 2);
});
