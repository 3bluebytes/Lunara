import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from '../memory/MemoryService.js';
import { recentReflectionInsights } from '../memory/reflectionInsights.js';
import { ReflectionObservationStore } from './ReflectionObservationStore.js';
import { ReflectionAgent } from './ReflectionAgent.js';
import { ListeningReflectionBridge } from './ListeningReflectionBridge.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { createVirtualPersonRuntimeComposition, retrieveMemories } from '../virtual-person/createVirtualPersonRuntimeComposition.js';
import { PromptAssembler } from '../virtual-person/PromptAssembler.js';
import { ReflectionAdminService } from '../services/ReflectionAdminService.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { createBus } from './communication/AgentMessageBus.js';
import { createEvent, EventType } from './communication/messages.js';

const response = JSON.stringify({ observation: '本次用户想安静听歌；不能据此推断永久偏好。', evidence: [], tags: ['context:quiet'], confidence: 0.9 });
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'lunara-reflection-repair-'));
  process.env.LUNARA_DB_PATH = resolve(root, 'state.db');
  const memory = new MemoryService('station');
  await memory.initialize();
  const ledger = new ConversationStore({ db: memory.store.db }).initialize();
  const childMemory = new MemoryService('radiohost:child');
  await childMemory.initialize();
  const bus = createBus({ log: false });
  const station = { stationMemory: memory, bus,
    listRadioHosts: () => [{ id: 'child' }], getRadiohostMetadata: id => id === 'child' ? { id } : null,
    getRadioHostMemoryService: async id => id === 'child' ? childMemory : null };
  let now = Date.now();
  const store = new ReflectionObservationStore({ db: memory.store.db, now: () => now });
  const worker = new ReflectionAgent({ station, bus, store, now: () => now,
    llm: { askText: async () => response }, ...options });
  await worker.initialize();
  await settle();
  t.after(async () => { worker.shutdown(); await settle(); await childMemory.shutdown(); await memory.shutdown(); });
  return { root, memory, childMemory, station, store, worker, bus, ledger,
    advance: ms => { now += ms; }, now: () => now };
}

function complete(ledger, id, person = 'lunara', text = '今天只想安静听歌。') {
  ledger.beginRequest({ sessionId: 'session', requestId: id, virtualPersonId: person, userText: text });
  return ledger.completeRequest({ requestId: id, virtualPersonId: person,
    message: { content: '好，我们安静听一会儿。' }, result: { outcomeCodes: ['RADIO_REQUEST_COMPLETED'] } });
}

function observation(store, key, personId = 'lunara', extra = {}) {
  store.append({ eventKey: key, personId, sessionId: 'session', kind: 'playback',
    data: { songId: key, songQuery: '歌曲 — 歌手', outcome: 'completed', playedSeconds: 180, ...extra } });
}

// 纯播放观察不触发模型；需要用户语言的测试用 turn 观察作为反思输入。
const turnObservation = (store, key, personId = 'lunara') => store.append({
  eventKey: key, personId, sessionId: 'session', kind: 'turn',
  data: { userText: `用户的话 ${key}`, assistantText: '角色的回应' } });

test('committed ledger supplies root user/assistant pair, recovers lost notification and rejects uncommitted/internal text', async t => {
  let prompt = '';
  const f = await fixture(t, { shortWindow: 1, llm: { askText: async value => { prompt = value; return response; } } });
  complete(f.ledger, 'r1');
  f.ledger.beginRequest({ sessionId: 'session', requestId: 'incomplete', virtualPersonId: 'lunara', userText: 'NEVER_COMMITTED' });
  // No bus notification: the durable ledger still recovers the completed pair.
  await f.worker.sweep();
  assert.match(prompt, /今天只想安静听歌/);
  assert.match(prompt, /好，我们安静听一会儿/);
  assert.match(prompt, /RADIO_REQUEST_COMPLETED/);
  assert.doesNotMatch(prompt, /NEVER_COMMITTED/);
  const insights = recentReflectionInsights(f.memory, 'person:lunara');
  assert.equal(insights.length, 1);
  assert.equal(insights[0].confidence, 0.4);
  assert.match(insights[0].evidence[0], /^turn:/);
  assert.equal(recentReflectionInsights(f.memory, 'radiohost:child').length, 0);
  f.worker._onTurnCommitted(createEvent({ type: EventType.TURN_COMMITTED, sourceAgentId: 'virtual-person:child',
    payload: { requestId: 'r1', sessionId: 'other', virtualPersonId: 'child', displayText: 'SECRET_STACK' } }));
  assert.equal(f.store.pending('child').length, 0);
});

