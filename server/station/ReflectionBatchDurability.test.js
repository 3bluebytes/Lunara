import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ReflectionAgent } from './ReflectionAgent.js';
import { ReflectionObservationStore } from './ReflectionObservationStore.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const insightJson = JSON.stringify({
  observation: '只观察到这次听歌结果，不推断永久偏好。',
  evidence: [], tags: ['signal:listening'], confidence: 0.3,
});

function fixture(t) {
  const db = new Database(':memory:');
  let clock = Date.now();
  const now = () => clock;
  const store = new ReflectionObservationStore({ db, now }).initialize();
  const workers = [];
  const memories = [];
  let modelCalls = 0;
  // The real observation journal and worker are under test. Memory persistence
  // is a deterministic seam here; the full MemoryService path has lifecycle tests.
  const memory = {
    store: { getById: id => memories.find(row => row.id === id) },
    searchMemory: (_query, options) => memories.filter(row => row.namespace === options.namespace
      && row.tags.split(',').includes(options.tags)).slice(0, options.limit),
    addMemory: record => {
      const id = memories.length + 1;
      memories.push({ ...record, id });
      return { ok: true, id };
    },
  };
  const worker = observationStore => {
    const result = new ReflectionAgent({
      store: observationStore, station: { stationMemory: memory }, now,
      shortWindow: 2, llm: { askText: async () => { modelCalls++; return insightJson; } },
      logger: { warn() {} },
    });
    // Exercise explicit attempts without starting production scheduling timers.
    workers.push(result);
    return result;
  };
  t.after(() => {
    for (const item of workers) item.shutdown();
    db.close();
  });
  return { db, store, now, worker, memories,
    advance: value => { clock += value; }, calls: () => modelCalls };
}

function observe(store, eventKey, createdAt) {
  store.append({ eventKey, personId: 'lunara', sessionId: 'listening-session',
    kind: 'playback', createdAt, data: { songId: eventKey, outcome: 'completed', playedSeconds: 180 } });
}

test('a written long-window batch keeps its identity when retry crosses the 24-hour cutoff', async t => {
  const f = fixture(t);
  observe(f.store, 'near-24h-cutoff', f.now() - DAY + 30_000);
  observe(f.store, 'recent-original', f.now() - MINUTE);
  const firstWorker = f.worker(f.store);
  f.store.acknowledge = () => { throw new Error('simulated interruption after memory write'); };
  assert.equal(await firstWorker._runReflection('lunara', 'long'), null);
  assert.equal(f.store.attempt('lunara', 'long').status, 'retry_pending');
  assert.equal(f.calls(), 1);
  assert.equal(f.memories.length, 1);
  const initialEvidence = JSON.parse(f.memories[0].evidence).eventKeys;
  assert.deepEqual(initialEvidence, ['near-24h-cutoff', 'recent-original']);

  firstWorker.shutdown();
  f.advance(61_000);
  // Recreate the journal/worker from persisted SQLite tables, not in-memory state.
  const reopened = new ReflectionObservationStore({ db: f.db, now: f.now }).initialize();
  observe(reopened, 'arrived-after-write', f.now());
  assert.deepEqual(reopened.pending('lunara', 'long').map(row => row.eventKey),
    ['recent-original', 'arrived-after-write'], 'fresh candidates exclude expired-window observations');
  const retry = f.worker(reopened);
  const result = await retry._runReflection('lunara', 'long');

  assert.equal(result?.memoryId, f.memories[0].id);
  assert.equal(f.calls(), 1, 'fixed batch retry must reuse the previously written insight');
  assert.equal(f.memories.length, 1, 'crossing the window must not create a second batch identity');
  assert.deepEqual(JSON.parse(f.memories[0].evidence).eventKeys, initialEvidence);
  assert.deepEqual(reopened.pending('lunara', 'long').map(row => row.eventKey), ['arrived-after-write']);
  assert.equal(reopened.attempt('lunara', 'long').status, 'succeeded');
  assert.equal(reopened.attempt('lunara', 'long').batch_json, null);
});

test('the observation count cap does not evict members of a saved retry batch', t => {
  const f = fixture(t);
  observe(f.store, 'unprotected-old', f.now() - 3 * MINUTE);
  observe(f.store, 'protected-first', f.now() - 2 * MINUTE);
  observe(f.store, 'protected-second', f.now() - MINUTE);
  const fixed = f.store.pending('lunara').filter(row => row.eventKey.startsWith('protected-'));
  f.store.saveBatch('lunara', 'short', fixed);
  f.store.markAttempt('lunara', 'short', { failures: 1, status: 'retry_pending', nextAt: f.now() + MINUTE });
  for (let i = 0; i < 2000; i++) observe(f.store, `new-observation-${i}`, f.now());

  f.store.prune();

  assert.deepEqual(f.store.batch('lunara', 'short', 4).map(row => row.eventKey),
    ['protected-first', 'protected-second'], 'count pruning must preserve exact saved membership');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reflection_observations WHERE event_key = ?')
    .get('unprotected-old').n, 0, 'the cap still evicts unprotected older observations');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reflection_observations WHERE event_key = ?')
    .get('new-observation-1999').n, 1);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM reflection_observations').get().n <= 2002,
    'only the bounded active batch may be retained in addition to the normal cap');
});

test('seven-day retention expires an incomplete saved batch without replaying its surviving subset', t => {
  const f = fixture(t);
  observe(f.store, 'near-retention-cutoff', f.now() - 7 * DAY + 30_000);
  observe(f.store, 'surviving-original', f.now());
  f.store.saveBatch('lunara', 'short', f.store.pending('lunara'));
  f.store.markAttempt('lunara', 'short', { failures: 1, status: 'retry_pending', nextAt: f.now() + MINUTE });
  f.advance(61_000);
  observe(f.store, 'unrelated-new-evidence', f.now());

  f.store.prune();

  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reflection_observations WHERE event_key = ?')
    .get('near-retention-cutoff').n, 0, 'active batches must not bypass the privacy retention deadline');
  assert.equal(f.store.attempt('lunara', 'short').status, 'batch_expired');
  assert.deepEqual(f.store.pending('lunara').map(row => row.eventKey), ['unrelated-new-evidence'],
    'surviving old members are retired together without consuming unrelated new evidence');
  assert.deepEqual(f.store.batch('lunara', 'short', 4).map(row => row.eventKey), ['unrelated-new-evidence'],
    'after prune retires the incomplete batch, only wholly new evidence may form a new batch');
});
