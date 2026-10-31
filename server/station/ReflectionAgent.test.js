// ReflectionAgent.test.js
//
// 覆盖 agent-reflection spec 关键要求：
//   - initialize 注册订阅
//   - REFLECTION_AGENT_DISABLED 跳过订阅
//   - 短窗触发条件（阈值 + 60s rate limit）
//   - LLM 失败不抛 + 计数+1
//   - insight 落到伙伴 namespace 且 confidence 截顶
//   - REFLECTION_INSIGHT_PUBLISHED 事件被发出且不带 content body
//   - shutdown 清空订阅

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ReflectionAgent } from './ReflectionAgent.js';
import { createBus } from './communication/AgentMessageBus.js';
import { EventType, createEvent, radiohostAgentId, StationAgentId } from './communication/messages.js';
import { MemoryService } from '../memory/MemoryService.js';
import { MemoryType } from '../memory/types.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-reflection-agent-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// 简易 station mock
let databaseNumber = 0;
function makeMockStation(radiohostId = 'host-a', hostName = 'TestHost') {
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `state-${++databaseNumber}.db`);
  const memCache = new Map();
  return {
    radiohostId,
    hostName,
    async getRadioHostMemoryService(id) {
      if (id !== radiohostId) return null;
      if (!memCache.has(id)) {
        const ns = `radiohost:${id}`;
        const svc = new MemoryService(ns);
        await svc.initialize();
        // 清空旧的
        for (const m of svc.searchMemory(undefined, { limit: 500 })) svc.deleteMemory(m.id);
        memCache.set(id, svc);
      }
      return memCache.get(id);
    },
    getRadiohostMetadata(id) { return id === radiohostId ? { id: radiohostId, name: hostName } : null; },
    listRadioHosts() { return [{ id: radiohostId, name: hostName }]; },
    getActiveRadiohost() { return { id: radiohostId, name: hostName }; },
  };
}

// 桩 LLM —— askText 按队列返回
function makeStubLLM(responses) {
  const queue = [...responses];
  return {
    askText: async () => {
      if (queue.length === 0) throw new Error('llm stub queue empty');
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return next;
    },
    extractJson(text) {
      const m = String(text || '').match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { return JSON.parse(m[0]); } catch { return null; }
    },
  };
}

async function testSubscriptionWiring() {
  console.log('\n--- initialize 注册订阅 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation();
  const refl = new ReflectionAgent({ bus, station, llm: makeStubLLM([]) });
  await refl.initialize();

  // 发一个 feedback 看 buffer 有没有变化
  bus.publishEvent(createEvent({
    type: EventType.USER_FEEDBACK_OBSERVED,
    sourceAgentId: radiohostAgentId('host-a'),
    payload: { radiohostId: 'host-a', userInput: 'hi', mood: 'calm', songs: [] },
  }));
  await bus.flush();
  const snap = refl.getStatusSnapshot();
  assert(snap.pendingBufferCounts['host-a'] === 1, 'USER_FEEDBACK_OBSERVED 入 buffer');
  refl.shutdown();
}

async function testDisabledSkipsSubscriptions() {
  console.log('\n--- disabled 跳过订阅 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation();
  const refl = new ReflectionAgent({ bus, station, llm: makeStubLLM([]), disabled: true });
  await refl.initialize();

  bus.publishEvent(createEvent({
    type: EventType.USER_FEEDBACK_OBSERVED,
    sourceAgentId: radiohostAgentId('host-a'),
    payload: { radiohostId: 'host-a', userInput: 'hi' },
  }));
  await bus.flush();
  const snap = refl.getStatusSnapshot();
  assert(snap.enabled === false, 'enabled=false');
  assert(!snap.pendingBufferCounts['host-a'], 'disabled 时事件被 ignore');
  refl.shutdown();
}

async function testCommittedTurnReflectionStaysPrivate() {
  console.log('\n--- 已提交 turn 异步进入说话者私有反思 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-a');
  let prompt = '';
  const llm = {
    askText: async value => {
      prompt = value;
      return JSON.stringify({ observation: '回复承接了用户上一句。', evidence: ['最终回复'], tags: ['dialogue:continuity'], confidence: 0.3 });
    },
    extractJson: text => JSON.parse(text),
  };
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 1 });
  await refl.initialize();
  const ledger = new ConversationStore({ db: refl.store.db }).initialize();
  ledger.beginRequest({ sessionId: 's', requestId: 'r', virtualPersonId: 'host-a', userText: '今天很累，想安静听歌。' });
  ledger.completeRequest({ requestId: 'r', virtualPersonId: 'host-a', message: { content: '我记得你刚才说今天很累。' } });
  bus.publishEvent(createEvent({
    type: EventType.TURN_COMMITTED,
    sourceAgentId: 'virtual-person:host-a',
    payload: {
      virtualPersonId: 'host-a', sessionId: 's', requestId: 'r',
      displayText: 'UNTRUSTED_EVENT_TEXT', outcomeCodes: [], committedAt: Date.now(),
      internalError: 'SECRET_STACK',
    },
  }));
  await bus.flush();
  await new Promise(r => setTimeout(r, 100));

  assert(prompt.includes('我记得你刚才说今天很累'), '反思只看到已提交的最终文本');
  assert(prompt.includes('今天很累，想安静听歌'), '反思读取匹配的用户原话');
  assert(!prompt.includes('UNTRUSTED_EVENT_TEXT'), '事件文本不能覆盖账本');
  assert(!prompt.includes('SECRET_STACK'), '反思输入不读取内部错误字段');
  const mem = await station.getRadioHostMemoryService('host-a');
  const insights = mem.searchMemory(undefined, { namespace: 'radiohost:host-a', tags: 'reflection-insight', limit: 5 });
  assert(insights.length === 1, '反思结果只写入当前 child 的私有 namespace');
  refl.shutdown();
}

