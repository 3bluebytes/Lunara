import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LUNARA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lunara-host-mgmt-config-'));

const { VirtualPersonRegistry, ROOT_ID } = await import('./VirtualPersonRegistry.js');
const { VirtualPersonService } = await import('./VirtualPersonService.js');

/** 每个用例一套隔离 db + persona 目录 + 可控的记忆与遗留注册项回调。 */
function harness({ memories = {}, legacyHosts = [], resolveVoiceProfile = null, failureFlags = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-host-mgmt-'));
  const personaRoot = join(dir, 'radiohost');
  mkdirSync(personaRoot, { recursive: true });
  const registry = new VirtualPersonRegistry({ dbPath: join(dir, 'state.db') });
  registry.initialize();
  const memoryTable = { ...memories };
  const legacy = new Set(legacyHosts);
  const rooms = { members: {}, active: {} };
  const conversationStore = {
    // VirtualPersonService.initialize() 会检查这两个成员；测试夹具必须提供，
    // 否则每次调用都会尝试重新初始化。
    db: {},
    initialize() {},
    resetActiveVirtualPerson(from) {
      for (const [session, id] of Object.entries(rooms.active)) {
        if (id === from) rooms.active[session] = ROOT_ID;
      }
      for (const [session, members] of Object.entries(rooms.members)) {
        if (members.includes(from)) {
          rooms.members[session] = members.filter(id => id !== from);
        }
      }
    },
    listRooms: () => Object.entries(rooms.members).map(([sessionId, memberIds]) => ({ sessionId, memberIds })),
  };
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    resolveVoiceProfile,
    countMemories: entity => memoryTable[entity.memoryNamespace] || 0,
    purgeMemories: entity => {
      if (failureFlags.failPurge) throw new Error('memory store exploded');
      const count = memoryTable[entity.memoryNamespace] || 0;
      delete memoryTable[entity.memoryNamespace];
      return count;
    },
    deletePersonaFile: id => {
      const file = join(personaRoot, id, 'persona.md');
      if (!existsSync(file)) return false;
      rmSync(join(personaRoot, id), { recursive: true, force: true });
      return true;
    },
    unregisterLegacyHost: id => {
      if (failureFlags.failLegacy) throw new Error('legacy registry exploded');
      return legacy.delete(id);
    },
  });
  return {
    dir, registry, service, memoryTable, legacy, rooms, personaRoot,
    writePersona: (id, text = '人格') => {
      mkdirSync(join(personaRoot, id), { recursive: true });
      writeFileSync(join(personaRoot, id, 'persona.md'), text);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedPerson(h, { id = 'radiohost_a', displayName = '小晚', personaDocument = '旧的', voiceProfileId = 'voice-1', namespace } = {}) {
  const ns = namespace || `radiohost:${id}`;
  return h.registry.createRadiohost({ id, displayName, personaDocument, voiceProfileId, memoryNamespace: ns });
}

test('编辑显示名生效，且不影响其他伙伴', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h, { id: 'radiohost_a', displayName: '小晚' });
  seedPerson(h, { id: 'radiohost_b', displayName: '阿宁' });
  const updated = h.service.updatePerson('radiohost_a', { displayName: '晚风' });
  assert.equal(updated.displayName, '晚风');
  assert.equal(h.registry.get('radiohost_b').displayName, '阿宁', '其他伙伴不得被影响');
});

test('编辑人格文本生效', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h, { personaDocument: '旧人格' });
  const updated = h.service.updatePerson('radiohost_a', { personaDocument: '新人格' });
  assert.equal(updated.personaDocument, '新人格');
});

test('编辑声音不影响人格内容', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h, { personaDocument: '保持不变的人格' });
  const updated = h.service.updatePerson('radiohost_a', { voiceProfileId: 'voice-2' });
  assert.equal(updated.voiceProfileId, 'voice-2');
  assert.equal(updated.personaDocument, '保持不变的人格', '换声音不得改变人格');
});

test('在场性格写进 metadata：校验通过才落库，不动人格与其他 metadata', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h, { personaDocument: '保持不变的人格' });
  const updated = h.service.updatePerson('radiohost_a', { presence: { temperament: 'quiet', style: ' 话少，偶尔冷幽默 ' } });
  assert.deepEqual(updated.metadata.presence, { temperament: 'quiet', style: '话少，偶尔冷幽默' });
  assert.equal(updated.personaDocument, '保持不变的人格');
  assert.throws(() => h.service.updatePerson('radiohost_a', { presence: { temperament: 'loud' } }), TypeError);
  assert.equal(h.registry.get('radiohost_a').metadata.presence.temperament, 'quiet', '非法输入整体不生效');
  const renamed = h.service.updatePerson('radiohost_a', { displayName: '晚风' });
  assert.equal(renamed.metadata.presence.temperament, 'quiet', '改别的字段不丢在场性格');
});

