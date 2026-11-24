import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPersonaExpandPrompt,
  buildPersonaPrompt,
  extractExpandedPersonaDocument,
  generatePersona,
  personaToMarkdown,
} from './PersonaGenerator.js';
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
    const longSupplement = '像熟悉的老朋友，平时在海边经营一家独立书店，总是记得对方上次随口提过的歌手与季节。';
    const persona = await generatePersona({
      personaPreset: preset.id,
      personaHint: longSupplement,
    });

    // 名字来自预设的名字候选，不再来自音色。
    assert.ok(preset.nameCandidates.includes(persona.name), `名字应来自候选：${persona.name}`);
    assert.equal(persona.supplement, longSupplement);
    assert.equal(persona.character, preset.character);
    assert.ok(persona.interpersonalDistance);
    assert.ok(persona.boundaries);
    assert.ok(persona.personaDescription);
    assert.ok(persona.speakingStyle);

    const md = personaToMarkdown(persona, persona.name);
    assert.ok(md.includes(longSupplement), 'markdown 必须保留完整补充设定');
    assert.ok(md.includes(preset.interpersonalDistance), 'markdown 必须写出人际距离');
    assert.ok(md.includes(preset.boundaries), 'markdown 必须写出相处分寸');
  });
});

test('buildPersonaExpandPrompt 与 extractExpandedPersonaDocument 满足 JSON 结构化与清洗契约', () => {
  const preset = getPersonaPreset('morning_bright');
  const prompt = buildPersonaExpandPrompt({ draft: '一个爱讲冷笑话的鼓手', displayName: '阿乐', preset });
  assert.match(prompt, /JSON/);
  assert.match(prompt, /一个爱讲冷笑话的鼓手/);
  assert.match(prompt, /轻快晨间/);

  const cleaned = extractExpandedPersonaDocument('```json\n{"personaDocument":"# 阿乐\\n\\n## 我是谁\\n爱敲鼓的朋友。"}\n```');
  assert.equal(cleaned, '## 我是谁\n爱敲鼓的朋友。');
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

test('人格生成把说话方式写成随情境的倾向与原因，不发明固定口癖', () => {
  const preset = getPersonaPreset('late_night_companion');
  const prompt = buildPersonaPrompt(preset, '');
  const speechField = prompt.split('\n').find(line => line.includes('"speechHabit"')) || '';
  assert.match(speechField, /情境/, '说话习惯要写随情境的变化');
  assert.match(speechField, /为什么|原因/, '说话习惯要写原因');
  assert.doesNotMatch(speechField, /常用句式/);
  assert.match(prompt, /不要发明固定的口头禅、尾音、语气词或标志性动作/);

  const expand = buildPersonaExpandPrompt({ draft: '说话爱带一句"好家伙"的鼓手', displayName: '阿乐', preset });
  assert.match(expand, /口癖[^\n]*必须完整保留/, '草稿里的口癖照常保留');
  assert.match(expand, /不要发明固定的口头禅、尾音、语气词或标志性动作/);
  assert.doesNotMatch(expand, /句子长短节奏/);
});