async function testShortTriggerAndPersist() {
  console.log('\n--- 短窗触发 + insight 落库 + 事件发出 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation();
  // 桩 LLM 返回合法 JSON
  const llmResp = JSON.stringify({
    observation: '用户连续 skip 了 3 首 upbeat，可能现在想听安静一点的',
    evidence: ['skip-1', 'skip-2', 'skip-3'],
    tags: ['signal:skip', 'mood:calm-preferred'],
    confidence: 0.9, // 故意写超过 0.4，看截顶
  });
  const llm = makeStubLLM([llmResp]);

  const events = [];
  bus.subscribe(EventType.REFLECTION_INSIGHT_PUBLISHED, e => events.push(e));

  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 3 });
  await refl.initialize();

  // 发 3 个 feedback 触发短窗
  for (let i = 0; i < 3; i++) {
    bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-a'),
      payload: { radiohostId: 'host-a', userInput: `msg${i}`, mood: 'unknown', songs: ['A — B'] },
    }));
    bus.publishEvent(createEvent({
      type: EventType.PLAY_OUTCOME_RECORDED,
      sourceAgentId: StationAgentId,
      payload: { radiohostId: 'host-a', songId: `s${i}`, songQuery: `A${i} — B${i}`, outcome: 'skipped', playedSeconds: 5, recordedAt: Date.now() },
    }));
  }
  await bus.flush();
  // 给异步 _runReflection 一点时间
  await new Promise(r => setTimeout(r, 200));

  const mem = await station.getRadioHostMemoryService('host-a');
  const insights = mem.searchMemory(undefined, {
    namespace: mem.namespace,
    type: MemoryType.SEMANTIC,
    tags: 'reflection-insight',
    limit: 10,
  });
  assert(insights.length === 1, `1 条 insight 落库（实际 ${insights.length}）`);
  if (insights.length > 0) {
    assert(insights[0].confidence <= 0.4 + 1e-9, `confidence 被截顶 ≤ 0.4 (实际 ${insights[0].confidence})`);
    assert(String(insights[0].tags).includes('reflection-short'), 'tags 含 reflection-short');
    assert(insights[0].content.includes('skip'), 'content 来自 LLM observation');
  }

  assert(events.length === 1, `1 个 REFLECTION_INSIGHT_PUBLISHED 事件（实际 ${events.length}）`);
  if (events.length > 0) {
    assert(!('content' in events[0].payload), '事件不带 content body');
    assert(typeof events[0].payload.memoryId === 'number', '事件含 memoryId');
    assert(events[0].payload.window === 'short', 'window=short');
  }

  refl.shutdown();
}

async function testLLMFailureDoesNotThrow() {
  console.log('\n--- LLM 失败不抛 + 计数+1 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-b');
  // LLM 返回乱七八糟的字符串
  const llm = makeStubLLM(['这不是合法 JSON，里面全是叙述']);
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2 });
  await refl.initialize();

  for (let i = 0; i < 2; i++) {
    bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-b'),
      payload: { radiohostId: 'host-b', userInput: `m${i}` },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 200));

  const mem = await station.getRadioHostMemoryService('host-b');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 5 });
  assert(insights.length === 0, '0 条 insight（drop）');
  assert(refl.reflectionFailures === 1, `reflectionFailures = 1 (实际 ${refl.reflectionFailures})`);
  refl.shutdown();
}

