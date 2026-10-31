// VirtualPersonToolRegistry.arguments.test.js — registry 侧安全参数归一（change §2.1）。
//
// 合同：prepareArguments 同步纯函数且幂等；execute 自己先归一，再鉴权、校验、执行；
// 直调 registry 与经 AgentLoop 的行为一致；归一失败 fail closed 为 typed INVALID_TOOL_ARGUMENTS；
// 未知工具保持既有 TOOL_NOT_AVAILABLE，不做任何参数猜测。
import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

const SELECT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['exact', 'playlist'] },
    playlist: { type: 'object', additionalProperties: false, properties: { source: { type: 'string' }, playlistId: { type: 'string' } } },
    reference: { type: 'object', additionalProperties: false, properties: { selectionId: { type: 'string' } } },
  },
};

function harness(t, { schema = SELECT_SCHEMA, optionalNullObjectFields = null, authorize = null } = {}) {
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const calls = { handler: [], authorize: [] };
  registry.register('select_music', {
    capability: 'music',
    readOnly: false,
    authorize,
    optionalNullObjectFields,
    definition: { description: '选歌', parameters: schema },
    handler: async (args, context) => {
      calls.handler.push({ args, context });
      return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK', facts: {} });
    },
  });
  t.after(() => {});
  return { registry, calls };
}

const context = () => ({ correlationId: 'corr-1', capabilities: ['music'] });

test('prepareArguments 同步、纯、幂等：包装与平铺结果一致', t => {
  const { registry } = harness(t);
  const wrapped = { params: { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } } };
  const plain = { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } };
  const before = structuredClone(wrapped);
  const prepared = registry.prepareArguments('select_music', wrapped);
  assert.deepEqual(prepared, plain);
  assert.deepEqual(registry.prepareArguments('select_music', prepared), plain, '幂等');
  assert.deepEqual(wrapped, before, '不能改写入参');
  assert.ok(!(prepared instanceof Promise), '必须同步返回');
});

test('直调 execute：包装调用与平铺调用都到达 handler 的归一参数，且鉴权看到同一份参数', async t => {
  const authorize = args => { authSeen.push(args); return true; };
  const authSeen = [];
  const { registry, calls } = harness(t, { authorize });
  const wrapped = await registry.execute('select_music', { params: { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } } }, context());
  const plain = await registry.execute('select_music', { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } }, context());
  assert.equal(wrapped.ok, true);
  assert.equal(plain.ok, true);
  assert.deepEqual(calls.handler[0].args, calls.handler[1].args, 'handler 收到的参数完全一致');
  assert.deepEqual(authSeen[0], authSeen[1], '授权判断使用归一后的同一份参数');
  assert.deepEqual(authSeen[0], { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } });
});

test('权限拒绝使用同一份归一参数，且不执行 handler', async t => {
  const authSeen = [];
  const { registry, calls } = harness(t, { authorize: args => { authSeen.push(structuredClone(args)); return false; } });
  const outcome = await registry.execute('select_music', { params: { mode: 'exact' } }, context());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TOOL_NOT_AUTHORIZED');
  assert.deepEqual(authSeen, [{ mode: 'exact' }], '包装字段不能污染授权判断');
  assert.equal(calls.handler.length, 0);
});

test('混合包装/嵌套包装/非对象包装 fail closed 为 INVALID_TOOL_ARGUMENTS，不执行 handler', async t => {
  const { registry, calls } = harness(t);
  for (const args of [
    { params: { mode: 'exact' }, mode: 'exact' },
    { params: { arguments: { mode: 'exact' } } },
    { params: '{"mode":"exact"}' },
  ]) {
    const outcome = await registry.execute('select_music', args, context());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'INVALID_TOOL_ARGUMENTS');
    assert.equal(outcome.kind, ToolOutcomeKind.BUSINESS_FAILURE);
    assert.equal(outcome.presentation.speak, false);
    assert.doesNotMatch(outcome.modelContext, /exact|playlistId/u, '错误上下文不能回显参数值');
  }
  assert.equal(calls.handler.length, 0, '归一失败绝不能产生副作用');
});

test('未知字段不被丢弃：additionalProperties:false 仍拒绝，宽松 schema 则原样给 handler', async t => {
  const strict = harness(t);
  const rejected = await strict.registry.execute('select_music', { mode: 'exact', unsupportedConstraint: { x: 1 } }, context());
  assert.equal(rejected.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(strict.calls.handler.length, 0);

  const permissive = harness(t, { schema: { type: 'object', properties: { mode: { type: 'string' } } } });
  const accepted = await permissive.registry.execute('select_music', { params: { mode: 'exact', unsupportedConstraint: { x: 1 } } }, context());
  assert.equal(accepted.ok, true);
  assert.deepEqual(permissive.calls.handler[0].args, { mode: 'exact', unsupportedConstraint: { x: 1 } },
    '未知字段必须保留，不能静默丢弃');
});

test('optionalNullObjectFields 显式 opt-in 的玩具工具：仅声明的顶层可选对象字段的 null 等价缺省', async t => {
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const seen = [];
  registry.register('toy_selection', {
    capability: 'music',
    optionalNullObjectFields: ['playlist', 'reference'],
    definition: { description: '玩具', parameters: SELECT_SCHEMA },
    handler: async args => { seen.push(args); return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }); },
  });
  const outcome = await registry.execute('toy_selection', { params: { mode: 'playlist', playlist: null, reference: null } }, context());
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, [{ mode: 'playlist' }], '两个显式 opt-in 的 null 对象字段被当作缺省');
  assert.deepEqual(registry.definitions()[0].function.parameters, SELECT_SCHEMA, '对外 schema 不变');
});

test('未 opt-in 的工具不清理 null：null 交给 schema 校验拒绝', async t => {
  const { registry, calls } = harness(t);
  const outcome = await registry.execute('select_music', { params: { mode: 'playlist', playlist: null } }, context());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(calls.handler.length, 0);
});

test('未知工具的 prepareArguments 是 no-op，execute 保持既有 TOOL_NOT_AVAILABLE', async t => {
  const { registry } = harness(t);
  const args = { params: { mode: 'exact' } };
  assert.deepEqual(registry.prepareArguments('not_a_tool', args), args, '未知工具不做任何猜测');
  const outcome = await registry.execute('not_a_tool', args, context());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TOOL_NOT_AVAILABLE');
});
