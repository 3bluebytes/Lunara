import test from 'node:test';
import assert from 'node:assert/strict';

const { PERSONA_PRESETS, listPersonaPresets, getPersonaPreset, defaultPersonaPreset } =
  await import('./personaPresets.js');
const { generatePersona, resolvePreset } = await import('../station/PersonaGenerator.js');

/** 每个预设必须能独立支撑一个完整人格，且六个维度都有实质内容。 */
const REQUIRED_DIMENSIONS = ['character', 'speechHabit', 'emotionalExpression', 'musicTaste',
  'interpersonalDistance', 'backgroundStory', 'boundaries'];

test('提供六套预设人设', () => {
  assert.equal(PERSONA_PRESETS.length, 6);
  const ids = PERSONA_PRESETS.map(preset => preset.id);
  assert.deepEqual([...ids].sort(), [
    'cool_analytical', 'late_night_companion', 'literary_lyrical',
    'morning_bright', 'music_obsessive', 'retro_broadcaster',
  ]);
});

test('每个预设都有完整的六个维度与名字候选', () => {
  for (const preset of PERSONA_PRESETS) {
    for (const dimension of REQUIRED_DIMENSIONS) {
      const value = String(preset[dimension] || '').trim();
      assert.ok(value.length >= 4, `${preset.id} 的 ${dimension} 过短或缺失：${value}`);
    }
    assert.ok(Array.isArray(preset.nameCandidates) && preset.nameCandidates.length >= 3,
      `${preset.id} 需要至少 3 个名字候选`);
    assert.ok(preset.displayName && preset.summary, `${preset.id} 缺少名称或定位`);
  }
});

test('预设不引用任何音色、provider 或性别', () => {
  // 这是解耦的核心约束：人设与声音正交。
  for (const preset of PERSONA_PRESETS) {
    const text = JSON.stringify(preset);
    for (const forbidden of ['voice', 'Voice', '音色', 'provider', 'kokoro', 'minimax', 'zf_', 'zm_', 'gender', '性别']) {
      assert.equal(text.includes(forbidden), false, `${preset.id} 不应包含 ${forbidden}`);
    }
  }
});

test('六个维度上彼此有区分度，不是同一个人的变体', () => {
  const characters = PERSONA_PRESETS.map(preset => preset.character);
  assert.equal(new Set(characters).size, characters.length, '性格底色不得重复');
  const distances = PERSONA_PRESETS.map(preset => preset.interpersonalDistance);
  assert.equal(new Set(distances).size, distances.length, '人际距离不得重复');
});

test('名字候选之间不互相重复，且不含受保护的真实人名', () => {
  const all = PERSONA_PRESETS.flatMap(preset => preset.nameCandidates);
  assert.equal(new Set(all).size, all.length, '名字候选不应重复使用');
  for (const name of all) {
    assert.ok(name.length >= 2 && name.length <= 4, `名字长度应合理：${name}`);
  }
});

test('getPersonaPreset 按 id 取用，未知 id 返回 null', () => {
  assert.equal(getPersonaPreset('late_night_companion').displayName, '深夜陪伴');
  assert.equal(getPersonaPreset('nope'), null);
  assert.equal(getPersonaPreset(''), null);
});

test('listPersonaPresets 返回副本，外部修改不影响预设', () => {
  const first = listPersonaPresets();
  first[0].displayName = '被改坏了';
  first[0].nameCandidates.push('入侵者');
  assert.equal(getPersonaPreset('late_night_companion').displayName, '深夜陪伴');
  assert.equal(getPersonaPreset('late_night_companion').nameCandidates.includes('入侵者'), false);
});

test('resolvePreset 接受对象、id 或缺失', () => {
  assert.equal(resolvePreset('morning_bright').id, 'morning_bright');
  assert.equal(resolvePreset({ id: 'custom', displayName: '自定义' }).id, 'custom');
  assert.equal(resolvePreset(null).id, defaultPersonaPreset().id, '缺失时用默认人设');
  // 未知的预设 id 必须可纠正地失败：静默换成默认人设等于"选了 A，得到 B"。
  assert.throws(() => resolvePreset('不存在'), /invalid personaPresetId/);
  assert.throws(() => resolvePreset('bogus_preset'), /invalid personaPresetId/);
  assert.equal(resolvePreset('').id, defaultPersonaPreset().id, '空 id 视为缺失');
});

