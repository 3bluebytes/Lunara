// intentOf.test.js — 群聊 ambient 跟话意图打分（add-companion-expression-and-reception 1.3）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseFollowers, intentFacts, intentOf, INTENT_THRESHOLD } from './intentOf.js';

test('each fact has its table score and reason code; long silence alone never reaches the threshold', () => {
  assert.deepEqual(intentOf({ followupDue: true }), { score: 1, reasons: ['followup-due'] });
  assert.deepEqual(intentOf({ invited: true }), { score: 1, reasons: ['invited'] });
  assert.deepEqual(intentOf({ mentioned: true }), { score: 0.7, reasons: ['mentioned'] });
  assert.deepEqual(intentOf({ openLoop: true }), { score: 0.5, reasons: ['open-loop'] });
  assert.deepEqual(intentOf({ longSilent: true }), { score: 0.2, reasons: ['long-silent'] });
  assert.ok(intentOf({ longSilent: true }).score < INTENT_THRESHOLD);
  assert.deepEqual(intentOf({ openLoop: true, longSilent: true }), { score: 0.7, reasons: ['open-loop', 'long-silent'] });
  assert.equal(intentOf({ followupDue: true, longSilent: true }).score, 1);
  assert.deepEqual(intentOf({}), { score: 0, reasons: [] });
});

test('at most one follower above the threshold, by score, ties by rotation order; nobody when nobody has intent', () => {
  const scores = { a: { score: 0.5, reasons: [] }, b: { score: 0.7, reasons: [] }, c: { score: 0.7, reasons: [] }, d: { score: 0.2, reasons: [] } };
  assert.deepEqual(chooseFollowers(['a', 'b', 'c', 'd'], id => scores[id]).chosen, ['b']);
  assert.deepEqual(chooseFollowers(['c', 'b'], id => scores[id]).chosen, ['c'], '同分按轮换');
  assert.deepEqual(chooseFollowers(['d'], id => scores[id]).chosen, []);
  assert.equal(chooseFollowers(['a', 'd'], id => scores[id]).scored.length, 2, '全部打分供 trace');
});

test('facts come from the visible ledger: mention after she last spoke, due follow-up, long silence', () => {
  const names = new Map([['mio', 'Mio']]);
  const wake = { firedAtMs: 10_000, previousWakeAtMs: 9_000, followups: [{ personId: 'mio' }] };
  const turns = [
    { role: 'assistant', speakerVirtualPersonId: 'lunara', visibleText: 'Mio 你听过这首吗？', createdAt: 1_000 },
    { role: 'assistant', speakerVirtualPersonId: 'mio', visibleText: '听过。', createdAt: 2_000 },
  ];
  const facts = intentFacts({ personId: 'mio', wake, turns, names });
  assert.equal(facts.mentioned, false, '提到她之后她已经开过口');
  assert.equal(facts.followupDue, true);
  assert.equal(facts.longSilent, true, '上次开口距今超过 2 个心跳间隔');
  const later = intentFacts({ personId: 'mio', wake: { firedAtMs: 10_000, previousWakeAtMs: 9_000 },
    turns: [...turns, { role: 'user', visibleText: '让 Mio 说说', createdAt: 9_500 }], names });
  assert.equal(later.mentioned, true);
  assert.equal(later.followupDue, false);
  const recent = intentFacts({ personId: 'mio', wake: { firedAtMs: 3_000, previousWakeAtMs: 2_500 }, turns, names });
  assert.equal(recent.longSilent, false);
});
