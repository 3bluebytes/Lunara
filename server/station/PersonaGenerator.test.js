import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePersona } from './PersonaGenerator.js';
import { getPersonaPreset } from '../persona/personaPresets.js';

function withFallbackMode(fn) {
  const previous = process.env.LUNARA_PERSONA_GENERATION_MODE;
  process.env.LUNARA_PERSONA_GENERATION_MODE = 'fallback';
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.LUNARA_PERSONA_GENERATION_MODE;
    else process.env.LUNARA_PERSONA_GENERATION_MODE = previous;
  });
}

test('explicit fallback mode creates a complete local persona without model access', async () => {
  await withFallbackMode(async () => {
    const preset = getPersonaPreset('literary_lyrical');
    const persona = await generatePersona({
      personaPreset: preset.id,
      personaHint: '像熟悉的老朋友，但不要替用户做决定',
    });

    // 名字来自预设的名字候选，不再来自音色。
    assert.ok(preset.nameCandidates.includes(persona.name), `名字应来自候选：${persona.name}`);
    assert.match(persona.speechHabit, /老朋友/);
    assert.equal(persona.character, preset.character);
    assert.ok(persona.interpersonalDistance);
    assert.ok(persona.boundaries);
    assert.ok(persona.personaDescription);
    assert.ok(persona.speakingStyle);
  });
});

test('fallback ignores any voice profile and never derives personality from it', async () => {
  await withFallbackMode(async () => {
    // 旧签名仍会传入 voiceProfile；迁移期必须被忽略而不是继续驱动人格。
    const persona = await generatePersona({
      personaPreset: 'cool_analytical',
      voiceProfile: {
        displayName: '电台女主播',
        description: '温暖自然',
        styleTags: ['warm'],
        gender: 'female',
      },
      personaHint: '',
    });

    assert.notEqual(persona.name, '电台女主播', '名字不得再取自音色的显示名');
    assert.equal(persona.character, getPersonaPreset('cool_analytical').character,
      '人格必须由人设决定，而不是由音色标签决定');
    assert.equal(JSON.stringify(persona).includes('温暖自然'), false, '音色描述不得渗进人格');
  });
});

test('未知的预设 id 可纠正地失败，而不是静默换成另一个人格', async () => {
  // 旧实现会回落到默认人设：用户选了 A，得到的是 B，且调用方毫无感知。
  await assert.rejects(
    () => generatePersona({ personaPreset: 'bogus_preset', personaHint: '' }),
    /invalid personaPresetId/,
  );
});

test('疑问句里的"叫什么"不会被当成名字', async () => {
  await withFallbackMode(async () => {
    const persona = await generatePersona({
      personaPreset: 'late_night_companion',
      personaHint: '随和一点，叫什么都行',
    });
    assert.notEqual(persona.name, '什么都', '疑问词不得被提取成名字');
    assert.ok(getPersonaPreset('late_night_companion').nameCandidates.includes(persona.name),
      '应回落到预设的名字候选');
  });
});
