import test from 'node:test';
import assert from 'node:assert/strict';

const VoiceDirectory = await import('./VoiceDirectory.js');

function fresh(options) {
  VoiceDirectory.reset();
  VoiceDirectory.initialize(null, options);
}

test('预设身份的 id 与供应商 voice id 不是同一个值', t => {
  fresh();
  for (const profile of VoiceDirectory.listVoiceProfiles({ includeLegacy: true })) {
    assert.match(profile.id, /^vp_/, `${profile.id} 应是 Lunara 自有稳定 id`);
    assert.notEqual(profile.id, profile.sourceVoiceId, 'id 不得等于供应商 voice id');
  }
});

test('历史供应商 voice id 仍可解析到稳定身份', () => {
  fresh();
  // 这三个是数据库中真实在用的值。
  assert.equal(VoiceDirectory.getVoiceProfile('Chinese (Mandarin)_Sweet_Lady').id, 'vp_sweet_lady');
  assert.equal(VoiceDirectory.getVoiceProfile('Chinese (Mandarin)_Mature_Woman').id, 'vp_mature_woman');
  assert.equal(VoiceDirectory.getVoiceProfile('female-chengshu-jingpin').id, 'vp_chengshu_male');
});

test('被改名前的旧显示名仍可解析（改名不得让旧引用失声）', () => {
  fresh();
  // 这四个显示名在迁移中被改掉了；任何仍引用旧名字的数据或调用方必须继续解析。
  assert.equal(VoiceDirectory.getVoiceProfile('甜美女声').id, 'vp_sweet_lady');
  assert.equal(VoiceDirectory.getVoiceProfile('电台男主播').id, 'vp_radio_host');
  assert.equal(VoiceDirectory.getVoiceProfile('傲娇御姐').id, 'vp_mature_woman');
  assert.equal(VoiceDirectory.getVoiceProfile('成熟精品').id, 'vp_chengshu_male');
});

test('稳定 id 自身也可解析', () => {
  fresh();
  assert.equal(VoiceDirectory.getVoiceProfile('vp_sweet_lady').id, 'vp_sweet_lady');
});

test('未知引用返回 null 而不是抛错', () => {
  fresh();
  assert.equal(VoiceDirectory.getVoiceProfile('不存在的音色'), null);
  assert.equal(VoiceDirectory.getVoiceProfile(''), null);
  assert.equal(VoiceDirectory.getVoiceProfile(null), null);
  assert.equal(VoiceDirectory.resolveVoiceRef('不存在的音色'), null);
});

test('自定义接口保留声音保持身份，改名不改 id；不可用时不冒充系统声音', () => {
  fresh();
  VoiceDirectory.setCustomVoiceEntries([{ sourceVoiceId: 'my-relay-voice', displayName: '自选声线' }]);
  const resolved = VoiceDirectory.resolveVoiceRef('my-relay-voice', { providers: new Set(['custom', 'system']) });
  assert.equal(resolved.providerId, 'custom');
  assert.equal(resolved.voiceId, 'my-relay-voice');
  assert.equal(resolved.isFallback, false);
  VoiceDirectory.setCustomVoiceEntries([{ sourceVoiceId: 'my-relay-voice', displayName: '改名' }]);
  assert.equal(VoiceDirectory.resolveVoiceRef('my-relay-voice', { providers: new Set(['custom']) }).profileId, resolved.profileId);
  assert.equal(VoiceDirectory.resolveVoiceRef(resolved.profileId, { providers: new Set(['system']) }).unavailable, true);
});

test('全部历史预设及旧别名保留，但不再回落到任何系统声音', () => {
  fresh();
  for (const preset of VoiceDirectory.PRESET_VOICES) {
    assert.equal(VoiceDirectory.getVoiceProfile(preset.id).id, preset.id);
    for (const providers of [new Set(), new Set(['custom']), new Set(['system'])]) {
      const resolved = VoiceDirectory.resolveVoiceRef(preset.id, { providers });
      assert.equal(resolved.unavailable, true, `${preset.id} 在系统语音关闭后必须如实不可用`);
      assert.equal(resolved.providerId, null);
    }
  }
  for (const [ref, id] of Object.entries(VoiceDirectory.LEGACY_ALIASES)) {
    assert.equal(VoiceDirectory.resolveProfileId(ref), id);
  }
  assert.equal(VoiceDirectory.resolveProfileId('zf_002'), 'vp_sweet_lady');
  assert.equal(VoiceDirectory.listVoiceProfiles().length, 0);
  assert.equal(VoiceDirectory.listResolvedVoiceProfiles().length, 0, '退休预设不进入新声音选择');
});

