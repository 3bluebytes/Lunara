import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettingsSnapshot, updateSettings } from '../server/settingsService.js';
import { SettingsHttpService } from '../server/services/RuntimeInfoServices.js';

function fixture(saved) {
  const prefs = new Map(saved ? [['settings', JSON.stringify(saved)]] : []);
  const state = { getPref: key => prefs.get(key) ?? null, setPref: (key, value) => prefs.set(key, value) };
  const tts = { getVoice: () => 'v1', setVoice: () => {} };
  return { state, tts, prefs, stored: () => JSON.parse(prefs.get('settings') || '{}') };
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('未配置推荐的用户看到均分，且不会因此被写入一条偏好', async () => {
  const f = fixture({ source: 'ncm', primarySource: 'qq', voice: 'v1' });
  const snapshot = await getSettingsSnapshot(f);
  assert.deepEqual(snapshot.recommendationWeights, { qq: 0.5, ncm: 0.5 });
  await updateSettings({ model: 'm' }, f);
  assert.equal(f.stored().recommendationWeights, undefined, '没动过滑块就不落盘，删掉偏好即回到现状');
});

test('用户调整后的比例落盘、归一，并在下次读取时保留', async () => {
  const f = fixture({ source: 'ncm', primarySource: 'qq' });
  await updateSettings({ recommendationWeights: { qq: 70, ncm: 30 } }, f);
  assert.ok(close(f.stored().recommendationWeights.qq, 0.7));
  const again = await getSettingsSnapshot(f);
  assert.ok(close(again.recommendationWeights.qq, 0.7));
  // 只改别的设置时不能顺手把权重重置成均分。
  await updateSettings({ primarySource: 'ncm' }, f);
  assert.ok(close(f.stored().recommendationWeights.ncm, 0.3));
});

test('目录源不进权重，非法载荷退回均分而不是写坏配置', async () => {
  const f = fixture({ source: 'ncm', primarySource: 'qq' });
  await updateSettings({ recommendationWeights: { qq: 0.5, ncm: 0.5, apple: 1 } }, f);
  assert.equal(f.stored().recommendationWeights.apple, undefined, '仅可跳转的源不占播放配额');
  await updateSettings({ recommendationWeights: { qq: 0, ncm: 0 } }, f);
  assert.ok(close(f.stored().recommendationWeights.qq, 0.5));
});

test('设置快照的每个可播源带目标份额，目录源不带', async () => {
  const f = fixture({ source: 'ncm', primarySource: 'qq', recommendationWeights: { qq: 0.6, ncm: 0.4 } });
  const http = new SettingsHttpService({ state: f.state, tts: f.tts,
    getSnapshot: getSettingsSnapshot, update: updateSettings,
    sourceHealth: async () => [{ id: 'qq', state: 'ready', since: 1, authenticated: true }] });
  const snapshot = await http.snapshot();
  const byId = Object.fromEntries(snapshot.options.source.map(source => [source.id, source]));
  assert.ok(close(byId.qq.weight, 0.6));
  assert.ok(close(byId.ncm.weight, 0.4));
  assert.equal(byId.apple, undefined, 'Apple 占位不再作为接入源');
  assert.equal(byId.qq.state, 'ready', '健康状态与权重同时存在');
});