test('failed batch and cooldown survive reopen; new observations are not consumed by its retry', async t => {
  let calls = 0;
  const f = await fixture(t, { shortWindow: 2, llm: { askText: async () => { calls++; throw new Error('SECRET_PROVIDER_ERROR'); } } });
  turnObservation(f.store, 'old-1'); turnObservation(f.store, 'old-2');
  await f.worker.sweep();
  assert.equal(calls, 1);
  assert.equal(f.store.pending('lunara').length, 2);
  assert.equal(f.store.attempt('lunara').status, 'retry_pending');
  f.worker.shutdown();
  const recoveredStore = new ReflectionObservationStore({ dbPath: resolve(f.root, 'state.db'), now: f.now });
  let prompt = '';
  const recovered = new ReflectionAgent({ station: f.station, store: recoveredStore, now: f.now,
    shortWindow: 2, llm: { askText: async value => { calls++; prompt = value; return response; } } });
  await recovered.initialize();
  await recovered.sweep();
  await settle();
  assert.equal(calls, 1, 'restart must not bypass cooldown');
  observation(recoveredStore, 'new-3');
  f.advance(61_000);
  await recovered.sweep();
  assert.equal(calls, 2);
  assert.doesNotMatch(prompt, /new-3/);
  assert.deepEqual(recoveredStore.pending('lunara').map(row => row.eventKey), ['new-3']);
  assert.equal(recoveredStore.attempt('lunara').failures, 0);
  assert.doesNotMatch(JSON.stringify(recovered.getStatusSnapshot()), /SECRET_PROVIDER/);
  recovered.shutdown();
});

test('capacity pruning never reimports a committed turn or accepts a late duplicate notification', async t => {
  const f = await fixture(t, { shortWindow: 50, idleMs: Infinity });
  complete(f.ledger, 'once-only');
  f.store.recoverCommittedTurns();
  const original = f.store.pending('lunara')[0];
  f.store.acknowledge([original], 'short');
  f.memory.store.db.transaction(() => {
    for (let i = 0; i < 2000; i++) observation(f.store, `newer-${i}`);
  })();
  f.store.prune();
  assert.equal(f.memory.store.db.prepare('SELECT id FROM reflection_observations WHERE event_key = ?').get(original.eventKey), undefined);
  f.store.recoverCommittedTurns();
  assert.equal(f.store.append(f.store.committedTurn('once-only')), false);
  assert.equal(f.memory.store.db.prepare('SELECT COUNT(*) AS n FROM reflection_observations').get().n, 2000);
  f.advance(8 * 24 * 60 * 60 * 1000);
  f.store.prune();
  assert.equal(f.memory.store.db.prepare('SELECT COUNT(*) AS n FROM reflection_import_receipts').get().n, 0);
  assert.equal(f.store.append(f.store.committedTurn('once-only')), false, 'late notifications cannot revive expired observations');
});

test('timeout aborts the provider; retry exhaustion is bounded and manual recovery remains possible', async t => {
  let aborted = 0;
  const f = await fixture(t, { shortWindow: 1, llmTimeoutMs: 10, llm: {
    askText: async (_prompt, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { aborted++; reject(new Error('ABORTED_SECRET')); }, { once: true });
    }),
  } });
  turnObservation(f.store, 'retry-me');
  for (let i = 0; i < 3; i++) { await f.worker.sweep(); f.advance(300_000); }
  assert.equal(aborted, 3);
  assert.equal(f.store.attempt('lunara').status, 'retry_exhausted');
  await f.worker.sweep();
  assert.equal(aborted, 3);
  assert.equal(f.store.pending('lunara').length, 1);
  f.worker.llm = { askText: async () => response };
  const admin = new ReflectionAdminService({ getStation: () => ({ ...f.station, getReflectionAgent: () => f.worker }) });
  assert.equal((await admin.run({ virtualPersonId: 'lunara', window: 'short' })).ran, true);
  assert.equal((await admin.status()).recentInsights[0].virtualPersonId, 'lunara');
});

