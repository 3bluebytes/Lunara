import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import { buildMusicSourceLaunch } from './start-music-source.mjs';

test('QQ is no longer an independently launched music source', () => {
  assert.throws(() => buildMusicSourceLaunch('qq', {
    root: '/repo',
    env: {},
    fileExists: () => true,
  }), /QQ SDK 已内置/);
});

test('NCM launch checks the package and uses the protected entry, and rejects unknown sources', () => {
  const launch = buildMusicSourceLaunch('ncm', {
    root: '/repo',
    env: {},
    fileExists: () => true,
  });
  // 实现内部用 path.resolve 拼路径：Windows 会把 '/repo/...' 解析为带盘符的绝对路径，断言跟随平台语义。
  assert.deepEqual(launch.args, [resolve('/repo/scripts/ncm-server.mjs')]);
  assert.throws(() => buildMusicSourceLaunch('ncm', {
    root: '/repo', env: {}, fileExists: () => false,
  }), /服务未安装/);
  assert.throws(() => buildMusicSourceLaunch('spotify', {
    root: '/repo', env: {}, fileExists: () => true,
  }), /不支持的独立音乐源/);
});
