import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualPersonRegistry } from '../virtual-person/VirtualPersonRegistry.js';
import * as VoiceDirectory from '../station/VoiceDirectory.js';
import { DEFAULT_FREE_VOICE, readCustomTtsConfig, resetCustomTtsConfigForTest,
  seedDefaultFreeVoice, seedFromLegacyMinimax } from '../ttsCustomConfig.js';
import { readTtsFallbackConfig, resetTtsFallbackConfigForTest } from '../ttsFallbackConfig.js';
import { createTtsCustomService } from './ttsCustomService.js';
import { TtsSynthesisError } from './TtsProvider.js';

test('fresh default resolves to consent-gated Edge; enabling needs no discovery, disabling blocks speech again', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-edge-default-'));
  const env = { LUNARA_DATA_DIR: dir, LUNARA_DB_PATH: join(dir, 'state.db'),
    LUNARA_CONFIG_DIR: join(dir, 'config'), LUNARA_TTS_CACHE_DIR: join(dir, 'cache'), MINIMAX_VOICE_ID: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  resetCustomTtsConfigForTest(); resetTtsFallbackConfigForTest(); VoiceDirectory.reset();
  const people = new VirtualPersonRegistry().initialize();
  let tts;
  t.after(() => {
    people.close();
    tts?.registry.unregister('free-edge');
    resetCustomTtsConfigForTest(); resetTtsFallbackConfigForTest(); VoiceDirectory.reset();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  let network = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('network forbidden in fixture'); });
  tts = await import('../tts.js');
  const { createPersonVoice, syncCustomVoices } = await import('./personVoice.js');
  const personVoice = createPersonVoice();
  const root = people.get('lunara');
  assert.equal(root.voiceProfileId, DEFAULT_FREE_VOICE.profileId);
  assert.equal(tts.getVoice(), root.voiceProfileId, 'gateway and root share the same default identity');
  assert.equal(seedFromLegacyMinimax({ env: {}, collectLegacyVoiceSelections: () => [root.voiceProfileId] }).seeded, false);
  assert.equal(seedDefaultFreeVoice({ voiceProfileId: root.voiceProfileId }).seeded, true);
  syncCustomVoices();
  const config = readCustomTtsConfig();
  assert.deepEqual(config.endpoints, []);
  assert.deepEqual(config.voices, [{ ...DEFAULT_FREE_VOICE }]);
  assert.equal(tts.registry.has('free-edge'), false);
  assert.equal(readTtsFallbackConfig().freeVoicesEnabled, false);
  assert.equal(readTtsFallbackConfig().consentAt, null);
  assert.equal(existsSync(join(dir, 'config/tts-fallback.json')), false);
  assert.equal(personVoice.resolvePersonVoice(root.voiceProfileId).unavailable, true);
  const [pending] = VoiceDirectory.listResolvedVoiceProfiles();
  assert.match(pending.sourceLabel, /免费声音（Edge）.*未启用/);
  assert.equal(pending.sourceProvider, 'free-edge');
  await assert.rejects(personVoice.synthesizeForPerson('确认前不发送', { voiceProfileId: root.voiceProfileId }), { code: 'TTS_PROVIDER_UNAVAILABLE' });
  assert.equal(network, 0);

  const service = createTtsCustomService({ onConfigChanged: syncCustomVoices });
  assert.match(service.saveFallback({ freeVoicesEnabled: true }).error, /确认/);
  assert.equal(tts.registry.has('free-edge'), false, 'no consent means no provider');
  const saved = service.saveFallback({ freeVoicesEnabled: true, consent: true });
  assert.equal(saved.fallback.freeVoicesEnabled, true);
  assert.ok(saved.fallback.consentAt);
  assert.deepEqual(personVoice.resolvePersonVoice(root.voiceProfileId), {
    profileId: root.voiceProfileId, providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural',
    isFallback: false, unavailable: false,
  });
  assert.equal(VoiceDirectory.listResolvedVoiceProfiles()[0].sourceLabel, '免费声音（Edge）');
  assert.equal(network, 0, 'enabling does not fetch lists or synthesize automatically');
  const calls = [];
  t.mock.method(tts.registry.get('free-edge'), 'synth', async (text, options) => {
    calls.push([text, options.voiceRef]);
    throw new TtsSynthesisError('offline-edge-stub', { providerId: 'free-edge' });
  });
  await assert.rejects(personVoice.synthesizeForPerson('确认后的测试句', { voiceProfileId: root.voiceProfileId }), /offline-edge-stub/);
  assert.deepEqual(calls, [['确认后的测试句', 'zh-CN-XiaoxiaoNeural']], 'explicit root synthesis targets Edge, not MiniMax or a substitute');
  assert.equal(network, 0);

  service.saveFallback({ freeVoicesEnabled: false });
  assert.equal(tts.registry.has('free-edge'), false);
  await assert.rejects(personVoice.synthesizeForPerson('关闭后不发送', { voiceProfileId: root.voiceProfileId }), { code: 'TTS_PROVIDER_UNAVAILABLE' });
  assert.equal(network, 0);
  resetCustomTtsConfigForTest(); resetTtsFallbackConfigForTest();
  syncCustomVoices();
  assert.equal(readTtsFallbackConfig().freeVoicesEnabled, false, 'saved disabled choice survives reload');
  assert.equal(seedDefaultFreeVoice({ voiceProfileId: root.voiceProfileId }).seeded, false);
});
