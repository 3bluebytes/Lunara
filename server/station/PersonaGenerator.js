// PersonaGenerator.js — LLM-powered radiohost persona creation (multidimensional model)
//
// 生成伙伴人格的 6 个维度，每个维度写成独立的 PERSONA 记忆记录。
// LLM 不可用时回落到由预令人设直接构造。
//
// **音色不参与人格推导。** 这是与旧实现最重要的差别：旧版把音色的
// displayName / description / styleTags / gender 全部喂进 prompt，导致“换一批音色”
// 等于“换一批人格”，且本地音色只有编号时人格生成退化成从编号瞎猜。
// 现在人格来源只有两个：预令人设与用户描述。

import * as llm from '../llm.js';
import { MemoryType, MemorySource, createMemoryRecord } from '../memory/types.js';
import { defaultPersonaPreset, getPersonaPreset } from '../persona/personaPresets.js';

const PRODUCT_TONE = 'Lunara 是一个私人电台应用，风格温和、克制、深夜陪伴感强。伙伴不是助手，不是聊天机器人，而是一个安静的、有品味的深夜电台人声。';

const PERSONA_DRAFT_LIMITS = {
  name: 20, character: 100, speechHabit: 200, emotionalExpression: 150,
  musicTaste: 200, interpersonalDistance: 150, backgroundStory: 300, boundaries: 150,
};
const PERSONA_DRAFT_REQUIRED = ['character', 'speechHabit', 'emotionalExpression', 'musicTaste',
  'interpersonalDistance', 'backgroundStory', 'boundaries'];

/**
 * Validate a persona drafted by the calling Agent (no hidden LLM).
 *
 * The conversation AgentLoop already ran the model and produced the persona; the
 * tool boundary must not silently rephrase, truncate or re-generate it. Missing
 * dimensions fail closed with a correctable message so the Agent can retry.
 */
export function normalizePersonaDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('personaDraft must be an object');
  }
  const missing = [];
  const persona = {};
  for (const [field, limit] of Object.entries(PERSONA_DRAFT_LIMITS)) {
    const raw = value[field];
    if (raw == null || raw === '') {
      if (PERSONA_DRAFT_REQUIRED.includes(field)) missing.push(field);
      continue;
    }
    if (typeof raw !== 'string') throw new TypeError(`personaDraft.${field} must be a string`);
    const text = raw.trim();
    if (!text) {
      if (PERSONA_DRAFT_REQUIRED.includes(field)) missing.push(field);
      continue;
    }
    if (text.length > limit) throw new TypeError(`personaDraft.${field} exceeds ${limit} characters`);
    persona[field] = text;
  }
  if (missing.length) throw new TypeError(`personaDraft is missing: ${missing.join(', ')}`);
  return withCompatibilityFields(persona);
}

/**
 * Generate a structured radiohost persona with 6 dimensions.
 *
 * @param {object} opts
 * @param {object|string} [opts.personaPreset] - 预令人设对象或 id。未指定时用默认人设。
 * @param {string} [opts.personaHint] - 用户对这个人物的期望
 * @param {object} [opts.personaDraft] - 调用方 Agent 已经生成好的人格；提供时校验后直接使用，不再调用模型
 * @returns {Promise<object>} Persona with both multidimensional and legacy compatibility fields
 */
export async function generatePersona(opts = {}) {
  const { personaHint } = opts;
  // Agent 已完成的决策属于调用方：这里只做边界校验，不再次调用模型。
  if (opts.personaDraft != null) return normalizePersonaDraft(opts.personaDraft);
  const personaPreset = resolvePreset(opts.personaPreset);
  const generationMode = String(process.env.LUNARA_PERSONA_GENERATION_MODE || 'model').toLowerCase();

  if (generationMode !== 'fallback') {
    try {
      const prompt = buildPersonaPrompt(personaPreset, personaHint);
      const text = await llm.askText(prompt, { taskId: 'persona_generation' });
      const parsed = llm.extractJson(text);

      if (parsed && parsed.name && (parsed.character || parsed.personaDescription)) {
        return withCompatibilityFields({
          name: String(parsed.name).slice(0, 20),
          character: String(parsed.character || parsed.personaDescription || '').slice(0, 100),
          speechHabit: String(parsed.speechHabit || parsed.speakingStyle || '').slice(0, 200),
          emotionalExpression: String(parsed.emotionalExpression || '').slice(0, 150),
          musicTaste: String(parsed.musicTaste || parsed.musicTasteBias || '').slice(0, 200),
          interpersonalDistance: String(parsed.interpersonalDistance || '').slice(0, 150),
          backgroundStory: String(parsed.backgroundStory || parsed.story || '').slice(0, 300),
          boundaries: String(parsed.boundaries || '').slice(0, 150),
        });
      }
    } catch (e) {
      console.warn('[persona] LLM generation failed:', e.message);
    }
  }

  // Fallback: rule-based generation using same 6-dimension structure
  return generateFallbackPersona(personaPreset, personaHint);
}

