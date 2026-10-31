// createMusicSourceWiring.test.js — 内置音乐源服务的生命周期接线契约

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMusicSourceComponent } from './createMusicSourceWiring.js';

function fakeNcm(baseUrl = 'http://127.0.0.1:3000') {
  const calls = [];
  return {
    calls,
    getBaseUrl: () => baseUrl,
    setBaseUrl: url => { calls.push(url); },
  };
}

test('start 把内置服务的实际地址同步给客户端', async () => {
  const ncm = fakeNcm();
  const component = createMusicSourceComponent({
    ncm,
    startEmbedded: async () => ({ mode: 'embedded', baseUrl: 'http://127.0.0.1:3011', stop: async () => {} }),
  });
  await component.start();
  assert.deepEqual(ncm.calls, ['http://127.0.0.1:3011']);
});

test('复用既有服务时不改写基地址', async () => {
  const ncm = fakeNcm();
  const component = createMusicSourceComponent({
    ncm,
    startEmbedded: async () => ({ mode: 'reused', baseUrl: 'http://127.0.0.1:3000', stop: async () => {} }),
  });
  await component.start();
  assert.deepEqual(ncm.calls, []);
});

test('内置服务不可用时不抛错、不改基地址', async () => {
  const ncm = fakeNcm();
  const component = createMusicSourceComponent({ ncm, startEmbedded: async () => null });
  await component.start();
  assert.deepEqual(ncm.calls, []);
});

test('stop 只关闭自己持有的句柄，重复 stop 安全', async () => {
  let stops = 0;
  const ncm = fakeNcm();
  const component = createMusicSourceComponent({
    ncm,
    startEmbedded: async () => ({ mode: 'embedded', baseUrl: 'http://127.0.0.1:3000', stop: async () => { stops += 1; } }),
  });
  await component.start();
  await component.stop();
  await component.stop();
  assert.equal(stops, 1);
});

test('缺少 ncm 客户端时在装配期报错，而不是运行时静默失效', () => {
  assert.throws(() => createMusicSourceComponent({}), /requires the ncm provider/);
});
