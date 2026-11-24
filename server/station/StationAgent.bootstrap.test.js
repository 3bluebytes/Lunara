import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StationAgent } from './StationAgent.js';
import { createRadioHost, RadioHostRegistry } from './RadioHost.js';
import { VirtualPersonRegistry } from '../virtual-person/VirtualPersonRegistry.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { VirtualPersonService } from '../virtual-person/VirtualPersonService.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-bootstrap-'));
  const dbPath = join(dir, 'state.db');
  const personaRoot = join(dir, 'radiohost');
  const env = {
    LUNARA_DATA_DIR: dir, LUNARA_DB_PATH: dbPath, LUNARA_RADIOHOST_DIR: personaRoot,
    LUNARA_CONFIG_DIR: join(dir, 'config'), LUNARA_PERSONA_GENERATION_MODE: 'fallback',
    WARM_POOL_DISABLED: '1', REFLECTION_AGENT_DISABLED: '1',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const running = new Set();
  t.after(async () => {
    for (const app of running) await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const loadPersona = id => {
    const path = join(personaRoot, id, 'persona.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  async function boot() {
    const registry = new VirtualPersonRegistry({ dbPath }).initialize();
    const conversationStore = new ConversationStore({ dbPath });
    const service = new VirtualPersonService({ registry, conversationStore, loadPersona });
    const station = new StationAgent({ virtualPersonRegistry: registry });
    const app = { registry, conversationStore, service, station, async close() {
      await station.shutdown();
      conversationStore.close();
      registry.close();
      running.delete(app);
    } };
    running.add(app);
    // Same ownership/order as server/index.js: root, Station, then legacy import.
    await station.initialize();
    service.initialize();
    service.syncLegacyHosts(station.registry.list());
    return app;
  }
  return { boot, dbPath, personaRoot };
}

function assertRootOnly(app) {
  const people = app.service.list({ includeArchived: true });
  assert.deepEqual(people.map(person => person.id), ['lunara'],
    'cold start must not import a second default Lunara as a child');
  assert.equal(people[0].kind, 'root');
  assert.equal(people[0].memoryNamespace, 'person:lunara');
  assert.equal(app.station.registry.count(), 0, 'Station must not seed a legacy default host');
}

test('fresh startup, repeated initialize and restart retain exactly one Lunara', async t => {
  const f = fixture(t);
  const first = await f.boot();
  assertRootOnly(first);
  const root = first.registry.update('lunara', {
    personaDocument: '用户保存的根人格', voiceProfileId: 'my-saved-voice',
  });
  await first.station.initialize();
  first.service.syncLegacyHosts(first.station.listRadioHosts());
  assertRootOnly(first);
  assert.equal(existsSync(f.personaRoot), false, 'no child persona files are seeded');
  const childMemory = first.station.stationMemory.store.db.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE namespace LIKE 'radiohost:%'",
  ).get();
  assert.equal(childMemory.n, 0, 'no child persona memories are seeded');
  await first.close();
  const second = await f.boot();
  assertRootOnly(second);
  assert.deepEqual(second.registry.get('lunara'), root, 'restart preserves root configuration');
});

test('removing the last child does not recreate a default host on restart', async t => {
  const f = fixture(t);
  const first = await f.boot();
  assertRootOnly(first);
  // Explicit creation remains available; startup is not the owner of this decision.
  const host = await first.station.createRadioHost({
    id: 'user-created', displayName: '小晚', voiceProfileId: 'vp_radio_host',
    personaPresetId: 'retro_broadcaster',
  });
  first.service.syncLegacyHosts([host]);
  assert.equal(first.registry.get(host.id).displayName, '小晚');
  first.registry.remove(host.id);
  await first.station.deleteRadioHost(host.id);
  await first.close();
  const second = await f.boot();
  assertRootOnly(second);
});

test('legacy same-name hosts retain persona, voice, status, memory and conversation after restart', async t => {
  const f = fixture(t);
  const legacy = new RadioHostRegistry().initialize();
  const originals = [
    createRadioHost({ id: 'default', name: 'Lunara', voiceProfileId: 'old-voice', status: 'inactive' }),
    createRadioHost({ id: 'user-lunara', name: 'Lunara', voiceProfileId: 'custom-voice', status: 'archived' }),
  ];
  for (const host of originals) {
    legacy.register(host);
    mkdirSync(join(f.personaRoot, host.id), { recursive: true });
    writeFileSync(join(f.personaRoot, host.id, 'persona.md'), `# ${host.id}\n保留的独立人设。`);
  }
  legacy.close();
  const first = await f.boot();
  assert.equal(first.service.list({ includeArchived: true }).length, 3);
  for (const host of originals) {
    const entity = first.registry.get(host.id);
    assert.equal(entity.personaDocument, `# ${host.id}\n保留的独立人设。`);
    assert.equal(entity.voiceProfileId, host.voiceProfileId);
    assert.equal(entity.memoryNamespace, host.namespace);
    assert.equal(entity.status, host.status);
  }
  const memory = await first.station.getRadioHostMemoryService('default');
  assert.equal(memory.addMemory({ type: 'semantic', content: '只属于旧角色的关系记忆', source: 'manual_seed' }).ok, true);
  const room = await first.service.createRoom({ title: '旧聊天', memberIds: ['default'] });
  const before = first.service.list({ includeArchived: true });
  await first.close();
  const second = await f.boot();
  assert.deepEqual(second.service.list({ includeArchived: true }), before);
  assert.deepEqual(second.conversationStore.getSession(room.sessionId).memberIds, ['default']);
  const savedMemory = await second.station.getRadioHostMemoryService('default');
  assert.equal(savedMemory.searchMemory('只属于旧角色的关系记忆')[0].content, '只属于旧角色的关系记忆');
  for (const host of originals) {
    assert.equal(readFileSync(join(f.personaRoot, host.id, 'persona.md'), 'utf8'),
      `# ${host.id}\n保留的独立人设。`);
  }
});

test('REFLECTION_INSIGHT_PUBLISHED invalidates warm pool for that companion', async t => {
  const f = fixture(t);
  const app = await f.boot();
  const calls = [];
  app.station.getWarmPoolService().attachPreparedSource({
    stats: () => ({}),
    invalidate: opts => calls.push(opts),
  });
  const { EventType, createEvent } = await import('./communication/messages.js');
  app.station.bus.publishEvent(createEvent({
    type: EventType.REFLECTION_INSIGHT_PUBLISHED,
    sourceAgentId: 'station',
    payload: { virtualPersonId: 'lunara', memoryId: 9, window: 'short' },
  }));
  await app.station.bus.flush();
  assert.deepEqual(calls, [{ sessionId: null, personId: 'lunara' }]);
});

test('createRadioHost with direct personaDocument skips fallback preset injection and writes verbatim persona.md', async t => {
  const f = fixture(t);
  const app = await f.boot();
  const customDoc = '## 我是谁\n只聊合成器波普的独立制作人。\n\n## 我对这个用户的态度\n像录音棚里的搭档。';
  const host = await app.station.createRadioHost({
    id: 'custom-direct',
    displayName: '阿澈',
    voiceProfileId: 'vp_radio_host',
    personaDocument: customDoc,
  });
  assert.equal(host.name, '阿澈');
  assert.equal(readFileSync(join(f.personaRoot, 'custom-direct', 'persona.md'), 'utf8'), `${customDoc}\n`);
});
