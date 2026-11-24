// ReflectionAgent.openLoops.test.js — 反思提炼「没完的事」（add-companion-heartbeat 阶段 C：7.1–7.4）。
//
// 已提交的对话回合走真实 ReflectionObservationStore + ConversationStore（同一个库）；模型换成桩。
// sink 就是生产里注入的 conversationStore.notes.acceptOpenLoop。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ReflectionAgent } from './ReflectionAgent.js';
import { createBus } from './communication/AgentMessageBus.js';
import { EventType, createEvent } from './communication/messages.js';
import { MemoryService } from '../memory/MemoryService.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { noteIdOf } from '../virtual-person/companionNotes.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-reflection-open-loops-')));
let databaseNumber = 0;

function makeStation(personId) {
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `state-${++databaseNumber}.db`);
  let service = null;
  return {
    async getRadioHostMemoryService(id) {
      if (id !== personId) return null;
      if (!service) {
        service = new MemoryService(`radiohost:${id}`);
        await service.initialize();
        for (const memory of service.searchMemory(undefined, { limit: 500 })) service.deleteMemory(memory.id);
      }
      return service;
    },
    getRadiohostMetadata: id => (id === personId ? { id, name: id } : null),
    listRadioHosts: () => [{ id: personId, name: personId }],
    getActiveRadiohost: () => ({ id: personId, name: personId }),
  };
}

async function harness({ personId = 'host-a', responses = [], members = null, sink = 'notes' } = {}) {
  const bus = createBus({ log: false });
  const station = makeStation(personId);
  const prompts = [];
  const queue = [...responses];
  const llm = {
    askText: async prompt => {
      prompts.push(prompt);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(prompt) : next;
    },
    extractJson: text => JSON.parse(text),
  };
  const reflection = new ReflectionAgent({ bus, station, llm, shortWindow: 1, logger: { warn() {}, log() {} } });
  await reflection.initialize();
  const ledger = new ConversationStore({ db: reflection.store.db }).initialize();
  ledger.createRoom({ sessionId: 's', memberIds: members || [personId], ...(members ? { hostId: personId } : {}) });
  if (sink === 'notes') reflection.setOpenLoopSink(loop => ledger.notes.acceptOpenLoop(loop));
  else if (typeof sink === 'function') reflection.setOpenLoopSink(sink);
  let requestNumber = 0;
  const say = async (userText, reply = '好的。', { sessionId = 's' } = {}) => {
    const requestId = `r${++requestNumber}`;
    const { turn } = ledger.beginRequest({ sessionId, requestId, virtualPersonId: personId, userText });
    const completion = ledger.completeRequest({ requestId, virtualPersonId: personId, message: { content: reply } });
    bus.publishEvent(createEvent({ type: EventType.TURN_COMMITTED, sourceAgentId: `virtual-person:${personId}`,
      payload: { virtualPersonId: personId, sessionId, requestId, displayText: reply, outcomeCodes: [], committedAt: Date.now() } }));
    await bus.flush();
    await new Promise(r => setTimeout(r, 80));
    return { userTurnId: turn.turnId, assistantTurnId: completion.turn.turnId, eventKey: `turn:${completion.turn.turnId}` };
  };
  const insights = async () => (await station.getRadioHostMemoryService(personId))
    .searchMemory(undefined, { namespace: `radiohost:${personId}`, tags: 'reflection-insight', limit: 5 });
  const loops = () => ledger.db.prepare("SELECT * FROM companion_notes WHERE kind = 'open_loop' ORDER BY note_id").all();
  return { reflection, ledger, prompts, say, insights, loops, personId,
    close() { reflection.shutdown(); } };
}

const reply = body => () => JSON.stringify(body);
// 桩模型：看到提示里的证据 id 再作答（证据 id 来自账本回合，测试里事先不知道）。
const fromPrompt = build => prompt => JSON.stringify(build(JSON.parse(prompt.split('\n').find(line => line.startsWith('[{')))));

