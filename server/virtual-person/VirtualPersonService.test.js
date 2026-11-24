import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { LLMNotConfiguredError } from '../llm.js';
import { ConversationStore, presenceTurnId } from './ConversationStore.js';
import { ROOT_PERSONA, ROOT_RELATIONSHIP, VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonService } from './VirtualPersonService.js';

test('service imports legacy radiohost identity and activates exactly one session speaker', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const calls = [];
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    createRadiohost: async input => {
      calls.push(['create', input]);
      return { id: 'legacy-host', name: input.displayName, voiceProfileId: input.voiceProfileId, namespace: 'radiohost:legacy-host', status: 'inactive' };
    },
    loadPersona: () => '# 夜航\n\n## 我是谁\n安静。\n\n## 我对这个用户的态度\n关系距离：熟悉但有分寸。',
  }).initialize();

  const created = await service.create({ displayName: '夜航', voiceProfileId: 'warm', personaHint: '安静' });
  assert.equal(created.id, 'legacy-host');
  assert.equal(created.voiceProfileId, 'warm');
  assert.match(created.relationshipStance, /熟悉但有分寸/);
  assert.equal(registry.get('lunara').memoryNamespace, 'person:lunara');
  assert.equal(created.memoryNamespace, 'radiohost:legacy-host');

  assert.equal(service.session('session-a').activeVirtualPersonId, 'lunara');

  const switched = await service.activate({ id: created.id, sessionId: 'session-a' });
  assert.equal(switched.session.activeVirtualPersonId, created.id);
  assert.equal(calls.length, 1, 'activation only changes the conversation; no global radiohost or voice mutation');
  assert.deepEqual(switched.session.memberIds, ['legacy-host']);
  assert.equal(service.archive(created.id).status, 'archived');
  assert.equal(conversationStore.getSession('session-a').activeVirtualPersonId, 'lunara');
  assert.equal(await service.activate({ id: created.id, sessionId: 'session-a' }), null);

  conversationStore.recordTrackIntro({
    sessionId: 'session-a', personId: 'lunara', correlationId: 'transition:1',
    queueItemId: 'queue:item-one', text: '适合现在听的一首。', about: '这会儿听正合适',
    track: { songId: 'song-one', title: '一首歌', artist: '歌手', source: 'qq' },
  });
  const [intro] = service.transcript('session-a');
  // 要点备忘入账，但不进聊天记录的对外投影。
  assert.equal(conversationStore.listTurns('session-a', { limit: 5, visibleOnly: true })[0].message.about, '这会儿听正合适');
  assert.ok(!JSON.stringify(intro).includes('这会儿听正合适'));
  assert.equal(intro.presentation, 'track_intro');
  assert.equal(intro.queueItemId, 'queue:item-one');
  assert.equal(intro.text, '适合现在听的一首。');

  registry.close();
  conversationStore.close();
  db.close();
});

test('deleteRoom drops suspended playback state but refuses a conversation that owns live playback', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const submitted = [];
  let snapshot = { activeListeningSessionId: 'playing-room',
    suspendedSessions: { 'suspended-room': { queue: [{ songId: 'left-behind' }] } },
    pendingSwitch: { listeningSessionId: 'switching-room' } };
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    loadPersona: () => '',
    playbackRuntime: {
      snapshot: () => snapshot,
      submit: async event => {
        submitted.push(event);
        // 运行时是播放状态的唯一写入者：删除前必须由它释放该会话的挂起状态。
        if (event.type === 'LISTENING_SESSION_REMOVED' && event.listeningSessionId === 'suspended-room') {
          delete snapshot.suspendedSessions['suspended-room'];
        }
        return { accepted: event.listeningSessionId !== snapshot.activeListeningSessionId };
      },
    },
  }).initialize();
  for (const sessionId of ['playing-room', 'suspended-room', 'switching-room', 'idle-room']) {
    conversationStore.createRoom({ sessionId, memberIds: ['lunara'] });
  }
  for (const sessionId of ['playing-room', 'switching-room']) {
    await assert.rejects(() => service.deleteRoom(sessionId), error => error.statusCode === 409, sessionId);
    assert.ok(conversationStore.getSession(sessionId), `${sessionId} 未能保留`);
  }
  // 挂着未听完队列的会话现在可以删除：先释放挂起状态，再删聊天记录。
  assert.equal(await service.deleteRoom('suspended-room'), true);
  assert.equal(conversationStore.getSession('suspended-room'), null);
  assert.ok(submitted.some(event => event.type === 'LISTENING_SESSION_REMOVED'
    && event.listeningSessionId === 'suspended-room'));
  assert.equal(await service.deleteRoom('idle-room'), true);
  assert.equal(conversationStore.getSession('idle-room'), null);
  // 守卫只读快照：会话不再是在听的那一个/不再等待切换后可以删除。
  snapshot = { activeListeningSessionId: 'elsewhere', suspendedSessions: {}, pendingSwitch: null };
  assert.equal(await service.deleteRoom('switching-room'), true);
  registry.close();
  conversationStore.close();
  db.close();
});

