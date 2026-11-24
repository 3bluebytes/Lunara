import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEAT_INTENSITIES,
  BEAT_PACES,
  DEFAULT_BEAT_PAUSE_MS,
  DELIVER_REPLY_TOOL_NAME,
  MAX_BEAT_PAUSE_MS,
  MAX_VOICE_DIRECTION_CHARS,
  MIN_BEAT_PAUSE_MS,
  REPLY_CAPABILITY,
  beatSpokenText,
  beatsToVisibleText,
  buildBeatItemSchema,
  buildBeatsArraySchema,
  formatTurnVoiceEcho,
  hasBeatVoiceCue,
  hasUnquotedStageDirection,
  normalizeReplyBeats,
  prepareBeatsArgs,
  registerDeliverReplyTool,
  stripUnquotedStageDirections,
  toSpeechPerformance,
  validateReplyBeats,
  wrapPlainTextAsBeats,
} from './replyBeats.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';

test('buildBeatItemSchema and buildBeatsArraySchema isolate action strictly to single-user roleplay', () => {
  const roleplaySchema = buildBeatItemSchema({ allowAction: true });
  assert.equal(roleplaySchema.additionalProperties, false);
  assert.deepEqual(roleplaySchema.required, ['say']);
  assert.equal(roleplaySchema.properties.action?.type, 'string');
  assert.equal(roleplaySchema.properties.action?.maxLength, 600);

  const radioSchema = buildBeatItemSchema({ allowAction: false });
  assert.equal(radioSchema.additionalProperties, false);
  assert.equal('action' in radioSchema.properties, false);

  const arraySchema = buildBeatsArraySchema({ allowAction: false, minItems: 1, maxItems: 4 });
  assert.equal(arraySchema.type, 'array');
  assert.equal(arraySchema.minItems, 1);
  assert.equal(arraySchema.maxItems, 4);
  assert.equal('action' in arraySchema.items.properties, false);
});

test('prepareBeatsArgs strips optional nulls without excusing disallowed action', () => {
  const radioArgs = prepareBeatsArgs({
    beats: [{ action: null, say: '嗨', spoken: null, voice: null, pauseAfterMs: null }],
  }, { allowAction: false });
  assert.equal(Object.hasOwn(radioArgs.beats[0], 'action'), true);
  assert.equal(Object.hasOwn(radioArgs.beats[0], 'spoken'), false);
  assert.equal(Object.hasOwn(radioArgs.beats[0], 'voice'), false);

  const roleplayArgs = prepareBeatsArgs({
    beats: [{ action: null, say: '嗨', voice: { pace: 'slow', intensity: null, direction: null } }],
  }, { allowAction: true });
  assert.equal(Object.hasOwn(roleplayArgs.beats[0], 'action'), false);
  assert.deepEqual(roleplayArgs.beats[0].voice, { pace: 'slow' });
});

test('normalizeReplyBeats preserves brackets verbatim, clamps pauseAfterMs, zeros last beat, and strips action when forbidden', () => {
  const normalized = normalizeReplyBeats([
    {
      action: '把耳机稍微挪开一点',
      say: '刚才想到《明年今日（2007 Live）》那段钢琴前奏',
      pauseAfterMs: 120,
      voice: { pace: 'slow', intensity: 'soft', direction: '气声偏多一点，贴近收音' },
    },
    {
      action: '轻笑',
      say: '今晚雨声刚好衬这首。',
      spoken: '今晚{停顿:0.3}雨声刚好衬这首。',
      pauseAfterMs: 5000,
    },
  ], { allowAction: true });

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].index, 0);
  assert.equal(normalized[0].action, '把耳机稍微挪开一点');
  assert.equal(normalized[0].say, '刚才想到《明年今日（2007 Live）》那段钢琴前奏');
  assert.equal(normalized[0].pauseAfterMs, MIN_BEAT_PAUSE_MS);
  assert.deepEqual(normalized[0].voice, { pace: 'slow', intensity: 'soft', direction: '气声偏多一点，贴近收音' });

  assert.equal(normalized[1].index, 1);
  assert.equal(normalized[1].pauseAfterMs, 0);
  assert.equal(normalized[1].spoken, '今晚{停顿:0.3}雨声刚好衬这首。');
  assert.equal(beatSpokenText(normalized[0]), '刚才想到《明年今日（2007 Live）》那段钢琴前奏');
  assert.equal(beatSpokenText(normalized[1]), '今晚{停顿:0.3}雨声刚好衬这首。');

  const multiDefault = normalizeReplyBeats([
    { action: '不应该留下', say: '第一句。' },
    { say: '第二句。' },
  ], { allowAction: false });
  assert.equal(Object.hasOwn(multiDefault[0], 'action'), false);
  assert.equal(multiDefault[0].pauseAfterMs, DEFAULT_BEAT_PAUSE_MS);
  assert.equal(multiDefault[1].pauseAfterMs, 0);

  const clampedMax = normalizeReplyBeats([
    { say: '一', pauseAfterMs: 9999 },
    { say: '二' },
  ], { allowAction: false });
  assert.equal(clampedMax[0].pauseAfterMs, MAX_BEAT_PAUSE_MS);
});