/** 接受对象、id 或缺失，统一得到一个人设对象。 */
export function resolvePreset(value) {
  if (value && typeof value === 'object' && value.id) return value;
  const id = String(value || '').trim();
  if (!id) return defaultPersonaPreset();
  const preset = getPersonaPreset(id);
  // 未知的预设 id 必须可纠正地失败。静默换成默认人设等于"用户选了 A，得到的是 B"，
  // 且调用方毫无感知——这与仓库的 fail closed 原则直接冲突。
  if (!preset) throw new TypeError(`invalid personaPresetId: unknown persona preset "${id}"`);
  return preset;
}

/**
 * Build the LLM prompt for 6-dimension persona generation.
 *
 * 注意：本函数**不接受也不读任何音色信息**。这不是遗漏——把音色写进来会
 * 破坏“人设与声音自由搭配”这一目标（同一个人设配不同音色应产出相同人格）。
 */
function buildPersonaPrompt(preset, personaHint) {
  const presetSection = `人设名称：${preset.displayName}
人设定位：${preset.summary}
性格底色：${preset.character}
说话习惯：${preset.speechHabit}
情感表达：${preset.emotionalExpression}
音乐审美：${preset.musicTaste}
人际距离：${preset.interpersonalDistance}
背景故事：${preset.backgroundStory}
边界：${preset.boundaries}
名字候选：${(preset.nameCandidates || []).join('、')}`;

  const hintSection = personaHint
    ? `\n用户对这个人物的期望："""${personaHint}"""\n用户的期望优先于上面的预设；两者冲突时以用户为准，但保留预设中未被冲突的维度。`
    : '\n用户没有额外期望，请以预设为准，把它展开成具体、有细节、有人味的内容，不要换一个人。';

  return `你正在为一个私人电台应用 "Lunara" 完善一位电台伙伴的人格。

${presetSection}
${hintSection}

产品调性：${PRODUCT_TONE}

请将伙伴人格拆分为以下 6 个维度，每个维度给出具体、有故事感、有人味的内容，不要泛泛而谈。
名字从名字候选中选择，除非用户明确指定了名字。

请输出严格的 JSON，不要前缀后缀和代码块：
{
  "name": "伙伴名，单个人名，2-4 个字",
  "character": "性格底色（2-8 字）。如：俏皮可爱、话少踏实、幽默风趣、毒舌温柔、文艺敏感、松弛搞怪",
  "speechHabit": "说话习惯描述（20-60 字）。如：短句、碎碎念、善用比喻、喜欢调侃、擅长讲故事、认真解释",
  "emotionalExpression": "情感表达方式（15-40 字）。如：直接表达、含蓄暗示、陪伴式回应、玩笑式、冷静理性",
	  "musicTaste": "音乐审美的多维度描述（20-60 字）。包含偏好的年代、流派、节奏、情绪、场景",
	  "interpersonalDistance": "人际距离定位（10-30 字）。如：像朋友、像深夜电台伙伴、像陪伴者、像专业音乐编辑",
	  "backgroundStory": "故事感设定（40-120 字）。给人一个有经历、有人味的故事背景",
	  "boundaries": "边界设定（15-40 字）。说明这个伙伴不该越界的地方，例如不过度打扰、不替代用户判断、不打探隐私"
	}`;
}

/**
 * Rule-based fallback persona generation using the preset's 6 dimensions.
 *
 * 由预令直接构造，**不读任何音色字段**。
 */
function generateFallbackPersona(preset, personaHint) {
  const name = (personaHint ? extractName(personaHint) : null)
    || (preset.nameCandidates || [])[0]
    || preset.displayName
    || '小播';
  // 直传对象时字段可能不全（resolvePreset 只要求 id），缺维度用空串兜底而不是 TypeError。
  const field = value => String(value || '');

  return withCompatibilityFields({
    name: name.slice(0, 20),
    character: field(preset.character).slice(0, 100),
    speechHabit: (personaHint ? `${personaHint.slice(0, 60)}，` : '') + field(preset.speechHabit).slice(0, 140),
    emotionalExpression: field(preset.emotionalExpression).slice(0, 150),
    musicTaste: field(preset.musicTaste).slice(0, 200),
    interpersonalDistance: field(preset.interpersonalDistance).slice(0, 150),
    backgroundStory: field(preset.backgroundStory).slice(0, 300),
    boundaries: field(preset.boundaries).slice(0, 150),
  });
}

function extractName(hint) {
  // 支持「名字叫X」「叫X吧」「叫他X」等常见说法：
  // 去掉指代词与句尾语气词，否则「叫他子夜吧」会被当成名字。
  const match = String(hint || '').match(/叫\s*([^\s，。,.！!？?]{2,4})/);
  if (!match) return null;
  const cleaned = match[1].replace(/^[他她它]/, '').replace(/[吧啊呀哦啦]$/, '');
  // 「叫什么都可以」这类疑问句不是命名；把"什么都可"当名字比不取名更糟。
  if (cleaned.length < 2 || /什么|啥|谁|哪|怎么|怎样/.test(cleaned)) return null;
  return cleaned;
}