test('archiving pauses the conversation that is currently playing and cancels a pending switch to it', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const submitted = [];
  let snapshot = {
    activeListeningSessionId: 'playing-room',
    phase: 'playing',
    currentIndex: 0,
    outputGeneration: 3,
    queue: [{ songId: 'track-1', programId: 'program-1' }],
    suspendedSessions: { 'suspended-room': { queue: [{ songId: 'left-behind' }] } },
    pendingSwitch: { listeningSessionId: 'switching-room' },
  };
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    loadPersona: () => '',
    playbackRuntime: {
      snapshot: () => snapshot,
      submit: async event => {
        submitted.push(event);
        if (event.type === 'PAUSE_REQUESTED') {
          // 真实运行时只在活动会话的当前 occurrence 上生效；这里如实模拟暂停结果。
          if (event.listeningSessionId === snapshot.activeListeningSessionId) snapshot = { ...snapshot, phase: 'paused' };
          return { accepted: true };
        }
        if (event.type === 'LISTENING_SWITCH_CANCELLED') {
          snapshot = { ...snapshot, pendingSwitch: null };
          return { accepted: true };
        }
        return { accepted: true };
      },
    },
  }).initialize();
  for (const sessionId of ['playing-room', 'suspended-room', 'switching-room']) {
    conversationStore.createRoom({ sessionId, memberIds: ['lunara'] });
  }

  // 在听的那一个：先按暂停，再归档，声音不会留在看不见的会话里。
  await service.updateRoom('playing-room', { archived: true });
  const pause = submitted.find(event => event.type === 'PAUSE_REQUESTED');
  assert.equal(pause.listeningSessionId, 'playing-room');
  assert.equal(pause.songId, 'track-1');
  assert.equal(pause.outputGeneration, 3);
  assert.equal(snapshot.phase, 'paused');
  assert.ok(conversationStore.getSession('playing-room').archivedAt);

  // 挂起会话的队列与位置不被归档打扰：恢复房间后还能接着听。
  await service.updateRoom('suspended-room', { archived: true });
  assert.equal(submitted.filter(event => event.type === 'PAUSE_REQUESTED').length, 1);

  // 正要切换过去的会话被归档：取消这次切换，而不是稍后自动开声。
  await service.updateRoom('switching-room', { archived: true });
  assert.ok(submitted.some(event => event.type === 'LISTENING_SWITCH_CANCELLED'
    && event.listeningSessionId === 'switching-room'));
  assert.equal(snapshot.pendingSwitch, null);
  registry.close();
  conversationStore.close();
  db.close();
});