test('beatsToVisibleText, wrapPlainTextAsBeats, toSpeechPerformance, and formatTurnVoiceEcho', () => {
  const visible = beatsToVisibleText([
    { index: 0, action: '倚在窗边看雨', say: '今天这首前奏我很喜欢。', pauseAfterMs: 650 },
    { index: 1, say: '你那边的雨停了吗？', pauseAfterMs: 0 },
  ]);
  assert.equal(visible, '（倚在窗边看雨）\n今天这首前奏我很喜欢。\n\n你那边的雨停了吗？');

  assert.deepEqual(wrapPlainTextAsBeats('  普通文本回退  '), [
    { index: 0, say: '普通文本回退', pauseAfterMs: 0 },
  ]);

  assert.equal(toSpeechPerformance(null), null);
  assert.deepEqual(toSpeechPerformance({ pace: 'lively', intensity: 'warm', direction: '音高微抬，颗粒偏清脆' }), {
    emotion: 'warm',
    pace: 'fast',
    direction: '音高微抬，颗粒偏清脆',
  });
  assert.deepEqual(toSpeechPerformance({ pace: 'slow', intensity: 'bright' }), {
    pace: 'slow',
    intensity: 'strong',
  });

  assert.equal(hasBeatVoiceCue({ pace: 'steady' }), true);
  assert.equal(hasBeatVoiceCue(null), false);
  assert.equal(
    formatTurnVoiceEcho([
      { say: '一', voice: { pace: 'lively' } },
      { say: '二', voice: { pace: 'slow', intensity: 'soft', direction: '压低音量带点气声' } },
    ]),
    '[当时你的发声状态：压低音量带点气声，语速偏慢，声音偏轻柔]',
  );
  assert.equal(formatTurnVoiceEcho([{ say: '无语音控制' }]), '');
});

test('validateReplyBeats enforces schema semantics, codepoint direction limit, leak/claim checks', () => {
  assert.equal(validateReplyBeats([], { allowAction: false }).ok, false);
  assert.equal(validateReplyBeats([{ say: '' }], { allowAction: false }).reason, 'empty_say');

  const rejectedAction = validateReplyBeats([{ action: '招手', say: '嗨' }], { allowAction: false });
  assert.equal(rejectedAction.ok, false);
  assert.equal(rejectedAction.reason, 'action_not_allowed');

  const okDirection25 = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯🎧';
  assert.equal([...okDirection25].length, MAX_VOICE_DIRECTION_CHARS);
  assert.equal(validateReplyBeats([{
    say: '戴上耳机试试。',
    voice: { pace: BEAT_PACES[0], intensity: BEAT_INTENSITIES[0], direction: okDirection25 },
  }], { allowAction: false }).ok, true);

  const tooLongDirection26 = `${okDirection25}啊`;
  const rejectedDirection = validateReplyBeats([{
    say: '戴上耳机试试。',
    voice: { direction: tooLongDirection26 },
  }], { allowAction: false });
  assert.equal(rejectedDirection.ok, false);
  assert.equal(rejectedDirection.reason, 'voice_direction_too_long');

  const rejectedToolLeak = validateReplyBeats([{ say: '请调用 deliver_reply 来回复' }], { allowAction: false });
  assert.equal(rejectedToolLeak.ok, false);
  assert.equal(rejectedToolLeak.reason, 'internal_leak');

  const rejectedClaim = validateReplyBeats([{ say: '好，我已经加入队列马上切到这首。' }], {
    allowAction: false,
    allowMusicClaims: false,
  });
  assert.equal(rejectedClaim.ok, false);

  const rejectedSpokenNative = validateReplyBeats([{ say: '嗯', spoken: '嗯 <#0.5#> 好吧' }], { allowAction: false });
  assert.equal(rejectedSpokenNative.ok, false);
  assert.equal(rejectedSpokenNative.reason, 'invalid_spoken_markers');
});