test('feedback arriving while the model is running survives successful acknowledgement', async t => {
  let release;
  const f = await fixture(t, { shortWindow: 1, llm: { askText: () => new Promise(resolve => { release = resolve; }) } });
  turnObservation(f.store, 'before');
  const run = f.worker.sweep();
  await settle();
  observation(f.store, 'during');
  release(response);
  await run;
  assert.deepEqual(f.store.pending('lunara').map(row => row.eventKey), ['during']);
});

test('retry after memory write reuses the exact persisted batch and does not duplicate the insight', async t => {
  let calls = 0;
  const f = await fixture(t, { shortWindow: 1, llm: { askText: async () => { calls++; return response; } } });
  complete(f.ledger, 'write-before-ack');
  const acknowledge = f.store.acknowledge.bind(f.store);
  f.store.acknowledge = () => { throw new Error('simulated crash boundary'); };
  await f.worker.sweep();
  assert.equal(recentReflectionInsights(f.memory, 'person:lunara').length, 1);
  observation(f.store, 'new-after-write');
  f.store.acknowledge = acknowledge;
  f.advance(61_000);
  await f.worker.sweep();
  assert.equal(calls, 1);
  assert.equal(recentReflectionInsights(f.memory, 'person:lunara').length, 1);
  assert.deepEqual(f.store.pending('lunara').map(row => row.eventKey), ['new-after-write']);
});

test('quiet listening windows degrade to stats_only without a model call; technical failures cannot become taste memories', async t => {
  let calls = 0;
  const f = await fixture(t, { shortWindow: 2, llm: { askText: async () => { calls++; return response; } } });
  observation(f.store, 'broken', 'lunara', { outcome: 'technical_failure' });
  f.advance(301_000);
  await f.worker.sweep();
  assert.equal(calls, 0);
  assert.equal(f.store.pending('lunara').length, 0);
  observation(f.store, 'heard-1'); observation(f.store, 'heard-2');
  f.advance(61_000);
  await f.worker.sweep();
  assert.equal(calls, 0, '纯播放窗口不烧模型');
  assert.equal(f.store.attempt('lunara').status, 'stats_only');
  assert.equal(f.store.pending('lunara').length, 0);
  assert.equal(f.store.songStats('lunara').length, 3, '播放结果（含技术失败）全部进入统计账本');
  f.store.append({ eventKey: 'turn-manual', personId: 'lunara', sessionId: 'session', kind: 'turn',
    data: { userText: '安静一点', assistantText: '好' } });
  f.advance(301_000);
  await f.worker.sweep();
  assert.equal(calls, 1, '带用户语言的批次仍触发反思');
});

test('generic follow-up retrieves only private recent insights with evidence and uncertainty', async t => {
  const f = await fixture(t);
  for (const namespace of ['person:lunara', 'radiohost:child']) {
    f.memory.addMemory({ type: 'semantic', namespace, source: 'agent_reflection', tags: 'reflection-insight,reflection-short',
      content: namespace === 'person:lunara' ? '近期曾要求轻柔的音乐' : 'CHILD_PRIVATE', confidence: 0.4,
      evidence: JSON.stringify({ eventKeys: ['playback:p:c'], scope: 'recent-listening-context' }) });
  }
  const memories = retrieveMemories(() => f.memory, { namespace: 'person:lunara', query: '继续听' });
  assert.equal(memories.filter(row => row.kind === 'reflection').length, 1);
  const prompt = new PromptAssembler().assemble({ entity: { id: 'lunara', displayName: 'Lunara', kind: 'root' }, memories });
  assert.match(prompt, /轻柔/); assert.match(prompt, /playback:p:c/); assert.match(prompt, /0.4/);
  assert.match(prompt, /明确要求和纠正始终优先/); assert.doesNotMatch(prompt, /CHILD_PRIVATE/);
});

