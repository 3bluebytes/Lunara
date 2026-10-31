import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMusicSourceLaunch } from './start-music-source.mjs';

test('QQ is no longer an independently launched music source', () => {
  assert.throws(() => buildMusicSourceLaunch('qq', {
    root: '/repo',
    env: {},
    fileExists: () => true,
  }), /QQ SDK 已内置/);
});

test('NCM launch resolves the installed package entry and rejects unknown sources', () => {
  const launch = buildMusicSourceLaunch('ncm', {
    root: '/repo',
    env: {},
    fileExists: () => true,
  });
  assert.deepEqual(launch.args, ['/repo/node_modules/NeteaseCloudMusicApi/app.js']);
  assert.throws(() => buildMusicSourceLaunch('spotify', {
    root: '/repo', env: {}, fileExists: () => true,
  }), /不支持的独立音乐源/);
});