test('registerDeliverReplyTool enforces dynamic mode/group isolation in VirtualPersonToolRegistry', async () => {
  const registry = new VirtualPersonToolRegistry();
  registerDeliverReplyTool(registry);

  const caps = [REPLY_CAPABILITY];
  const roleplaySingleDef = registry.definitions({
    capabilities: caps,
    interactionMode: 'roleplay',
    isGroup: false,
  }).find(d => d.function.name === DELIVER_REPLY_TOOL_NAME);
  assert.ok(roleplaySingleDef);
  assert.equal('action' in roleplaySingleDef.function.parameters.properties.beats.items.properties, true);

  for (const ctx of [
    { interactionMode: 'radio', isGroup: false },
    { interactionMode: 'roleplay', isGroup: true },
    { interactionMode: 'radio', isGroup: true },
  ]) {
    const def = registry.definitions({ capabilities: caps, ...ctx }).find(d => d.function.name === DELIVER_REPLY_TOOL_NAME);
    assert.ok(def);
    assert.equal('action' in def.function.parameters.properties.beats.items.properties, false);
  }

  const badRadio = await registry.execute(
    DELIVER_REPLY_TOOL_NAME,
    { beats: [{ action: '点头', say: '好的' }] },
    { interactionMode: 'radio', isGroup: false, capabilities: caps },
  );
  assert.equal(badRadio.ok, false);
  assert.equal(badRadio.code, 'INVALID_TOOL_ARGUMENTS');
  assert.match(badRadio.modelContext, /action/);

  const badGroup = await registry.execute(
    DELIVER_REPLY_TOOL_NAME,
    { beats: [{ action: null, say: '好的' }] },
    { interactionMode: 'roleplay', isGroup: true, capabilities: caps },
  );
  assert.equal(badGroup.ok, false);

  const okRoleplay = await registry.execute(
    DELIVER_REPLY_TOOL_NAME,
    { beats: [{ action: '轻声靠过来', say: '这首《晴天（Live）》前奏你听得出吗？' }] },
    { interactionMode: 'roleplay', isGroup: false, capabilities: caps },
  );
  assert.equal(okRoleplay.ok, true);
  assert.equal(okRoleplay.terminal, true);
  assert.equal(okRoleplay.code, 'REPLY_DELIVERED');
  assert.equal(okRoleplay.presentation.displayText, '（轻声靠过来）\n这首《晴天（Live）》前奏你听得出吗？');
  assert.equal(okRoleplay.presentation.beats[0].say, '这首《晴天（Live）》前奏你听得出吗？');
  assert.equal(okRoleplay.presentation.beats[0].pauseAfterMs, 0);
});