test('reflection batches have a byte budget and revoked/expired insights do not return to context', async t => {
  const f = await fixture(t, { shortWindow: 50, idleMs: Infinity });
  for (let i = 0; i < 30; i++) {
    f.store.append({ eventKey: `large-${i}`, personId: 'lunara', kind: 'turn',
      data: { userText: '用户'.repeat(500), assistantText: '助手'.repeat(500) } });
  }
  const batch = f.store.batch('lunara', 'short', 50);
  assert.ok(batch.length < 30);
  assert.ok(batch.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) <= 16_000);
  for (const [tags, expiresAt] of [['reflection-insight,revoked', null], ['reflection-insight', Date.now() - 1]]) {
    f.memory.addMemory({ namespace: 'person:lunara', type: 'semantic', source: 'agent_reflection',
      content: '不应被检索的旧推测', tags, confidence: 0.3, expiresAt });
  }
  assert.deepEqual(recentReflectionInsights(f.memory, 'person:lunara'), []);
});

test('root participates in the optional long window and successful work is not rerun the same day', async t => {
  let calls = 0;
  const f = await fixture(t, { longAuto: true, shortWindow: 50, idleMs: Infinity,
    llm: { askText: async () => { calls++; return response; } } });
  // Use a known local morning, avoiding dependence on test runner timezone/hour.
  const morning = new Date(f.now()); morning.setHours(9, 0, 0, 0);
  if (morning.getTime() < f.now()) morning.setDate(morning.getDate() + 1);
  f.advance(morning.getTime() - f.now());
  observation(f.store, 'long-root');
  await f.worker._checkLongWindowTick();
  assert.equal(calls, 1);
  assert.equal(recentReflectionInsights(f.memory, 'person:lunara', { now: Date.now() })[0].window, 'long');
  f.advance(61_000);
  await f.worker._checkLongWindowTick();
  assert.equal(calls, 1);
});

test('validated playback retains original owner across handoff, continuation, duplicates and stale events', async t => {
  const f = await fixture(t, { shortWindow: 50, idleMs: Infinity });
  complete(f.ledger, 'root-request');
  const runtime = new PlaybackRuntimeHost();
  await runtime.ready;
  const bridge = new ListeningReflectionBridge({ reflection: f.worker });
  const detach = bridge.attach(runtime); t.after(detach);
  const published = [];
  t.after(f.bus.subscribe(EventType.PLAY_OUTCOME_RECORDED, event => published.push(event.payload)));
  const track = (songId, programId, requestId) => ({ songId, programId, requestId,
    title: songId, artist: 'artist', url: 'https://example.invalid/audio', duration: 180, intro: { text: '歌曲' } });
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'program:p1', delivery: 'replace_now', source: 'user',
    tracks: [track('s1', 'p1', 'root-request')] });
  const fact = (type, eventId, extra = {}) => {
    const s = runtime.snapshot();
    return { type, eventId, runtimeVersion: s.version, songId: s.currentSongId,
      programId: s.queue[s.currentIndex].programId, correlationId: s.txn.correlationId, ...extra };
  };
  await runtime.submit(fact('TRACK_STARTED', 'started'));
  await runtime.submit(fact('TRACK_ENDED', 'wrong-program-end', { programId: 'forged', natural: true }));
  assert.equal(runtime.snapshot().phase, 'playing');
  assert.equal(f.store.pending('lunara').filter(row => row.kind === 'playback').length, 0);
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'empty-replacement', source: 'user', delivery: 'replace_now', tracks: [] });
  assert.equal(f.store.pending('lunara').filter(row => row.kind === 'playback').length, 0);
  f.ledger.setActiveVirtualPerson('session', 'child');
  const ended = fact('TRACK_ENDED', 'ended', { natural: true, deliveredDuration: 180 });
  await runtime.submit(ended);
  await runtime.submit(ended);
  const key = runtime.snapshot().pendingContinuation.boundaryKey;
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'program:p2', delivery: 'append', source: 'auto_continue',
    continuationBoundaryKey: key, tracks: [track('s2', 'p2', `runtime-continuation:${key}`)] });
  assert.equal(f.store.programOwner('p2').personId, 'lunara');
  await runtime.submit(fact('TRACK_STARTED', 'started-2'));
  await runtime.submit(fact('TRACK_FAILED', 'wrong-song', { songId: 'forged', error: 'SECRET' }));
  await runtime.submit(fact('TRACK_FAILED', 'failed-2', { error: 'SECRET_URL' }));
  await f.bus.flush();
  const outcomes = f.store.pending('lunara').filter(row => row.kind === 'playback');
  assert.deepEqual(outcomes.map(row => row.data.outcome), ['completed', 'technical_failure']);
  assert.ok(outcomes.every(row => row.sessionId === 'session'));
  assert.equal(f.store.pending('child').length, 0);
  assert.doesNotMatch(JSON.stringify(outcomes), /SECRET/);
  assert.deepEqual(published.map(row => row.outcome), ['completed', 'technical_failure']);
  assert.ok(published.every(row => row.virtualPersonId === 'lunara' && row.observationKey));
  assert.equal(outcomes.length, 2, 'publishing authoritative outcomes must not duplicate reflection observations');
});