function withCompatibilityFields(persona) {
  const boundaries = persona.boundaries || '不过度打扰，不打探隐私，不把一时情绪当成永久偏好';
  return {
    ...persona,
    boundaries,
    personaDescription: persona.personaDescription || persona.character || '',
    speakingStyle: persona.speakingStyle || persona.speechHabit || '',
    musicTasteBias: persona.musicTasteBias || persona.musicTaste || '',
    story: persona.story || persona.backgroundStory || '',
  };
}

/**
 * Convert a 6-dimension persona to MemoryRecord array for a given namespace.
 * Each dimension becomes an independent PERSONA record with dimension tags.
 *
 * @param {object} persona - Generated persona with 6 dimensions
 * @param {string} namespace - radiohost's namespace
 * @returns {object[]} Array of MemoryRecords
 */
export function personaToMemoryRecords(persona, namespace) {
  const records = [];

  if (persona.character) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `性格底色：${persona.character}`,
      summary: '伙伴性格底色',
      tags: 'identity,role,character',
      source: MemorySource.MANUAL_SEED,
      importance: 10,
      confidence: 1.0,
    }));
  }

  if (persona.speechHabit) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `说话习惯：${persona.speechHabit}`,
      summary: '伙伴说话习惯',
      tags: 'style,speaking,voice,speech_habit',
      source: MemorySource.MANUAL_SEED,
      importance: 9,
      confidence: 1.0,
    }));
  }

  if (persona.emotionalExpression) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `情感表达：${persona.emotionalExpression}`,
      summary: '伙伴情感表达方式',
      tags: 'style,emotion,expression,emotional_expression',
      source: MemorySource.MANUAL_SEED,
      importance: 8,
      confidence: 1.0,
    }));
  }

  if (persona.musicTaste) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `音乐审美：${persona.musicTaste}`,
      summary: '伙伴音乐审美偏好',
      tags: 'aesthetic,music,taste,music_taste',
      source: MemorySource.MANUAL_SEED,
      importance: 9,
      confidence: 1.0,
    }));
  }

  if (persona.interpersonalDistance) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `人际距离：${persona.interpersonalDistance}`,
      summary: '伙伴人际距离定位',
      tags: 'style,distance,companion,distance',
      source: MemorySource.MANUAL_SEED,
      importance: 7,
      confidence: 1.0,
    }));
  }

  if (persona.backgroundStory) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `故事背景：${persona.backgroundStory}`,
      summary: '伙伴故事背景',
      tags: 'story,background,story',
      source: MemorySource.MANUAL_SEED,
      importance: 7,
      confidence: 1.0,
    }));
  }

  if (persona.boundaries) {
    records.push(createMemoryRecord(MemoryType.PERSONA, {
      namespace,
      content: `边界设定：${persona.boundaries}`,
      summary: '伙伴边界设定',
      tags: 'boundaries,safety,limits',
      source: MemorySource.MANUAL_SEED,
      importance: 9,
      confidence: 1.0,
    }));
  }

  return records;
}

/**
 * v2: 把 6 维 persona 渲染为 markdown 文档，写到 user/radiohost/<slug>/persona.md。
 * 替代 personaToMemoryRecords。
 *
 * @param {object} persona - 由 generatePersona 返回的 6 维 persona 对象
 * @param {string} [displayName] - 伙伴显示名（作为 H1）
 * @returns {string} markdown 全文，符合 persona-generator spec 的结构规范（H1 + ≥3 H2）
 */
export function personaToMarkdown(persona, displayName) {
  const name = displayName || persona.name || '伙伴';
  const lines = [`# ${name}`, ''];

  // 一对一映射 6 维到 4 个固定 H2 section + 可选 我的故事
  if (persona.character) {
    lines.push('## 我是谁');
    lines.push(persona.character);
    if (persona.story && persona.story.trim()) {
      lines.push('');
      lines.push(persona.story);
    }
    lines.push('');
  }
  if (persona.speechHabit || persona.emotionalExpression) {
    lines.push('## 我说话的方式');
    if (persona.speechHabit) lines.push(persona.speechHabit);
    if (persona.emotionalExpression) {
      lines.push('');
      lines.push(`情感表达：${persona.emotionalExpression}`);
    }
    lines.push('');
  }
  if (persona.musicTasteBias) {
    lines.push('## 我喜欢的音乐');
    lines.push(persona.musicTasteBias);
    lines.push('');
  }
  if (persona.relationshipDistance || persona.userRelationshipNote) {
    lines.push('## 我对这个用户的态度');
    if (persona.relationshipDistance) lines.push(`关系距离：${persona.relationshipDistance}`);
    if (persona.userRelationshipNote) lines.push(persona.userRelationshipNote);
    lines.push('');
  }
  // 兜底：如果上面的字段都缺失，至少塞个最小化的人格描述
  if (lines.length <= 2) {
    lines.push('## 我是谁');
    lines.push('（未填写人格底色——请手动补充本文件）');
    lines.push('');
    lines.push('## 我说话的方式');
    lines.push('（待补充）');
    lines.push('');
    lines.push('## 我喜欢的音乐');
    lines.push('（待补充）');
    lines.push('');
    lines.push('## 我对这个用户的态度');
    lines.push('（待补充）');
  }
  return lines.join('\n').trim() + '\n';
}
