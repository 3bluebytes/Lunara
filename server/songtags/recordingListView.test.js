import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicatesOf, foldRecordingRows } from './recordingListView.js';

const row = (provider, songId, title, extra = {}) => ({ provider, song_id: songId, title, artist: 'A', ...extra });

function fakeRecordings(pairs = []) {
  const map = new Map(pairs.map(([a, b, id]) => [`${a}:b`, id]));
  const owner = new Map();
  for (const [qq, ncm, id] of pairs) { owner.set(`qq:${qq}`, id); owner.set(`ncm:${ncm}`, id); }
  return {
    recordingOf(provider, songId) {
      const id = owner.get(`${provider}:${songId}`);
      if (!id) return { recordingId: `self:${provider}:${songId}`, isSelf: true };
      return { recordingId: id, isSelf: false };
    },
  };
}

test('合并过的两行折成一行，带来源列表与成员，顺序不变', () => {
  const rows = [
    row('qq', 'q1', '晴天'),
    row('ncm', 'n1', '晴天'),
    row('qq', 'q2', '稻香'),
  ];
  const recordings = fakeRecordings([['q1', 'n1', 'rec-1']]);
  const { items, folded } = foldRecordingRows(rows, { recordings });
  assert.equal(items.length, 2);
  assert.equal(folded, 1);
  assert.equal(items[0].recordingId, 'rec-1');
  assert.equal(items[0].merged, true);
  assert.deepEqual(items[0].sources, ['qq', 'ncm']);
  assert.deepEqual(items[0].members.map(m => [m.provider, m.songId]), [['qq', 'q1'], ['ncm', 'n1']]);
  assert.equal(items[0].representativeProvider, 'qq', '代表行沿用列表里先出现的那条');
  assert.equal(items[1].merged, undefined, '未合并的行完全不变');
});

test('合并行显示共享标签，而不是某一份可能过期的副本', () => {
  const rows = [row('qq', 'q1', '晴天', { mood: '旧值' }), row('ncm', 'n1', '晴天', { mood: '旧值' })];
  const tagStore = { getTags: () => ({ song_id: 'q1', provider: 'qq', title: '晴天', artist: 'A', mood: '共享值', confidence: 0.9 }) };
  const { items } = foldRecordingRows(rows, { recordings: fakeRecordings([['q1', 'n1', 'rec-1']]), tagStore });
  assert.equal(items.length, 1);
  assert.equal(items[0].mood, '共享值');
  assert.deepEqual(items[0].sources, ['qq', 'ncm'], '共享标签不覆盖来源留痕');
});

test('身份层缺失或抛错时保持原样：列表不能因为身份问题变空', () => {
  const rows = [row('qq', 'q1', '晴天'), row('ncm', 'n1', '晴天')];
  assert.deepEqual(foldRecordingRows(rows, {}).items, rows);
  const broken = { recordingOf() { throw new Error('db closed'); } };
  const result = foldRecordingRows(rows, { recordings: broken });
  assert.equal(result.items.length, 2, '身份层抛错时退回各自一行');
  assert.equal(result.folded, 0);
});

test('重复行计数只算真的存在的成员行，用来修正分页总数', () => {
  const items = [{ merged: true, members: [
    { provider: 'qq', songId: 'q1' }, { provider: 'ncm', songId: 'n1' },
  ] }];
  assert.equal(duplicatesOf(items, { countSongTagRows: pairs => pairs.length }), 1);
  assert.equal(duplicatesOf(items, null), 0);
});
