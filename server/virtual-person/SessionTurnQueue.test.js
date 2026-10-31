import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTurnQueue } from './SessionTurnQueue.js';

test('has() reports whether a session has queued or running work, read-only', async () => {
  const queue = new SessionTurnQueue();
  assert.equal(queue.has('room'), false);
  let release;
  const running = queue.run('room', () => new Promise(resolve => { release = resolve; }));
  assert.equal(queue.has('room'), true);
  assert.equal(queue.has('other'), false);
  await new Promise(resolve => setImmediate(resolve));
  release(); await running;
  assert.equal(queue.has('room'), false);
});

test('the runtime exposes read-only presence activity: busy queue and last listener turn', async () => {
  const { VirtualPersonRuntime } = await import('./VirtualPersonRuntime.js');
  const turnQueue = new SessionTurnQueue();
  const runtime = new VirtualPersonRuntime({ conversationStore: { lastUserTurnAt: id => (id === 'room' ? 42 : null) },
    registry: {}, promptAssembler: {}, agentLoop: {}, presentationService: {}, turnQueue });
  assert.deepEqual(runtime.presenceActivity('room'), { busy: false, lastUserTurnAtMs: 42 });
  let release;
  const running = turnQueue.run('room', () => new Promise(resolve => { release = resolve; }));
  assert.deepEqual(runtime.presenceActivity('room'), { busy: true, lastUserTurnAtMs: 42 });
  await new Promise(resolve => setImmediate(resolve));
  release(); await running;
});
