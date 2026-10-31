import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingReviewController } from './recordingReviewController.js';

const proposal = n => ({ id: 'p' + n, title: '歌曲 ' + n, artist: '歌手', members: [] });
const snapshot = (count = 7) => ({ revision: 'r1', proposals: Array.from({ length: count }, (_, n) => proposal(n)),
  proposalCount: count, recordings: [], recordingCount: 0, trackCount: count * 2, latestBatchId: null });
function fixture({ get = async () => snapshot(), post = async () => ({ ok: true, confirmed: 7 }) } = {}) {
  const calls = [];
  const controller = createRecordingReviewController({ apiClient: {
    get: async (...args) => { calls.push(['get', ...args]); return get(...args); },
    post: async (...args) => { calls.push(['post', ...args]); return post(...args); },
  }, requestIdFactory: () => 'stable-request' });
  return { controller, calls };
}

test('closed review is lazy; library events do not open it or read the catalog', async () => {
  const { controller, calls } = fixture();
  await controller.handleServerEvent({ type: 'library-updated' });
  assert.equal(controller.getSnapshot().open, false);
  assert.deepEqual(calls, []);
  await controller.open();
  assert.equal(controller.getSnapshot().selected.length, 7);
  controller.close();
  await controller.handleServerEvent({ type: 'library-updated' });
  assert.equal(calls.length, 1);
});

test('lost response retains the exact request and prevents new writes or selection edits', async () => {
  let writes = 0;
  const { controller, calls } = fixture({ post: async () => {
    if (++writes === 1) throw new Error('private diagnostic');
    return { ok: true, confirmed: 7 };
  } });
  await controller.open();
  await controller.confirm();
  assert.equal(controller.getSnapshot().uncertain, true);
  assert.doesNotMatch(controller.getSnapshot().error, /private|失败/);
  controller.select('p0', false);
  await controller.confirm();
  await controller.handleServerEvent({ type: 'library-updated' });
  assert.equal(calls.length, 2);
  await controller.retry();
  assert.deepEqual(calls.filter(call => call[0] === 'post').map(call => call[2]), [
    { requestId: 'stable-request', revision: 'r1', proposalIds: Array.from({ length: 7 }, (_, n) => 'p' + n) },
    { requestId: 'stable-request', revision: 'r1', proposalIds: Array.from({ length: 7 }, (_, n) => 'p' + n) },
  ]);
  assert.equal(controller.getSnapshot().uncertain, false);
  assert.match(controller.getSnapshot().notice, /已对齐 7 组/);
});

test('stale proposals fail closed until a successful refresh', async () => {
  const { controller, calls } = fixture({ post: async () => { throw { status: 409 }; } });
  await controller.open();
  await controller.confirm();
  assert.equal(controller.getSnapshot().stale, true);
  assert.equal(controller.getSnapshot().uncertain, false);
  assert.match(controller.getSnapshot().error, /已变化.*刷新/);
  await controller.confirm();
  assert.equal(calls.length, 2);
  await controller.refresh();
  assert.equal(controller.getSnapshot().stale, false);
});

test('a failed refresh after commit does not misreport the accepted write', async () => {
  let reads = 0;
  const { controller } = fixture({ get: async () => {
    if (++reads > 1) throw new Error('offline');
    return snapshot();
  } });
  await controller.open();
  await controller.confirm();
  const state = controller.getSnapshot();
  assert.match(state.notice, /已对齐 7 组/);
  assert.match(state.error, /读取/);
  assert.equal(state.readFailed, true);
  assert.equal(state.uncertain, false);
});

test('50-per-page selections are bounded; refreshed selections survive matching proposals', async () => {
  const { controller } = fixture({ get: async () => snapshot(120) });
  await controller.open();
  assert.equal(controller.getSnapshot().selected.length, 50);
  controller.select('p0', false);
  await controller.handleServerEvent({ type: 'library-updated' });
  assert.equal(controller.getSnapshot().selected.length, 49);
  controller.setPage(1);
  assert.equal(controller.getSnapshot().selected.length, 50);
  assert.equal(controller.getSnapshot().selected[0], 'p50');
  controller.setPage(2);
  assert.equal(controller.getSnapshot().selected.length, 20);
  controller.selectAll(false);
  assert.equal(controller.getSnapshot().selected.length, 0);
});

test('pending reads cannot reopen the panel; destroy ignores late responses', async () => {
  let resolve;
  const { controller } = fixture({ get: () => new Promise(done => { resolve = done; }) });
  const pending = controller.open();
  controller.close();
  controller.destroy();
  resolve(snapshot());
  await pending;
  assert.equal(controller.getSnapshot().open, false);
  assert.equal(controller.getSnapshot().view, null);
});

test('dismiss, split and undo use local review routes without player or account mutations', async () => {
  const view = { ...snapshot(), latestBatchId: 'b1', recordings: [{ recordingId: 'g1', revision: 'g-rev', members: [] }] };
  const { controller, calls } = fixture({ get: async () => view });
  await controller.open();
  await controller.dismiss();
  await controller.split('g1');
  await controller.undo();
  assert.deepEqual(calls.filter(call => call[0] === 'post').map(call => call.slice(1)), [
    ['/api/library/recordings/dismiss', {}],
    ['/api/library/recordings/split', { recordingId: 'g1', revision: 'g-rev' }],
    ['/api/library/recordings/split', { batchId: 'b1' }],
  ]);
});