test('只有自定义接口保留声音可解析；系统语音不再出现', () => {
  fresh();
  VoiceDirectory.setCustomVoiceEntries([{ sourceVoiceId: 'same', displayName: '接口声' }]);
  const profiles = VoiceDirectory.listResolvedVoiceProfiles({ providers: new Set(['custom']) });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].sourceLabel, '自定义接口');
  assert.equal(profiles[0].isFallback, false);
  const withoutCustom = VoiceDirectory.listResolvedVoiceProfiles({ providers: new Set() });
  assert.equal(withoutCustom[0].unavailable, true);
  assert.equal(withoutCustom[0].sourceLabel, '未就绪');
  assert.equal(VoiceDirectory.setSystemVoiceEntries, undefined, '系统声音入口必须彻底移除');
});

test('探测失败的安全默认不再假设任何 provider', () => {
  fresh({ getAvailableProviders: () => { throw Error('probe failed'); } });
  assert.equal(VoiceDirectory.resolveVoiceRef('vp_sweet_lady').unavailable, true);
});

test('旧签名传入的供应商列表被登记为别名而不改变预设', () => {
  VoiceDirectory.reset();
  VoiceDirectory.initialize([{ id: 'some-legacy-voice', name: '温润男声' }]);
  assert.equal(VoiceDirectory.getVoiceProfile('some-legacy-voice').id, 'vp_gentleman');
  assert.equal(VoiceDirectory.getVoiceProfile('vp_gentleman').displayName, '温润男声');
});

test('reset 后可重新初始化（测试隔离）', () => {
  fresh();
  assert.equal(VoiceDirectory.isInitialized(), true);
  VoiceDirectory.reset();
  assert.equal(VoiceDirectory.isInitialized(), false);
  assert.deepEqual(VoiceDirectory.listVoiceProfiles(), []);
});

test('多接口声音池：每把声音解析到自己的接口与 model；只有所属接口不可用时才不可用', () => {
  fresh();
  VoiceDirectory.setCustomVoiceEntries([
    { profileId: 'vp_cx_d54f990d', providerId: 'custom', providerName: 'MiniMax', sourceVoiceId: 'female-shaonv', displayName: '少女' },
    { profileId: 'vp_cx_aaaa0001', providerId: 'custom-breeze', providerName: 'Breeze', sourceVoiceId: 'voc_1', displayName: '暖心', model: 'breeze-tts-2' },
    { profileId: 'vp_cx_aaaa0002', providerId: 'custom-breeze', providerName: 'Breeze', sourceVoiceId: 'female-shaonv', displayName: '同名' },
  ]);
  const both = new Set(['custom', 'custom-breeze']);
  const minimax = VoiceDirectory.resolveVoiceRef('vp_cx_d54f990d', { providers: both });
  assert.deepEqual([minimax.providerId, minimax.voiceId, minimax.params], ['custom', 'female-shaonv', undefined]);
  const breeze = VoiceDirectory.resolveVoiceRef('vp_cx_aaaa0001', { providers: both });
  assert.deepEqual([breeze.providerId, breeze.voiceId, breeze.params], ['custom-breeze', 'voc_1', { model: 'breeze-tts-2' }]);
  assert.equal(VoiceDirectory.resolveProfileId('female-shaonv'), 'vp_cx_d54f990d', '源 id 别名留给第一个登记的声音');
  const onlyBreeze = new Set(['custom-breeze']);
  assert.equal(VoiceDirectory.resolveVoiceRef('vp_cx_d54f990d', { providers: onlyBreeze }).unavailable, true);
  assert.equal(VoiceDirectory.resolveVoiceRef('vp_cx_aaaa0001', { providers: onlyBreeze }).unavailable, false);
  const labels = VoiceDirectory.listResolvedVoiceProfiles({ providers: both }).map(profile => [profile.id, profile.sourceLabel]);
  assert.deepEqual(labels, [['vp_cx_d54f990d', 'MiniMax'], ['vp_cx_aaaa0001', 'Breeze'], ['vp_cx_aaaa0002', 'Breeze']]);
  VoiceDirectory.setCustomVoiceEntries([{ profileId: 'vp_cx_aaaa0001', providerId: 'custom-breeze', sourceVoiceId: 'voc_1' }]);
  assert.equal(VoiceDirectory.resolveProfileId('female-shaonv'), null, '移除的声音不留陈旧别名');
});
