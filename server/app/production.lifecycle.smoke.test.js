import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function ownedResources() {
  return process.getActiveResourcesInfo()
    .filter(name => /tcp|timeout/i.test(name))
    .sort();
}

test('production composition starts and stops without owned network or timer handles', async () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    WARM_POOL_DISABLED: process.env.WARM_POOL_DISABLED,
    LUNARA_RUNTIME_ROOT: process.env.LUNARA_RUNTIME_ROOT,
    LUNARA_PERSONA_GENERATION_MODE: process.env.LUNARA_PERSONA_GENERATION_MODE,
  };
  const temp = mkdtempSync(resolve(tmpdir(), 'lunara-production-runtime-'));
  process.chdir(temp);
  process.env.WARM_POOL_DISABLED = '0';
  process.env.LUNARA_RUNTIME_ROOT = temp;
  // A production lifecycle smoke test must not contact the configured model just
  // because its isolated runtime starts with an empty radiohost registry.
  process.env.LUNARA_PERSONA_GENERATION_MODE = 'fallback';

  try {
    const server = await import('../index.js');
    const before = ownedResources();
    await server.start(0, { host: '127.0.0.1', probeProviders: false });
    const handle = server.getRuntimeHandle();
    assert.equal(handle.runtime.status, 'running');
    assert.ok(handle.address.port > 0);
    assert.equal(handle.server.listening, true);

    const { lifeContextService: life } = handle.runtime.services;

    await server.stop();
    for (let index = 0; index < 3; index += 1) {
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    }
    assert.equal(handle.runtime.status, 'stopped');
    assert.equal(life.store.db.open, false);
    assert.deepEqual(ownedResources(), before);

    await server.start(0, { host: '127.0.0.1', probeProviders: false });
    assert.equal(life.store.db.open, true);
    assert.ok(life.getRoutine());
    await server.stop();
    for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(life.store.db.open, false);
    assert.deepEqual(ownedResources(), before);
  } finally {
    const server = await import('../index.js');
    await server.stop().catch(() => {});
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
