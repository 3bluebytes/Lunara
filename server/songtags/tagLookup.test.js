import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagLookup } from './tagLookup.js';

function countingStore({ batch = true } = {}) {
  const calls = { getTags: 0, getTagsMany: [], getArtistTags: 0 };
  const store = {
    marker: 'store',
    getTags: (songId, provider) => { calls.getTags += 1; return { songId, provider: provider || null }; },
    getArtistTags: () => { calls.getArtistTags += 1; return { gender: 'female' }; },
    other() { return this.marker; },
  };
  if (batch) store.getTagsMany = (provider, ids) => {
    calls.getTagsMany.push([provider, ids]);
    return new Map(ids.map(id => [id, id === 'untagged' ? null : { songId: id, provider }]));
  };
  return { store, calls };
}

test('prefetch batches by provider and later reads stay in memory', () => {
  const { store, calls } = countingStore();
  const view = createTagLookup(store);
  view.prefetch([{ songId: '1', source: 'qq:library' }, { song_id: '2', source: 'qq' }, { songId: 'x', provider: 'ncm' },
    { songId: 'untagged', source: 'qq:daily' }]);
  assert.deepEqual(calls.getTagsMany, [['qq', ['1', '2', 'untagged']], ['ncm', ['x']]]);
  assert.deepEqual(view.getTags('1', 'qq:library'), { songId: '1', provider: 'qq' });
  assert.equal(view.getTags('untagged', 'qq'), null, '未标注就是 null，不再回查');
  view.getTags('2', 'qq');
  assert.equal(calls.getTags, 0);
});

test('unprefetched reads fall back once and are cached; other members delegate to the store', () => {
  const { store, calls } = countingStore({ batch: false });
  const view = createTagLookup(store);
  assert.equal(view.prefetch([{ songId: '1', source: 'qq' }]), 0, '没有批量接口时不预取');
  view.getTags('1', 'qq');
  view.getTags('1', 'qq');
  view.getArtistTags('k');
  view.getArtistTags('k');
  assert.equal(calls.getTags, 1);
  assert.equal(calls.getArtistTags, 1);
  assert.equal(view.other(), 'store');
  assert.equal(createTagLookup(null), null, '标签库不可用仍然是 null');
});
