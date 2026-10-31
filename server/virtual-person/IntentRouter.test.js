import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';
import { IntentRouter } from './IntentRouter.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';

const cadence = { id: 'cadence', function: { name: 'set_familiar_artist_cadence', arguments: '{}' } };
const select = { id: 'select', function: { name: 'select_music', arguments: '{}' } };
const commit = { id: 'commit', function: { name: 'commit_music_selection', arguments: '{}' } };

test('IntentRouter owns the first-call music guidance without another model request', async () => {
  const prompts = [];
  const loop = new AgentLoop({
    toolRegistry: { definitions: () => [], execute: () => { throw new Error('unexpected tool call'); } },
    chat: async messages => {
      prompts.push(messages[0].content);
      return { message: { role: 'assistant', content: '我听到了。' } };
    },
  });
  const result = await loop.run({ systemPrompt: '原有身份与记忆',
    messages: [{ role: 'user', content: '我想聊聊' }],
    capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] });
  assert.equal(result.finalText, '我听到了。');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /原有身份与记忆/u);
  assert.match(prompts[0], /## 意图路由与音乐动作/u);
  assert.match(prompts[0], /set_familiar_artist_cadence/u);
  // 两步选歌：候选不是已播放，提交才能安排。
  assert.match(prompts[0], /select_music 返回候选 offer（不是已经播放）/u);
  assert.match(prompts[0], /commit_music_selection/u);
  assert.match(prompts[0], /recommend_only（候选与提交都不会播放）/u);
  assert.doesNotMatch(new IntentRouter().extendSystemPrompt('原有身份与记忆', { capabilities: [] }), /意图路由与音乐动作/u);
});

test('IntentRouter plans source-backed feedback before selection and blocks a failed prerequisite', () => {
  const plan = new IntentRouter().plan([select, cadence]);
  assert.deepEqual(plan.calls.map(call => call.id), ['cadence', 'select']);
  assert.equal(plan.blockedOutcome(select), null);
  plan.observe(cadence, { ok: false });
  assert.equal(plan.blockedOutcome(select)?.code, 'PREFERENCE_WRITE_REQUIRED');
  assert.equal(plan.blockedOutcome(commit)?.code, 'PREFERENCE_WRITE_REQUIRED', '偏好没写成功时提交同样被拦截');

  const successful = new IntentRouter().plan([select, cadence]);
  successful.observe(cadence, { ok: true });
  assert.equal(successful.blockedOutcome(select), null);
  assert.equal(successful.blockedOutcome(commit), null);
  assert.deepEqual(new IntentRouter().plan([{ id: 'read', function: { name: 'get_listening_state' } }, select])
    .calls.map(call => call.id), ['read', 'select']);
  // 同一响应里候选查询必须排在提交之前。
  assert.deepEqual(new IntentRouter().plan([commit, select, cadence]).calls.map(call => call.id),
    ['cadence', 'select', 'commit']);
});

test('an exact select_music that may end the turn runs after same-batch non-music actions', () => {
  const remember = { id: 'remember', function: { name: 'remember_person_fact', arguments: '{}' } };
  const plan = new IntentRouter().plan([select, remember, commit, cadence]);
  assert.deepEqual(plan.calls.map(call => call.id), ['cadence', 'remember', 'select', 'commit']);
});

test('IntentRouter decides when a music batch made no progress, across rounds of one run', () => {
  const router = new IntentRouter();
  const call = name => ({ id: name, function: { name } });
  const noMatch = { ok: false, code: 'NO_MATCHING_CANDIDATES' };
  const run = {};

  const first = router.plan([call('select_music')], run);
  first.observe(call('select_music'), noMatch);
  assert.equal(first.noProgressOutcome(), null);
  const second = router.plan([call('select_music')], run);
  second.observe(call('select_music'), noMatch);
  assert.equal(second.noProgressOutcome(), noMatch);

  // 同批任一搜索找到候选就不算无进展，与执行顺序无关。
  const found = router.plan([call('select_music'), call('search_music')], {});
  found.observe(call('select_music'), noMatch);
  found.observe(call('select_music'), noMatch);
  found.observe(call('search_music'), { ok: true, facts: { total: 2 } });
  assert.equal(found.noProgressOutcome(), null);

  for (const code of ['NO_FRESH_MUSIC_REQUEST', 'WEB_READ_ONLY_TURN', 'PREFERENCE_WRITE_REQUIRED']) {
    const plan = router.plan([call('control_listening')], {});
    const outcome = { ok: false, code };
    plan.observe(call('control_listening'), outcome);
    assert.equal(plan.noProgressOutcome(), outcome);
  }
});
