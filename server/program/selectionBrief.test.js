import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectionBrief, recentListeningLines, personaMusicTaste, BRIEF_PRIORITY_NOTE,
  BRIEF_SECTION_KEYS } from './selectionBrief.js';

const NOW = new Date(2026, 9, 23, 23, 30).getTime();
const DAY = 86_400_000;
const request = { mode: 'discovery', delivery: 'append', count: 3, artist: '',
  constraints: { tags: { language: 'zh' }, excludeVersions: ['live'], requiredVersion: null, excludedSongIds: [], excludedArtists: ['某歌手'] },
  softPreferences: '安静一点', preferredArtists: [] };
const feedback = { id: 1, namespace: 'radiohost:a', source: 'user_explicit_feedback',
  content: '用户与我一起听歌时，对 A《晚风》的反馈：喜欢。原话：这首太好听了', tags: 'music-feedback', evidence: '{}' };
const schema = { id: 2, namespace: 'radiohost:a', source: 'taste_schema', content: '偏爱慢节奏中文 R&B，夜里更明显', tags: 'taste-schema' };
const context = (overrides = {}) => ({ memories: [schema, feedback], shared: [], listening: { queue: [] },
  tasteSignals: [{ key: 'music.genre.rnb', attribute: 'genre', value: 'rnb', polarity: 'positive', confidence: 0.42 },
    { key: 'music.artist.x', attribute: 'artist', value: 'x', polarity: 'negative', confidence: 0.3 }], ...overrides });

