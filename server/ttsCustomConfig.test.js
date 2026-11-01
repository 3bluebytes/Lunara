import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configModule = await import('./ttsCustomConfig.js');
const {
  readCustomTtsConfig, saveCustomTtsConfig, publicCustomTtsConfig,
  customTtsConfigured, seedFromLegacyMinimax, resetCustomTtsConfigForTest,
  removeCustomTtsEndpoint, getCustomTtsEndpoint, customVoiceProfileId,
} = configModule;

function makeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-custom-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  resetCustomTtsConfigForTest();
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    resetCustomTtsConfigForTest();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const endpointOf = (id = 'custom') => readCustomTtsConfig().endpoints.find(endpoint => endpoint.id === id);

test('保存与读取往返；apiKey 只写不读出（对外只有 hasKey）', { skip: process.platform === 'win32' ? 'POSIX 文件权限语义,Windows 不适用' : false }, t => {
  const dir = makeConfigDir(t);
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://tts.example/v1', apiKey: 'sk-secret', model: 'tts-1' } });
  const endpoint = endpointOf();
  assert.equal(endpoint.baseUrl, 'https://tts.example/v1');
  assert.equal(endpoint.apiKey, 'sk-secret');
  assert.equal(endpoint.protocol, 'openai', '未指定协议时默认 openai，保持旧行为');
  const view = publicCustomTtsConfig();
  assert.equal(view.endpoints[0].hasKey, true);
  assert.doesNotMatch(JSON.stringify(view), /sk-secret|apiKey/, '对外视图不得包含 key');
  const mode = statSync(join(dir, 'tts-custom.json')).mode & 0o777;
  assert.equal(mode, 0o600, '配置文件必须是 0600');
});

test('旧单接口文件读成 id=custom 的接口，声音沿用旧 profileId', t => {
  const dir = makeConfigDir(t);
  writeFileSync(join(dir, 'tts-custom.json'), JSON.stringify({
    protocol: 'minimax', baseUrl: 'https://api.minimaxi.com', apiKey: 'sk-old', model: 'speech-2.8-hd',
    voices: [{ sourceVoiceId: 'female-shaonv', displayName: '少女音色' }, { sourceVoiceId: 'v2', model: 'speech-2.6-hd' }],
    migratedFromMinimax: true,
  }));
  const config = readCustomTtsConfig();
  assert.equal(config.version, 2);
  assert.deepEqual(config.endpoints.map(endpoint => [endpoint.id, endpoint.protocol, endpoint.apiKey]), [['custom', 'minimax', 'sk-old']]);
  assert.equal(config.endpoints[0].name, 'MiniMax');
  assert.deepEqual(config.voices.map(voice => [voice.endpointId, voice.sourceVoiceId, voice.profileId, voice.model ?? null]), [
    ['custom', 'female-shaonv', 'vp_cx_d54f990d', null],
    ['custom', 'v2', customVoiceProfileId('custom', 'v2'), 'speech-2.6-hd'],
  ]);
  assert.equal(config.migratedFromMinimax, true);
});

test('新增第二个接口不影响第一个；自动生成 custom-<slug> id，冲突追加序号', t => {
  makeConfigDir(t);
  saveCustomTtsConfig({ endpoint: { id: 'custom', protocol: 'minimax', baseUrl: 'https://mm', apiKey: 'sk-mm', model: 'speech-2.8-hd' },
    voices: [{ endpointId: 'custom', sourceVoiceId: 'female-shaonv', displayName: '少女' }] });
  const first = saveCustomTtsConfig({ endpoint: { name: 'Breeze', protocol: 'breeze', baseUrl: 'https://b', apiKey: 'brz-1', model: 'breeze-tts-2' } });
  assert.equal(first.savedEndpointId, 'custom-breeze');
  const second = saveCustomTtsConfig({ endpoint: { name: 'Breeze', protocol: 'breeze', baseUrl: 'https://b2', apiKey: 'brz-2' } });
  assert.equal(second.savedEndpointId, 'custom-breeze-2');
  const third = saveCustomTtsConfig({ endpoint: { name: '中文名', protocol: 'openai', baseUrl: 'https://o', apiKey: 'sk-o' } });
  assert.equal(third.savedEndpointId, 'custom-openai', '名称没有可用字符时用协议生成');
  const config = readCustomTtsConfig();
  assert.deepEqual(config.endpoints.map(endpoint => endpoint.id), ['custom', 'custom-breeze', 'custom-breeze-2', 'custom-openai']);
  assert.equal(endpointOf('custom').apiKey, 'sk-mm');
  assert.deepEqual(config.voices.map(voice => voice.sourceVoiceId), ['female-shaonv'], '只保存接口时不动声音池');
});

