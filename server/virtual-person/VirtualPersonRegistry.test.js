import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { LEGACY_ROOT_PERSONA, ROOT_PERSONA_VERSION, VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { customVoiceProfileId } from '../ttsCustomConfig.js';

const edgeDefaultId = customVoiceProfileId('free-edge', 'zh-CN-XiaoxiaoNeural');

test('registry bootstraps root and preserves child identity boundaries', () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db }).initialize();
  const root = registry.get('lunara');
  assert.equal(root.kind, 'root');
  assert.equal(root.memoryNamespace, 'person:lunara');
  assert.equal(root.voiceProfileId, edgeDefaultId);
  assert.match(root.personaDocument, /独立判断力的长期同伴/);
  assert.equal(root.metadata.managedRootPersonaVersion, ROOT_PERSONA_VERSION);

  const child = registry.createRadiohost({ displayName: '淑女', voiceProfileId: 'voice-lady' });
  assert.match(child.id, /^radiohost_/, '子实体 id 前缀必须是 radiohost_');
  assert.equal(child.kind, 'radiohost');
  assert.equal(child.memoryNamespace, `radiohost:${child.id}`, '记忆 namespace 前缀必须是 radiohost:');
  assert.equal(child.toolProfileId, 'radiohost');
  assert.equal(child.parentId, 'lunara');
  assert.notEqual(child.memoryNamespace, root.memoryNamespace);
  assert.throws(() => registry.createRadiohost({ parentId: 'missing', displayName: 'orphan' }), /parent/);
  assert.throws(() => registry.updateStatus('lunara', 'archived'), /cannot be archived/);
  registry.close();
  db.close();
});

test('managed root persona upgrades without overwriting a custom root persona', () => {
  const db = new Database(':memory:');
  const first = new VirtualPersonRegistry({ db }).initialize();
  db.prepare(`UPDATE virtual_persons SET persona_document = ?, metadata_json = '{}' WHERE id = 'lunara'`).run(LEGACY_ROOT_PERSONA);
  const upgraded = first.ensureRoot();
  assert.match(upgraded.personaDocument, /回复长短由内容决定/);

  db.prepare(`UPDATE virtual_persons SET voice_profile_id = '' WHERE id = 'lunara'`).run();
  assert.equal(first.ensureRoot().voiceProfileId, edgeDefaultId);

  db.prepare(`UPDATE virtual_persons SET voice_profile_id = 'Chinese (Mandarin)_Sweet_Lady' WHERE id = 'lunara'`).run();
  assert.equal(first.ensureRoot().voiceProfileId, 'Chinese (Mandarin)_Sweet_Lady', 'existing non-empty voice is never silently replaced');

  db.prepare(`UPDATE virtual_persons SET persona_document = ?, metadata_json = '{}' WHERE id = 'lunara'`).run('用户自定义的人格文档');
  const preserved = first.ensureRoot();
  assert.equal(preserved.personaDocument, '用户自定义的人格文档');
  first.close();
  db.close();
});
