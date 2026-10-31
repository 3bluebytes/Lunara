// floorRunner.test.js — 用户回合与 ambient 一拍共用的发言权状态机（add-companion-expression-and-reception 1.1）。
//
// Run: node --test server/virtual-person/floorRunner.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFloorRun, FLOOR_KINDS } from './floorRunner.js';

const members = ['a', 'b', 'c'];
const ambient = (initial = [{ personId: 'a', role: 'holder' }]) =>
  createFloorRun({ kind: 'ambient', initial, memberIds: members, canOpenInvite: () => true });

test('A→B→A: one invitation, one return to the inviter, then no further invitation', () => {
  const run = ambient();
  assert.deepEqual(run.next(), { personId: 'a', role: 'holder' });
  assert.deepEqual(run.inviteTargets('a').sort(), ['b', 'c']);
  assert.equal(run.invite('a', 'b').ok, true);
  run.settle('a', { spoke: true });

  const invited = run.next();
  assert.equal(invited.personId, 'b');
  assert.equal(invited.role, 'invited');
  assert.deepEqual(invited.invitation, { fromPersonId: 'a', toPersonId: 'b', hop: 'invite' });
  assert.deepEqual(run.inviteTargets('b'), ['a'], '回传只能交回邀请者');
  assert.equal(run.invite('b', 'c').code, 'FLOOR_TARGET_INVALID');
  assert.equal(run.invite('b', 'a').ok, true);
  run.settle('b', { spoke: true });

  const back = run.next();
  assert.equal(back.personId, 'a');
  assert.equal(back.role, 'returned');
  assert.deepEqual(run.inviteTargets('a'), []);
  assert.equal(run.invite('a', 'c').code, 'FLOOR_ALREADY_SPENT');
  run.settle('a', { spoke: true });
  assert.equal(run.next(), null);
  assert.equal(run.lines, 3);
});

test('an invitation counts only once the inviter actually spoke', () => {
  const run = ambient([{ personId: 'a', role: 'holder' }, { personId: 'c', role: 'follower' }]);
  run.next();
  assert.equal(run.invite('a', 'b').ok, true);
  assert.equal(run.invite('a', 'c').code, 'FLOOR_ALREADY_SPENT', '同一回合重复邀请也算用掉');
  run.settle('a', { spoke: false });
  assert.deepEqual(run.next(), { personId: 'c', role: 'follower' }, '没入账的邀请作废，队列照常');
  assert.equal(run.invitation, null);
});

test('inviting a queued follower moves them forward as invited and does not run them twice', () => {
  const run = ambient([{ personId: 'a', role: 'holder' }, { personId: 'b', role: 'follower' }]);
  run.next();
  run.invite('a', 'b');
  run.settle('a', { spoke: true });
  assert.equal(run.next().role, 'invited');
  run.settle('b', { spoke: true });
  assert.equal(run.next(), null);
});

test('the visible-line cap leaves room for the invited line or refuses the invitation', () => {
  const run = createFloorRun({ kind: 'ambient', memberIds: members, canOpenInvite: () => true,
    initial: [{ personId: 'a', role: 'holder' }, { personId: 'b', role: 'follower' }, { personId: 'c', role: 'follower' }] });
  run.next(); run.settle('a', { spoke: true });
  run.next(); run.settle('b', { spoke: true });
  run.next();
  assert.deepEqual(run.inviteTargets('c'), [], '第三句之后放不下被邀请的话');
  run.settle('c', { spoke: true });
  assert.equal(run.next(), null);
  assert.equal(FLOOR_KINDS.ambient.maxLines, 3);
});

test('a terminal music mutation or an interruption ends the run', () => {
  const run = createFloorRun({ kind: 'listener', memberIds: members, canOpenInvite: () => true,
    initial: [{ personId: 'a', role: 'planned' }] });
  run.next();
  run.invite('a', 'b');
  run.settle('a', { spoke: true, terminalMutation: true });
  assert.equal(run.next(), null);
  assert.equal(run.stopReason, 'mutation');

  const interrupted = ambient([{ personId: 'a', role: 'holder' }, { personId: 'b', role: 'follower' }]);
  interrupted.next(); interrupted.settle('a', { spoke: true });
  interrupted.interrupt('listener');
  assert.equal(interrupted.next(), null);
  assert.equal(interrupted.stopReason, 'listener');
});

test('only the current speaker may invite, and the opening rule is supplied per round kind', () => {
  const run = createFloorRun({ kind: 'listener', memberIds: members,
    initial: [{ personId: 'a', role: 'planned' }, { personId: 'b', role: 'planned' }],
    canOpenInvite: personId => personId === 'b' });
  run.next();
  assert.equal(run.invite('a', 'c').code, 'FLOOR_NOT_AVAILABLE', '不是计划最后一位');
  assert.equal(run.invite('b', 'c').code, 'FLOOR_NOT_AVAILABLE', '不是当前发言者');
  run.settle('a', { spoke: true });
  run.next();
  assert.deepEqual(run.inviteTargets('b'), ['c'], '已经跑过的人不能被邀请');
});

test('a declined invitation ends the chain: the decline line counts, no return', () => {
  const run = ambient();
  run.next(); run.invite('a', 'b'); run.settle('a', { spoke: true });
  run.next();
  run.settle('b', { spoke: true, declined: true });
  assert.equal(run.next(), null);
  assert.equal(run.lines, 2);
});
