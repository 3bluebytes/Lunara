import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingStore } from './recordingStore.js';
import { SongTagStore } from '../songtags/songTagStore.js';
import { RecordingReviewService, proposeRecordings } from './recordingReview.js';

const track = (provider, n, extra = {}) => ({ provider, song_id: `${provider}-${n}`, title: `歌曲 ${n}`,
  artist: '同一歌手', album: '同一专辑', duration: 200, ...extra });
const pairs = count => Array.from({ length: count }, (_, n) => [track('qq', n), track('ncm', n)]).flat();
async function fixture(t, initial = pairs(6)) {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-review-'));
  const recordings = new RecordingStore({ dbPath: join(dir, 'state.db') }).initialize();
  const tags = new SongTagStore({ dbPath: join(dir, 'state.db'), db: recordings.db,
    getRecordingStore: () => recordings }).initialize();
  let catalog = initial;
  const review = new RecordingReviewService({ recordings, tagStore: tags, readCatalog: () => catalog });
  t.after(async () => { tags.close(); recordings.close(); await rm(dir, { recursive: true, force: true }); });
  return { review, recordings, tags, setCatalog: value => { catalog = value; } };
}

function accept(review, requestId = 'test-request', count = 1) {
  const view = review.snapshot();
  return review.confirm({ requestId, revision: view.revision, proposalIds: view.proposals.slice(0, count).map(item => item.id) });
}

test('visiting the review is pure: same metadata creates proposals, never merges', async t => {
  const { review, recordings } = await fixture(t);
  const before = recordings.db.prepare('SELECT COUNT(*) AS n FROM equivalence_decision').get().n;
  const view = review.snapshot();
  assert.equal(view.proposalCount, 6);
  assert.equal(view.showPrompt, true);
  assert.equal(view.trackCount, 12);
  assert.deepEqual(review.snapshot(), view);
  assert.equal(recordings.stats().recordings, 0);
  assert.equal(recordings.db.prepare('SELECT COUNT(*) AS n FROM equivalence_decision').get().n, before);
  assert.doesNotMatch(JSON.stringify(view), /account_uid|cookie|https?:|url/);
});

test('ambiguous versions, missing duration, same-source duplicates and single-source catalogs do not prompt', async t => {
  const { review, setCatalog } = await fixture(t, [
    track('qq', 1), track('ncm', 1, { title: '歌曲 1 (Live)' }),
    track('qq', 2), track('ncm', 2, { duration: 30 }),
    track('qq', 3), track('ncm', 3, { duration: 0 }),
    track('qq', 4), track('ncm', 4), track('ncm', 'other', { title: '歌曲 4' }),
  ]);
  assert.equal(review.snapshot().proposalCount, 0);
  setCatalog([track('qq', 0)]);
  assert.equal(review.snapshot().showPrompt, false);
});

test('confirmation persists, is idempotent, rejects stale input and never mutates remote membership', async t => {
  const { review, recordings } = await fixture(t);
  const view = review.snapshot();
  const input = { requestId: 'confirm-1', revision: view.revision, proposalIds: [view.proposals[0].id] };
  const result = review.confirm(input);
  assert.equal(result.confirmed, 1);
  assert.equal(recordings.stats().recordings, 1);
  assert.equal(review.snapshot().alignedCount, 1);
  assert.equal(review.confirm(input).replay, true);
  assert.throws(() => review.confirm({ ...input, proposalIds: [view.proposals[1].id] }), { code: 'recording_request_conflict' });
  assert.throws(() => review.confirm({ ...input, requestId: 'stale' }), { code: 'stale_recording_review' });
  assert.throws(() => review.confirm({ requestId: 'forged', revision: review.snapshot().revision,
    proposalIds: ['arbitrary-song-id'] }), { code: 'stale_recording_proposal' });
});

test('a whole batch is atomic even if the last selected proposal is invalid', async t => {
  const { review, recordings } = await fixture(t);
  const view = review.snapshot();
  assert.throws(() => review.confirm({ requestId: 'bad', revision: view.revision,
    proposalIds: [view.proposals[0].id, 'forged'] }));
  assert.equal(recordings.stats().recordings, 0);
  const original = recordings.link.bind(recordings);
  let calls = 0;
  recordings.link = args => { if (++calls === 2) throw new Error('simulated disk error'); return original(args); };
  assert.throws(() => accept(review, 'disk-failure', 2), /simulated disk error/);
  assert.equal(recordings.stats().recordings, 0, 'first link is rolled back with the rest of the batch');
  assert.equal(recordings.db.prepare('SELECT COUNT(*) AS n FROM recording_review_batches').get().n, 0);
});

test('undo preserves shared tags and originals, is idempotent and keeps audit receipts', async t => {
  const { review, recordings, tags } = await fixture(t);
  tags.upsert({ provider: 'qq', song_id: 'qq-0', title: '歌曲 0', mood: '用户原先的修正', source: 'user', confidence: 1 });
  const result = accept(review);
  tags.upsert({ provider: 'qq', song_id: 'qq-0', title: '歌曲 0', mood: '共享标签', confidence: 0.8 });
  assert.equal(tags.getTags('ncm-0', 'ncm').mood, '共享标签');
  assert.equal(review.split({ batchId: result.batchId }).split, 1);
  assert.equal(recordings.stats().recordings, 0);
  assert.equal(tags.getTags('qq-0', 'qq').mood, '用户原先的修正');
  assert.equal(tags.getTags('ncm-0', 'ncm').mood, '共享标签');
  assert.equal(review.split({ batchId: result.batchId }).replay, true);
  const decisions = recordings.db.prepare('SELECT * FROM equivalence_decision ORDER BY decision_id').all();
  assert.ok(decisions[0].revoked_at);
  assert.equal(decisions.at(-1).kind, 'unlink');
  assert.equal(decisions.at(-1).revoked_at, null, 'undo itself remains a live audit fact');
});

