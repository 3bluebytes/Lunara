// personMemory.selection.test.js — 记忆小节先过滤再截取；撤回只撤该撤的（harden-memory-selection-and-forget）。
//
// Run: node --test server/virtual-person/personMemory.selection.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryService } from '../memory/MemoryService.js';
import { isMemoryRevoked, revokeMemory } from '../memory/memoryProvenance.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { registerPersonMemoryTools, retrievePersonMemories } from './personMemory.js';

async function withTools(run, { conversationStore = { revokeObservation() {} } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-memory-selection-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const registry = new VirtualPersonRegistry({ dbPath: join(dir, 'state.db') }).initialize();
  registry.createRadiohost({ id: 'a', displayName: 'A', voiceProfileId: 'voice-a' });
  registry.createRadiohost({ id: 'b', displayName: 'B', voiceProfileId: 'voice-b' });
  const person = registry.get('a');
  const memory = new MemoryService(person.memoryNamespace);
  await memory.initialize();
  const tools = {};
  registerPersonMemoryTools({ register: (name, def) => { tools[name] = def; } },
    { getMemoryService: () => memory, conversationStore, registry });
  let turn = 0;
  const ctx = (userText, userTurnId = `turn-${++turn}`) => ({ virtualPersonId: 'a', sessionId: 'room', userText, userTurnId });
  const retrieve = (extra = {}) => retrievePersonMemories(memory, null, { namespace: person.memoryNamespace, virtualPersonId: 'a',
    sessionId: 'room', query: '周末去哪', ...extra });
  try {
    await run({ memory, tools, ctx, retrieve, person });
  } finally {
    await memory.shutdown();
    registry.close();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const rel = rows => rows.filter(row => row.kind === 'relationship').map(row => row.content).sort();

test('群聊里私密洞察也照常注入：和公开洞察同一套按分数排、同一个名额', async () => {
  await withTools(async ({ memory, retrieve, person }) => {
    const now = Date.now();
    const add = (content, policy, key, confidence) => memory.addMemory({ namespace: person.memoryNamespace, type: 'semantic',
      source: 'agent_reflection', content, confidence, tags: `reflection-insight,reflection-short,claim:${key}`,
      expiresAt: now + 86_400_000, evidence: JSON.stringify({ claim: { key, polarity: 'positive' }, policy }) });
    add('私密1', { disclosure: 'private' }, 'p.one', 0.4);
    add('私密2', { disclosure: 'private' }, 'p.two', 0.4);
    add('私密3', { disclosure: 'private' }, 'p.three', 0.4);
    add('公开：最近常听后摇', { disclosure: 'normal' }, 'music.genre.postrock', 0.3);
    const group = retrieve({ isGroup: true, memberIds: ['a', 'b'], sessionId: 'group' })
      .filter(row => row.kind === 'reflection').map(row => row.content);
    assert.deepEqual([...group].sort(), ['私密1', '私密2', '私密3'], '分数更高的私密洞察占满名额，不再为群聊让位');
  });
});

test('相关长期记忆先过滤再截取：限定在别的聊天的事实不挤掉本聊天的临时要求', async () => {
  await withTools(async ({ memory, tools, ctx, retrieve, person }) => {
    const temp = tools.remember_person_fact.handler({ content: '今天这个聊天只想听爵士钢琴', sourceQuote: '这次只想听爵士钢琴' },
      ctx('这次只想听爵士钢琴'));
    assert.equal(temp.ok, true);
    // 临时事实也存成 semantic：期限靠 expiresAt 与 policy，关系记忆、串词与选歌按同一套适用面读到它。
    const saved = memory.store.getById(temp.facts.memoryId);
    assert.equal(saved.type, 'semantic');
    assert.ok(saved.expiresAt > Date.now());
    // 8 条限定在别的聊天的事实，与本轮原话高度相关
    for (let i = 0; i < 8; i += 1) {
      memory.addMemory({ namespace: person.memoryNamespace, type: 'semantic', source: 'user_explicit_feedback',
        content: `别处的事${i}：再来点别的`, tags: ['person-relationship'],
        evidence: JSON.stringify({ writeKey: `k${i}`, sourceTurnId: `t${i}`,
          policy: { disclosure: 'normal', onlyConversationId: 'elsewhere', until: Date.now() + 3_600_000 } }) });
    }
    const rows = retrieve({ query: '再来点爵士钢琴', isGroup: true, memberIds: ['a', 'b'] });
    assert.ok(rows.some(row => row.id === temp.facts.memoryId), '本聊天的临时要求应仍能进上下文');
  });
});

test('来源已撤回的口味图式不会从相关长期记忆绕回来', async () => {
  await withTools(async ({ memory, retrieve, person }) => {
    const contributor = memory.addMemory({ namespace: person.memoryNamespace, type: 'semantic', source: 'user_explicit_feedback',
      content: '喜欢爵士钢琴', tags: ['person-relationship'], evidence: '{}' });
    memory.addMemory({ namespace: person.memoryNamespace, type: 'semantic', content: '长期偏爱深夜的爵士钢琴', tags: 'taste-schema',
      importance: 8, evidence: JSON.stringify({ schema: 2, revision: 1, scope: 'widest-audience', contributorIds: [contributor.id] }) });
    revokeMemory(memory.store, contributor.id);
    const rows = retrieve({ query: '来点深夜的爵士钢琴' });
    assert.ok(!rows.some(row => /长期偏爱深夜的爵士钢琴/u.test(row.content)), JSON.stringify(rows.map(row => [row.kind, row.content])));
  });
});

test('忘掉同一句话里记下的一条事实，另一条照常注入', async () => {
  await withTools(async ({ tools, ctx, retrieve }) => {
    const text = '记住：我养了一只猫叫团子，另外我在杭州工作';
    const c = ctx(text, 'turn-same');
    const cat = tools.remember_person_fact.handler({ content: '用户养了一只猫叫团子', sourceQuote: '我养了一只猫叫团子' }, c);
    const job = tools.remember_person_fact.handler({ content: '用户在杭州工作', sourceQuote: '我在杭州工作' }, c);
    assert.equal(cat.ok && job.ok, true);
    assert.deepEqual(rel(retrieve()), ['用户养了一只猫叫团子', '用户在杭州工作'].sort());
    const forgot = tools.forget_person_memory.handler({ memoryIds: [cat.facts.memoryId] }, ctx('忘掉猫的事'));
    assert.equal(forgot.ok, true);
    assert.deepEqual(rel(retrieve()), ['用户在杭州工作'], '只撤回了猫，工作这条不应一起消失');
  });
});

test('取代链 A←B←C：撤回中间的 B，A 不复活与 C 并存；再撤回 C，A 恢复', async () => {
  await withTools(async ({ memory, tools, ctx, retrieve }) => {
    const a = tools.remember_person_fact.handler({ content: '用户住在上海', sourceQuote: '我住在上海' }, ctx('我住在上海'));
    const b = tools.remember_person_fact.handler({ content: '用户搬到杭州', sourceQuote: '我搬到杭州',
      replacesMemoryIds: [a.facts.memoryId] }, ctx('我搬到杭州'));
    const c = tools.remember_person_fact.handler({ content: '用户搬到北京', sourceQuote: '我搬到北京',
      replacesMemoryIds: [b.facts.memoryId] }, ctx('我搬到北京'));
    assert.equal(c.ok, true, c.modelContext);
    assert.deepEqual(rel(retrieve()), ['用户搬到北京']);
    revokeMemory(memory.store, b.facts.memoryId); // 例如删掉说"搬到杭州"的聊天
    assert.deepEqual(rel(retrieve()), ['用户搬到北京'], '现状仍是北京，上海不应复活');
    revokeMemory(memory.store, c.facts.memoryId);
    assert.deepEqual(rel(retrieve()), ['用户住在上海'], '链上后来的都撤回了，最早的恢复成现状');
  });
});

test('用户要求忘掉共享事实时能撤回，之后不再注入', async () => {
  await withTools(async ({ tools, ctx, retrieve }) => {
    const text = '我喜欢后摇，所有伙伴都可以知道';
    const shared = tools.remember_shared_fact.handler({ content: '用户喜欢后摇', sourceQuote: '所有伙伴都可以知道' }, ctx(text));
    assert.equal(shared.ok, true, shared.modelContext);
    assert.ok(retrieve({ query: '我喜欢后摇' }).some(row => /后摇/u.test(row.content)), '撤回前共享事实在上下文里');
    const forgot = tools.forget_person_memory.handler({ memoryIds: [shared.facts.memoryId] }, ctx('忘掉我喜欢后摇这件事'));
    assert.equal(forgot.ok, true, forgot.code);
    assert.ok(!retrieve({ query: '我喜欢后摇' }).some(row => /后摇/u.test(row.content)), '撤回后不再出现在任何小节');
  });
});

test('更新的反思与被取代的行再多，也不会把最早的显式事实挤出候选', async () => {
  const { relationshipFacts } = await import('./personMemory.js');
  await withTools(async ({ memory, person }) => {
    const ns = person.memoryNamespace;
    const base = Date.now() - 10 * 86_400_000;
    const insert = (content, source, tags, at, extra = {}) => memory.store.insert({ createdAt: at, updatedAt: at, lastAccessedAt: at,
      namespace: ns, type: 'semantic', source, content, summary: '', tags, confidence: 0.7, importance: 5, evidence: '{}', ...extra });
    memory.store.db.transaction(() => {
      insert('用户最早说过：小时候学过大提琴', 'user_explicit_feedback', 'person-relationship', base);
      for (let i = 0; i < 1100; i += 1) insert(`用户的第 ${i} 条事实`, 'user_explicit_feedback', 'person-relationship', base + 1000 + i);
      for (let i = 0; i < 1200; i += 1) insert(`反思 ${i}`, 'agent_reflection', 'reflection-insight', base + 5_000_000 + i,
        { expiresAt: Date.now() + 86_400_000 });
    })();
    const { kept, overflow } = relationshipFacts(memory, { namespace: ns });
    assert.equal(kept.length + overflow.length, 1101);
    assert.ok(overflow.some(row => row.content.includes('大提琴')));
  });
});

test('忘掉一条显式事实时，同一句话学到的近况一起不再注入', async () => {
  await withTools(async ({ memory, person, retrieve }) => {
    const ns = person.memoryNamespace;
    const fact = memory.addMemory({ namespace: ns, type: 'semantic', source: 'user_explicit_feedback', content: '用户下周三去北京面试',
      tags: ['person-relationship'], evidence: JSON.stringify({ schema: 2, writeKey: 'wk-fact', sourceTurnId: 'T1', policy: { disclosure: 'normal' } }) });
    memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: '对方下周三要去北京面试',
      tags: 'reflection-life,life-upcoming', expiresAt: Date.now() + 86_400_000,
      evidence: JSON.stringify({ schema: 2, writeKey: 'reflection-batch:x:life:0', sourceTurnIds: ['T1'], eventKeys: ['turn:A1'],
        sessions: ['s1'], policy: { disclosure: 'normal' } }) });
    assert.ok(retrieve({ sessionId: 's2', query: '最近怎么样' }).some(item => /面试/.test(item.content)), '撤回前近况在');
    revokeMemory(memory.store, fact.id);
    assert.deepEqual(retrieve({ sessionId: 's2', query: '最近怎么样' }).filter(item => /面试/.test(item.content)).map(item => item.kind), []);
  });
});

test('忘掉共享事实时，其他看过原话的伙伴从这句话反思出的内容也失效，他们各自的显式事实不动', async () => {
  const revoked = [];
  const conversationStore = { revokeObservation: (personId, turnId) => revoked.push([personId, turnId]),
    observersOf: turnId => (turnId === 'turn-shared' ? ['a', 'b'] : []) };
  await withTools(async ({ memory, tools, ctx }) => {
    const bNamespace = 'radiohost:b';
    const shared = tools.remember_shared_fact.handler({ content: '用户喜欢后摇', sourceQuote: '所有伙伴都可以知道' },
      ctx('我喜欢后摇，所有伙伴都可以知道', 'turn-shared'));
    assert.equal(shared.ok, true, shared.modelContext);
    const insight = memory.addMemory({ namespace: bNamespace, type: 'semantic', source: 'agent_reflection', content: '用户最近偏爱后摇',
      tags: 'reflection-insight', evidence: JSON.stringify({ writeKey: 'reflection:b:1', sourceTurnIds: ['turn-shared'] }) });
    const fact = memory.addMemory({ namespace: bNamespace, type: 'semantic', source: 'user_explicit_feedback', content: '用户在杭州工作',
      tags: 'person-relationship', evidence: JSON.stringify({ writeKey: 'fact:b:1', sourceTurnId: 'turn-shared' }) });
    const forgot = tools.forget_person_memory.handler({ memoryIds: [shared.facts.memoryId] }, ctx('忘掉我喜欢后摇这件事'));
    assert.equal(forgot.ok, true, forgot.code);
    assert.deepEqual(revoked.filter(([, turnId]) => turnId === 'turn-shared').map(([personId]) => personId).sort(), ['a', 'b']);
    assert.equal(isMemoryRevoked(memory.store, memory.store.getById(insight.id)), true, 'B 的反思不再生效');
    assert.equal(isMemoryRevoked(memory.store, memory.store.getById(fact.id)), false, 'B 自己记下的显式事实保留');
  }, { conversationStore });
});

test('带"今天只"限定的临时事实不能取代长期事实，旧事实保留', async () => {
  await withTools(async ({ memory, tools, ctx, retrieve }) => {
    const old = tools.remember_person_fact.handler({ content: '用户住在上海', sourceQuote: '我住在上海' }, ctx('记住我住在上海'));
    assert.equal(old.ok, true);
    const text = '今天只当我住在杭州，陪我聊聊杭州';
    const temporary = tools.remember_person_fact.handler({ content: '用户住在杭州', sourceQuote: '今天只当我住在杭州',
      replacesMemoryIds: [old.facts.memoryId] }, ctx(text));
    assert.equal(temporary.ok, false);
    assert.equal(temporary.code, 'MEMORY_REPLACE_SCOPE_MISMATCH');
    assert.doesNotMatch(memory.store.getById(old.facts.memoryId).tags, /superseded/u);
    assert.deepEqual(rel(retrieve({ sessionId: 'room2' })), ['用户住在上海']);
  });
});

test('另一句里的"今天只…"不限定这条事实：搬家照常取代旧住址', async () => {
  await withTools(async ({ tools, ctx, retrieve }) => {
    const old = tools.remember_person_fact.handler({ content: '用户住在上海', sourceQuote: '我住在上海' }, ctx('记住我住在上海'));
    const text = '我上周搬到杭州了，记住我现在住杭州。今天只想听点安静的';
    const moved = tools.remember_person_fact.handler({ content: '用户住在杭州', sourceQuote: '记住我现在住杭州',
      replacesMemoryIds: [old.facts.memoryId] }, ctx(text));
    assert.equal(moved.ok, true);
    assert.deepEqual(rel(retrieve({ sessionId: 'room2' })), ['用户住在杭州']);
  });
});

test('成功取代旧事实后重试同一条（换了措辞）原样返回已保存', async () => {
  await withTools(async ({ tools, ctx, retrieve }) => {
    const old = tools.remember_person_fact.handler({ content: '用户住在上海', sourceQuote: '我住在上海' }, ctx('我住在上海'));
    const args = { content: '用户搬到杭州', sourceQuote: '我搬到杭州了', replacesMemoryIds: [old.facts.memoryId] };
    const first = tools.remember_person_fact.handler(args, ctx('我搬到杭州了', 'move'));
    const retry = tools.remember_person_fact.handler({ ...args, content: '用户已经搬去杭州' }, ctx('我搬到杭州了', 'move'));
    assert.equal(retry.ok, true, retry.code);
    assert.equal(retry.facts.memoryId, first.facts.memoryId);
    assert.deepEqual(rel(retrieve({ sessionId: 'room2' })), ['用户搬到杭州']);
  });
});

test('只限这次的事实与临时表达偏好在本聊天里读得到，别的聊天读不到', async () => {
  const { retrieveExpressionPreferences } = await import('../program/narrationContext.js');
  await withTools(async ({ memory, tools, ctx, retrieve, person }) => {
    const fact = tools.remember_person_fact.handler({ content: '用户这次聊天里希望被叫作船长', sourceQuote: '叫我船长' },
      ctx('只限这次，叫我船长'));
    assert.equal(fact.ok, true);
    assert.ok(rel(retrieve({ query: '放首歌吧' })).includes('用户这次聊天里希望被叫作船长'));
    assert.ok(!rel(retrieve({ sessionId: 'room2', query: '放首歌吧' })).includes('用户这次聊天里希望被叫作船长'));
    const expression = tools.remember_person_fact.handler({ content: '这次串词结尾别再提天气', sourceQuote: '串词结尾别再提天气',
      kind: 'expression' }, ctx('这次只想安静点，串词结尾别再提天气'));
    assert.equal(expression.ok, true);
    assert.equal(retrieveExpressionPreferences(memory, { namespace: person.memoryNamespace, sessionId: 'room' }).length, 1);
    assert.equal(retrieveExpressionPreferences(memory, { namespace: person.memoryNamespace, sessionId: 'room2' }).length, 0);
  });
});

test('remember_person_fact 写入时段与会话编码，retrievePersonMemories 激活 _stateBoost 优先命中相符时段记忆', async () => {
  const { getTimeBucket, getDayOfWeek } = await import('../env.js');
  await withTools(async ({ memory, tools, ctx, retrieve, person }) => {
    const nowDate = new Date();
    const expectedBucket = getTimeBucket(nowDate);
    const expectedDay = getDayOfWeek(nowDate);
    const saved = tools.remember_person_fact.handler({ content: '深夜喜欢纯音乐', sourceQuote: '深夜喜欢纯音乐' },
      ctx('我深夜喜欢纯音乐'));
    assert.equal(saved.ok, true);
    const stored = memory.store.getById(saved.facts.memoryId);
    assert.equal(stored.time_bucket, expectedBucket);
    assert.equal(stored.day_of_week, expectedDay);
    assert.equal(stored.session_id, 'room');

    const nowMs = Date.now();
    const otherBucket = expectedBucket === 'morning' ? 'night' : 'morning';
    const rSame = memory.addMemory({ namespace: person.memoryNamespace, type: 'semantic', source: 'consolidation',
      content: '夜间适合轻声听歌', time_bucket: expectedBucket, day_of_week: expectedDay,
      createdAt: nowMs - 2_000, updatedAt: nowMs - 2_000 });
    const rDiff = memory.addMemory({ namespace: person.memoryNamespace, type: 'semantic', source: 'consolidation',
      content: '晨间适合轻声听歌', time_bucket: otherBucket, day_of_week: (expectedDay + 3) % 7,
      createdAt: nowMs, updatedAt: nowMs });
    assert.ok(rSame.ok && rDiff.ok, `rSame=${JSON.stringify(rSame)} rDiff=${JSON.stringify(rDiff)}`);
    const recalled = retrieve({ query: '轻声听歌', currentTimeBucket: expectedBucket, currentDayOfWeek: expectedDay })
      .filter(row => row.kind === 'memory');
    const idxSame = recalled.findIndex(row => row.id === rSame.id);
    const idxDiff = recalled.findIndex(row => row.id === rDiff.id);
    assert.ok(idxSame >= 0 && idxDiff >= 0 && idxSame < idxDiff, '匹配当前时段/星期的记忆应借 _stateBoost 排在前面');
  });
});