test('archiving fails closed when the runtime cannot stop the audible conversation', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const snapshot = {
    activeListeningSessionId: 'playing-room',
    phase: 'playing',
    currentIndex: 0,
    outputGeneration: 1,
    queue: [{ songId: 'track-1', programId: 'program-1' }],
    suspendedSessions: {},
    pendingSwitch: null,
  };
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    loadPersona: () => '',
    // 暂不认识这次暂停：归档必须被拒，不能留下“已归档、仍在放”。
    playbackRuntime: { snapshot: () => snapshot, submit: async () => ({ accepted: false, reason: 'stale media identity' }) },
  }).initialize();
  conversationStore.createRoom({ sessionId: 'playing-room', memberIds: ['lunara'] });
  await assert.rejects(() => service.updateRoom('playing-room', { archived: true }), error => error.statusCode === 409);
  assert.equal(conversationStore.getSession('playing-room').archivedAt, null);
  registry.close();
  conversationStore.close();
  db.close();
});

test('transcript 带 ambient 推荐的实时状态；确认交给推荐模块并原样返回结果', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  let status = 'pending';
  const turnId = presenceTurnId('w');
  const accepts = [];
  const ambientRecommendations = {
    view: id => (id === turnId ? { turnId: id, sessionId: 'room', selectionId: 'selection:x', status, expiresAt: 99 } : null),
    accept: async input => { accepts.push(input); status = 'queued'; return { ok: true, code: 'RECOMMENDATION_QUEUED',
      recommendation: { turnId: input.turnId, sessionId: 'room', selectionId: 'selection:x', provider: 'qq', songId: '42',
        title: '晚风', artist: '陈婧霏', recommendedBy: 'lunara', status, expiresAt: 99 } }; },
  };
  const service = new VirtualPersonService({ registry, conversationStore, ambientRecommendations }).initialize();
  conversationStore.ensureSession('room', 'lunara');
  conversationStore.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'w', kind: 'ambient',
    text: '想放《晚风》给你听。', extra: { musicRecommendation: { selectionId: 'selection:x', provider: 'qq', songId: '42',
      title: '晚风', artist: '陈婧霏', recommendedBy: 'lunara', status: 'pending', expiresAt: 99 } } });
  const [turn] = service.transcript('room');
  assert.deepEqual(turn.musicRecommendation, { provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏',
    recommendedBy: 'lunara', status: 'pending', expiresAt: 99 });
  assert.equal('selectionId' in turn.musicRecommendation, false, '客户端只拿 turnId，不拿内部 selection');
  const result = await service.acceptRecommendation('room', turnId);
  assert.deepEqual(accepts, [{ sessionId: 'room', turnId }]);
  assert.equal(result.code, 'RECOMMENDATION_QUEUED');
  assert.deepEqual(result.recommendation, { turnId, provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏',
    recommendedBy: 'lunara', status: 'queued', expiresAt: 99 }, '确认结果同样不带内部 selection');
  assert.equal(service.transcript('room')[0].musicRecommendation.status, 'queued', '状态以推荐表为准');
  registry.close();
});

test('create 支持零预设直通保存 personaDocument，且提供预设时初始化 defaultTemperament', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const radiohostCalls = [];
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    createRadiohost: async input => {
      radiohostCalls.push(input);
      return {
        id: `host_${radiohostCalls.length}`,
        name: input.displayName,
        voiceProfileId: input.voiceProfileId,
        namespace: `radiohost:host_${radiohostCalls.length}`,
        status: 'inactive',
      };
    },
    loadPersona: () => '不应读取旧磁盘模板',
  }).initialize();

  const customDoc = '## 我是谁\n住在海边的爵士鼓手。\n\n## 我对这个用户的态度\n像合拍的乐队队友。';
  const pureCustom = await service.create({
    displayName: '阿海',
    voiceProfileId: 'vp_1',
    personaDocument: customDoc,
  });
  assert.equal(radiohostCalls[0].personaPresetId, null);
  assert.equal(radiohostCalls[0].personaDocument, customDoc);
  assert.equal(pureCustom.personaDocument, customDoc);
  assert.equal(pureCustom.relationshipStance, '像合拍的乐队队友。');
  assert.equal(pureCustom.metadata?.presence, undefined);

  const withPreset = await service.create({
    displayName: '晴天',
    voiceProfileId: 'vp_1',
    personaPresetId: 'morning_bright',
    personaDocument: '## 我是谁\n早起跑步的电台同伴。\n\n## 我对这个用户的态度\n自在熟稔。',
  });
  assert.equal(withPreset.metadata?.presence?.temperament, 'lively');

  await assert.rejects(
    () => service.create({ displayName: '超长', voiceProfileId: 'vp_1', personaDocument: '甲'.repeat(4001) }),
    /exceeds 4000 characters/,
  );
  await assert.rejects(
    () => service.create({ displayName: '控制符\u0007', voiceProfileId: 'vp_1', personaDocument: '正常' }),
    /control characters/,
  );
  registry.close();
  conversationStore.close();
  db.close();
});

