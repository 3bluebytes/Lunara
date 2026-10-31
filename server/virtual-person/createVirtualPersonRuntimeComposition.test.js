import { MUSIC_CAPABILITY } from '../program/musicSelectionRequest.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSONA_CREATE_CAPABILITY,
  PERSONA_SWITCH_CAPABILITY,
  createVirtualPersonRuntimeComposition,
} from './createVirtualPersonRuntimeComposition.js';

function fixture(execute, personaGateway = null) {
  return createVirtualPersonRuntimeComposition({
    chat: async () => ({ message: { role: 'assistant', content: 'ok' } }),
    synthesize: async () => null,
    publish() {},
    queueService: { snapshot: () => ({}), publishSnapshot() {} },
    playbackRuntime: { snapshot: () => ({ version: 1 }) },
    getMusicService: execute ? () => ({ execute }) : null,
    personaGateway,
    logger: { error() {}, warn() {} },
  });
}

test('typed music tools replace nested radio interpretation and sanitize returned facts', async () => {
  const calls = [];
  const composition = fixture(async (args, context) => { calls.push({ args, context }); return { ok: true, code: 'MUSIC_COMMITTED',
    tracks: [{ songId: '42', title: '歌', artist: '歌手', url: 'https://secret.invalid?token=abc' }] }; });
  const names = composition.toolRegistry.definitions({ capabilities: [MUSIC_CAPABILITY] }).map(item => item.function.name);
  assert.ok(names.includes('select_music')); assert.ok(names.includes('get_user_playlists'));
  assert.ok(!names.includes('radio_request'));
  const outcome = await composition.toolRegistry.execute('select_music', { mode: 'discovery', delivery: 'append' }, { sessionId: 'a' });
  assert.equal(outcome.code, 'MUSIC_COMMITTED'); assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(outcome), /secret.invalid|token=abc/);
});

test('persona creation requires explicit user intent and activation is session-scoped', async () => {
  const calls = [];
  const person = { id: 'radiohost-night', kind: 'radiohost', displayName: '夜航', voiceProfileId: 'warm', status: 'active' };
  const composition = fixture(null, {
    create: async input => { calls.push(['create', input]); return person; },
    list: async () => [{ id: 'lunara', kind: 'root', displayName: 'Lunara', status: 'active' }, person],
    activate: async input => { calls.push(['activate', input]); return { entity: person }; },
    listVoices: async () => [{ id: 'warm', displayName: '温柔女声', description: '柔和' }],
  });
  const rootCapabilities = [PERSONA_CREATE_CAPABILITY, PERSONA_SWITCH_CAPABILITY];
  // 人格内容由调用方 Agent 起草并随工具提交；工具只校验和保存。
  const draft = { character: '克制安静', speechHabit: '短句，语速慢', emotionalExpression: '含蓄',
    musicTaste: '九十年代粤语歌与深夜爵士', interpersonalDistance: '像深夜电台伙伴',
    backgroundStory: '在夜间电台做了很多年，习惯先听完再开口。', boundaries: '不过度打扰，不打探隐私' };

  const refused = await composition.toolRegistry.execute('persona_create_radiohost', {
    displayName: '夜航', voiceProfileId: 'warm', personaDraft: draft,
  }, { correlationId: 'rq-1', userText: '我喜欢克制一点的主播' });
  assert.equal(refused.code, 'EXPLICIT_PERSONA_CREATION_REQUIRED');
  assert.equal(calls.length, 0);

  const incomplete = await composition.toolRegistry.execute('persona_create_radiohost', {
    displayName: '夜航', voiceProfileId: 'warm', personaDraft: { character: '克制安静' },
  }, { correlationId: 'rq-1b', userText: '创建一个叫夜航的伙伴' });
  assert.equal(incomplete.code, 'INVALID_TOOL_ARGUMENTS', '缺维度的人格草稿不能触达生成阶段');
  assert.equal(calls.length, 0);

  const created = await composition.toolRegistry.execute('persona_create_radiohost', {
    displayName: '夜航', voiceProfileId: 'warm', personaDraft: draft,
  }, { correlationId: 'rq-2', userText: '创建一个叫夜航的伙伴' });
  assert.equal(created.code, 'RADIOHOST_PERSONA_CREATED');
  assert.equal(calls[0][0], 'create');
  assert.deepEqual(calls[0][1].personaDraft, draft, '人格草稿原样交给创建链路，不由工具重写');

  const activated = await composition.toolRegistry.execute('persona_activate', {
    virtualPersonId: 'radiohost-night',
  }, { correlationId: 'rq-3', sessionId: 'session-a', userText: '切换到夜航来聊' });
  assert.equal(activated.code, 'PERSONA_ACTIVATED');
  assert.deepEqual(calls[1], ['activate', { id: 'radiohost-night', sessionId: 'session-a' }]);
  assert.deepEqual(
    composition.toolRegistry.definitions({ capabilities: rootCapabilities }).map(item => item.function.name),
    ['persona_create_radiohost', 'persona_list', 'persona_list_voices', 'persona_activate'],
  );
  const voices = await composition.toolRegistry.execute('persona_list_voices', {}, {
    correlationId: 'rq-4', capabilities: rootCapabilities,
  });
  assert.equal(voices.facts.voices[0].id, 'warm');
  assert.equal(voices.facts.voices[0].name, '温柔女声');

  const activationRefused = await composition.toolRegistry.execute('persona_activate', {
    virtualPersonId: 'radiohost-night',
  }, { correlationId: 'rq-5', sessionId: 'session-a', userText: '我觉得夜航这个名字很好听' });
  assert.equal(activationRefused.code, 'EXPLICIT_PERSONA_ACTIVATION_REQUIRED');
  // 否定的主持/接手请求不是确认（add-group-companion-dialogue 3.3）。
  for (const userText of ['不要让夜航主持', '别叫夜航来接', '以后不想让夜航主持了']) {
    const refused = await composition.toolRegistry.execute('persona_activate', { virtualPersonId: 'radiohost-night' },
      { correlationId: 'rq-6', sessionId: 'session-a', userText });
    assert.equal(refused.code, 'EXPLICIT_PERSONA_ACTIVATION_REQUIRED', userText);
  }
  const hosted = await composition.toolRegistry.execute('persona_activate', { virtualPersonId: 'radiohost-night' },
    { correlationId: 'rq-7', sessionId: 'session-a', userText: '以后让夜航主持吧' });
  assert.equal(hosted.code, 'PERSONA_ACTIVATED');
  assert.equal(calls.filter(call => call[0] === 'activate').length, 2);
});

