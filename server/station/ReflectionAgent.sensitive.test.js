// ReflectionAgent.sensitive.test.js — 反思判为敏感后，派生的洞察与来源都带 sensitive 标签，在哪个聊天里提不提由伙伴拿捏（privacy-as-persona-discretion）。
//
// Run: node --test server/station/ReflectionAgent.sensitive.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReflectionAgent } from './ReflectionAgent.js';
import { createBus } from './communication/AgentMessageBus.js';
import { EventType, createEvent } from './communication/messages.js';
import { MemoryService } from '../memory/MemoryService.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { retrievePersonMemories } from '../virtual-person/personMemory.js';

const personId = 'host-a';
const namespace = `radiohost:${personId}`;

async function withReflection(run, { llmReply = null, roomMode = 'radio' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-reflection-sensitive-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'state.db');
  let service = null;
  const station = {
    async getRadioHostMemoryService(id) {
      if (id !== personId) return null;
      if (!service) { service = new MemoryService(namespace); await service.initialize(); }
      return service;
    },
    getRadiohostMetadata: id => ({ id, name: id }), listRadioHosts: () => [{ id: personId, name: personId }],
    getActiveRadiohost: () => ({ id: personId, name: personId }),
  };
  const bus = createBus({ log: false });
  const llm = {
    askText: async prompt => {
      const rows = JSON.parse(prompt.split('\n').find(line => line.startsWith('[{')));
      if (typeof llmReply === 'function') return JSON.stringify(llmReply(rows));
      return JSON.stringify({ observation: '对方正在做化疗，身体很虚，想听很安静的钢琴曲。', evidence: [rows[0].evidenceId],
        tags: ['signal:calm'], confidence: 0.3,
        open_loops: [{ kind: 'upcoming', text: '对方下周还有一次化疗', evidence: [rows[0].evidenceId], sensitive: true }] });
    },
    extractJson: text => JSON.parse(text),
  };
  const reflection = new ReflectionAgent({ bus, station, llm, shortWindow: 1, logger: { warn() {}, log() {} } });
  await reflection.initialize();
  const ledger = new ConversationStore({ db: reflection.store.db }).initialize();
  reflection.setOpenLoopSink(loop => ledger.notes.acceptOpenLoop(loop));
  ledger.createRoom({ sessionId: 'dm', memberIds: [personId], interactionMode: roomMode });
  ledger.createRoom({ sessionId: 'dm2', memberIds: [personId] });
  ledger.createRoom({ sessionId: 'group', memberIds: [personId, 'host-b'], hostId: personId });
  let reqSeq = 0;
  const sayAndReflect = async ({
    beforeReflection = () => {},
    userText = '最近在做化疗，身体很虚，下周还要去一次，想听点很安静的钢琴',
  } = {}) => {
    const requestId = `r${++reqSeq}`;
    ledger.beginRequest({ sessionId: 'dm', requestId, virtualPersonId: personId, userText });
    ledger.completeRequest({ requestId, virtualPersonId: personId, message: { content: '好的，我陪你。' } });
    beforeReflection();
    bus.publishEvent(createEvent({ type: EventType.TURN_COMMITTED, sourceAgentId: `virtual-person:${personId}`,
      payload: { virtualPersonId: personId, sessionId: 'dm', requestId, displayText: 'x', outcomeCodes: [], committedAt: Date.now() } }));
    await bus.flush();
    for (let i = 0; i < 50 && !service?.searchMemory(undefined, { namespace, tags: 'reflection-insight', limit: 1 }).length; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const context = (sessionId, memberIds = [personId]) => retrievePersonMemories(service, ledger, { namespace, virtualPersonId: personId,
    sessionId, isGroup: memberIds.length > 1, memberIds, query: '放首歌吧' });
  try {
    await run({ ledger, sayAndReflect, context, insight: () => service.searchMemory(undefined, { namespace, tags: 'reflection-insight', limit: 1 })[0] });
  } finally {
    reflection.shutdown();
    await service?.shutdown();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const mentions = (items, kind) => items.filter(item => item.kind === kind).some(item => /化疗/.test(item.content));
const labeled = (items, kind) => items.filter(item => item.kind === kind && /化疗/.test(item.content));

test('同一批里有敏感 open loop 时，洞察带 sensitive 标签，她在哪个聊天里都记得', async () => {
  await withReflection(async ({ sayAndReflect, context, insight }) => {
    await sayAndReflect();
    const row = insight();
    assert.ok(row, '洞察照常写入');
    // 敏感只是标签，不再把洞察锁在来源聊天：群聊里提不提是她的分寸。
    assert.deepEqual(JSON.parse(row.evidence).policy, { disclosure: 'normal', sensitive: true });
    assert.equal(mentions(context('group', [personId, 'host-b']), 'reflection'), true, '群聊里也记得');
    assert.equal(mentions(context('dm2'), 'reflection'), true, '别的一对一也记得');
    assert.equal(mentions(context('dm'), 'reflection'), true, '原聊天照常可见');
  });
});

test('反思时她已离开那个聊天，敏感判断照样给原话打上标签', async () => {
  await withReflection(async ({ ledger, sayAndReflect, context }) => {
    await sayAndReflect({ beforeReflection: () => ledger.setActiveVirtualPerson('dm', 'host-b') });
    assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM companion_notes WHERE kind = 'open_loop'").get().n, 0, '不再是成员，不写心里话');
    const excerpts = labeled(context('dm2'), 'encounter');
    assert.ok(excerpts.length > 0, '她听到过的原话在别的聊天里仍是摘录');
    assert.ok(excerpts.every(item => item.content.endsWith('（比较私人的事）')), '带敏感标签');
  });
});

test('顶层 sensitive: true（无 open_loops）将洞察与来源标为敏感，且不上报到 reflection_publications', async () => {
  await withReflection(async ({ ledger, sayAndReflect, context, insight }) => {
    await sayAndReflect({ userText: '今晚想靠在你怀里慢慢聊' });
    const row = insight();
    assert.ok(row, '洞察照常写入私有记忆');
    assert.deepEqual(JSON.parse(row.evidence).policy, { disclosure: 'normal', sensitive: true });
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM reflection_publications').get().n, 0, '敏感洞察不上报 Station');
    const excerpts = context('dm2').filter(item => item.kind === 'encounter' && /靠在你怀里/.test(item.content));
    assert.ok(excerpts.length > 0 && excerpts.every(item => item.content.endsWith('（比较私人的事）')), '来源回合也标为比较私人的事');
  }, {
    llmReply: rows => ({
      observation: '用户喜欢深夜亲密依靠在耳边轻声聊天。',
      evidence: [rows[0].evidenceId],
      tags: ['intimacy'],
      confidence: 0.3,
      sensitive: true,
      claim: { key: 'interaction.intimacy', polarity: 'positive', text: '用户喜欢深夜亲密依靠', scope: 'shared_candidate', explicitSharedQuote: '' },
      open_loops: [],
    }),
  });
});

test('roleplay（私语）会话回合导入后自动带 private 策略，不上报到 reflection_publications', async () => {
  await withReflection(async ({ ledger, sayAndReflect, insight }) => {
    await sayAndReflect({ userText: '我平时很喜欢爵士乐' });
    const row = insight();
    assert.ok(row, '私语反思照常写入私有记忆');
    assert.equal(JSON.parse(row.evidence).policy.disclosure, 'private');
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM reflection_publications').get().n, 0, '私语观察不上报 Station');
  }, {
    roomMode: 'roleplay',
    llmReply: rows => ({
      observation: '用户喜欢爵士乐。',
      evidence: [rows[0].evidenceId],
      tags: ['taste'],
      confidence: 0.3,
      sensitive: false,
      claim: { key: 'music.genre.jazz', polarity: 'positive', text: '用户喜欢爵士乐', scope: 'shared_candidate', explicitSharedQuote: '' },
      open_loops: [],
    }),
  });
});

test('relationship 范围留作伙伴私有累积不上报；shared_candidate 音乐偏好才写入 reflection_publications', async () => {
  await withReflection(async ({ ledger, sayAndReflect, insight }) => {
    await sayAndReflect({ userText: '我就喜欢听 R&B' });
    const row = insight();
    assert.ok(row && String(row.tags).includes('claim:music.genre.rnb'), '私有记忆保留 claim 标签用于合并');
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM reflection_publications').get().n, 0, 'relationship 不上报 Station');
  }, {
    llmReply: rows => ({
      observation: '用户喜欢和宿主一起听 R&B。',
      evidence: [rows[0].evidenceId],
      tags: ['taste'],
      confidence: 0.3,
      sensitive: false,
      claim: { key: 'music.genre.rnb', polarity: 'positive', text: '用户喜欢和宿主一起听 R&B', scope: 'relationship', explicitSharedQuote: '' },
      open_loops: [],
    }),
  });

  await withReflection(async ({ ledger, sayAndReflect, insight }) => {
    await sayAndReflect({ userText: '我平时很喜欢听爵士乐' });
    assert.ok(insight());
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM reflection_publications').get().n, 1, '可共享的音乐偏好才写入 reflection_publications');
  }, {
    llmReply: rows => ({
      observation: '用户平时喜欢听爵士乐。',
      evidence: [rows[0].evidenceId],
      tags: ['taste'],
      confidence: 0.3,
      sensitive: false,
      claim: { key: 'music.genre.jazz', polarity: 'positive', text: '用户喜欢爵士乐', scope: 'shared_candidate', explicitSharedQuote: '' },
      open_loops: [],
    }),
  });
});
