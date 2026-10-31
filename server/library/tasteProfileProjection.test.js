import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTasteProfileToStationMemory, tasteProfileText } from './tasteProfileProjection.js';

function fixture() {
  const rows = [{ id: 1, content: '用户明确说不要摇滚', tags: 'station_seed,user_explicit', source: 'user_explicit_feedback' }];
  let nextId = 2;
  const active = new Map();
  const station = {
    setActiveTasteSource(provider, uid) { active.set(provider, String(uid)); },
    isStationSeedActive(row) {
      if (!String(row.tags).includes('taste_bootstrap')) return true;
      const provider = /provider:([^,]+)/.exec(row.tags)?.[1];
      const uid = /account_uid:([^,]+)/.exec(row.tags)?.[1];
      return uid === encodeURIComponent(active.get(provider));
    },
    stationMemory: {
      searchMemory(_query, options = {}) {
        const tags = String(options.tags || '').split(',').filter(Boolean);
        return rows.filter(row => tags.every(tag => String(row.tags).includes(tag)));
      },
      deleteMemory(id) {
        const index = rows.findIndex(row => row.id === id);
        if (index >= 0) rows.splice(index, 1);
      },
      addMemory(record) { rows.push({ ...record, id: nextId++ }); return { ok: true, id: nextId - 1 }; },
    },
  };
  return { rows, station };
}

const profile = {
  coverage: { distinctSongs: 80, playlists: 4 },
  artists: [{ name: 'A' }, { name: 'B' }], genres: [{ name: '流行' }],
  languages: [{ name: 'mandarin' }], affectBands: [{ name: 'low-high' }],
};

test('canonical taste profile projects idempotent low-confidence soft memory per account', async () => {
  const { rows, station } = fixture();
  const first = await projectTasteProfileToStationMemory({ station, provider: 'ncm', accountUid: 'U', profile });
  const second = await projectTasteProfileToStationMemory({ station, provider: 'ncm', accountUid: 'U', profile });
  assert.equal(first.projected, true);
  assert.equal(second.skipped, 'unchanged');
  assert.equal(rows.filter(row => String(row.tags).includes('account_uid:U')).length, 1);
  const projected = rows.find(row => String(row.tags).includes('taste_bootstrap'));
  assert.equal(projected.confidence, 0.55);
  assert.match(projected.content, /低置信软画像/);
  assert.match(projected.content, /可被当前请求和明确反馈覆盖/);
  assert.equal(tasteProfileText(profile).includes('绝对'), false);
  assert.equal(rows.some(row => row.content === '用户明确说不要摇滚'), true, 'explicit user memory is untouched');
});

test('account switch preserves both projections but only current account seed is active', async () => {
  const { rows, station } = fixture();
  await projectTasteProfileToStationMemory({ station, provider: 'ncm', accountUid: 'U', profile });
  await projectTasteProfileToStationMemory({ station, provider: 'ncm', accountUid: 'V', profile: { ...profile, artists: [{ name: 'C' }] } });
  const projected = rows.filter(row => String(row.tags).includes('taste_bootstrap'));
  assert.equal(projected.length, 2);
  assert.equal(projected.filter(row => station.isStationSeedActive(row)).length, 1);
  assert.match(projected.find(row => station.isStationSeedActive(row)).tags, /account_uid:V/);
});