test('expandPersonaDraft 返回可编辑正文，未配模型返 503，生成失败返 502 且绝不静默回退预设', async () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  let askImpl = async () => JSON.stringify({
    personaDocument: '# 阿澈\n\n## 我是谁\n复古唱片店老板。\n\n## 我对这个用户的态度\n像聊得来的熟客。',
  });
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    askText: (prompt, opts) => askImpl(prompt, opts),
  }).initialize();

  await assert.rejects(
    () => service.expandPersonaDraft({ draft: '   ' }),
    err => err.statusCode === 400,
  );

  const ok = await service.expandPersonaDraft({ draft: '开复古唱片店', displayName: '阿澈', presetId: 'music_obsessive' });
  assert.equal(ok.personaDocument, '## 我是谁\n复古唱片店老板。\n\n## 我对这个用户的态度\n像聊得来的熟客。');
  assert.equal(service.list().length, 1, '扩写绝不能副作用创建虚拟人');

  askImpl = async () => { throw new LLMNotConfiguredError('missing api key'); };
  await assert.rejects(
    () => service.expandPersonaDraft({ draft: '开复古唱片店' }),
    err => err.statusCode === 503 && err.code === 'llm_not_configured',
  );

  askImpl = async () => { throw new Error('upstream timeout'); };
  await assert.rejects(
    () => service.expandPersonaDraft({ draft: '开复古唱片店', presetId: 'late_night_companion' }),
    err => err.statusCode === 502 && err.code === 'persona_expand_failed',
  );

  registry.close();
  conversationStore.close();
  db.close();
});

test('updatePerson 同步提取 relationshipStance、回写 persona.md，并支持 lunara 传空串恢复默认人格', () => {
  const db = new Database(':memory:');
  const registry = new VirtualPersonRegistry({ db });
  const conversationStore = new ConversationStore({ db });
  const savedFiles = [];
  const service = new VirtualPersonService({
    registry,
    conversationStore,
    savePersonaFile: (id, content) => savedFiles.push([id, content]),
  }).initialize();

  const child = registry.createRadiohost({ displayName: '小晚', voiceProfileId: 'vp_1' });
  const updatedChild = service.updatePerson(child.id, {
    personaDocument: '## 我是谁\n改写后的自建伙伴。\n\n## 我对这个用户的态度\n坦诚直接的老友。',
  });
  assert.equal(updatedChild.relationshipStance, '坦诚直接的老友。');
  assert.deepEqual(savedFiles, [[
    child.id,
    '## 我是谁\n改写后的自建伙伴。\n\n## 我对这个用户的态度\n坦诚直接的老友。\n',
  ]]);

  const customLunara = service.updatePerson('lunara', {
    personaDocument: '## 我是谁\n用户定制版 Lunara。\n\n## 我对这个用户的态度\n幽默损友。',
  });
  assert.equal(customLunara.metadata.userAuthoredPersona, true);
  assert.equal(customLunara.relationshipStance, '幽默损友。');

  const resetLunara = service.updatePerson('lunara', { personaDocument: '' });
  assert.equal(resetLunara.personaDocument, ROOT_PERSONA);
  assert.equal(resetLunara.relationshipStance, ROOT_RELATIONSHIP);
  assert.equal(resetLunara.metadata.userAuthoredPersona, false);
  assert.equal(savedFiles.length, 1, '根角色 lunara 不写磁盘 radiohost persona.md');

  registry.close();
  conversationStore.close();
  db.close();
});
