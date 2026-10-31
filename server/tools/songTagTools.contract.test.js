import assert from 'node:assert/strict';
import test from 'node:test';
import { SongTagStore } from '../songtags/songTagStore.js';
import { correctSongTags, deleteSongTags, getSongTags } from './songTagTools.js';
import { normalizeToolOutcome } from './ToolOutcome.js';
import { registerMusicTools } from '../virtual-person/musicTools.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';

function fixture(t) {
  const store = new SongTagStore({ dbPath: ':memory:' }).initialize();
  t.after(() => store.close());
  for (const provider of ['qq', 'ncm']) store.upsert({ provider, song_id: '123', title: provider,
    language: 'english', confidence: 0.5 });
  return store;
}

test('bare ambiguous tag mutations reject without inventing a legacy row', async t => {
  const store = fixture(t);
  for (const handler of [correctSongTags, deleteSongTags]) {
    const result = normalizeToolOutcome(await handler({ song_id: '123', language: 'cantonese' }, { store }));
    assert.equal(result.ok, false);
  }
  assert.equal(store.getTags('123', 'qq').language, 'english');
  assert.equal(store.getTags('123', 'ncm').language, 'english');
  assert.equal(store.getTags('123', 'legacy'), null);
});

test('explicit source and current track modify only their canonical tag row', async t => {
  const store = fixture(t);
  const corrected = normalizeToolOutcome(await correctSongTags({ provider: 'qq', song_id: '123', language: 'cantonese' }, { store }));
  assert.equal(corrected.ok, true);
  assert.equal(store.getTags('123', 'qq').language, 'cantonese');
  assert.equal(store.getTags('123', 'ncm').language, 'english');
  const deleted = normalizeToolOutcome(await deleteSongTags({}, { store,
    currentTrack: () => ({ song_id: '123', source: 'ncm' }) }));
  assert.equal(deleted.ok, true);
  assert.equal(store.getTags('123', 'ncm'), null);
  assert.ok(store.getTags('123', 'qq'));
});

test('unknown bare identity fails closed while explicit identity can create and unique legacy can update', async t => {
  const store = fixture(t);
  assert.equal(normalizeToolOutcome(await correctSongTags({ song_id: 'unknown', language: 'cantonese' }, { store })).ok, false);
  assert.equal(store.getTags('unknown'), null);
  assert.equal(normalizeToolOutcome(await correctSongTags({ provider: 'qq', song_id: 'new', language: 'cantonese' }, { store })).ok, true);
  assert.ok(store.getTags('new', 'qq'));
  store.upsert({ song_id: 'old', language: 'english' });
  assert.equal(normalizeToolOutcome(await correctSongTags({ song_id: 'old', language: 'cantonese' }, { store })).ok, true);
  assert.equal(store.getTags('old', 'legacy').language, 'cantonese');
});

test('missing target, invalid fields and resolver exception retain failure semantics without raw diagnostics', async t => {
  const store = fixture(t);
  const cases = [
    [{ language: 'cantonese' }, {}],
    [{ provider: 'qq', song_id: '123', language: 'klingon' }, {}],
    [{ query: 'missing' }, { resolveTrack: async () => { throw new Error('secret-token=fixture'); } }],
  ];
  for (const [args, deps] of cases) {
    const result = normalizeToolOutcome(await correctSongTags(args, { store, ...deps }));
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.content, /secret-token/);
  }
  assert.equal(normalizeToolOutcome('failed plain string').ok, false);
  assert.equal(normalizeToolOutcome(await getSongTags({ provider: 'qq', song_id: 'missing' }, { store })).ok, true);
});

test('typed registry forwards tag business failures and explicit provider facts', async t => {
  const store = fixture(t);
  let invalidations = 0;
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => ({ getSongTagStore: () => store,
    playbackRuntime: { listeningSnapshot: () => ({ queue: [], currentIndex: -1 }) },
    pool: { invalidate: () => invalidations++ } }));
  const failed = await registry.execute('correct_song_tags', { language: 'cantonese' }, { sessionId: 'fixture' });
  assert.equal(failed.kind, 'business_failure');
  assert.equal(invalidations, 0);
  const success = await registry.execute('correct_song_tags', { provider: 'qq', song_id: '123', language: 'cantonese' });
  assert.equal(success.kind, 'success');
  assert.equal(success.facts.provider, 'qq');
  assert.equal(invalidations, 1);
});
