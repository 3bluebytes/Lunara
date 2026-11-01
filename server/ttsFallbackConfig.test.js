// 免费声音开关与代读兜底配置：默认关闭、开启必须带知情确认、目标只接受两种形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = await import('./ttsFallbackConfig.js');

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-fallback-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  config.resetTtsFallbackConfigForTest();
  try {
    return run(dir);
  } finally {
    delete process.env.LUNARA_CONFIG_DIR;
    config.resetTtsFallbackConfigForTest();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('默认全部关闭，没有确认时间和目标', () => withTempDir(() => {
  assert.deepEqual(config.readTtsFallbackConfig(), {
    version: 1, freeVoicesEnabled: false, consentAt: null, fallbackEnabled: false, fallbackTarget: null,
  });
  assert.equal(config.effectiveFallbackTarget(), null);
}));

test('开启免费声音必须带知情确认，否则拒绝且不写文件', () => withTempDir(dir => {
  assert.throws(() => config.saveTtsFallbackConfig({ freeVoicesEnabled: true }), /确认/);
  assert.throws(() => readFileSync(join(dir, 'tts-fallback.json')), /ENOENT/);
  assert.equal(config.readTtsFallbackConfig().freeVoicesEnabled, false);
}));

test('确认后开启：记下确认时间，代读默认开、目标默认晓晓，文件 0600', { skip: process.platform === 'win32' ? 'POSIX 文件权限语义,Windows 不适用' : false }, () => withTempDir(dir => {
  const saved = config.saveTtsFallbackConfig({ freeVoicesEnabled: true, consent: true }, { now: () => 1761523200000 });
  assert.equal(saved.freeVoicesEnabled, true);
  assert.equal(saved.consentAt, '2025-10-27T00:00:00.000Z');
  assert.equal(saved.fallbackEnabled, true);
  assert.deepEqual(saved.fallbackTarget, { providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural' });
  assert.equal(statSync(join(dir, 'tts-fallback.json')).mode & 0o777, 0o600);
  assert.deepEqual(config.effectiveFallbackTarget(), { providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural' });
}));

test('关掉免费声音后 Edge 目标失效，但声音池目标仍可代读', () => withTempDir(() => {
  config.saveTtsFallbackConfig({ freeVoicesEnabled: true, consent: true });
  config.saveTtsFallbackConfig({ freeVoicesEnabled: false });
  assert.equal(config.readTtsFallbackConfig().fallbackEnabled, true);
  assert.equal(config.effectiveFallbackTarget(), null);
  config.saveTtsFallbackConfig({ fallbackTarget: { profileId: 'vp_cx_0123abcd' } });
  assert.deepEqual(config.effectiveFallbackTarget(), { profileId: 'vp_cx_0123abcd' });
  config.saveTtsFallbackConfig({ fallbackEnabled: false });
  assert.equal(config.effectiveFallbackTarget(), null);
}));

test('不合法的目标被拒绝', () => withTempDir(() => {
  for (const target of [{ providerId: 'custom', voiceId: 'x' }, { providerId: 'free-edge', voiceId: "x' y" }, { profileId: 'vp_sy_1' }, 'free-edge']) {
    assert.throws(() => config.saveTtsFallbackConfig({ fallbackTarget: target }), /目标/);
  }
  assert.deepEqual(config.saveTtsFallbackConfig({ fallbackTarget: null }).fallbackTarget, null);
}));

test('再次开启已确认过的免费声音仍然要求本次确认，并刷新确认时间', () => withTempDir(() => {
  config.saveTtsFallbackConfig({ freeVoicesEnabled: true, consent: true }, { now: () => 1000 });
  config.saveTtsFallbackConfig({ freeVoicesEnabled: false });
  assert.throws(() => config.saveTtsFallbackConfig({ freeVoicesEnabled: true }), /确认/);
  const saved = config.saveTtsFallbackConfig({ freeVoicesEnabled: true, consent: true }, { now: () => 2000 });
  assert.equal(saved.consentAt, new Date(2000).toISOString());
}));
