import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTERACTION_MODES,
  assertInteractionMode,
  normalizeInteractionMode,
  parseRoleplaySegments,
  sanitizeSpeechForTts,
  splitSpeechChunks,
} from './roleplaySpeech.js';

test('interaction mode normalization and strict assertion', () => {
  assert.deepEqual(INTERACTION_MODES, ['radio', 'roleplay']);
  assert.equal(normalizeInteractionMode(undefined), 'radio');
  assert.equal(normalizeInteractionMode('roleplay'), 'roleplay');
  assert.equal(normalizeInteractionMode('other'), 'radio');
  assert.equal(assertInteractionMode('radio'), 'radio');
  assert.equal(assertInteractionMode('roleplay'), 'roleplay');
  assert.throws(() => assertInteractionMode('drama'), /invalid interactionMode/);
});

test('explicit stage directions （...） and *...* extract speech only for TTS', () => {
  const input = '（把手里那根发夹放在桌上，听见它磕了一下）\n“你疯了。”\n*伸手把裙摆往下按了按* “大白天的，张口就是这个。”';
  const parsed = parseRoleplaySegments(input);
  assert.equal(parsed.hasAction, true);
  assert.equal(parsed.hasSpeech, true);
  assert.equal(parsed.segments.filter(s => s.type === 'action').length, 2);
  assert.equal(parsed.segments.filter(s => s.type === 'speech').length, 2);
  assert.equal(parsed.spokenText, '你疯了。 大白天的，张口就是这个。');
});

test('action-only reply yields empty spokenText and hasSpeech=false', () => {
  const parsed = parseRoleplaySegments('（她没有抬头，只是把桌面上的杯子往里推了半寸。）');
  assert.equal(parsed.hasAction, true);
  assert.equal(parsed.hasSpeech, false);
  assert.equal(parsed.spokenText, '');
});

test('unbracketed novel-style narrative with quoted speech extracts dialogue only', () => {
  const input = '我手里的杯子放回桌上，磕得有点响。中午的光从窗帘缝里挤进来，落在袖口上。\n\n“你——你把话说成这样。”我抬眼看你，耳根有点热，“我在这儿坐着，你就这么跟我说话。”\n\n我把裙摆往下按了按。';
  const parsed = parseRoleplaySegments(input);
  assert.equal(parsed.hasAction, true);
  assert.equal(parsed.hasSpeech, true);
  assert.equal(parsed.spokenText, '你——你把话说成这样。 我在这儿坐着，你就这么跟我说话。');
  assert.doesNotMatch(parsed.spokenText, /杯子|窗帘|裙摆/);
});

test('parenthetical album/year annotations in normal radio speech stay speech', () => {
  const input = '这首周杰伦（2003年）的现场版（Live）编曲很松弛，适合深夜听。';
  const parsed = parseRoleplaySegments(input);
  assert.equal(parsed.hasAction, false);
  assert.equal(parsed.hasSpeech, true);
  assert.equal(parsed.spokenText, input);
});

test('splitSpeechChunks breaks long spoken text at sentence and clause bounds', () => {
  const short = '只有这一句。';
  assert.deepEqual(splitSpeechChunks(short, { maxChars: 120 }), [short]);

  const long = Array.from({ length: 8 }, (_, i) => `这是第${i + 1}句比较完整的话，用来确认语音合成切分不会超过单段长度限制。`).join('');
  const chunks = splitSpeechChunks(long, { maxChars: 120 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok([...chunk].length <= 120, `chunk exceeded 120 chars: ${[...chunk].length}`);
  }
  assert.equal(chunks.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''));
});

