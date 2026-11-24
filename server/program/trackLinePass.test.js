// line pass：音乐落定之后 host 写串词的那一次模型调用。它的任何失败都不影响已提交的音乐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineCollector, createTrackLinePass } from './trackLinePass.js';
import { TRACK_LINES_CAPABILITY, TRACK_LINES_TOOL_NAME, TRACK_LINE_MAX_ROUNDS } from './trackLineTools.js';

const material = targets => ({
  tracks: targets.map(({ ref }) => ({ ref, material: {}, checks: {} })),
  performance: null, voiceProfileId: 'v1', membershipRevision: 2, trigger: { role: 'user', content: '写串词' },
});

function targetsOf(...titles) {
  const log = { saved: [], failed: [] };
  const targets = titles.map(title => ({ track: { title },
    save: async line => { log.saved.push({ title, line }); return true; },
    fail: async reason => { log.failed.push({ title, reason }); } }));
  return { targets, log };
}

test('复用 host 的 system prompt 和消息，只开放写串词的工具，轮数有界', async () => {
  let seen;
  const pass = createTrackLinePass({ getMaterial: material, agentLoop: { run: async input => { seen = input; return { outcomes: [{ code: 'TRACK_LINES_SAVED' }] }; } } });
  const { targets } = targetsOf('晴天');
  await pass.run({ sessionId: 's1', personId: 'p1', systemPrompt: 'host 的 prompt', messages: [{ role: 'user', content: '来首歌' }], targets, requestId: 'r1' });
  assert.equal(seen.systemPrompt, 'host 的 prompt');
  assert.deepEqual(seen.messages, [{ role: 'user', content: '来首歌' }, { role: 'user', content: '写串词' }]);
  assert.deepEqual(seen.capabilities, [TRACK_LINES_CAPABILITY]);
  assert.deepEqual(seen.toolNames, [TRACK_LINES_TOOL_NAME]);
  assert.equal(seen.modelProfileId, 'track_lines');
  assert.equal(seen.profileOverrides.maxRounds, TRACK_LINE_MAX_ROUNDS);
  assert.ok(Number.isFinite(seen.profileOverrides.deadlineMs));
  assert.equal(seen.toolContext.trackLineTask.targets.size, 1);
});

test('写了部分：没写的走 fail，写了的不走', async () => {
  const pass = createTrackLinePass({ getMaterial: material, agentLoop: { run: async ({ toolContext }) => {
    toolContext.trackLineTask.targets.get('t1').saved = true;
    return { outcomes: [{ code: 'TRACK_LINES_SAVED' }] };
  } } });
  const { targets, log } = targetsOf('晴天', '七里香');
  const result = await pass.run({ sessionId: 's1', personId: 'p1', targets });
  assert.equal(result.written, 1);
  assert.deepEqual(log.failed, [{ title: '七里香', reason: 'not-written' }]);
  assert.deepEqual(pass.stats().notWritten, { 'not-written': 1 });
});

test('模型报错、素材报错都不抛出，所有歌归位', async () => {
  for (const options of [
    { getMaterial: material, agentLoop: { run: async () => { throw Object.assign(new Error('x'), { code: 'EMPTY_ASSISTANT_RESPONSE' }); } } },
    { getMaterial: () => { throw new Error('boom'); }, agentLoop: { run: async () => ({}) } },
  ]) {
    const pass = createTrackLinePass(options);
    const { targets, log } = targetsOf('晴天', '七里香');
    const result = await pass.run({ sessionId: 's1', personId: 'p1', targets });
    assert.equal(result.written, 0);
    assert.equal(log.failed.length, 2);
  }
});

test('fail 自己出错不影响其他歌', async () => {
  const pass = createTrackLinePass({ getMaterial: material, agentLoop: { run: async () => ({}) } });
  const { targets, log } = targetsOf('晴天', '七里香');
  targets[0].fail = async () => { throw new Error('nope'); };
  await pass.run({ sessionId: 's1', personId: 'p1', targets });
  assert.deepEqual(log.failed.map(item => item.title), ['七里香']);
});

