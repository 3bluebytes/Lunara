import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('MemoryService shutdown closes its SQLite store and permits clean reinitialization', async () => {
  const originalCwd = process.cwd();
  process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-memory-lifecycle-')));
  try {
    const { MemoryService } = await import('./MemoryService.js');
    const memory = new MemoryService('station');
    await memory.initialize();
    const firstStore = memory.getStore();
    assert.equal(firstStore.db.open, true);

    await memory.shutdown();
    assert.equal(memory.isInitialized(), false);
    assert.equal(firstStore.db, null);

    await memory.initialize();
    assert.notEqual(memory.getStore(), firstStore);
    await memory.shutdown();
  } finally {
    process.chdir(originalCwd);
  }
});