async function testRateLimitSuppresses() {
  console.log('\n--- 60s rate-limit 抑制 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-c');
  const llmResp = JSON.stringify({
    observation: 'ok', evidence: [], tags: [], confidence: 0.3,
  });
  const llm = makeStubLLM([llmResp, llmResp]); // 两条响应备用，但只应用到 1 条
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2 });
  await refl.initialize();

  // 第一波：触发反思
  for (let i = 0; i < 2; i++) {
    bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-c'),
      payload: { radiohostId: 'host-c', userInput: `a${i}` },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));

  // 第二波：立刻又满足阈值（应该被 rate-limit 抑制，不写新 insight）
  for (let i = 0; i < 2; i++) {
    bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-c'),
      payload: { radiohostId: 'host-c', userInput: `b${i}` },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));

  const mem = await station.getRadioHostMemoryService('host-c');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 5 });
  assert(insights.length === 1, `rate-limit 后只有 1 条 insight（实际 ${insights.length}）`);
  refl.shutdown();
}

async function testShutdownClearsSubscriptions() {
  console.log('\n--- shutdown 清空订阅 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation();
  const refl = new ReflectionAgent({ bus, station, llm: makeStubLLM([]) });
  await refl.initialize();
  refl.shutdown();

  bus.publishEvent(createEvent({
    type: EventType.USER_FEEDBACK_OBSERVED,
    sourceAgentId: radiohostAgentId('host-a'),
    payload: { radiohostId: 'host-a', userInput: 'after-shutdown' },
  }));
  await bus.flush();
  const snap = refl.getStatusSnapshot();
  // buffer 在 shutdown 时已清，shutdown 之后事件不再入 buffer
  assert(!snap.pendingBufferCounts['host-a'], 'shutdown 后事件不再处理');
}

async function testStatsOnlyBatchSkipsLLM() {
  console.log('\n--- 纯播放批次降级为 stats_only，不烧 LLM ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-stats');
  let llmCalls = 0;
  const llm = { askText: async () => { llmCalls++; return '{}'; }, extractJson: text => JSON.parse(text) };
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 3 });
  await refl.initialize();

  for (let i = 0; i < 3; i++) {
    bus.publishEvent(createEvent({
      type: EventType.PLAY_OUTCOME_RECORDED,
      sourceAgentId: StationAgentId,
      payload: { radiohostId: 'host-stats', observationKey: `playback:p${i}:c1`, songId: `song-${i}`,
        provider: 'qq', songQuery: `歌${i} — 歌手${i}`, outcome: i < 2 ? 'skipped' : 'completed',
        playedSeconds: null, recordedAt: Date.now() },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));

  const mem = await station.getRadioHostMemoryService('host-stats');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 5 });
  assert(llmCalls === 0, `纯播放批次零 LLM 调用（实际 ${llmCalls}）`);
  assert(insights.length === 0, '不产出洞察');
  assert(refl.store.attempt('host-stats').status === 'stats_only', 'attempt 状态 stats_only');
  assert(refl.store.attempt('host-stats').failures === 0, '不计失败');
  const stats = refl.store.songStats('host-stats');
  assert(stats.length === 3, `统计账本记录 3 首（实际 ${stats.length}）`);
  assert(stats.every(row => row.count === 1), '每首计数为 1');

  // 同一 eventKey 重放不得重复计数
  bus.publishEvent(createEvent({
    type: EventType.PLAY_OUTCOME_RECORDED,
    sourceAgentId: StationAgentId,
    payload: { radiohostId: 'host-stats', observationKey: 'playback:p0:c1', songId: 'song-0',
      provider: 'qq', songQuery: '歌0 — 歌手0', outcome: 'skipped', playedSeconds: null, recordedAt: Date.now() },
  }));
  await bus.flush();
  await new Promise(r => setTimeout(r, 50));
  const statsAfterReplay = refl.store.songStats('host-stats');
  assert(statsAfterReplay.find(row => row.songId === 'song-0').count === 1, '重放同一事件不重复计数');
  refl.shutdown();
}