test('open_loops ride along with no_signal and land as private, dated notes from the user turn', async () => {
  const h = await harness({ responses: [fromPrompt(rows => ({ no_signal: true, open_loops: [
    { kind: 'upcoming', text: '对方明天下午有个面试', dueDate: '2026-10-20', evidence: [rows[0].evidenceId], confidence: 0.9 },
  ] }))] });
  try {
    const { userTurnId } = await h.say('明天下午我有个面试，有点紧张');
    assert.match(h.prompts[0], /open_loops/);
    const [row] = h.loops();
    assert.equal(row.text, '对方明天下午有个面试');
    assert.equal(row.origin, 'reflection');
    assert.equal(row.session_id, 's');
    assert.equal(row.person_id, 'host-a');
    assert.deepEqual(JSON.parse(row.source_refs_json), [`turn:${userTurnId}`]);
    assert.equal(row.confidence, 0.4, '短窗置信度上限 0.4');
    assert.equal(new Date(row.due_at).getDate(), 20);
    assert.equal((await h.insights()).length, 0, 'no_signal 仍不写 insight');
    assert.equal(h.reflection.store.attempt('host-a').status, 'no_signal');
  } finally { h.close(); }
});

test('invalid open loops are dropped one by one: kind, date, assistant-only evidence, unknown evidence', async () => {
  const h = await harness({ responses: [fromPrompt(rows => ({ no_signal: true, open_loops: [
    { kind: 'wish', text: '不认识的类型', evidence: [rows[0].evidenceId] },
    { kind: 'upcoming', text: '不存在的日期', dueDate: '2026-02-30', evidence: [rows[0].evidenceId] },
    { kind: 'unfinished', text: '没有证据', evidence: ['turn:made-up'] },
    { kind: 'promise', text: '那首歌之后再聊', evidence: [rows[0].evidenceId] },
    { kind: 'upcoming', text: '超过三条的第五条', evidence: [rows[0].evidenceId] },
  ] }))] });
  try {
    await h.say('等我听完这张专辑你再问我感受');
    assert.deepEqual(h.loops().map(row => row.text), []);
  } finally { h.close(); }

  const ok = await harness({ responses: [fromPrompt(rows => ({ no_signal: true, open_loops: [
    { kind: 'wish', text: '不认识的类型', evidence: [rows[0].evidenceId] },
    { kind: 'promise', text: '听完专辑后问问感受', evidence: [rows[0].evidenceId] },
  ] }))] });
  try {
    await ok.say('等我听完这张专辑你再问我感受');
    assert.deepEqual(ok.loops().map(row => row.text), ['听完专辑后问问感受']);
  } finally { ok.close(); }
});

test('a private disclosure keeps its private label on the note (not sensitive by itself); an insight write and the loop share one batch', async () => {
  const h = await harness({ responses: [fromPrompt(rows => ({ observation: '对方最近压力大。', evidence: [rows[0].evidenceId],
    tags: [], confidence: 0.3, open_loops: [{ kind: 'upcoming', text: '对方下周复查', evidence: [rows[0].evidenceId] }] }))] });
  try {
    await h.say('这个只告诉你，我下周要去复查');
    const [row] = h.loops();
    // 私下说的是一个标签，敏感是另一个（模型判断健康、感情、家庭、财务）；两者都只影响提示词里的标注。
    assert.equal(row.sensitive, 0);
    assert.equal(JSON.parse(row.policy_json).disclosure, 'private');
    assert.equal((await h.insights()).length, 1);
  } finally { h.close(); }
});

test('deterministic ids: a replayed batch writes the same note once', async () => {
  const h = await harness();
  try {
    const loop = { personId: 'host-a', sessionId: 's', batchTag: 'reflection-batch:abc', index: 0, text: '面试',
      sourceTurnIds: [], policy: {} };
    const { userTurnId } = await h.say('周五面试');
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...loop, sourceTurnIds: [userTurnId] }), true);
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...loop, sourceTurnIds: [userTurnId] }), false);
    assert.equal(h.loops().length, 1);
    assert.equal(h.loops()[0].note_id, noteIdOf('reflection', 'reflection-batch:abc', 0));
  } finally { h.close(); }
});