test('invalid structured tool arguments never reach execution', async () => {
  let called = false;
  const composition = fixture(() => { called = true; });
  const result = await composition.toolRegistry.execute('select_music', { mode: 'discovery', delivery: 'append', count: 'three' });
  assert.equal(result.code, 'INVALID_TOOL_ARGUMENTS'); assert.equal(called, false);
});

test('context budget defaults match modern model windows and stay env-overridable', () => {
  const previousBytes = process.env.CONVERSATION_CONTEXT_MAX_BYTES;
  const previousMessages = process.env.CONVERSATION_CONTEXT_MAX_MESSAGES;
  delete process.env.CONVERSATION_CONTEXT_MAX_BYTES;
  delete process.env.CONVERSATION_CONTEXT_MAX_MESSAGES;
  try {
    const composition = fixture(null);
    assert.equal(composition.contextBudgeter.maxBytes, 262_144);
    assert.equal(composition.contextBudgeter.maxMessages, 128);
  } finally {
    if (previousBytes !== undefined) process.env.CONVERSATION_CONTEXT_MAX_BYTES = previousBytes;
    if (previousMessages !== undefined) process.env.CONVERSATION_CONTEXT_MAX_MESSAGES = previousMessages;
  }
});

test('ambient turn 的 presence_respond 已注册，但普通回合的能力里没有 presence.ambient', async () => {
  const composition = fixture(async () => ({ ok: true }));
  assert.deepEqual(composition.toolRegistry.definitions({ capabilities: ['presence.ambient'] }).map(item => item.function.name),
    ['note_thought', 'schedule_followup', 'presence_respond']);
  // 心里话只在有可见条目时由 runtime 临时加上 presence.notes；普通能力集里不常驻。
  assert.deepEqual(composition.toolRegistry.definitions({ capabilities: ['presence.notes'] }).map(item => item.function.name),
    ['settle_thought']);
  assert.equal(typeof composition.runtime.handleAmbientTurn, 'function');
  const entity = { id: 'lunara', kind: 'root' };
  const ordinary = composition.runtime.capabilityResolver(entity, { musicOwnerId: entity.id });
  assert.ok(!ordinary.includes('presence.ambient'));
  assert.ok(!ordinary.includes('presence.notes'));
  assert.ok(!composition.toolRegistry.definitions({ capabilities: ordinary }).some(item => item.function.name === 'presence_respond'));
});