test('没有目标不调模型', async () => {
  let called = false;
  const pass = createTrackLinePass({ getMaterial: material, agentLoop: { run: async () => { called = true; return {}; } } });
  assert.deepEqual(await pass.run({ sessionId: 's1', personId: 'p1', targets: [] }), { requested: 0, written: 0 });
  assert.equal(called, false);
});

test('记录一条诊断：请求几首、写了几首、没写的原因', async () => {
  const events = [];
  const pass = createTrackLinePass({ getMaterial: material, agentLoop: { run: async () => ({ outcomes: [] }) },
    sessionTrace: { recordScoped: (sessionId, event) => events.push({ sessionId, event }) } });
  const { targets } = targetsOf('晴天');
  await pass.run({ sessionId: 's1', personId: 'p1', targets, requestId: 'r1' });
  assert.equal(events[0].sessionId, 's1');
  assert.equal(events[0].event.type, 'track_line_pass_completed');
  assert.equal(events[0].event.requested, 1);
  assert.equal(events[0].event.written, 0);
});

test('collector 把工具深处提交的歌带到这一轮结束之后', () => {
  const collector = createLineCollector();
  collector.collect([{ track: { title: 'a' } }]);
  collector.collect([{ track: { title: 'b' } }]);
  assert.equal(collector.targets.length, 2);
});

test('交给模型的历史里没有选歌用的标签和时长', async () => {
  let seen;
  const pass = createTrackLinePass({ getMaterial: material, agentLoop: { run: async input => { seen = input; return { outcomes: [] }; } } });
  const { targets } = targetsOf('晴天');
  const tool = { role: 'tool', content: JSON.stringify({ code: 'MUSIC_CANDIDATES_OFFERED',
    facts: { candidates: [{ index: 1, title: '晴天', duration: 269, features: { tags: { energy: 'low' } } }] } }) };
  await pass.run({ sessionId: 's1', personId: 'p1', messages: [tool], targets });
  assert.doesNotMatch(seen.messages[0].content, /duration|energy|features/u);
  assert.match(seen.messages[0].content, /晴天/u);
});

test('停顿交给素材：隔久恢复的重写知道停在几点', async () => {
  let options;
  const pass = createTrackLinePass({ getMaterial: (targets, opts) => { options = opts; return material(targets); },
    agentLoop: { run: async () => ({ outcomes: [] }) } });
  const { targets } = targetsOf('晴天');
  await pass.run({ sessionId: 's1', personId: 'p1', targets, playbackGap: { stoppedAtMs: 1, resumedAtMs: 2 } });
  assert.deepEqual(options.playbackGap, { stoppedAtMs: 1, resumedAtMs: 2 });
});

test('target 带的选歌理由原样交给素材装配', async () => {
  let seen = null;
  const pass = createTrackLinePass({ getMaterial: targets => { seen = targets; return material(targets); },
    agentLoop: { run: async () => ({}) } });
  const { targets } = targetsOf('晴天', '七里香');
  targets[1].note = '想换个口味';
  await pass.run({ sessionId: 's1', personId: 'p1', targets, requestId: 'r1' });
  assert.deepEqual(seen.map(entry => entry.note ?? null), [null, '想换个口味']);
});

test('pass 事件带上风格类放行的统计 styleKept', async () => {
  const events = [];
  const pass = createTrackLinePass({ getMaterial: material,
    sessionTrace: { record: (_context, event) => events.push(event) },
    agentLoop: { run: async ({ toolContext }) => { toolContext.trackLineTask.onStyleKept('stock-phrasing'); return {}; } } });
  await pass.run({ sessionId: 's1', personId: 'p1', ...targetsOf('晴天'), requestId: 'r1' });
  assert.deepEqual(events.at(-1).styleKept, { 'stock-phrasing': 1 });
  assert.deepEqual(pass.stats().styleKept, { 'stock-phrasing': 1 });
});
