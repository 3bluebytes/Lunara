import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureElectronInstalled, inspectElectronInstall } from './ensure-electron.mjs';

test('inspect reports a complete install only when path.txt target exists', () => {
  const files = new Set(['/repo/node_modules/electron/path.txt', '/repo/node_modules/electron/dist/Electron.app']);
  const result = inspectElectronInstall({
    root: '/repo',
    fileExists: path => files.has(path),
    readText: () => 'Electron.app\n',
  });
  assert.equal(result.ready, true);
  assert.equal(result.binaryPath, '/repo/node_modules/electron/dist/Electron.app');
});

test('ensure invokes the package installer once and verifies the result', async () => {
  let installed = false;
  let calls = 0;
  const result = await ensureElectronInstalled({
    root: '/repo',
    inspect: () => installed
      ? { ready: true, binaryPath: '/repo/electron' }
      : { ready: false, reason: 'path.txt missing' },
    runInstaller: async path => {
      calls += 1;
      assert.equal(path, '/repo/node_modules/electron/install.js');
      installed = true;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ready, true);
});

test('ensure returns a readable error when repair did not produce a binary', async () => {
  await assert.rejects(ensureElectronInstalled({
    root: '/repo',
    inspect: () => ({ ready: false, reason: 'binary missing' }),
    runInstaller: async () => {},
  }), /Electron 二进制仍不可用.*binary missing/);
});
