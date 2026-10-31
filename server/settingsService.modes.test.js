import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettingsSnapshot, updateSettings } from './settingsService.js';
const fixture = saved => {
  let value = JSON.stringify(saved);
  return { state: { getPref: () => value, setPref: (_, next) => { value = next; } },
    tts: { getVoice: () => 'v', setVoice() {} }, stored: () => JSON.parse(value) };
};
test('legacy stays multi, inactive Apple preference is no longer selectable', async () => {
  const f = fixture({ source: 'apple', primarySource: 'ncm' });
  const snapshot = await getSettingsSnapshot(f);
  assert.equal(snapshot.playbackSourceMode, 'multi');
  assert.equal(snapshot.source, 'ncm');
});
test('single / multi mode roundtrip preserves weights', async () => {
  const f = fixture({ primarySource: 'qq', recommendationWeights: { qq: .7, ncm: .3 } });
  await updateSettings({ playbackSourceMode: 'single', primarySource: 'ncm' }, f);
  assert.equal(f.stored().playbackSourceMode, 'single');
  assert.equal((await getSettingsSnapshot(f)).primarySource, 'ncm');
  await updateSettings({ playbackSourceMode: 'multi' }, f);
  assert.equal(f.stored().recommendationWeights.qq, .7);
});
test('invalid explicit modes and sources do not write', async () => {
  const f = fixture({ primarySource: 'qq' });
  for (const input of [{ playbackSourceMode: 'both' }, { playbackSourceMode: 'single', primarySource: 'apple' }]) {
    await assert.rejects(updateSettings(input, f));
    assert.deepEqual(f.stored(), { primarySource: 'qq' });
  }
});
