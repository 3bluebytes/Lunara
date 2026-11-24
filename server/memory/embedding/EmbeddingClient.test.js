// EmbeddingClient.test.js — embedding 子进程的按需启动、超时、停用与空闲退出（add-local-semantic-memory-recall）。
//
// 单元部分用假 fork；真实模型集成测试只在 LUNARA_EMBEDDING_TEST_MODEL_DIR 指向已安装模型时运行。
// Run: node --test server/memory/embedding/EmbeddingClient.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { EmbeddingClient } from './EmbeddingClient.js';
import { isModelInstalled } from './embeddingModel.js';

function fakeFork(reply) {
  const children = [];
  const forkImpl = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.sent = [];
    child.send = message => {
      child.sent.push(message);
      const answer = reply(message);
      if (answer) setImmediate(() => child.emit('message', { id: message.id, ...answer }));
    };
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
    };
    children.push(child);
    return child;
  };
  return { forkImpl, children };
}

const vectors = texts => ({ dims: [texts.length, 2], data: Float32Array.from(texts.flatMap(() => [0.6, 0.8])) });
const quiet = { warn() {} };

test('模型未安装时不可用，也不启动子进程', async () => {
  const { forkImpl, children } = fakeFork(() => null);
  const client = new EmbeddingClient({ modelRoot: '/nowhere', forkImpl, logger: quiet });
  assert.equal(client.available(), false);
  await assert.rejects(client.embed(['x']), { code: 'EMBEDDING_UNAVAILABLE' });
  assert.equal(children.length, 0);
});

test('按需启动一次，返回逐条向量；空闲后退出', async () => {
  const { forkImpl, children } = fakeFork(message => vectors(message.texts));
  const client = new EmbeddingClient({ modelRoot: '/m', forkImpl, isInstalled: () => true, idleMs: 20, logger: quiet });
  const result = await client.embed(['a', 'b']);
  assert.equal(result.length, 2);
  assert.deepEqual([...result[1]].map(value => Math.round(value * 10) / 10), [0.6, 0.8]);
  await client.embed(['c']);
  assert.equal(children.length, 1, '复用同一个子进程');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(children[0].exitCode, 0, '空闲后退出');
  assert.equal(client.child, null);
});

test('预热：后台加载模型后 ready，重复预热共用一次', async () => {
  const { forkImpl, children } = fakeFork(message => vectors(message.texts));
  const client = new EmbeddingClient({ modelRoot: '/m', forkImpl, isInstalled: () => true, logger: quiet });
  assert.equal(client.ready(), false);
  const [first, second] = await Promise.all([client.warmUp(), client.warmUp()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(children.length, 1);
  assert.equal(children[0].sent.length, 1, '只发了一次预热请求');
  assert.equal(client.ready(), true);
  client.close();
  assert.equal(client.ready(), false, '子进程退出后要重新预热');
});

test('预热失败不抛错', async () => {
  const { forkImpl } = fakeFork(() => ({ error: 'EMBEDDING_PACKAGE_MISSING' }));
  const client = new EmbeddingClient({ modelRoot: '/m', forkImpl, isInstalled: () => true, logger: quiet });
  assert.equal(await client.warmUp(), false);
  assert.equal(client.available(), false);
});

test('超时回落但不停用；连续出错三次后停用', async () => {
  let mode = 'silent';
  const { forkImpl } = fakeFork(message => (mode === 'silent' ? null : { error: 'EMBEDDING_FAILED' }));
  const client = new EmbeddingClient({ modelRoot: '/m', forkImpl, isInstalled: () => true, coldTimeoutMs: 10, logger: quiet });
  await assert.rejects(client.embed(['a'], { timeoutMs: 10 }), { code: 'EMBEDDING_TIMEOUT' });
  assert.equal(client.available(), true);
  mode = 'error';
  for (let i = 0; i < 3; i += 1) await assert.rejects(client.embed(['a'], { timeoutMs: 50 }), { code: 'EMBEDDING_FAILED' });
  assert.equal(client.available(), false);
});

test('缺少依赖包时立即停用', async () => {
  const { forkImpl } = fakeFork(() => ({ error: 'EMBEDDING_PACKAGE_MISSING' }));
  const client = new EmbeddingClient({ modelRoot: '/m', forkImpl, isInstalled: () => true, logger: quiet });
  await assert.rejects(client.embed(['a']), { code: 'EMBEDDING_PACKAGE_MISSING' });
  assert.equal(client.available(), false);
});

test('子进程退出时在途请求立即失败', async () => {
  const { forkImpl, children } = fakeFork(() => null);
  const client = new EmbeddingClient({ modelRoot: '/m', forkImpl, isInstalled: () => true, logger: quiet });
  const pending = client.embed(['a'], { timeoutMs: 5000 });
  children[0].kill();
  await assert.rejects(pending, { code: 'EMBEDDING_PROCESS_EXITED' });
});

const modelDir = process.env.LUNARA_EMBEDDING_TEST_MODEL_DIR;
test('真实本地模型：中英改述能拉近相似度', { skip: !isModelInstalled(modelDir) && '未设置 LUNARA_EMBEDDING_TEST_MODEL_DIR' }, async () => {
  const client = new EmbeddingClient({ modelRoot: modelDir });
  try {
    const [fact, query, other, drinkFact, drinkQuery] = await client.embed(['我对芒果过敏', '推荐点夏天的水果吧',
      '我收藏了一张 1975 年的爵士黑胶', '我不喝酒', 'Planning a party this weekend, what drinks should I get?']);
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    assert.ok(dot(fact, query) > dot(other, query) + 0.2);
    assert.ok(dot(drinkFact, drinkQuery) > dot(other, drinkQuery));
  } finally {
    client.close();
  }
});