test('partial failure during undo rolls back tag copies and identity changes together', async t => {
  const { review, recordings, tags } = await fixture(t);
  const batch = accept(review, 'two', 2);
  tags.upsert({ provider: 'qq', song_id: 'qq-0', mood: 'shared' });
  const dissolve = recordings.dissolve.bind(recordings);
  let calls = 0;
  recordings.dissolve = args => { if (++calls === 2) throw new Error('simulated undo failure'); return dissolve(args); };
  assert.throws(() => review.split({ batchId: batch.batchId }), /simulated undo failure/);
  assert.equal(recordings.stats().recordings, 2);
  assert.equal(tags.db.prepare('SELECT COUNT(*) AS n FROM song_tags').get().n, 0);
});

test('a changed group cannot be undone by an old batch or an old detail view', async t => {
  const { review, recordings } = await fixture(t);
  const batch = accept(review);
  const group = review.snapshot().recordings[0];
  recordings.link({ a: group.members[0], b: { provider: 'qq', songId: 'additional' }, kind: 'user-confirmed' });
  assert.throws(() => review.split({ batchId: batch.batchId }), { code: 'stale_recording_group' });
  assert.throws(() => review.split({ recordingId: group.recordingId, revision: group.revision }), { code: 'stale_recording_group' });
  assert.equal(recordings.stats().members, 3);
});

test('a group can be split from its current detail view and does not immediately prompt again', async t => {
  const { review } = await fixture(t);
  accept(review);
  const group = review.snapshot().recordings[0];
  assert.equal(review.split({ recordingId: group.recordingId, revision: group.revision }).split, 1);
  assert.equal(review.snapshot().showPrompt, false);
});

test('dismissal is durable and bounded: only 20 genuinely new proposals may prompt one more time', async t => {
  const { review, setCatalog, recordings, tags } = await fixture(t);
  review.dismiss();
  assert.equal(review.snapshot().showPrompt, false);
  review.dismiss();
  setCatalog(pairs(25));
  assert.equal(review.snapshot().showPrompt, false, '19 new pairs do not qualify');
  setCatalog(pairs(26));
  assert.equal(review.snapshot().showPrompt, true);
  review.dismiss();
  setCatalog(pairs(60));
  assert.equal(review.snapshot().showPrompt, false, 'second dismissal is permanent');
  const reopened = new RecordingReviewService({ recordings, tagStore: tags, readCatalog: () => pairs(100) });
  assert.equal(reopened.snapshot().showPrompt, false);
});

test('representative cannot refer to a member in a different recording', async t => {
  const { recordings } = await fixture(t);
  const a = recordings.link({ a: { provider: 'qq', songId: 'a' }, b: { provider: 'ncm', songId: 'b' }, kind: 'user-confirmed' });
  recordings.link({ a: { provider: 'qq', songId: 'c' }, b: { provider: 'ncm', songId: 'd' }, kind: 'user-confirmed' });
  assert.equal(recordings.setRepresentative({ recordingId: a.recordingId, provider: 'qq', songId: 'c' }).ok, false);
  assert.equal(recordings.representativeOf(a.recordingId).songId, 'a');
});

test('指纹一致的跨源组合只提提议：排在前面、带证据说明，但不写任何等价关系', () => {
  const recorded = [];
  const recordings = {
    recordingOf: () => ({ recordingId: 'self:x', isSelf: true }),
    link: (...args) => { recorded.push(args); throw new Error('proposal must never link'); },
  };
  const tracks = [
    { provider: 'qq', songId: 'q1', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 },
    { provider: 'ncm', songId: 'n1', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 268 },
    { provider: 'qq', songId: 'q2', title: '稻香', artist: '周杰伦', album: '魔杰座', duration: 223 },
    { provider: 'ncm', songId: 'n2', title: '完全不同的歌', artist: '别人', album: '别的', duration: 200 },
  ];
  const fingerprints = [
    { provider: 'qq', songId: 'q1', fingerprint: 'aaaa'.repeat(20) },
    { provider: 'ncm', songId: 'n1', fingerprint: 'aaaa'.repeat(20) },
    { provider: 'ncm', songId: 'n2', fingerprint: 'ffff'.repeat(20) },
  ];
  const proposals = proposeRecordings(tracks, recordings, { fingerprints });
  const fingerprintRow = proposals[0];
  assert.equal(fingerprintRow.evidence, 'fingerprint', '指纹证据排最前（预选）');
  assert.deepEqual(fingerprintRow.members.map(m => m.songId), ['n1', 'q1']);
  assert.match(fingerprintRow.reason, /听起来是同一首/);
  assert.doesNotMatch(fingerprintRow.reason, /指纹|fingerprint|audio/, '界面不用内部术语');
  assert.equal(recorded.length, 0, '提议阶段绝不写等价关系');
  // 元数据不同但指纹一致的另一首不会因为指纹被硬凑成与「稻香」同组。
  assert.equal(proposals.some(row => row.members.some(m => m.songId === 'q2')), false);
});
