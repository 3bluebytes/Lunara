import test from 'node:test';
import assert from 'node:assert/strict';
import { WarmPoolService } from './WarmPoolService.js';
test('disabled preparation creates no background timer or model call', async () => {
  let calls = 0;
  const pool = await new WarmPoolService({ disabled: true, select: () => calls++ }).initialize();
  await pool.refresh(); assert.equal(calls, 0); assert.equal(pool.timer, null); pool.shutdown();
});
test('start and shutdown are idempotent and release the timer', async () => {
  const pool = new WarmPoolService({ disabled: false });
  await pool.initialize(); const timer = pool.timer; await pool.initialize();
  assert.equal(pool.timer, timer); pool.shutdown(); pool.shutdown(); assert.equal(pool.timer, null);
});
