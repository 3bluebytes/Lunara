import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lunara-state-test-'));
process.env.LUNARA_DB_PATH = join(dir, 'state.db');
const state = await import('./state.js');

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('VALID_OUTCOMES accepts technical_failure and superseded, and recentPlaysIdentitySince filters them out', () => {
  state.logPlay({ song_id: 'ok-1', title: 'Ok', artist: 'Singer', source: 'qq' });
  state.logPlay({ song_id: 'fail-1', title: 'Broken', artist: 'Singer', source: 'qq' });
  state.logPlay({ song_id: 'super-1', title: 'Switched', artist: 'Singer', source: 'ncm' });

  const failOutcome = state.recordOutcome({ song_id: 'fail-1', source: 'qq', outcome: 'technical_failure', played_seconds: 0 });
  const superOutcome = state.recordOutcome({ song_id: 'super-1', provider: 'ncm', outcome: 'superseded', played_seconds: 3 });
  assert.equal(failOutcome.ok, true);
  assert.equal(failOutcome.updated, 1);
  assert.equal(superOutcome.ok, true);
  assert.equal(superOutcome.updated, 1);

  const ids = state.recentPlaysIdentitySince(0).map(row => row.song_id);
  assert.equal(ids.includes('ok-1'), true);
  assert.equal(ids.includes('fail-1'), false, '技术失败不得污染 24 小时冷却与新鲜度');
  assert.equal(ids.includes('super-1'), false, '被替代未播不得污染 24 小时冷却与新鲜度');

  const mix = state.sourceMixSince(0);
  const qqCount = mix.find(row => row.provider === 'qq')?.n || 0;
  const ncmCount = mix.find(row => row.provider === 'ncm')?.n || 0;
  assert.equal(qqCount, 1);
  assert.equal(ncmCount, 0, 'superseded 不应算作音源实际听歌占比');
});

test('findRecentPlayBySong matches by canonical provider when provided without cross-provider mismatch', () => {
  state.logPlay({ song_id: 'dup-42', title: 'SameIdQQ', artist: 'ArtistA', source: 'qq:library' });
  state.logPlay({ song_id: 'dup-42', title: 'SameIdNCM', artist: 'ArtistB', source: 'ncm' });

  const updatedQQ = state.recordOutcome({ song_id: 'dup-42', provider: 'qq', outcome: 'technical_failure', played_seconds: 0 });
  assert.equal(updatedQQ.updated, 1);
  assert.equal(updatedQQ.play.artist, 'ArtistA');
  assert.equal(updatedQQ.play.source, 'qq:library');

  const recentIds = state.recentPlaysIdentitySince(0)
    .filter(row => row.song_id === 'dup-42')
    .map(row => row.source);
  assert.deepEqual(recentIds, ['ncm'], '按 provider 精确命中 qq 行后，同 id 的 ncm 实播不受误伤');
});
