import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueRelevantCandidateTags } from './candidateTagging.js';

test('candidate tagging is opt-in, bounded, provider-aware and never filters candidates', () => {
  const list = Array.from({ length: 150 }, (_, index) => ({ song_id: String(index), source: index % 2 ? 'qq:daily' : 'ncm:liked' }));
  const calls = [];
  const store = { needsTagging: id => Number(id) % 2 === 0 };
  assert.equal(enqueueRelevantCandidateTags(list, { store, enqueue: () => true, enabled: false }).enqueued, 0);
  const result = enqueueRelevantCandidateTags(list, { store, enqueue: song => { calls.push(song); return true; }, enabled: true, limit: 999 });
  assert.equal(result.scanned, 100);
  assert.equal(result.enqueued, 50);
  assert.equal(calls.every(song => song.provider === 'ncm'), true);
  assert.equal(list.length, 150, 'original candidate pool remains intact/playable');
});
