// 主动开口进入后续对话：模型看到她说过的话，但看不到调度元数据，也拿不到 presence 工具；
// 用户一开口先通知 presence（中止正在准备的那句）。
// Run: node --test server/presence/presenceHistory.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentLoop } from '../virtual-person/AgentLoop.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { PresentationService } from '../virtual-person/PresentationService.js';
import { PromptAssembler } from '../virtual-person/PromptAssembler.js';
import { VirtualPersonRegistry } from '../virtual-person/VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from '../virtual-person/VirtualPersonRuntime.js';
import { VirtualPersonService } from '../virtual-person/VirtualPersonService.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { registerPresenceTools } from './presenceTools.js';
import { canSpeakAloudFor } from './createPresenceWiring.js';

const LINE = '这首听完，房间好像安静了一点。';

test('presence lines join later model history without scheduling metadata or presence tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-presence-history-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  const conversationStore = new ConversationStore({ dbPath });
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerPresenceTools(tools);
  const calls = [];
  const chat = async (messages, definitions) => {
    calls.push({ messages: structuredClone(messages), tools: (definitions || []).map(tool => tool.function.name) });
    return { message: { role: 'assistant', content: '嗯，是有点。' } };
  };
  const runtime = new VirtualPersonRuntime({
    registry, conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date('2026-10-19T12:00:00.000Z') }),
    agentLoop: new AgentLoop({ chat, toolRegistry: tools }),
    presentationService: new PresentationService(),
    logger: { error() {}, warn() {} },
  }).initialize();
  try {
    conversationStore.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
    conversationStore.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'room/lunara/track_completed/q1',
      kind: 'track_completed', text: LINE, sourceRefs: ['moment'] });
    const heard = [];
    runtime.onUserTurn(sessionId => heard.push(sessionId));
    runtime.onUserTurn(() => { throw new Error('listener failure must not break the turn'); });
    await runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '是啊', speak: false });
    assert.deepEqual(heard, ['room']);
    const [first] = calls;
    const prior = first.messages.find(message => message.role === 'assistant' && message.content === LINE);
    assert.ok(prior, '模型能看到她刚才主动说的那句');
    assert.equal('presence' in prior, false);
    assert.equal('presentation' in prior, false);
    assert.doesNotMatch(JSON.stringify(first.messages), /triggerKey|track_completed/);
    assert.equal(first.tools.some(name => name.includes('presence')), false, '普通聊天拿不到 presence 工具');
    const transcript = new VirtualPersonService({ registry, conversationStore }).transcript('room');
    assert.equal(transcript[0].presentation, 'presence');
    assert.equal('presence' in transcript[0], false, '客户端投影不含调度元数据');
    assert.equal(conversationStore.db.prepare('SELECT COUNT(*) AS n FROM conversation_observations WHERE turn_id LIKE ?').get('presence:%').n, 0);
  } finally {
    runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('voice gate: current audio session, playing or just exhausted, a connected client', () => {
  let snapshot = { activeListeningSessionId: 'room', phase: 'playing' };
  let clients = 1;
  const gate = canSpeakAloudFor({ playbackRuntime: { snapshot: () => snapshot }, clientCount: () => clients });
  assert.equal(gate('room'), true);
  assert.equal(gate('other'), false, '不是当前音频会话');
  snapshot = { ...snapshot, phase: 'paused' };
  assert.equal(gate('room'), false, '用户暂停了');
  snapshot = { ...snapshot, phase: 'exhausted' };
  assert.equal(gate('room'), true);
  clients = 0;
  assert.equal(gate('room'), false, '没有客户端在线');
});
