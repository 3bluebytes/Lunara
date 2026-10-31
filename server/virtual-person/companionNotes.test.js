import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ConversationStore } from './ConversationStore.js';
import { createNoteStage, localDateMs, NOTE_LIMITS, noteIdOf } from './companionNotes.js';

function fixture() {
  let nowMs = Date.parse('2026-10-19T12:00:00Z');
  const db = new Database(':memory:');
  const store = new ConversationStore({ db, now: () => nowMs }).initialize();
  store.createRoom({ sessionId: 'chat-a', memberIds: ['lunara'] });
  store.createRoom({ sessionId: 'chat-b', memberIds: ['lunara'] });
  store.createRoom({ sessionId: 'group', memberIds: ['lunara', 'xiaoman'], hostId: 'lunara' });
  const thought = (sessionId, text, extra = {}) => store.notes.create({ noteId: noteIdOf('ambient', `${sessionId}:${text}`),
    personId: 'lunara', sessionId, kind: 'thought', text, origin: 'ambient', ...extra });
  return { db, store, notes: store.notes, thought, advance: ms => { nowMs += ms; }, now: () => nowMs,
    close: () => { store.close(); db.close(); } };
}

test('notes table is additive and an old database opens without it', () => {
  const db = new Database(':memory:');
  const legacy = new ConversationStore({ db }).initialize();
  db.exec('DROP TABLE companion_notes');
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  const reopened = new ConversationStore({ db }).initialize();
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(after.filter(name => !before.includes(name)), ['companion_notes']);
  reopened.close(); legacy.close(); db.close();
});

test('a thought stays in its chat and with its companion', () => {
  const h = fixture();
  try {
    h.thought('chat-a', '这几首都是雨天的歌');
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).length, 1);
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-b' }).length, 0);
    assert.equal(h.notes.listVisible({ personId: 'xiaoman', sessionId: 'chat-a' }).length, 0);
  } finally { h.close(); }
});

test('deterministic ids make replays idempotent', () => {
  const h = fixture();
  try {
    assert.equal(h.thought('chat-a', '同一条'), true);
    assert.equal(h.thought('chat-a', '同一条'), false);
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).length, 1);
  } finally { h.close(); }
});

test('open notes are bounded to twelve and follow-ups to three, evicting the soonest to expire', () => {
  const h = fixture();
  try {
    for (let index = 0; index < 13; index += 1) {
      h.notes.create({ noteId: noteIdOf('test', 'loop', index), personId: 'lunara', sessionId: 'chat-a', kind: 'open_loop',
        text: `没完的事 ${index}`, origin: 'reflection', expiresAt: h.now() + (index + 1) * 60_000 });
    }
    const visible = h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' });
    assert.equal(visible.length, 12);
    assert.equal(visible.some(note => note.text === '没完的事 0'), false);
    for (let index = 0; index < 4; index += 1) {
      h.notes.create({ noteId: noteIdOf('test', 'followup', index), personId: 'lunara', sessionId: 'chat-b', kind: 'followup',
        text: `再想想 ${index}`, origin: 'ambient', dueAt: h.now() + (index + 1) * 60_000 });
      h.advance(1);
    }
    assert.equal(h.notes.pendingFollowups('chat-b').length, 3);
  } finally { h.close(); }
});

test('expiry is lazy and by kind', () => {
  const h = fixture();
  try {
    h.thought('chat-a', '刚想到的');
    h.notes.create({ noteId: 'note:followup', personId: 'lunara', sessionId: 'chat-a', kind: 'followup', text: '下次再聊',
      origin: 'ambient', wakeCondition: 'nextListening' });
    h.notes.create({ noteId: 'note:loop', personId: 'lunara', sessionId: 'chat-a', kind: 'open_loop', text: '没日期的事',
      origin: 'reflection' });
    h.advance(NOTE_LIMITS.thoughtMs);
    assert.deepEqual(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).map(note => note.noteId).sort(),
      ['note:followup', 'note:loop']);
    h.advance(NOTE_LIMITS.followupMs);
    assert.deepEqual(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).map(note => note.noteId), ['note:loop']);
    h.advance(NOTE_LIMITS.undatedLoopMs);
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).length, 0);
    assert.equal(h.notes.get('note:loop').status, 'expired');
  } finally { h.close(); }
});

test('a dated open loop lives until the day after its date', () => {
  const h = fixture();
  try {
    const dueAt = localDateMs('2026-10-20');
    h.notes.create({ noteId: 'note:interview', personId: 'lunara', sessionId: 'chat-a', kind: 'open_loop', text: '面试',
      origin: 'reflection', dueAt });
    assert.equal(h.notes.get('note:interview').expiresAt, dueAt + 2 * NOTE_LIMITS.dayMs);
    assert.equal(localDateMs('2026-02-30'), null);
  } finally { h.close(); }
});

test('forgetting the source turn hides and drops notes derived from it', () => {
  const h = fixture();
  try {
    const { turn } = h.store.beginRequest({ sessionId: 'chat-a', virtualPersonId: 'lunara', userText: '明天下午我有个面试' });
    h.notes.create({ noteId: 'note:interview', personId: 'lunara', sessionId: 'chat-a', kind: 'open_loop', text: '明天下午的面试',
      origin: 'reflection', sourceRefs: [`turn:${turn.turnId}`] });
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).length, 1);
    h.store.revokeObservation('lunara', turn.turnId);
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).length, 0);
    assert.equal(h.notes.get('note:interview').status, 'dropped');
  } finally { h.close(); }
});

