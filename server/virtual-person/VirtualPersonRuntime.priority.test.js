// 回窗问候的后台入场保留；不新增 Agent/播放状态，只测试现有 host 的协调边界。
import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';

const runtime = () => new VirtualPersonRuntime({ conversationStore: {}, registry: {}, promptAssembler: {},
  agentLoop: {}, presentationService: {} });
const tick = () => new Promise(setImmediate);

test('pending admission is not hostBusy; global and room holds release independently and idempotently', async () => {
  const r = runtime();
  const global = r.holdBackgroundHost();
  const local = r.holdBackgroundHost('room');
  let roomActivity = null, otherActivity = null;
  const first = r.acquireBackgroundHost('room').then(activity => { roomActivity = activity; });
  const second = r.acquireBackgroundHost('other').then(activity => { otherActivity = activity; });
  await tick();
  assert.equal(r.hostBusy('room'), false);
  assert.equal(r.hostBusy('other'), false);
  global(); global();
  await tick();
  assert.equal(roomActivity, null);
  assert.ok(otherActivity);
  local(); local();
  await Promise.all([first, second]);
  assert.equal(r.hostBusy('room'), true);
  roomActivity.leave(); otherActivity.leave();
  assert.equal(r.hostBusy('room'), false);
  assert.equal(r.backgroundHostAdmissionWaiters.size, 0);
});

test('cancelled background admission never enters or retains waiters', async () => {
  const r = runtime();
  const release = r.holdBackgroundHost('room');
  const controller = new AbortController();
  const pending = r.acquireBackgroundHost('room', { signal: controller.signal });
  controller.abort(new Error('cancelled task'));
  await assert.rejects(pending, /cancelled task/);
  release();
  assert.equal(r.hostBusy('room'), false);
  assert.equal(r.backgroundHostAdmissionWaiters.size, 0);
  assert.equal(r.backgroundHostControllers.size, 0);
});

test('line pass waits outside hostBusy and rechecks the original membership before writing', async () => {
  const r = runtime();
  let token = 'before', runs = 0;
  const failures = [];
  r.conversationStore = { membershipToken: () => token, getSession: () => ({ memberIds: ['host'] }) };
  r.registry = { get: () => ({ status: 'active' }) };
  r.attachTrackLinePass({ run: async () => { runs += 1; } });
  const release = r.holdBackgroundHost('room');
  const pending = r.startLinePass({ sessionId: 'room', entity: { id: 'host' },
    targets: [{ fail: reason => failures.push(reason) }], assembled: { systemPrompt: '', messages: [] } });
  await tick();
  assert.equal(r.hostBusy('room'), false);
  assert.equal(runs, 0);
  token = 'after';
  release();
  await pending;
  assert.equal(runs, 0);
  assert.deepEqual(failures, ['stale']);
  assert.equal(r.hostBusy('room'), false);
});

test('greeting cancellation releases its hold; shutdown rejects parked background work without starting it', async () => {
  const r = runtime();
  const greeting = new AbortController();
  r.holdBackgroundHost('room', { signal: greeting.signal });
  const pending = r.acquireBackgroundHost('room');
  greeting.abort();
  const activity = await pending;
  activity.leave();
  r.holdBackgroundHost();
  const parked = r.acquireBackgroundHost('room');
  r.shutdown();
  await assert.rejects(parked, /runtime shutdown/);
  await assert.rejects(r.acquireBackgroundHost('room'), /runtime shutdown/);
  assert.equal(r.hostBusy('room'), false);
  assert.equal(r.backgroundHostAdmissionWaiters.size, 0);
  assert.equal(r.backgroundHostHolds.size, 0);
});