test('未提供的字段保持不变', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h, { displayName: '小晚', personaDocument: '人格', voiceProfileId: 'voice-1' });
  const updated = h.service.updatePerson('radiohost_a', { displayName: '晚风' });
  assert.equal(updated.personaDocument, '人格');
  assert.equal(updated.voiceProfileId, 'voice-1');
});

test('校验失败时所有字段保持原值', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h, { displayName: '小晚', personaDocument: '人格' });
  assert.throws(() => h.service.updatePerson('radiohost_a', { displayName: '', personaDocument: '不该写入' }), /displayName/);
  const after = h.registry.get('radiohost_a');
  assert.equal(after.displayName, '小晚');
  assert.equal(after.personaDocument, '人格', '一次失败的编辑不得留下半改状态');
});

test('超长人格文本被拒绝', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h);
  assert.throws(() => h.service.updatePerson('radiohost_a', { personaDocument: 'x'.repeat(4001) }), /4000/);
});

test('编辑不存在的伙伴返回可纠正错误', t => {
  const h = harness();
  t.after(h.cleanup);
  assert.throws(() => h.service.updatePerson('nope', { displayName: 'x' }), /not available|not found/);
});

test('用户改过人格后，受管默认值升级不再覆盖它', t => {
  const h = harness();
  t.after(h.cleanup);
  // 模拟：根陪伴者处于受管状态
  h.registry.update(ROOT_ID, { personaDocument: '用户亲手写的人格' });
  assert.equal(h.registry.get(ROOT_ID).metadata.userAuthoredPersona, true);
  // 重新 ensureRoot（模拟重启时的默认值升级）
  h.registry.ensureRoot();
  assert.equal(h.registry.get(ROOT_ID).personaDocument, '用户亲手写的人格',
    '用户改过的人格不得被默认值覆盖');
});

test('只换声音不会把受管人格锁成用户所有', t => {
  const h = harness();
  t.after(h.cleanup);
  h.registry.update(ROOT_ID, { voiceProfileId: 'voice-x' });
  assert.notEqual(h.registry.get(ROOT_ID).metadata.userAuthoredPersona, true,
    '仅换声音不应阻止默认人格升级');
});

test('根陪伴者可以编辑但不可删除', async t => {
  const h = harness();
  t.after(h.cleanup);
  const updated = h.service.updatePerson(ROOT_ID, { displayName: 'Lunara 新名' });
  assert.equal(updated.displayName, 'Lunara 新名');
  // deletePerson 是异步的（需要等待遗留注册项清理），因此必须用 rejects。
  await assert.rejects(() => h.service.deletePerson(ROOT_ID), /cannot be deleted/);
  assert.ok(h.registry.get(ROOT_ID), '根陪伴者必须仍然存在');
});

test('删除前披露真实的记忆条数与会话数', t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 7 } });
  t.after(h.cleanup);
  seedPerson(h);
  h.rooms.members['conversation:one'] = ['lunara', 'radiohost_a'];
  h.rooms.members['conversation:two'] = ['lunara'];
  const impact = h.service.personDeletionImpact('radiohost_a');
  assert.equal(impact.memories, 7);
  assert.equal(impact.rooms, 1);
  assert.equal(impact.deletable, true);
  assert.equal(impact.displayName, '小晚');
});

test('根陪伴者的披露标记为不可删除', t => {
  const h = harness();
  t.after(h.cleanup);
  const impact = h.service.personDeletionImpact(ROOT_ID);
  assert.equal(impact.deletable, false);
  assert.equal(impact.isRoot, true);
});

test('删除清理记忆、人格文件、实体行与遗留注册项', async t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 5 }, legacyHosts: ['radiohost_a'] });
  t.after(h.cleanup);
  seedPerson(h);
  h.writePersona('radiohost_a');
  assert.ok(existsSync(join(h.personaRoot, 'radiohost_a', 'persona.md')));

  const result = await h.service.deletePerson('radiohost_a');
  assert.equal(result.deleted, true);
  assert.equal(result.memories, 5);
  assert.equal(result.personaFile, true);
  assert.equal(result.legacyHost, true);
  assert.equal(h.registry.get('radiohost_a'), null, '实体行必须被移除');
  assert.equal(h.memoryTable['radiohost:radiohost_a'], undefined, '记忆必须被移除');
  assert.equal(h.legacy.has('radiohost_a'), false, '遗留注册项必须被移除');
  assert.equal(existsSync(join(h.personaRoot, 'radiohost_a')), false, '人格文件不得残留为孤儿');
});

test('删除正在发言的伙伴会回落到根，且不留下成员引用', async t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 1 } });
  t.after(h.cleanup);
  seedPerson(h);
  h.rooms.active['conversation:one'] = 'radiohost_a';
  h.rooms.members['conversation:one'] = ['lunara', 'radiohost_a'];

  await h.service.deletePerson('radiohost_a');
  assert.equal(h.rooms.active['conversation:one'], ROOT_ID, '当前发言者应回落到根');
  assert.deepEqual(h.rooms.members['conversation:one'], ['lunara'], '成员引用应被清除');
});