test('brief opens with the priority note and lists the seven parts in order（3.1）', () => {
  const brief = buildSelectionBrief({ request, context: context(), personaTaste: '偏好 70s soft rock', now: NOW,
    listening: { plays: [{ ts: NOW - 3_600_000, title: '晚风', artist: 'A', outcome: 'completed' }],
      songStats: [{ songQuery: '晚风 — A', outcome: 'completed', count: 4, lastSeenAt: NOW - DAY }] } });
  assert.ok(brief.text.startsWith(BRIEF_PRIORITY_NOTE));
  assert.match(BRIEF_PRIORITY_NOTE, /本轮明确要求 > 显式反馈 > 口味画像 > 推断与近期观察/);
  const order = ['【本轮请求的条件', '【用户的显式音乐反馈', '【口味画像', '【伙伴自己的审美', '【口味信号', '【近期收听事实', '【当前一起听计划']
    .map(title => brief.text.indexOf(title));
  assert.ok(order.every(index => index > 0), '七个部分都在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '按优先级排列');
  assert.match(brief.text, /硬条件（标签）：language=zh/);
  assert.match(brief.text, /软偏好：安静一点/);
  assert.match(brief.text, /原话：这首太好听了（来源：用户亲口说的；范围：你和用户之间）/);
  assert.match(brief.text, /可能喜欢流派「rnb」（置信度 0.42，\+music\.genre\.rnb）/);
  assert.match(brief.text, /可能不喜欢歌手「x」（置信度 0.30，-music\.artist\.x）/);
  assert.match(brief.text, /现在是周五深夜（23:30）/);
  assert.deepEqual(Object.keys(brief.stats.sections), BRIEF_SECTION_KEYS);
  assert.equal(brief.stats.length, brief.text.length);
});

test('persona taste is labelled as the companion\'s own and never sits in feedback or schema', () => {
  const brief = buildSelectionBrief({ request, context: context(), personaTaste: '偏好 70s soft rock', now: NOW });
  const persona = brief.text.indexOf('70s soft rock');
  const header = brief.text.indexOf('【伙伴自己的审美（这是伙伴自己的审美，不是用户口味）】');
  const signals = brief.text.indexOf('【口味信号');
  assert.ok(header > 0 && persona > header && persona < signals, '审美只在自己那一段');
  assert.equal(brief.text.slice(0, header).includes('soft rock'), false);
});

test('empty parts are omitted; disabled produces no brief', t => {
  const bare = buildSelectionBrief({ request: { ...request, constraints: { tags: {} }, softPreferences: '' },
    context: { memories: [], shared: [], tasteSignals: [], listening: {} }, now: NOW });
  assert.equal(bare.text.includes('【本轮请求的条件】'), false);
  assert.equal(bare.text.includes('【口味画像】'), false);
  assert.equal(bare.stats.sections.feedback, 0);
  process.env.MUSIC_BRIEF_DISABLED = '1';
  t.after(() => { delete process.env.MUSIC_BRIEF_DISABLED; });
  assert.equal(buildSelectionBrief({ request, context: context(), now: NOW }), null);
});

test('over-long briefs drop recent facts and signals first; parts 1–3 stay whole（3.1 截断）', () => {
  const longSchema = { ...schema, content: '画像'.repeat(700) };
  const plays = Array.from({ length: 10 }, (_, index) => ({ ts: NOW - (index + 1) * 3_600_000,
    title: `很长的歌名${'长'.repeat(40)}${index}`, artist: `歌手${index}`, outcome: 'completed' }));
  const signals = Array.from({ length: 12 }, (_, index) => ({ key: `music.genre.g${index}`, attribute: 'genre',
    value: `g${index}`, polarity: 'positive', confidence: 0.3 }));
  const full = buildSelectionBrief({ request, context: context({ memories: [longSchema, feedback], tasteSignals: signals }),
    personaTaste: '审美', listening: { plays }, now: NOW, maxChars: 100_000 });
  const limit = full.text.length - 600;
  const cut = buildSelectionBrief({ request, context: context({ memories: [longSchema, feedback], tasteSignals: signals }),
    personaTaste: '审美', listening: { plays }, now: NOW, maxChars: limit });
  assert.ok(cut.text.length <= limit);
  assert.equal(cut.stats.truncated, true);
  assert.ok(cut.stats.sections.recent < full.stats.sections.recent, '先截近期收听');
  assert.equal(cut.stats.sections.signals, full.stats.sections.signals, '近期收听够截时信号保持不动');
  for (const kept of ['画像'.repeat(700), '原话：这首太好听了', '软偏好：安静一点']) assert.ok(cut.text.includes(kept));
  const tight = buildSelectionBrief({ request, context: context({ memories: [longSchema, feedback], tasteSignals: signals }),
    personaTaste: '审美', listening: { plays }, now: NOW, maxChars: 300 });
  assert.equal(tight.stats.sections.recent, 0);
  assert.equal(tight.stats.sections.signals, 0);
  assert.equal(tight.stats.sections.persona, 0);
  assert.equal(tight.stats.sections.schema, 1, '口味画像不截断，哪怕超过上限');
  assert.ok(tight.text.includes('画像'.repeat(700)));
});

test('recent listening facts exclude technical failures and old rows（3.3）', () => {
  const lines = recentListeningLines({ now: NOW,
    plays: [
      { ts: NOW - 3_600_000 * 2, title: '能放', artist: 'A', outcome: 'skipped' },
      { ts: NOW - 3_600_000, title: '坏链接', artist: 'B', outcome: 'technical_failure' },
      { ts: NOW - 40 * DAY, title: '很久以前', artist: 'C', outcome: 'completed' },
    ],
    songStats: [
      { songQuery: '晚风 — A', outcome: 'completed', count: 5, lastSeenAt: NOW - DAY },
      { songQuery: '夜曲 — B', outcome: 'completed', count: 2, lastSeenAt: NOW - DAY },
      { songQuery: '断流 — B', outcome: 'technical_failure', count: 9, lastSeenAt: NOW - DAY },
      { songQuery: '跳 — D', outcome: 'skipped', count: 3, lastSeenAt: NOW - 2 * DAY },
      { songQuery: '旧 — E', outcome: 'completed', count: 50, lastSeenAt: NOW - 45 * DAY },
    ] });
  assert.deepEqual(lines, [
    '近 30 天常听完的歌手：A（5 次）、B（2 次）',
    '近 30 天常跳过的歌手：D（3 次）',
    '- 最近播放：A《能放》，跳过，2 小时前',
  ]);
  assert.equal(lines.join('\n').includes('坏链接'), false);
});

test('persona taste comes from the persona document, never from memory; placeholders are not taste', () => {
  const entity = { personaDocument: '# 我\n\n## 我喜欢的音乐\n老派爵士与器乐\n\n## 我对这个用户的态度\n亲近' };
  assert.equal(personaMusicTaste({ entity }), '老派爵士与器乐');
  assert.equal(personaMusicTaste({ entity: { personaDocument: '性格：安静\n音乐审美：偏好民谣' } }), '偏好民谣');
  assert.equal(personaMusicTaste({ entity: { personaDocument: '## 我喜欢的音乐\n（待补充）' } }), '');
  assert.equal(personaMusicTaste({ entity: { personaDocument: '' } }), '');
});
