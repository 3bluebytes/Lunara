// toolArgumentPreparation.test.js — 安全参数归一（harden-native-agent-harness §2）。
//
// 合同：同步、纯函数、幂等。
//   - 只在 schema 未声明 params/arguments/parameters、且它是唯一顶层键时解一层包装；
//   - 混合包装、嵌套包装、非对象包装一律 fail closed（不猜）；
//   - 未知字段原样保留，不丢、不映射 enum、不修截断 JSON；
//   - 只有显式 opt-in 的顶层可选对象字段，null 才等价于缺省；required/nullable 不动。
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareToolArguments, ToolArgumentPreparationError } from './toolArgumentPreparation.js';

const SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['exact', 'playlist'] },
    playlist: { type: 'object', additionalProperties: false, properties: { source: { type: 'string' }, playlistId: { type: 'string' } } },
    reference: { type: 'object', additionalProperties: false, properties: { selectionId: { type: 'string' } } },
    requiredObject: { type: 'object', properties: { value: { type: 'string' } } },
    nullableObject: { type: ['object', 'null'] },
  },
  required: ['requiredObject'],
};

const POLICY = { parameters: SELECT_SCHEMA, optionalNullObjectFields: ['playlist', 'reference', 'requiredObject', 'nullableObject', 'mode'] };

test('纯函数：不改写入参', () => {
  const input = { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } };
  const snapshot = structuredClone(input);
  const output = prepareToolArguments(input, POLICY);
  assert.deepEqual(input, snapshot, '源对象不能被修改');
  assert.deepEqual(output, snapshot);
});

test('幂等：同一参数连续归一两遍结果一致', () => {
  const once = prepareToolArguments({ params: { mode: 'playlist', playlist: null } }, POLICY);
  const twice = prepareToolArguments(once, POLICY);
  assert.deepEqual(once, { mode: 'playlist' });
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test('单一无歧义包装解一层：params / arguments / parameters', () => {
  for (const key of ['params', 'arguments', 'parameters']) {
    assert.deepEqual(
      prepareToolArguments({ [key]: { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } } }, POLICY),
      { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } },
      `${key} 包装应被解开`,
    );
  }
});

test('schema 已声明的同名字段不是包装：原样保留', () => {
  const schema = { type: 'object', properties: { params: { type: 'object' } } };
  const input = { params: { anything: 1 } };
  assert.deepEqual(prepareToolArguments(input, { parameters: schema }), input);
});

test('混合包装兄弟键 fail closed，不做部分解包', () => {
  for (const input of [
    { params: { mode: 'playlist', playlist: { source: 'qq', playlistId: '42' } }, mode: 'playlist' },
    { arguments: { mode: 'playlist' }, parameters: { mode: 'playlist' } },
    { params: { mode: 'playlist' }, playlist: { source: 'qq', playlistId: '42' } },
  ]) {
    assert.throws(() => prepareToolArguments(input, POLICY), error => {
      assert.equal(error.name, 'ToolArgumentPreparationError');
      assert.equal(error.code, 'AMBIGUOUS_ARGUMENT_WRAPPER');
      assert.doesNotMatch(String(error.message), /playlistId|exact/u, '错误信息不能回显参数值');
      return true;
    });
  }
});

test('嵌套包装与标量包装 fail closed', () => {
  assert.throws(() => prepareToolArguments({ params: { params: { mode: 'playlist' } } }, POLICY),
    error => error.code === 'NESTED_ARGUMENT_WRAPPER');
  for (const value of [null, '{"mode":"playlist"}', 42, ['mode']]) {
    assert.throws(() => prepareToolArguments({ params: value }, POLICY),
      error => error.code === 'INVALID_ARGUMENT_WRAPPER', `包装值 ${JSON.stringify(value)} 必须拒绝`);
  }
});

test('未知字段保留给 schema 校验，不静默丢弃也不映射 enum', () => {
  const prepared = prepareToolArguments({ params: { mode: 'original', unsupportedConstraint: { x: 1 } } }, POLICY);
  assert.deepEqual(prepared, { mode: 'original', unsupportedConstraint: { x: 1 } });
});

test('只有显式 opt-in、schema 声明的顶层可选对象字段才把 null 当缺省', () => {
  const prepared = prepareToolArguments({ requiredObject: { value: 'x' }, playlist: null, reference: null, mode: null }, POLICY);
  assert.deepEqual(prepared, { requiredObject: { value: 'x' }, mode: null },
    'playlist/reference 的 null 被移除；mode 不是对象字段，保留 null 交给 schema 拒绝');
  // required 对象字段保留 null，交给 schema 报错；nullable 对象字段保留 null 语义。
  assert.deepEqual(prepareToolArguments({ requiredObject: null, nullableObject: null }, POLICY), { requiredObject: null, nullableObject: null });
  // 未 opt-in 的工具不删任何 null。
  assert.deepEqual(prepareToolArguments({ playlist: null }, { parameters: SELECT_SCHEMA }), { playlist: null });
  // 非 null 值不改写。
  const kept = { requiredObject: { value: 'x' }, playlist: { source: 'qq', playlistId: '42' } };
  assert.deepEqual(prepareToolArguments(kept, POLICY), kept);
});

test('非对象入参原样返还，由 schema 校验拒绝', () => {
  for (const value of [{}, undefined, null, '{"a":1}', 7, []]) {
    assert.deepEqual(prepareToolArguments(value, POLICY), value);
  }
});

test('无 schema 时只做包装归一，不猜字段', () => {
  assert.deepEqual(prepareToolArguments({ params: { anything: 1 } }), { anything: 1 });
  assert.deepEqual(prepareToolArguments({ anything: 1 }), { anything: 1 });
});

test('错误类型带稳定 code，便于 registry 映射为 typed invalid args', () => {
  const error = new ToolArgumentPreparationError('INVALID_ARGUMENT_WRAPPER', 'argument wrapper must be an object');
  assert.equal(error.name, 'ToolArgumentPreparationError');
  assert.equal(error.code, 'INVALID_ARGUMENT_WRAPPER');
  assert.ok(error instanceof Error);
});