async function testTechnicalFailuresNeverBecomeTaste() {
  console.log('\n--- 技术失败只入统计账本，不形成任何喜恶判断 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-fail');
  let llmCalls = 0;
  const llm = { askText: async () => { llmCalls++; return '{}'; }, extractJson: text => JSON.parse(text) };
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 3 });
  await refl.initialize();

  for (let i = 0; i < 3; i++) {
    bus.publishEvent(createEvent({
      type: EventType.PLAY_OUTCOME_RECORDED,
      sourceAgentId: StationAgentId,
      payload: { radiohostId: 'host-fail', observationKey: `playback:f${i}:c1`, songId: `fail-${i}`,
        provider: i === 0 ? 'qq' : 'ncm', songQuery: `故障歌${i} — 歌手`, outcome: 'technical_failure',
        playedSeconds: null, recordedAt: Date.now() },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 200));

  const mem = await station.getRadioHostMemoryService('host-fail');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 5 });
  assert(llmCalls === 0, `技术失败零模型调用（实际 ${llmCalls}）`);
  assert(insights.length === 0, '技术失败不产出「不喜欢」类洞察');
  const status = refl.store.attempt('host-fail').status;
  assert(status === 'no_taste_signal' || status === 'stats_only', `批次如实标记为无口味信号（实际 ${status}）`);
  assert(refl.store.songStats('host-fail').length === 3, '仍然入账，供长期统计但不作为偏好证据');
  refl.shutdown();
}

async function testNoSignalExit() {
  console.log('\n--- LLM no_signal 出口按成功处理 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-quiet');
  const llm = makeStubLLM([JSON.stringify({ no_signal: true })]);
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2 });
  await refl.initialize();

  for (let i = 0; i < 2; i++) {
    bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-quiet'),
      payload: { radiohostId: 'host-quiet', userInput: `寒暄${i}` },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));

  const mem = await station.getRadioHostMemoryService('host-quiet');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 5 });
  assert(insights.length === 0, 'no_signal 不写记忆');
  assert(refl.reflectionFailures === 0, 'no_signal 不计失败');
  assert(refl.store.attempt('host-quiet').status === 'no_signal', 'attempt 状态 no_signal');
  refl.shutdown();
}

async function testClaimMergeAccumulates() {
  console.log('\n--- 同 claim 同极性合并累积，不新增行 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-merge');
  const llm = makeStubLLM([
    JSON.stringify({ observation: '用户不喜欢每次推歌都从同样的歌开始', evidence: [], tags: ['signal:repeat'],
      confidence: 0.3, claim: { key: 'recommendation.routine', polarity: 'negative', text: '推歌别套路化', scope: 'relationship', explicitSharedQuote: '' } }),
    JSON.stringify({ observation: '用户反复强调推歌别形成固定套路', evidence: [], tags: ['signal:repeat'],
      confidence: 0.2, claim: { key: 'recommendation.routine', polarity: 'negative', text: '推歌别套路化', scope: 'relationship', explicitSharedQuote: '' } }),
  ]);
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2, rateLimitMs: 10 });
  await refl.initialize();

  const send = texts => { let i = 0;
    for (const t of texts) bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-merge'),
      payload: { radiohostId: 'host-merge', userInput: t + (i++) },
    }));
  };
  send(['别总推那几首', '开场别固定']);
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));
  send(['真的别再重复了', '换点新歌推']);
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));

  const mem = await station.getRadioHostMemoryService('host-merge');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 10 });
  assert(insights.length === 1, `两次反思只留 1 条（实际 ${insights.length}）`);
  const row = insights[0];
  if (row) {
    assert(String(row.tags).includes('claim:recommendation.routine'), 'tags 带 claim 键');
    assert(row.confidence > 0.3 && row.confidence <= 0.4 + 1e-9, `置信度有界上调（实际 ${row.confidence}）`);
    const evidence = JSON.parse(row.evidence || '{}');
    assert(evidence.occurrences === 2, `证据次数 2（实际 ${evidence.occurrences}）`);
    assert((evidence.eventKeys || []).length === 4, `eventKeys 累积 4 条（实际 ${(evidence.eventKeys || []).length}）`);
  }
  refl.shutdown();
}