test('inline action beats inside quoted paragraphs are stripped from spokenText while unquoted spoken paragraphs survive', () => {
  const scene = [
    '（我整个人僵在那儿，手先动的，一把把裙子从你手里扯回来，扯得布都皱了）',
    '',
    '“起来。”声音不高，可这次是真的稳，“从我身上起来。”',
    '',
    '（我坐直，光着一只脚踩在地板上，凉）',
    '',
    '“我什么时候穿什么、敲谁的门、请谁吃饭，那是我的事。”我抬眼看你，“你要拿这个当话柄，那这屋里就没我坐的地方了。”',
    '',
    '（把散下来的头发拢到脑后）',
    '',
    '“勾引。”我把这两个字念了一遍，“我要是真想勾你，用得着一天说三遍不行？”',
    '',
    '（转回来，靠着窗台）',
    '',
    '洗把脸，回去。明天你要还想来，好好说话，我照样给你开门。',
  ].join('\n');

  const parsed = parseRoleplaySegments(scene);
  assert.equal(parsed.hasAction, true);
  assert.equal(parsed.hasSpeech, true);
  assert.doesNotMatch(parsed.spokenText, /声音不高|我抬眼看你|我把这两个字念了一遍|扯得布|窗台/);
  assert.match(parsed.spokenText, /起来。 从我身上起来。/);
  assert.match(parsed.spokenText, /那是我的事。 你要拿这个当话柄/);
  assert.match(parsed.spokenText, /勾引。 我要是真想勾你/);
  assert.match(parsed.spokenText, /洗把脸，回去。明天你要还想来，好好说话，我照样给你开门。$/);

  const inlineActions = parsed.segments.filter(s => s.type === 'action' && s.inline);
  assert.equal(inlineActions.length, 3);
  assert.deepEqual(inlineActions.map(s => s.content), [
    '声音不高，可这次是真的稳，',
    '我抬眼看你，',
    '我把这两个字念了一遍，',
  ]);
  const trailingPlain = parsed.segments.at(-1);
  assert.equal(trailingPlain.type, 'speech');
  assert.equal(trailingPlain.inline, undefined);
  assert.equal(trailingPlain.content, '洗把脸，回去。明天你要还想来，好好说话，我照样给你开门。');
});

test('single-quote leading/trailing beats and anti-false-positive protections', () => {
  const leadAction = parseRoleplaySegments('我抬眼看你，“出去。”');
  assert.equal(leadAction.hasAction, true);
  assert.equal(leadAction.spokenText, '出去。');
  assert.deepEqual(leadAction.segments, [
    { type: 'action', content: '我抬眼看你，' },
    { type: 'speech', content: '“出去。”', inline: true },
  ]);

  const trailAction = parseRoleplaySegments('“算了，”我把视线移开。');
  assert.equal(trailAction.hasAction, true);
  assert.equal(trailAction.spokenText, '算了，');
  assert.deepEqual(trailAction.segments, [
    { type: 'speech', content: '“算了，”' },
    { type: 'action', content: '我把视线移开。', inline: true },
  ]);

  const falsePositives = [
    '我不喜欢被人扣上“勾引”这种帽子。',
    '“喜欢你。”这种话你也信？',
    '“春风”和“秋雨”，你更喜欢哪一个？',
  ];
  for (const line of falsePositives) {
    const parsed = parseRoleplaySegments(line);
    assert.equal(parsed.hasAction, false, `should not misclassify as action: ${line}`);
    assert.equal(parsed.spokenText, line.replace(/[“”]/g, ''));
  }
});

test('sanitizeSpeechForTts normalizes dense ellipses and preserves song/album brackets without regex sigh injection', () => {
  assert.equal(sanitizeSpeechForTts('“啊……慢、慢一点……”'), '啊，慢，慢一点。');
  assert.equal(sanitizeSpeechForTts('“……还在。”'), '还在。');
  assert.equal(sanitizeSpeechForTts('“你疯了吗……？”'), '你疯了吗？');
  assert.equal(sanitizeSpeechForTts('“……”'), '');
  assert.equal(sanitizeSpeechForTts('《明年今日（2007 Live）》不错。'), '《明年今日（2007 Live）》不错。');
});

test('roleplaySpeech no longer exports legacy regex performance derivation helpers', async () => {
  const serverMod = await import('./roleplaySpeech.js');
  const pwaMod = await import('../../pwa/features/chat/roleplaySpeech.js');
  for (const mod of [serverMod, pwaMod]) {
    assert.equal('ROLEPLAY_SPEECH_PLAN_VERSION' in mod, false);
    assert.equal('deriveBeatPerformance' in mod, false);
    assert.equal('buildRoleplaySpeechPlan' in mod, false);
  }
});

test('splitSpeechChunks defaults to maxChars = 220 and keeps <=220 text intact', () => {
  const medium = '雨点落在窗台上，我们把这首慢歌放到尾奏结束。'.repeat(7);
  assert.ok([...medium].length > 140 && [...medium].length <= 220);
  assert.deepEqual(splitSpeechChunks(medium), [medium]);

  const over = '夜风轻轻吹过来，桌面上的茶水还有余温，留声机缓缓转动着。'.repeat(10);
  const chunks = splitSpeechChunks(over);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok([...chunk].length <= 220, `chunk exceeded 220 chars: ${[...chunk].length}`);
  }
});
