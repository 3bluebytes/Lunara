import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import { ReflectionObservationStore } from './ReflectionObservationStore.js';

test('合并后 payload 变化会重新发布给 Station 晋升；崩溃重放不重复', () => {
  const db = new Database(':memory:');
  const store = new ReflectionObservationStore({ db });
  store.initialize();
  db.exec('CREATE TABLE station_processed_insights (memory_id INTEGER PRIMARY KEY, processed_at INTEGER NOT NULL)');
  const processed = () => db.prepare('SELECT COUNT(*) AS n FROM station_processed_insights').get().n;
  const payload = () => JSON.parse(db.prepare('SELECT payload_json FROM reflection_publications WHERE memory_id = 1').get().payload_json);

  store.publishInsight(1, 'night', { originalEvidence: [{ originalKey: 'a' }] });
  db.prepare('INSERT INTO station_processed_insights VALUES (1, 1)').run();

  store.publishInsight(1, 'night', { originalEvidence: [{ originalKey: 'a' }] });
  assert.equal(processed(), 1, '同样的 payload 不触发重读');

  store.publishInsight(1, 'night', { originalEvidence: [{ originalKey: 'a' }, { originalKey: 'b' }] });
  assert.equal(processed(), 0, '新证据让晋升重新读这条洞察');
  assert.equal(payload().originalEvidence.length, 2);
});