async function testOppositePolarityStaysSeparate() {
  console.log('\n--- 同 claim 对立极性保留两行 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-conflict');
  const llm = makeStubLLM([
    JSON.stringify({ observation: '用户说最近想多听 R&B', evidence: [], tags: [],
      confidence: 0.3, claim: { key: 'music.genre.rnb', polarity: 'positive', text: '偏爱 R&B', scope: 'relationship', explicitSharedQuote: '' } }),
    JSON.stringify({ observation: '用户表示这几天不想听 R&B 了', evidence: [], tags: [],
      confidence: 0.3, claim: { key: 'music.genre.rnb', polarity: 'negative', text: '暂时回避 R&B', scope: 'temporary', explicitSharedQuote: '' } }),
  ]);
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2, rateLimitMs: 10 });
  await refl.initialize();
  for (const [i, t] of ['多来点律动', '来点 R&B'].entries()) {
    bus.publishEvent(createEvent({ type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-conflict'), payload: { radiohostId: 'host-conflict', userInput: t + i } }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));
  for (const [i, t] of ['这两天别放 R&B', '换别的吧'].entries()) {
    bus.publishEvent(createEvent({ type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-conflict'), payload: { radiohostId: 'host-conflict', userInput: t + i } }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 150));

  const mem = await station.getRadioHostMemoryService('host-conflict');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 10 });
  assert(insights.length === 2, `对立极性保留 2 条（实际 ${insights.length}）`);
  refl.shutdown();
}

async function testVerbatimKeylessMerge() {
  console.log('\n--- 无 claim 逐字级重复合并 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-verbatim');
  const same = JSON.stringify({ observation: '用户提到初中常听回音哥，现在更偏爱 R&B。', evidence: [], tags: [], confidence: 0.3, claim: null });
  const llm = makeStubLLM([same, same]);
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2, rateLimitMs: 10 });
  await refl.initialize();
  for (const [round, texts] of [['a', ['回音哥', '芊芊']], ['b', ['回音哥又提', '现在爱 R&B']]].entries()) {
    for (const [i, t] of texts.entries()) {
      bus.publishEvent(createEvent({ type: EventType.USER_FEEDBACK_OBSERVED,
        sourceAgentId: radiohostAgentId('host-verbatim'), payload: { radiohostId: 'host-verbatim', userInput: t + round + i } }));
    }
    await bus.flush();
    await new Promise(r => setTimeout(r, 150));
  }
  const mem = await station.getRadioHostMemoryService('host-verbatim');
  const insights = mem.searchMemory(undefined, { tags: 'reflection-insight', limit: 10 });
  assert(insights.length === 1, `逐字重复合并为 1 条（实际 ${insights.length}）`);
  refl.shutdown();
}

async function runTests() {
  console.log('\n🧪 ReflectionAgent tests\n');
  try {
    await testSubscriptionWiring();
    await testDisabledSkipsSubscriptions();
    await testCommittedTurnReflectionStaysPrivate();
    await testShortTriggerAndPersist();
    await testLLMFailureDoesNotThrow();
    await testRateLimitSuppresses();
    await testShutdownClearsSubscriptions();
    await testStatsOnlyBatchSkipsLLM();
    await testTechnicalFailuresNeverBecomeTaste();
    await testNoSignalExit();
    await testClaimMergeAccumulates();
    await testOppositePolarityStaysSeparate();
    await testVerbatimKeylessMerge();
    await testBudgetRejectionDefersWithoutConsumingRetries();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

async function testBudgetRejectionDefersWithoutConsumingRetries() {
  console.log('\n--- 日内预算拒绝：不消耗重试次数，推迟到下一个自然日 ---');
  const bus = createBus({ log: false });
  const station = makeMockStation('host-budget');
  const llm = {
    askText: async () => { const error = new Error('LLM daily token budget exhausted'); error.code = 'LLM_BUDGET_EXHAUSTED'; throw error; },
    extractJson: text => JSON.parse(text),
  };
  const refl = new ReflectionAgent({ bus, station, llm, shortWindow: 2 });
  await refl.initialize();

  for (let i = 0; i < 2; i++) {
    bus.publishEvent(createEvent({
      type: EventType.USER_FEEDBACK_OBSERVED,
      sourceAgentId: radiohostAgentId('host-budget'),
      payload: { radiohostId: 'host-budget', userInput: `m${i}` },
    }));
  }
  await bus.flush();
  await new Promise(r => setTimeout(r, 200));

  const attempt = refl.store.attempt('host-budget');
  assert(attempt.status === 'budget_deferred', `状态 budget_deferred（实际 ${attempt.status}）`);
  assert(attempt.failures === 0, `不消耗重试次数（实际 ${attempt.failures}）`);
  assert(refl.reflectionFailures === 0, `不算模型失败（实际 ${refl.reflectionFailures}）`);
  const nextDay = new Date(); nextDay.setHours(24, 0, 0, 0);
  assert(Math.abs(attempt.next_attempt_at - nextDay.getTime()) < 1000, '推迟到下一个自然日');
  assert(attempt.next_attempt_at > Date.now(), '今天不再重试');
  refl.shutdown();
}