test('删除一个伙伴不影响其他伙伴', async t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 3, 'radiohost:radiohost_b': 4 } });
  t.after(h.cleanup);
  seedPerson(h, { id: 'radiohost_a' });
  seedPerson(h, { id: 'radiohost_b', displayName: '阿宁' });
  h.writePersona('radiohost_b');

  await h.service.deletePerson('radiohost_a');
  assert.equal(h.registry.get('radiohost_b').displayName, '阿宁');
  assert.equal(h.memoryTable['radiohost:radiohost_b'], 4, '其他人的记忆不得被波及');
  assert.ok(existsSync(join(h.personaRoot, 'radiohost_b', 'persona.md')));
});

test('删除不存在的伙伴返回 deleted:false 而不是抛错', async t => {
  const h = harness();
  t.after(h.cleanup);
  const result = await h.service.deletePerson('nope');
  assert.equal(result.deleted, false);
});

test('重复删除同一伙伴是安全的', async t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 2 } });
  t.after(h.cleanup);
  seedPerson(h);
  const first = await h.service.deletePerson('radiohost_a');
  assert.equal(first.deleted, true);
  const second = await h.service.deletePerson('radiohost_a');
  assert.equal(second.deleted, false, '再次删除应安全失败而不是报错');
});

test('归档与删除是不同语义：归档保留记忆', t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 9 } });
  t.after(h.cleanup);
  seedPerson(h);
  h.service.archive('radiohost_a');
  assert.equal(h.registry.get('radiohost_a').status, 'archived');
  assert.equal(h.memoryTable['radiohost:radiohost_a'], 9, '归档必须保留记忆');
});

test('归档后的伙伴不可编辑', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h);
  h.service.archive('radiohost_a');
  assert.throws(() => h.service.updatePerson('radiohost_a', { displayName: 'x' }), /not available/);
});
test('未知的声音引用在编辑入口被拒绝（fail closed）', t => {
  const h = harness({ resolveVoiceProfile: id => id === 'vp_ok' });
  t.after(h.cleanup);
  seedPerson(h);
  assert.throws(
    () => h.service.updatePerson('radiohost_a', { voiceProfileId: 'garbage-voice' }),
    /not a known voice profile/,
  );
  assert.equal(h.registry.get('radiohost_a').voiceProfileId, 'voice-1', '被拒绝的编辑不得写入');
  // legacy 值（供应商 voice id / 旧显示名）经别名表解析后同样是"已知"。
  assert.equal(h.service.updatePerson('radiohost_a', { voiceProfileId: 'vp_ok' }).voiceProfileId, 'vp_ok');
});

test('未注入声音解析器时不校验（保持既有行为）', t => {
  const h = harness();
  t.after(h.cleanup);
  seedPerson(h);
  assert.equal(h.service.updatePerson('radiohost_a', { voiceProfileId: 'voice-2' }).voiceProfileId, 'voice-2');
});

test('记忆清理失败时立即中止：一切保持原样，且可重试收敛', async t => {
  const flags = { failPurge: true };
  const h = harness({ memories: { 'radiohost:radiohost_a': 3 }, legacyHosts: ['radiohost_a'], failureFlags: flags });
  t.after(h.cleanup);
  seedPerson(h);
  h.writePersona('radiohost_a');

  const first = await h.service.deletePerson('radiohost_a');
  assert.equal(first.deleted, false, '记忆没删掉时不得谎报已删除');
  assert.match(first.errors.join(';'), /memory store exploded/, '失败必须如实上报');
  // 立即中止意味着什么都不动：既不能"人还在、记忆没了"，也不能"人删了、记忆成孤儿"。
  assert.ok(h.registry.get('radiohost_a'), '实体必须仍在');
  assert.equal(h.memoryTable['radiohost:radiohost_a'], 3, '记忆必须原样保留');
  assert.ok(existsSync(join(h.personaRoot, 'radiohost_a')), '人格文件必须原样保留');
  assert.ok(h.legacy.has('radiohost_a'), '遗留注册项必须原样保留');

  flags.failPurge = false;
  const second = await h.service.deletePerson('radiohost_a');
  assert.equal(second.deleted, true, '失败修复后重试应完成删除');
  assert.equal(h.memoryTable['radiohost:radiohost_a'], undefined, '重试时记忆一并清理');
  assert.equal(h.legacy.has('radiohost_a'), false, '重试时遗留注册项一并清理');
  assert.equal(existsSync(join(h.personaRoot, 'radiohost_a')), false, '重试时人格文件一并清理');
});

test('记忆之外的步骤失败不阻断其余清理', async t => {
  const h = harness({ memories: { 'radiohost:radiohost_a': 2 }, failureFlags: { failLegacy: true } });
  t.after(h.cleanup);
  seedPerson(h);
  h.writePersona('radiohost_a');

  const result = await h.service.deletePerson('radiohost_a');
  assert.equal(result.deleted, true, '遗留注册项失败不得阻止实体删除');
  assert.equal(result.personaFile, true, '文件清理必须照常完成');
  assert.match(result.errors.join(';'), /legacy registry exploded/);
});