//
// 下面是本组最重要的断言：人格由人设决定，与声音无关。
//
process.env.LUNARA_PERSONA_GENERATION_MODE = 'fallback';

test('同一人设产出的人格与其自身维度一致', async () => {
  const preset = getPersonaPreset('music_obsessive');
  const persona = await generatePersona({ personaPreset: preset.id });
  assert.equal(persona.character, preset.character);
  assert.equal(persona.interpersonalDistance, preset.interpersonalDistance);
  assert.equal(persona.boundaries, preset.boundaries);
  assert.ok(preset.nameCandidates.includes(persona.name), `名字应来自候选：${persona.name}`);
});

test('人格生成不接受也不读取音色信息', async () => {
  // 即使调用方仍传入 voiceProfile（迁移期的旧签名），也必须被忽略。
  const withVoice = await generatePersona({
    personaPreset: 'late_night_companion',
    voiceProfile: { displayName: '柔声女声', description: '温柔电台女声', styleTags: ['female', 'soft'], gender: 'female' },
  });
  const without = await generatePersona({ personaPreset: 'late_night_companion' });
  assert.deepEqual(withVoice, without, '传入音色不得改变生成结果');
  assert.equal(JSON.stringify(withVoice).includes('柔声女声'), false, '人格中不得出现音色名称');
});

test('不同人设产出明显不同的人格（同一“声音”下）', async () => {
  const a = await generatePersona({ personaPreset: 'cool_analytical' });
  const b = await generatePersona({ personaPreset: 'morning_bright' });
  assert.notEqual(a.character, b.character);
  assert.notEqual(a.speechHabit, b.speechHabit);
  assert.notEqual(a.interpersonalDistance, b.interpersonalDistance);
});

test('同一人设重复生成结果稳定（不随声音或随机漂移）', async () => {
  const first = await generatePersona({ personaPreset: 'retro_broadcaster' });
  const second = await generatePersona({ personaPreset: 'retro_broadcaster' });
  assert.deepEqual(first, second);
});

test('用户描述优先于预设，并体现在说话习惯中', async () => {
  const persona = await generatePersona({
    personaPreset: 'cool_analytical',
    personaHint: '我希望他是个温柔的夜间陪伴者',
  });
  assert.match(persona.speechHabit, /温柔的夜间陪伴者/);
});

test('用户指定名字时采纳用户的名字', async () => {
  const persona = await generatePersona({
    personaPreset: 'literary_lyrical',
    personaHint: '叫他子夜吧',
  });
  assert.equal(persona.name, '子夜');
});

test('未指定人设时回落到默认人设而不是报错', async () => {
  const persona = await generatePersona({});
  assert.equal(persona.character, defaultPersonaPreset().character);
});

test('输出保留兼容字段，供既有记忆写入路径使用', async () => {
  const persona = await generatePersona({ personaPreset: 'morning_bright' });
  for (const field of ['personaDescription', 'speakingStyle', 'musicTasteBias', 'story', 'boundaries', 'name']) {
    assert.ok(persona[field], `缺少兼容字段 ${field}`);
  }
  assert.equal(persona.speakingStyle, persona.speechHabit);
  assert.equal(persona.story, persona.backgroundStory);
});

test('无标签的声音也不会导致人格空泛（旧实现会退化成占位人格）', async () => {
  // 本地音色只有编号（zf_002），旧实现以音色为锚会产出泛泛而谈的人格。
  const persona = await generatePersona({
    personaPreset: 'late_night_companion',
    voiceProfile: { displayName: 'zf_002', description: '', styleTags: [], gender: null },
  });
  assert.ok(persona.character.length >= 4);
  assert.ok(persona.backgroundStory.length >= 10, '背景故事不应退化成占位文本');
  assert.notEqual(persona.character, '安静、克制', '不应落入旧兜底的固定文案');
});