test('an unreadable source hides the note even before any revocation', () => {
  const h = fixture();
  try {
    h.notes.create({ noteId: 'note:ghost', personId: 'lunara', sessionId: 'chat-a', kind: 'thought', text: '来源已不在',
      origin: 'ambient', sourceRefs: ['turn:missing'] });
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' }).length, 0);
  } finally { h.close(); }
});

test('deleting a chat deletes its notes in the same transaction', () => {
  const h = fixture();
  try {
    h.thought('chat-a', '会被删');
    h.thought('chat-b', '留着');
    h.store.deleteRoom('chat-a');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM companion_notes WHERE session_id = 'chat-a'").get().n, 0);
    assert.equal(h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-b' }).length, 1);
  } finally { h.close(); }
});

test('ambient view hides sensitive, over-raised, recently raised and not-yet-due notes', () => {
  const h = fixture();
  try {
    const base = { personId: 'lunara', sessionId: 'chat-a', origin: 'reflection' };
    h.notes.create({ ...base, noteId: 'note:sensitive', kind: 'open_loop', text: '体检结果', sensitive: true });
    h.notes.create({ ...base, noteId: 'note:raised', kind: 'open_loop', text: '面试' });
    h.notes.create({ ...base, noteId: 'note:later', kind: 'followup', text: '过会儿再想', origin: 'ambient', dueAt: h.now() + 60_000 });
    h.notes.create({ ...base, noteId: 'note:track', kind: 'followup', text: '这首放完', origin: 'ambient',
      wakeCondition: 'afterCurrentTrack:q1' });
    h.notes.create({ ...base, noteId: 'note:next', kind: 'followup', text: '下次一起听', origin: 'ambient', wakeCondition: 'nextListening' });
    h.notes.markRaised({ personId: 'lunara', sessionId: 'chat-a', noteIds: ['note:raised'] });
    const ids = scope => h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a', ...scope }).map(note => note.noteId).sort();
    assert.deepEqual(ids({}), ['note:later', 'note:next', 'note:raised', 'note:sensitive', 'note:track']);
    assert.deepEqual(ids({ mode: 'ambient', currentQueueItemId: 'q1', wake: { reason: 'heartbeat' } }), []);
    assert.deepEqual(ids({ mode: 'ambient', currentQueueItemId: 'q2', wake: { reason: 'session_open' } }), ['note:next', 'note:track']);
    h.advance(NOTE_LIMITS.raiseGapMs);
    assert.deepEqual(ids({ mode: 'ambient', currentQueueItemId: 'q1', wake: { reason: 'heartbeat' } }), ['note:later', 'note:raised']);
    h.notes.markRaised({ personId: 'lunara', sessionId: 'chat-a', noteIds: ['note:raised'] });
    h.advance(NOTE_LIMITS.raiseGapMs);
    assert.equal(ids({ mode: 'ambient', currentQueueItemId: 'q1', wake: { reason: 'heartbeat' } }).includes('note:raised'), false);
  } finally { h.close(); }
});

test('a staged batch applies creates, consumption, settles and raises', () => {
  const h = fixture();
  try {
    h.thought('chat-a', '旧的想法');
    const [old] = h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' });
    h.notes.create({ noteId: 'note:due', personId: 'lunara', sessionId: 'chat-a', kind: 'followup', text: '到点了', origin: 'ambient',
      dueAt: h.now() - 1 });
    const stage = createNoteStage();
    stage.creates.push({ noteId: 'note:new', kind: 'thought', text: '新想法', origin: 'ambient' });
    stage.consumes.push('note:due');
    stage.raises.push(old.noteId);
    h.notes.applyStage(stage, { personId: 'lunara', sessionId: 'chat-a' });
    assert.equal(h.notes.get('note:new').status, 'open');
    assert.equal(h.notes.get('note:due').status, 'resolved');
    assert.equal(h.notes.get(old.noteId).status, 'raised');
    assert.equal(h.notes.get(old.noteId).raisedCount, 1);
    assert.equal(h.notes.settle({ personId: 'lunara', sessionId: 'chat-a', noteId: old.noteId, status: 'resolved' }), true);
    assert.equal(h.notes.settle({ personId: 'lunara', sessionId: 'chat-a', noteId: old.noteId, status: 'resolved' }), false);
    assert.equal(h.notes.settle({ personId: 'xiaoman', sessionId: 'chat-a', noteId: 'note:new', status: 'dropped' }), false);
  } finally { h.close(); }
});

test('notes never become observations, summaries or ledger turns', () => {
  const h = fixture();
  try {
    const before = h.db.prepare('SELECT (SELECT COUNT(*) FROM conversation_observations) AS o, (SELECT COUNT(*) FROM conversation_turns) AS t').get();
    h.thought('chat-a', '这几首都是雨天的歌');
    h.notes.markRaised({ personId: 'lunara', sessionId: 'chat-a', noteIds: [h.notes.listVisible({ personId: 'lunara', sessionId: 'chat-a' })[0].noteId] });
    const after = h.db.prepare('SELECT (SELECT COUNT(*) FROM conversation_observations) AS o, (SELECT COUNT(*) FROM conversation_turns) AS t').get();
    assert.deepEqual(after, before);
    assert.deepEqual(h.store.listSummaries('chat-a'), []);
  } finally { h.close(); }
});