test('更新接口：key 留空保留旧值；未知协议回落 openai；id 只认已有或生成的', t => {
  makeConfigDir(t);
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://tts.example', apiKey: 'sk-old', model: 'm1' } });
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://tts.example/v2', protocol: 'breeze' } });
  assert.equal(endpointOf().apiKey, 'sk-old');
  assert.equal(endpointOf().baseUrl, 'https://tts.example/v2');
  assert.equal(endpointOf().protocol, 'breeze');
  saveCustomTtsConfig({ endpoint: { id: 'custom', protocol: 'vendor-x' } });
  assert.equal(endpointOf().protocol, 'openai', '未知协议不得进配置文件');
  const created = saveCustomTtsConfig({ endpoint: { id: '../../evil', name: 'x', baseUrl: 'https://x', apiKey: 'k' } });
  assert.match(created.savedEndpointId, /^custom-[a-z0-9-]+$/, '不存在的 id 不被采信，改为生成');
});

test('声音池：按 (endpointId, sourceVoiceId) 去重；不同接口同名 voice 不同 profileId；孤儿声音丢弃', t => {
  makeConfigDir(t);
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://a', apiKey: 'k' } });
  saveCustomTtsConfig({ endpoint: { name: 'b', baseUrl: 'https://b', apiKey: 'k' } });
  saveCustomTtsConfig({ voices: [
    { endpointId: 'custom', sourceVoiceId: 'same', displayName: '甲' },
    { endpointId: 'custom', sourceVoiceId: 'same', displayName: '重复被丢' },
    { endpointId: 'custom-b', sourceVoiceId: 'same', displayName: '乙', model: 'm2' },
    { endpointId: 'custom-gone', sourceVoiceId: 'orphan' },
    { endpointId: 'custom', sourceVoiceId: '' },
    { endpointId: 'custom', sourceVoiceId: 'v2', profileId: 'vp_cx_deadbeef' },
  ] });
  const voices = readCustomTtsConfig().voices;
  assert.deepEqual(voices.map(voice => [voice.endpointId, voice.sourceVoiceId, voice.displayName]), [
    ['custom', 'same', '甲'], ['custom-b', 'same', '乙'], ['custom', 'v2', 'v2'],
  ]);
  assert.notEqual(voices[0].profileId, voices[1].profileId);
  assert.equal(voices[0].profileId, customVoiceProfileId('custom', 'same'));
  assert.equal(voices[2].profileId, customVoiceProfileId('custom', 'v2'), '客户端给的 profileId 不被采信');
  assert.equal(voices[1].model, 'm2');
});

test('profileId 落盘后改名不变', t => {
  const dir = makeConfigDir(t);
  writeFileSync(join(dir, 'tts-custom.json'), JSON.stringify({ version: 2,
    endpoints: [{ id: 'custom-b', name: 'B', protocol: 'breeze', baseUrl: 'https://b', apiKey: 'k', model: 'm' }],
    voices: [{ endpointId: 'custom-b', sourceVoiceId: 'v', displayName: '旧名', profileId: 'vp_cx_0badf00d' }] }));
  saveCustomTtsConfig({ voices: [{ endpointId: 'custom-b', sourceVoiceId: 'v', displayName: '新名' }] });
  const [voice] = readCustomTtsConfig().voices;
  assert.equal(voice.displayName, '新名');
  assert.equal(voice.profileId, 'vp_cx_0badf00d');
});

test('删除接口一并移除它名下的声音，其他接口不变', t => {
  makeConfigDir(t);
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://a', apiKey: 'k' } });
  saveCustomTtsConfig({ endpoint: { name: 'b', baseUrl: 'https://b', apiKey: 'k' } });
  saveCustomTtsConfig({ voices: [{ endpointId: 'custom', sourceVoiceId: 'a1' }, { endpointId: 'custom-b', sourceVoiceId: 'b1' }] });
  const result = removeCustomTtsEndpoint('custom-b');
  assert.equal(result.removedVoices, 1);
  const config = readCustomTtsConfig();
  assert.deepEqual(config.endpoints.map(endpoint => endpoint.id), ['custom']);
  assert.deepEqual(config.voices.map(voice => voice.sourceVoiceId), ['a1']);
  assert.equal(removeCustomTtsEndpoint('custom-missing').removed, false);
});