test('next dialogue reads committed context without waiting for the reflection model', async t => {
  let release;
  let entered = false;
  const f = await fixture(t, { shortWindow: 1, llm: { askText: () => {
    entered = true; return new Promise(resolve => { release = resolve; });
  } } });
  const seen = [];
  const composition = createVirtualPersonRuntimeComposition({
    chat: async messages => { seen.push(messages); return { message: { role: 'assistant', content: '我记住这次想安静听歌。' } }; },
    synthesize: async () => { throw new Error('No speech allowed'); }, publish: () => {},
    queueService: { snapshot: () => ({ queue: [] }), publishSnapshot: () => {} }, playbackRuntime: { snapshot: () => ({ queue: [] }) },
    getMemoryService: () => f.memory,
    observeCommittedTurn: event => f.worker._onTurnCommitted({ payload: event }),
  });
  composition.runtime.initialize();
  t.after(() => composition.runtime.shutdown());
  await composition.runtime.handleTurn({ sessionId: 'dialogue', requestId: 'd1', userText: '今晚安静听歌。', speak: false });
  await settle();
  assert.equal(entered, true);
  await composition.runtime.handleTurn({ sessionId: 'dialogue', requestId: 'd2', userText: '你记得我刚才说什么吗？', speak: false });
  assert.ok(seen[1].some(message => message.role === 'user' && message.content === '今晚安静听歌。'));
  assert.ok(seen[1].some(message => message.role === 'assistant' && message.content.includes('安静听歌')));
  release(response);
  await settle();
});

test('authoritative operational outcomes remain available when reflection is disabled without inventing a memory owner', async t => {
  const bus = createBus({ log: false });
  const outcomes = [];
  t.after(bus.subscribe(EventType.PLAY_OUTCOME_RECORDED, event => outcomes.push(event.payload)));
  const runtime = new PlaybackRuntimeHost();
  await runtime.ready;
  t.after(new ListeningReflectionBridge({ reflection: { disabled: true, bus } }).attach(runtime));
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'disabled-program', source: 'user', delivery: 'replace_now',
    tracks: [{ songId: 's', programId: 'p', requestId: 'unknown', title: '歌', artist: '人', url: '/test.mp3' }] });
  const currentFact = type => {
    const snapshot = runtime.snapshot();
    return { type, eventId: type, runtimeVersion: snapshot.version, songId: 's', programId: 'p', correlationId: snapshot.txn.correlationId };
  };
  await runtime.submit(currentFact('TRACK_STARTED'));
  const end = { ...currentFact('TRACK_ENDED'), natural: true };
  await runtime.submit(end);
  await runtime.submit(end);
  await bus.flush();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, 'completed');
  assert.equal(outcomes[0].virtualPersonId, undefined);
});
