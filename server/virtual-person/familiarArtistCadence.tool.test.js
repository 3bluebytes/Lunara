import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from './ConversationStore.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { registerMusicTools } from './musicTools.js';
import { MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { getFamiliarArtistCadence } from '../program/familiarArtistCadence.js';

test('cadence tool requires a current-turn quote, writes exact source, and replays safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-cadence-tool-'));
  const conversationStore = new ConversationStore({ dbPath: join(dir, 'state.db') });
  conversationStore.initialize();
  let invalidations = 0;
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => ({ conversationStore, pool: { invalidate() { invalidations++; } } }));
  const quote = '我不太喜欢一直听陌生歌手，但偶尔可以穿插。';
  const context = { userText: quote, userTurnId: 'turn-1', virtualPersonId: 'lunara',
    capabilities: [MUSIC_MUTATION_CAPABILITY], groupAction: { ownerId: 'lunara' }, toolCallCount: 1 };
  try {
    const invalid = await registry.execute('set_familiar_artist_cadence',
      { mode: 'familiar_first', sourceQuote: '我讨厌所有陌生歌手' }, context);
    assert.equal(invalid.ok, false);
    assert.equal(getFamiliarArtistCadence(conversationStore.db, 'lunara'), null);
    let checks = 0;
    const stale = await registry.execute('set_familiar_artist_cadence',
      { mode: 'familiar_first', sourceQuote: quote },
      { ...context, isCurrent: () => ++checks === 1 });
    assert.equal(stale.code, 'STALE_MUSIC_TURN');
    assert.equal(getFamiliarArtistCadence(conversationStore.db, 'lunara'), null);
    const saved = await registry.execute('set_familiar_artist_cadence',
      { mode: 'familiar_first', sourceQuote: quote }, context);
    assert.equal(saved.ok, true);
    assert.equal(saved.terminal, true);
    assert.equal(getFamiliarArtistCadence(conversationStore.db, 'lunara').sourceQuote, quote);
    const replay = await registry.execute('set_familiar_artist_cadence',
      { mode: 'familiar_first', sourceQuote: quote }, context);
    assert.equal(replay.facts.replayed, true);
    const conflicting = await registry.execute('set_familiar_artist_cadence',
      { mode: 'clear', sourceQuote: quote }, context);
    assert.equal(conflicting.ok, false);
    assert.equal(getFamiliarArtistCadence(conversationStore.db, 'lunara').mode, 'familiar_first');
    assert.equal(invalidations, 1);
    const clearQuote = '取消熟悉歌手优先';
    const cleared = await registry.execute('set_familiar_artist_cadence',
      { mode: 'clear', sourceQuote: clearQuote }, { ...context, userTurnId: 'turn-2', userText: clearQuote });
    assert.equal(cleared.ok, true);
    assert.deepEqual(getFamiliarArtistCadence(conversationStore.db, 'lunara'), {
      mode: 'clear', sourceTurnId: 'turn-2', sourceQuote: clearQuote,
    });
  } finally {
    conversationStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
