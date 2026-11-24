// write_track_lines：host 写串词的唯一工具。逐条校验、合格的立刻存，不碰队列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { TRACK_LINES_CAPABILITY, TRACK_LINES_TOOL_NAME, performanceDefect, registerTrackLineTools } from './trackLineTools.js';

const checks = title => ({ track: { title, artist: '某人' }, facts: {}, recentConversation: [], chatIntroduced: false,
  minChars: 4, minSentences: 1, recommendation: null, lyricExcerpt: null, memories: [], liked: null, listenerAsked: false, overusedPhrases: [] });

function registered() {
  const registry = new VirtualPersonToolRegistry();
  const register = registry.register.bind(registry);
  const holder = {};
  registry.register = (name, spec) => { holder.tool = spec; return register(name, spec); };
  registerTrackLineTools(registry);
  return { registry, tool: holder.tool };
}

function fixture({ saveResult = true, performance = null } = {}) {
  const saved = [];
  const target = (ref, title) => [ref, { checks: checks(title), saved: false, lastRule: null,
    save: async line => { saved.push({ ref, line }); return saveResult; }, fail: () => {} }];
  const task = { targets: new Map([target('t1', '晴天'), target('t2', '七里香')]), performance, voiceProfileId: 'v1',
    membershipRevision: 3, now: () => 1000, onRejected: () => {} };
  const { registry, tool } = registered();
  const call = (lines, context = {}) => tool.handler({ lines },
    { trackLineTask: task, round: 1, finishReason: 'tool_calls', ...context });
  return { task, saved, call, registry, tool };
}

test('注册：只属于 track_lines 能力，重复注册不报错', () => {
  const { registry, tool } = registered();
  assert.equal(tool.capability, TRACK_LINES_CAPABILITY);
  assert.doesNotThrow(() => registerTrackLineTools(registry));
  const names = registry.definitions({ capabilities: [TRACK_LINES_CAPABILITY] }).map(item => item.function.name);
  assert.deepEqual(names, [TRACK_LINES_TOOL_NAME]);
});

test('合格的存下，带上写作时间和成员修订；全部合格即结束', async () => {
  const { call, saved, task } = fixture();
  const outcome = await call([{ ref: 't1', text: '《晴天》这首，上周你还在说想听。' }]);
  assert.equal(outcome.code, 'TRACK_LINES_SAVED');
  assert.equal(outcome.terminal, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].line.text, '《晴天》这首，上周你还在说想听。');
  assert.equal(saved[0].line.writtenAt, 1000);
  assert.equal(saved[0].line.membershipRevision, 3);
  assert.equal(saved[0].line.voiceProfileId, 'v1');
  assert.equal(task.targets.get('t1').saved, true);
  assert.equal(task.targets.get('t2').saved, false, '少写的歌没有被碰');
});

test('about：可选的要点备忘随串词存下，压成单行并截断；不给就是 null', async () => {
  const { call, saved, task, tool } = fixture();
  assert.equal(tool.definition.parameters.properties.lines.items.properties.about.type, 'string');
  assert.ok(!tool.definition.parameters.properties.lines.items.required.includes('about'));
  await call([{ ref: 't1', text: '《晴天》这首，上周你还在说想听。', about: `上周提过想听\n${'长'.repeat(200)}` },
    { ref: 't2', text: '《七里香》放在这儿，夏天的味道还没散。' }]);
  assert.equal(saved.length, 2);
  assert.match(saved[0].line.about, /^上周提过想听 长+$/u);
  assert.equal(saved[0].line.about.length, 80);
  assert.equal(saved[1].line.about, null);
  assert.equal(task.batchLines[0].about, saved[0].line.about);
});

test('不合格的那条可纠正，合格的先存下，再交不重复保存', async () => {
  const { call, saved, task } = fixture();
  const first = await call([{ ref: 't1', text: '《晴天》这首，上周你还在说想听。' }, { ref: 't2', text: '这首歌很好听。' }]);
  assert.equal(first.code, 'TRACK_LINES_REJECTED');
  assert.notEqual(first.terminal, true);
  assert.deepEqual(first.facts.written, ['t1']);
  assert.equal(first.facts.rejected[0].ref, 't2');
  assert.ok(task.targets.get('t2').lastRule);
  const second = await call([{ ref: 't1', text: '《晴天》又一遍。' }, { ref: 't2', text: '《七里香》放到这里正好，歇一下。' }], { round: 2 });
  assert.equal(second.code, 'TRACK_LINES_SAVED');
  assert.deepEqual(saved.map(item => item.ref), ['t1', 't2']);
});

test('第二轮还不合格也结束，不再要求重写', async () => {
  const { call, saved } = fixture();
  const outcome = await call([{ ref: 't2', text: '这首歌很好听。' }], { round: 2 });
  assert.equal(outcome.code, 'TRACK_LINES_SAVED');
  assert.equal(outcome.terminal, true);
  assert.equal(saved.length, 0);
});

test('未知引用不影响其他歌', async () => {
  const { call, saved } = fixture();
  const outcome = await call([{ ref: 't9', text: '《不存在》' }, { ref: 't1', text: '《晴天》这首，上周你还在说想听。' }]);
  assert.equal(outcome.code, 'TRACK_LINES_REJECTED');
  assert.equal(outcome.facts.rejected[0].rule, 'unknown-ref');
  assert.equal(saved.length, 1);
});