test('a failing sink never blocks the insight write or the batch acknowledgement', async () => {
  const h = await harness({ sink: () => { throw new Error('notes down'); },
    responses: [fromPrompt(rows => ({ observation: '对方在准备面试。', evidence: [rows[0].evidenceId], tags: [], confidence: 0.3,
      open_loops: [{ kind: 'upcoming', text: '面试', evidence: [rows[0].evidenceId] }] }))] });
  try {
    await h.say('周五面试');
    assert.equal((await h.insights()).length, 1);
    assert.equal(h.reflection.store.attempt('host-a').status, 'succeeded');
    assert.equal(h.reflection.reflectionFailures, 0);
  } finally { h.close(); }
});

test('the sink refuses sources she cannot read herself, other rooms and non-members; other members do not matter', async () => {
  const h = await harness({ members: ['host-a', 'host-b'] });
  try {
    const { userTurnId } = await h.say('周五面试');
    const base = { personId: 'host-a', sessionId: 's', batchTag: 'b', text: '面试', policy: {} };
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...base, index: 1, sourceTurnIds: [] }), false, '没有来源');
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...base, index: 2, sourceTurnIds: [userTurnId], personId: 'stranger' }), false);
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...base, index: 3, sourceTurnIds: [userTurnId],
      policy: { onlyConversationId: 'elsewhere' } }), false, '披露限定在别的聊天');
    h.ledger.createRoom({ sessionId: 'other', memberIds: ['host-a'] });
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...base, index: 4, sessionId: 'other', sourceTurnIds: [userTurnId] }), false,
      '来源不属于这个聊天');
    const original = h.ledger.canReadTurn.bind(h.ledger);
    h.ledger.canReadTurn = (id, turn, options) => (id === 'host-a' ? false : original(id, turn, options));
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...base, index: 5, sourceTurnIds: [userTurnId] }), false, '她自己读不到');
    h.ledger.canReadTurn = (id, turn, options) => (id === 'host-b' ? false : original(id, turn, options));
    assert.equal(h.ledger.notes.acceptOpenLoop({ ...base, index: 6, sourceTurnIds: [userTurnId] }), true,
      '别的成员读不读得到不影响她自己的心里话');
    h.ledger.canReadTurn = original;
  } finally { h.close(); }
});

test('a pure playback batch still skips the model and emits no open loop', async () => {
  const h = await harness();
  try {
    h.reflection.store.append({ eventKey: 'playback:1', personId: 'host-a', sessionId: 's', kind: 'playback',
      createdAt: Date.now(), data: { outcome: 'completed', songId: 's1' } });
    await h.reflection._runReflection('host-a', 'short');
    assert.equal(h.prompts.length, 0);
    assert.equal(h.reflection.store.attempt('host-a').status, 'stats_only');
    assert.equal(h.loops().length, 0);
  } finally { h.close(); }
});

// 近况（add-person-life-notes）：open loop 另存一条伙伴级记忆，别的聊天也能看到；敏感的带 sensitive 标签。
const lifeNotes = async h => (await (await h.reflection.station.getRadioHostMemoryService(h.personId)))
  .searchMemory(undefined, { namespace: `radiohost:${h.personId}`, tags: 'reflection-life', limit: 10 });

test('open loops also land as dated life notes with their sources; a sensitive one carries the sensitive label', async () => {
  const h = await harness({ responses: [fromPrompt(rows => ({ no_signal: true, open_loops: [
    { kind: 'upcoming', text: '对方下周三去马德里出差', dueDate: '2026-10-07', evidence: [rows[0].evidenceId] },
    { kind: 'upcoming', text: '对方下周三去医院复查', dueDate: '2026-10-07', evidence: [rows[0].evidenceId], sensitive: true },
  ] }))] });
  try {
    const { userTurnId } = await h.say('下周三我去马德里出差，顺便复查一下');
    const all = await lifeNotes(h);
    assert.deepEqual(all.map(row => row.content).sort(), ['对方下周三去医院复查', '对方下周三去马德里出差']);
    const sensitive = all.find(row => row.content.includes('复查'));
    assert.equal(JSON.parse(sensitive.evidence).policy.sensitive, true);
    const notes = all.filter(row => row.content.includes('马德里'));
    const evidence = JSON.parse(notes[0].evidence);
    assert.notEqual(evidence.policy?.sensitive, true);
    assert.deepEqual(evidence.sourceTurnIds, [userTurnId]);
    assert.deepEqual(evidence.sessions, ['s']);
    assert.equal(evidence.dueDate, '2026-10-07');
    assert.match(notes[0].tags, /life-upcoming/);
    assert.ok(notes[0].expiresAt > new Date(2026, 9, 9).getTime() - 1, '日期过后两天才过期');
    assert.equal(h.loops().length, 2, '两条都仍是原聊天的心里话');
  } finally { h.close(); }
});

