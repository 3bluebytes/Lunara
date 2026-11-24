import assert from 'node:assert/strict';
import test from 'node:test';

import { createJournalAnnotationGenerator } from './journalAnnotation.js';

class FakeLLMNotConfiguredError extends Error {
  constructor() {
    super('LLM not configured');
    this.name = 'LLMNotConfiguredError';
  }
}

function makeDeps(overrides = {}) {
  const calls = [];
  const llm = {
    LLMNotConfiguredError: FakeLLMNotConfiguredError,
    async chat(messages, tools, options) {
      calls.push({ messages, tools, options });
      return { message: { content: '{"anchor":"雨夜走在街上","text":"记得带伞，听歌的时候也别吹太久夜风。"}' } };
    },
    extractJson(raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    ...overrides.llm,
  };
  return {
    calls,
    virtualPerson: overrides.virtualPerson ?? {
      registry: { get: () => ({ personaDocument: '安静温和的伙伴。' }) },
    },
    getStation: overrides.getStation ?? (() => ({
      stationMemory: {
        store: {
          search: () => [{ summary: '用户喜欢在雨天听木吉他。' }],
        },
      },
    })),
    loadPersonaMarkdown: overrides.loadPersonaMarkdown ?? (() => ''),
    llm,
  };
}

test('generates annotation and preserves verbatim anchor from entry text', async () => {
  const deps = makeDeps();
  const generate = createJournalAnnotationGenerator(deps);

  const out = await generate({
    personId: 'lunara',
    person: { displayName: 'Lunara', memoryNamespace: 'person:lunara' },
    entry: {
      localDate: '2026-11-24',
      mood: '平静',
      title: '下班路上的雨',
      content: '今天雨夜走在街上，耳机里放着老歌。',
      attachedTracks: [{ title: '晴天', artist: '周杰伦', playedAt: '21:10' }],
      attachedQuotes: [{ speaker: 'Lunara', time: '21:15', text: '慢点走。' }],
    },
  });

  assert.deepEqual(out, {
    anchor: '雨夜走在街上',
    text: '记得带伞，听歌的时候也别吹太久夜风。',
  });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].options.taskId, 'journal_annotation');
  assert.match(deps.calls[0].messages[0].content, /雨天听木吉他/);
});

test('drops fabricated anchor that does not appear in source text', async () => {
  const deps = makeDeps({
    llm: {
      async chat() {
        return { message: { content: '{"anchor":"并不存在的句子","text":"这句批注仍然有效。"}' } };
      },
    },
  });
  const generate = createJournalAnnotationGenerator(deps);

  const out = await generate({
    personId: 'lunara',
    person: { displayName: 'Lunara' },
    entry: { localDate: '2026-11-24', title: '普通一天', content: '喝了杯热茶。' },
  });

  assert.deepEqual(out, { anchor: '', text: '这句批注仍然有效。' });
});

test('maps unconfigured LLM error to annotation_llm_unavailable', async () => {
  const deps = makeDeps({
    llm: {
      async chat() {
        throw new FakeLLMNotConfiguredError();
      },
    },
  });
  const generate = createJournalAnnotationGenerator(deps);

  await assert.rejects(
    () => generate({ personId: 'lunara', person: {}, entry: { localDate: '2026-11-24', content: 'hi' } }),
    err => err?.code === 'annotation_llm_unavailable',
  );
});

test('rejects empty annotation text with annotation_empty', async () => {
  const deps = makeDeps({
    llm: {
      async chat() {
        return { message: { content: '{"anchor":"","text":"   "}' } };
      },
    },
  });
  const generate = createJournalAnnotationGenerator(deps);

  await assert.rejects(
    () => generate({ personId: 'lunara', person: {}, entry: { localDate: '2026-11-24', content: 'hi' } }),
    err => err?.code === 'annotation_empty',
  );
});
