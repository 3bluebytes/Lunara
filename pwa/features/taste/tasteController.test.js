import assert from 'node:assert/strict';
import test from 'node:test';
import { createTasteController } from './tasteController.js';

test('taste controller reads status and bounded history', async () => {
  const paths = [];
  const controller = createTasteController({ apiClient: { get: async path => { paths.push(path); return { ok: true, log: [] }; } } });
  await controller.status();
  await controller.history(3);
  assert.deepEqual(paths, ['/api/taste/status', '/api/taste/log?limit=3']);
});

test('taste history bounds untrusted limit', async () => {
  const paths = [];
  const controller = createTasteController({ apiClient: { get: async path => { paths.push(path); return { ok: true }; } } });
  await controller.history(999);
  assert.equal(paths[0], '/api/taste/log?limit=50');
});
