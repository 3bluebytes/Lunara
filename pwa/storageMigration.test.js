import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateStorageKey } from './storageMigration.js';

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test('legacy boot key 迁移到 lunara key 并移除旧 key', () => {
  const storage = fakeStorage({ 'claudio.bootDone': '1' });
  assert.equal(migrateStorageKey(storage, 'claudio.bootDone', 'lunara.bootDone'), true);
  assert.equal(storage.getItem('lunara.bootDone'), '1');
  assert.equal(storage.getItem('claudio.bootDone'), null);
});

test('新 key 已存在时不被 legacy 值覆盖', () => {
  const storage = fakeStorage({ 'claudio.bootDone': '0', 'lunara.bootDone': '1' });
  assert.equal(migrateStorageKey(storage, 'claudio.bootDone', 'lunara.bootDone'), false);
  assert.equal(storage.getItem('lunara.bootDone'), '1');
  assert.equal(storage.getItem('claudio.bootDone'), null);
});