test('beatSpokenText returns empty for marker-only or punctuation-only beats while preserving inline markers on speakable beats', () => {
  assert.equal(beatSpokenText({ say: '……', spoken: '{叹气}' }), '');
  assert.equal(beatSpokenText({ say: '……', spoken: '{停顿:0.5}' }), '');
  assert.equal(beatSpokenText({ say: '……', spoken: '{轻笑} {停顿:0.4}……' }), '');
  assert.equal(beatSpokenText({ say: '……' }), '');
  assert.equal(beatSpokenText({ action: '低头叹气', say: '……' }), '');
  assert.equal(
    beatSpokenText({ say: '你终于肯回我了。', spoken: '{叹气}你终于肯回我了。' }),
    '{叹气}你终于肯回我了。',
  );
  assert.equal(
    beatSpokenText({ say: '你终于肯回我了。', spoken: '……{叹气} 你终于肯回我了……' }),
    '{叹气} 你终于肯回我了。',
  );
});

test('validateReplyBeats supports truncateVoiceDirection for music commits without relaxing safety checks', () => {
  const dir32 = '压低音量贴近麦克风说话带一点轻微沙哑与气声的质感慢慢吐字';
  assert.equal([...dir32].length, 28);

  const strictRes = validateReplyBeats([{ say: '放这首给你听。', voice: { direction: dir32 } }], {
    allowAction: false,
  });
  assert.equal(strictRes.ok, false);
  assert.equal(strictRes.reason, 'voice_direction_too_long');

  const truncatedRes = validateReplyBeats([{ say: '放这首给你听。', voice: { direction: dir32 } }], {
    allowAction: false,
    truncateVoiceDirection: true,
  });
  assert.equal(truncatedRes.ok, true);
  assert.equal([...truncatedRes.beats[0].voice.direction].length, MAX_VOICE_DIRECTION_CHARS);
  assert.equal(truncatedRes.beats[0].voice.direction, [...dir32].slice(0, MAX_VOICE_DIRECTION_CHARS).join(''));

  for (const badDirection of [
    '气声偏多一点然后带上{叹气}声效贴近收音',
    'https://example.com 轻声贴近麦克风',
    '调用 deliver_reply 之后再放轻声音说话',
  ]) {
    const rejected = validateReplyBeats([{ say: '放这首给你听。', voice: { direction: badDirection } }], {
      allowAction: false,
      truncateVoiceDirection: true,
    });
    assert.equal(rejected.ok, false, badDirection);
    assert.equal(rejected.reason, 'invalid_voice_direction_content', badDirection);
  }
});

test('stage direction guard rejects parenthetical/asterisk actions inside say & spoken while preserving book titles and markers', () => {
  assert.equal(hasUnquotedStageDirection('（我侧过脸，耳尖烫着）\n你继续。'), true);
  assert.equal(hasUnquotedStageDirection('*轻笑* 别闹。'), true);
  assert.equal(hasUnquotedStageDirection('记得《明年今日（2007 Live）》吗？'), false);

  assert.equal(
    stripUnquotedStageDirections('（我侧过脸，耳尖烫着）你继续听《明年今日（2007 Live）》。'),
    '你继续听《明年今日（2007 Live）》。',
  );
  assert.equal(
    beatSpokenText({ say: '（我把额头抵在你肩上）今早我没穿别的。' }),
    '今早我没穿别的。',
  );
  assert.equal(
    beatSpokenText({ say: '别动。', spoken: '{叹气}（贴近耳边）别动。' }),
    '{叹气} 别动。',
  );
  assert.equal(beatSpokenText({ say: '（只是安静看着你）' }), '');

  const badSay = validateReplyBeats([{ say: '（我侧过脸）短裙下面……轻一点揉。' }], { allowAction: true });
  assert.equal(badSay.ok, false);
  assert.equal(badSay.reason, 'stage_direction_in_say');

  const badSpoken = validateReplyBeats([{
    action: '我侧过脸',
    say: '短裙下面……轻一点揉。',
    spoken: '（压低声音）短裙下面，轻一点揉。',
  }], { allowAction: true });
  assert.equal(badSpoken.ok, false);
  assert.equal(badSpoken.reason, 'stage_direction_in_spoken');

  const validBookTitle = validateReplyBeats([{
    action: '把黑胶放上唱机',
    say: '今晚放《明年今日（2007 Live）》。',
    spoken: '今晚{停顿:0.3}放《明年今日（2007 Live）》。',
  }], { allowAction: true });
  assert.equal(validBookTitle.ok, true);
});