test('customTtsConfigured：任一接口有 URL 与 key 即可；getCustomTtsEndpoint 带上本接口声音', t => {
  makeConfigDir(t);
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://tts.example' } });
  assert.equal(customTtsConfigured(), false);
  saveCustomTtsConfig({ endpoint: { name: 'b', baseUrl: 'https://b', apiKey: 'sk-x' },
    voices: [{ endpointId: 'custom', sourceVoiceId: 'a' }] });
  assert.equal(customTtsConfigured(), true);
  saveCustomTtsConfig({ voices: [{ endpointId: 'custom', sourceVoiceId: 'a' }, { endpointId: 'custom-b', sourceVoiceId: 'b' }] });
  assert.deepEqual(getCustomTtsEndpoint('custom-b').voices.map(voice => voice.sourceVoiceId), ['b']);
  assert.equal(getCustomTtsEndpoint('nope'), null);
});

test('seedFromLegacyMinimax：一次性填入 env 与已存声音选择，幂等', t => {
  makeConfigDir(t);
  const fakeState = { getPref: key => (key === 'settings' ? { voice: 'Chinese (Mandarin)_Radio_Host' } : null) };
  const first = seedFromLegacyMinimax({
    env: {
      MINIMAX_BASE_URL: 'https://api.minimaxi.com',
      MINIMAX_API_KEY: 'sk-legacy',
      MINIMAX_MODEL: 'speech-2.8-hd',
      MINIMAX_VOICE_ID: 'Chinese (Mandarin)_Sweet_Lady',
    },
    state: fakeState,
    collectLegacyVoiceSelections: () => ['Chinese (Mandarin)_Mature_Woman', 'Chinese (Mandarin)_Sweet_Lady'],
    displayNameForLegacySource: id => ({ 'Chinese (Mandarin)_Sweet_Lady': '柔声女声', 'Chinese (Mandarin)_Radio_Host': '深夜男主播', 'Chinese (Mandarin)_Mature_Woman': '成熟女声' })[id] || null,
  });
  assert.equal(first.seeded, true);
  const config = readCustomTtsConfig();
  const [endpoint] = config.endpoints;
  assert.equal(endpoint.id, 'custom', '迁移来的接口沿用 custom，旧绑定与缓存不变');
  assert.equal(endpoint.baseUrl, 'https://api.minimaxi.com');
  assert.equal(endpoint.model, 'speech-2.8-hd');
  assert.equal(endpoint.protocol, 'minimax', '旧链路本来就是 MiniMax 协议，迁移如实标记');
  assert.equal(config.migratedFromMinimax, true);
  assert.deepEqual(config.voices.map(v => [v.sourceVoiceId, v.displayName]), [
    ['Chinese (Mandarin)_Sweet_Lady', '柔声女声'],
    ['Chinese (Mandarin)_Radio_Host', '深夜男主播'],
    ['Chinese (Mandarin)_Mature_Woman', '成熟女声'],
  ]);
  // 幂等：第二次不再迁移，且不会覆盖用户后续改动
  saveCustomTtsConfig({ endpoint: { id: 'custom', baseUrl: 'https://my-relay.example' } });
  const second = seedFromLegacyMinimax({ env: {}, state: fakeState, collectLegacyVoiceSelections: () => [] });
  assert.equal(second.seeded, false);
  assert.equal(endpointOf().baseUrl, 'https://my-relay.example');
});

test('seedFromLegacyMinimax：key 缺失时如实留空而不是编造', t => {
  makeConfigDir(t);
  seedFromLegacyMinimax({
    env: { MINIMAX_BASE_URL: 'https://api.minimaxi.com' },
    state: null,
    collectLegacyVoiceSelections: () => [],
  });
  assert.equal(endpointOf().apiKey, '');
  assert.equal(customTtsConfigured(), false);
});

test('声音池可以保留免费声音（endpointId=free-edge），不需要对应的自定义接口', t => {
  makeConfigDir(t);
  const saved = saveCustomTtsConfig({ voices: [
    { endpointId: 'free-edge', sourceVoiceId: 'zh-CN-YunxiNeural', displayName: '云希' },
    { endpointId: 'custom-gone', sourceVoiceId: 'x' },
  ] });
  assert.deepEqual(saved.voices.map(voice => [voice.endpointId, voice.sourceVoiceId, voice.profileId]), [
    ['free-edge', 'zh-CN-YunxiNeural', customVoiceProfileId('free-edge', 'zh-CN-YunxiNeural')],
  ]);
  resetCustomTtsConfigForTest();
  assert.equal(readCustomTtsConfig().voices.length, 1, '重新读取后仍在');
  assert.equal(getCustomTtsEndpoint('free-edge'), null, '免费声音不是自定义接口');
});
