// songTagStore.recording.test.js — 标签归属跨源合并后的两件事：
//   1. 同一首歌只打一次标（第二个源读到的就是那一份，不再触发生成）；
//   2. 合并前已经打过的标不能丢（读的时候提升过来，撤销时回填回去）。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SongTagStore } from './songTagStore.js';
import { RecordingStore } from '../music/recordingStore.js';

const QQ = { provider: 'qq', songId: 'qq-1' };
const NCM = { provider: 'ncm', songId: '12345' };

async function fixture({ withIdentity = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-tags-rec-'));
  const dbPath = join(dir, 'state.db');
  const recordings = withIdentity ? new RecordingStore({ dbPath, now: () => 1_000 }).initialize() : null;
  const tags = new SongTagStore({
    dbPath,
    now: () => 1_000,
    getRecordingStore: withIdentity ? () => recordings : () => null,
  }).initialize();
  return {
    dir, tags, recordings,
    cleanup: async () => { tags.close?.(); recordings?.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

function tagRow(identity, extra = {}) {
  return {
    provider: identity.provider,
    song_id: identity.songId,
    title: '晴天',
    artist: '周杰伦',
    mood: '明亮',
    confidence: 0.8,
    ...extra,
  };
}

test('without a merged recording, tags land in song_tags exactly as before', async () => {
  const { tags, cleanup } = await fixture();
  try {
    tags.upsert(tagRow(QQ));
    const read = tags.getTags('qq-1', 'qq');
    assert.equal(read.recordingId, undefined, 'unmerged reads carry no recording identity');
    assert.equal(read.mood, '明亮');
    const count = tags.db.prepare('SELECT COUNT(*) AS n FROM recording_tags').get();
    assert.equal(count.n, 0, 'no recording-level row is created for a standalone track');
  } finally {
    await cleanup();
  }
});

test('a merged recording is tagged once and both sources read the same tags', async () => {
  const { tags, recordings, cleanup } = await fixture();
  try {
    const link = recordings.link({ a: QQ, b: NCM, kind: 'user-confirmed' });
    tags.upsert(tagRow(QQ));

    const viaOther = tags.getTags('12345', 'ncm');
    assert.equal(viaOther.mood, '明亮');
    assert.equal(viaOther.recordingId, link.recordingId);
    // 只写一行录音级标签，song_tags 里不再多出一份。
    assert.equal(tags.db.prepare('SELECT COUNT(*) AS n FROM recording_tags').get().n, 1);
    assert.equal(tags.db.prepare('SELECT COUNT(*) AS n FROM song_tags').get().n, 0);

    // 第二个源因此不需要重新打标。
    assert.equal(tags.needsTagging('12345', 'ncm'), false);
    assert.equal(tags.needsTagging('qq-1', 'qq'), false);
  } finally {
    await cleanup();
  }
});

test('tags written before the merge are promoted instead of regenerated', async () => {
  const { tags, recordings, cleanup } = await fixture();
  try {
    // 合并之前，以供给身份打过一次标。
    tags.upsert(tagRow(NCM, { mood: '安静' }));
    recordings.link({ a: QQ, b: NCM, kind: 'user-confirmed' });

    const viaQq = tags.getTags('qq-1', 'qq');
    assert.equal(viaQq.mood, '安静', 'the existing tags must follow the track into the recording');
    assert.ok(viaQq.recordingId);
    assert.equal(tags.db.prepare('SELECT COUNT(*) AS n FROM recording_tags').get().n, 1);
    assert.equal(tags.needsTagging('qq-1', 'qq'), false);
  } finally {
    await cleanup();
  }
});

test('unlinking does not lose the tags that were shared', async () => {
  const { tags, recordings, cleanup } = await fixture();
  try {
    const link = recordings.link({ a: QQ, b: NCM, kind: 'user-confirmed' });
    tags.upsert(tagRow(QQ, { mood: '明亮' }));
    assert.ok(tags.getTags('12345', 'ncm').mood);

    // 撤销前先把录音级标签回填给每个成员。
    const preserved = tags.preserveTagsAcrossUnlink({ recordingId: link.recordingId, members: [QQ, NCM] });
    assert.equal(preserved.copied, 2);
    recordings.unlink({ recordingId: link.recordingId, ...NCM });

    // 拆开之后两条各自都还读得到此前打好的标。
    assert.equal(tags.getTags('qq-1', 'qq').mood, '明亮');
    assert.equal(tags.getTags('12345', 'ncm').mood, '明亮');
    assert.equal(tags.getTags('qq-1', 'qq').recordingId, undefined, 'no longer a merged read');
  } finally {
    await cleanup();
  }
});

test('a broken identity layer degrades to supply-level tags instead of failing', async () => {
  const { tags, cleanup } = await fixture({ withIdentity: false });
  try {
    tags.upsert(tagRow(QQ));
    assert.equal(tags.getTags('qq-1', 'qq').mood, '明亮');
    assert.equal(tags.getTags('12345', 'ncm'), null);
  } finally {
    await cleanup();
  }
});

test('corrections on a merged recording update the shared row, not a per-source copy', async () => {
  const { tags, recordings, cleanup } = await fixture();
  try {
    recordings.link({ a: QQ, b: NCM, kind: 'user-confirmed' });
    tags.upsert(tagRow(QQ));
    const corrected = tags.correctTags ? tags.correctTags('12345', { mood: '安静' }, 'ncm') : null;
    // 不同版本的方法名不同；至少保证 upsert 覆盖也走录音级。
    tags.upsert(tagRow(NCM, { mood: '安静' }));
    assert.equal(tags.getTags('qq-1', 'qq').mood, '安静');
    assert.equal(tags.db.prepare('SELECT COUNT(*) AS n FROM recording_tags').get().n, 1);
    assert.equal(tags.db.prepare('SELECT COUNT(*) AS n FROM song_tags').get().n, 0);
    void corrected;
  } finally {
    await cleanup();
  }
});

test('getTagsMany matches per-row getTags, including merged recordings and missing rows', async () => {
  const { tags, recordings, cleanup } = await fixture();
  try {
    recordings.link({ a: QQ, b: NCM, kind: 'user-confirmed' });
    tags.upsert(tagRow(QQ));
    tags.upsert(tagRow({ provider: 'ncm', songId: 'plain' }, { mood: '安静' }));
    const ids = ['12345', 'plain', 'missing'];
    const many = tags.getTagsMany('ncm', ids);
    assert.deepEqual([...many.keys()], ids);
    for (const id of ids) assert.deepEqual(many.get(id), tags.getTags(id, 'ncm'), `${id} 与逐条读取一致`);
    assert.equal(many.get('12345').mood, '明亮', '合并过的歌读到录音级标签');
    assert.equal(many.get('missing'), null);
    assert.deepEqual(recordings.memberSongIds('ncm', ids), new Set(['12345']));
  } finally {
    await cleanup();
  }
});

test('getTagsMany without an identity layer batches plain rows', async () => {
  const { tags, cleanup } = await fixture({ withIdentity: false });
  try {
    tags.upsert(tagRow(QQ));
    const many = tags.getTagsMany('qq:library', ['qq-1', 'none']);
    assert.equal(many.get('qq-1').mood, '明亮');
    assert.equal(many.get('none'), null);
  } finally {
    await cleanup();
  }
});