test('a replayed batch writes the life note once; a revoked source is not learned back', async () => {
  const h = await harness();
  try {
    const service = await h.reflection.station.getRadioHostMemoryService('host-a');
    const loop = { kind: 'upcoming', text: '对方周五面试', dueDate: null, sessionId: 's', sourceTurnIds: ['t1'],
      eventKeys: ['turn:t1'], mentionedAt: Date.now(), policy: { disclosure: 'normal' } };
    h.reflection._writeLifeNotes(service, 'radiohost:host-a', 'batch-1', [loop]);
    h.reflection._writeLifeNotes(service, 'radiohost:host-a', 'batch-1', [loop]);
    assert.equal((await lifeNotes(h)).length, 1);
    const { forgetLearnedFromSources } = await import('../memory/forgetSources.js');
    forgetLearnedFromSources(service.store.db, { turnIds: ['t1'] });
    h.reflection._writeLifeNotes(service, 'radiohost:host-a', 'batch-2', [loop]);
    assert.equal((await lifeNotes(h)).filter(row => !/revoked/.test(row.tags)).length, 0);
  } finally { h.close(); }
});

test('settling an open loop retires its mirrored life note and replay cannot resurrect it', async () => {
  const { retireSettledLifeNotes } = await import('../memory/reflectionInsights.js');
  const h = await harness({ responses: [fromPrompt(rows => ({ no_signal: true, open_loops: [
    { kind: 'upcoming', text: '对方周五面试', dueDate: '2026-10-09', evidence: [rows[0].evidenceId] },
  ] }))] });
  try {
    const service = await h.reflection.station.getRadioHostMemoryService('host-a');
    h.ledger.notes.setOnSettled(note => retireSettledLifeNotes(service, {
      namespace: 'radiohost:host-a', lifeWriteKey: note.policy?.lifeWriteKey || null,
      sessionId: note.sessionId, text: note.text, status: note.status,
    }));
    await h.say('我周五要去面试');
    assert.equal((await lifeNotes(h)).filter(row => !/superseded/.test(row.tags)).length, 1);
    const [note] = h.loops();
    const policy = JSON.parse(note.policy_json);
    assert.equal(h.ledger.notes.settle({ personId: 'host-a', sessionId: 's', noteId: note.note_id, status: 'resolved' }), true);
    const activeAfter = (await lifeNotes(h)).filter(row => !/(?:revoked|superseded)/.test(row.tags) && (!row.expiresAt || row.expiresAt > Date.now()));
    assert.equal(activeAfter.length, 0, '了结 open_loop 后对应近况即时退场');
    // 崩溃重放同一批时不再把已了结的 life note 写回。
    const [batchTag, , indexStr] = policy.lifeWriteKey.split(':');
    h.reflection._writeLifeNotes(service, 'radiohost:host-a', batchTag, Array.from({ length: Number(indexStr) + 1 }, (_, idx) => (
      idx === Number(indexStr) ? { kind: 'upcoming', text: note.text, dueDate: '2026-10-09', sessionId: 's', sourceTurnIds: ['t-replay'],
        eventKeys: ['turn:t-replay'], mentionedAt: Date.now(), policy: { disclosure: 'normal' } } : { kind: 'upcoming', text: '', sessionId: 's', sourceTurnIds: [] }
    )));
    const rows = service.store.db.prepare("SELECT tags, expires_at FROM memories WHERE namespace = 'radiohost:host-a' AND tags LIKE '%reflection-life%'").all();
    assert.equal(rows.length, 1, '已了结的 writeKey 不会被重放重建');
  } finally { h.close(); }
});