test('身份或代次失效时：runtime 拒绝保存，这条静默作废', async () => {
  const { call, task } = fixture({ saveResult: false });
  const outcome = await call([{ ref: 't1', text: '《晴天》这首，上周你还在说想听。' }]);
  assert.equal(outcome.code, 'TRACK_LINES_SAVED');
  assert.deepEqual(outcome.facts.written, []);
  assert.equal(task.targets.get('t1').saved, false);
  assert.equal(task.targets.get('t1').lastRule, 'stale');
});

test('取消或成员失效：不存、不要求重写', async () => {
  const { call, saved } = fixture();
  const stale = await call([{ ref: 't1', text: '《晴天》这首，上周你还在说想听。' }], { isCurrent: () => false });
  assert.equal(stale.code, 'TRACK_LINE_PASS_STALE');
  assert.equal(stale.terminal, true);
  const controller = new AbortController();
  controller.abort();
  const aborted = await call([{ ref: 't1', text: '《晴天》这首，上周你还在说想听。' }], { signal: controller.signal });
  assert.equal(aborted.code, 'TRACK_LINE_PASS_STALE');
  assert.equal(saved.length, 0);
});

test('响应被截断时一条都不存', async () => {
  const { call, saved } = fixture();
  const outcome = await call([{ ref: 't1', text: '《晴天》这首，上周你还在说' }], { finishReason: 'length' });
  assert.equal(outcome.code, 'TRACK_LINES_TRUNCATED');
  assert.equal(saved.length, 0);
});

test('没有任务时不写任何东西', async () => {
  const { tool } = registered();
  const outcome = await tool.handler({ lines: [] }, {});
  assert.equal(outcome.code, 'TRACK_LINE_PASS_UNAVAILABLE');
});

test('表演标记：声音不支持时拒绝，支持时人读文本去掉标记、带标记的原文另存', async () => {
  assert.equal(performanceDefect('《晴天》{笑}来了', { performance: null, track: { title: '晴天' } }).rule, 'performance-unsupported');
  const capability = { markers: ['{笑}'], emotions: ['calm'], pace: true, intensity: false, direction: false,
    limits: { maxInlineEvents: 1, maxPauses: 0, pauseSeconds: null } };
  const { call, saved } = fixture({ performance: capability });
  const outcome = await call([{ ref: 't1', text: '《晴天》{笑}这首，上周你还在说想听。', performance: { emotion: 'calm' } }]);
  assert.equal(outcome.code, 'TRACK_LINES_SAVED');
  assert.equal(saved[0].line.text, '《晴天》这首，上周你还在说想听。');
  assert.equal(saved[0].line.spokenText, '《晴天》{笑}这首，上周你还在说想听。');
  assert.equal(saved[0].line.performance.emotion, 'calm');
});

test('同一批：先存下的那条参与后面几条的重复检查（对比过的歌、用滥词）', async () => {
  const { call, saved, task } = fixture();
  task.recentLines = [{ text: '《甲》放着不碍事。' }, { text: '《乙》也不碍事。' }];
  const outcome = await call([
    { ref: 't1', text: '《晴天》也不碍事，比《每天每天》安静些。' },
    { ref: 't2', text: '《七里香》不像《每天每天》那么甜，慢慢放。' },
  ]);
  assert.deepEqual(saved.map(item => item.ref), ['t1']);
  assert.equal(outcome.facts.rejected[0].ref, 't2');
  assert.equal(outcome.facts.rejected[0].rule, 'repeats-reference');
  const kept = [];
  task.onStyleKept = rule => kept.push(rule);
  const third = await call([{ ref: 't2', text: '《七里香》放着还是不碍事，慢慢来。' }], { round: 2 });
  assert.equal(third.code, 'TRACK_LINES_SAVED');
  assert.deepEqual(saved.map(item => item.ref), ['t1', 't2'], '风格类提醒过一次，再交就存下');
  assert.deepEqual(kept, ['overused-phrase'], '最近两条 + 同批先存的一条，三条共有，这条再用就算用滥');
});

test('风格类只退回一次：同一首再交即使还用了那个片段也存下，并记 styleKept', async () => {
  const { call, saved, task } = fixture();
  task.targets.get('t1').checks.overusedPhrases = ['不碍事'];
  const kept = [];
  task.onStyleKept = rule => kept.push(rule);
  const line = '《晴天》放着不碍事，你忙你的。';
  const first = await call([{ ref: 't1', text: line }]);
  assert.equal(first.code, 'TRACK_LINES_REJECTED');
  assert.equal(first.facts.rejected[0].rule, 'overused-phrase');
  const second = await call([{ ref: 't1', text: line }], { round: 2 });
  assert.equal(second.code, 'TRACK_LINES_SAVED');
  assert.equal(saved.length, 1);
  assert.deepEqual(kept, ['overused-phrase']);
});

test('风格类不会让歌安静：第一次交就是最后一轮时直接存下', async () => {
  const { call, saved, task } = fixture();
  task.targets.get('t1').checks.overusedPhrases = ['不碍事'];
  const kept = [];
  task.onStyleKept = rule => kept.push(rule);
  await call([{ ref: 't1', text: '《晴天》放着不碍事，你忙你的。' }], { round: 2 });
  assert.equal(saved.length, 1);
  assert.deepEqual(kept, ['overused-phrase']);
});

test('事实类照旧拦：退回过风格问题之后，再交若缺歌名仍不存', async () => {
  const { call, saved, task } = fixture();
  task.targets.get('t1').checks.overusedPhrases = ['不碍事'];
  await call([{ ref: 't1', text: '《晴天》放着不碍事，你忙你的。' }]);
  const second = await call([{ ref: 't1', text: '放着不碍事，你忙你的。' }], { round: 2 });
  assert.equal(second.facts.rejected[0].rule, 'missing-title');
  assert.equal(saved.length, 0);
});
