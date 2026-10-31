import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LUNARA_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'lunara-settings-service-'));

const { getSettingsSnapshot, updateSettings, restoreRuntimeSettings } = await import('./settingsService.js');

function makeDeps(initial = {}) {
  let stored = JSON.stringify(initial);
  let voice = initial.voice || 'voice-default';
  return {
    state: {
      getPref: () => stored,
      setPref: (_key, value) => { stored = value; },
    },
    tts: {
      getVoice: () => voice,
      setVoice: value => { voice = value; },
    },
    inspect: () => ({ stored: JSON.parse(stored), voice }),
  };
}

test('设置保存后热生效，state.db 不再保存 provider 或 apiKey', async () => {
  const deps = makeDeps({ llm: 'claude-cli', source: 'ncm', primarySource: 'qq' });
  const result = await updateSettings({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'top-secret',
    model: 'agent-model',
    source: 'qq',
    primarySource: 'ncm',
  }, { ...deps, ttsVoiceIds: ['voice-default'] });

  assert.equal(result.ready, true);
  assert.deepEqual(result.current.llm, {
    baseUrl: 'https://gateway.test/v1',
    model: 'agent-model',
    apiKeySet: true,
    ready: true,
  });
  assert.deepEqual(deps.inspect().stored, {
    source: 'qq',
    voice: 'voice-default',
    primarySource: 'ncm',
    playbackSourceMode: 'multi',
  });
  assert.equal(JSON.stringify(result).includes('top-secret'), false);
});

test('GET snapshot 脱敏，旧 llm provider 字段被安全忽略', async () => {
  const deps = makeDeps({ llm: 'claude-cli', source: 'qq', primarySource: 'ncm' });
  const snapshot = await getSettingsSnapshot(deps);
  assert.equal(snapshot.llm.apiKeySet, true);
  assert.equal('apiKey' in snapshot.llm, false);
  assert.equal(snapshot.source, 'qq');
  assert.equal(snapshot.primarySource, 'ncm');
});

test('启动恢复只应用非敏感运行偏好', () => {
  const previous = process.env.PRIMARY_SOURCE;
  const deps = makeDeps({ llm: 'claude-cli', voice: 'voice-a', primarySource: 'ncm' });
  const restored = restoreRuntimeSettings(deps);
  assert.equal(restored.llm, 'claude-cli');
  assert.equal(deps.inspect().voice, 'voice-a');
  assert.equal(process.env.PRIMARY_SOURCE, 'ncm');
  if (previous === undefined) delete process.env.PRIMARY_SOURCE;
  else process.env.PRIMARY_SOURCE = previous;
});
