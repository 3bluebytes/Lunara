import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fallbackBeatsForPlainText,
  isMixedRoleplayBeats,
  replayDeliveredBeatMessages,
  validateReplyBeats,
} from './replyBeats.js';

const NARRATED = '我顺着你躺下去，裙摆被压得皱皱的，腿还软着。我抬眼看你，呼吸还没完全稳下来。\n“别急，慢慢来。”\n我的手抓住你的小臂，声音很轻，像怕吵醒什么。\n“今天有的是时间，你抱着我就好。”';

test('私语纯文本兜底按解析器拆成 action/say 分拍', () => {
  const beats = fallbackBeatsForPlainText(NARRATED, { allowAction: true });
  assert.equal(beats.length, 2);
  assert.match(beats[0].action, /顺着你躺下去/);
  assert.equal(beats[0].say, '别急，慢慢来。');
  assert.match(beats[1].action, /抓住你的小臂/);
  assert.equal(beats[1].say, '今天有的是时间，你抱着我就好。');
  assert.equal(beats.at(-1).pauseAfterMs, 0);

  const bracketed = fallbackBeatsForPlainText('（把毯子往你肩上拉了拉）\n别着凉了。', { allowAction: true });
  assert.equal(bracketed.length, 1);
  assert.equal(bracketed[0].action, '把毯子往你肩上拉了拉');
  assert.equal(bracketed[0].say, '别着凉了。');
});

test('没有动作的纯台词仍是一拍；电台模式不拆', () => {
  assert.deepEqual(fallbackBeatsForPlainText('今天想听点什么？', { allowAction: true }),
    [{ index: 0, say: '今天想听点什么？', pauseAfterMs: 0 }]);
  const radio = fallbackBeatsForPlainText(NARRATED, { allowAction: false });
  assert.equal(radio.length, 1);
  assert.equal(radio[0].action, undefined);
});

test('超过四拍时多出的部分并入最后一拍', () => {
  const text = [1, 2, 3, 4, 5, 6].map(n => `（动作${n}）\n台词${n}。`).join('\n');
  const beats = fallbackBeatsForPlainText(text, { allowAction: true });
  assert.equal(beats.length, 4);
  assert.match(beats[3].action, /动作4[\s\S]*动作6/);
  assert.match(beats[3].say, /台词4[\s\S]*台词6/);
});

test('识别一拍里混排叙述与台词的旧回合（有无括号都算）', () => {
  assert.equal(isMixedRoleplayBeats([{ say: NARRATED }]), true);
  assert.equal(isMixedRoleplayBeats([{ say: '（笑了一下）好呀。' }]), true);
  assert.equal(isMixedRoleplayBeats([{ say: '好呀，那就这首。' }]), false);
  assert.equal(isMixedRoleplayBeats([{ action: '笑', say: '好呀。' }]), false);
  assert.equal(isMixedRoleplayBeats([{ say: 'a' }, { say: 'b' }]), false);
});

test('自己的分拍回复回放为 deliver_reply 调用与工具结果', () => {
  const turn = {
    turnId: 'turn_abc',
    message: {
      role: 'assistant',
      content: '（轻笑）\n好呀。\n\n那就这首。',
      beats: [
        { index: 0, action: '轻笑', say: '好呀。', spoken: '{轻笑}好呀。', voice: { pace: 'slow' }, pauseAfterMs: 650, audioUrl: '/tts/x.mp3', hash: 'x' },
        { index: 1, say: '那就这首。', pauseAfterMs: 0 },
      ],
    },
  };
  const [call, result] = replayDeliveredBeatMessages(turn, { allowAction: true, voiceEcho: '[当时你的发声状态：放慢]' });
  assert.equal(call.role, 'assistant');
  assert.equal(call.content, '');
  assert.equal(call.tool_calls.length, 1);
  assert.equal(call.tool_calls[0].id, 'replay_turn_abc');
  assert.equal(call.tool_calls[0].function.name, 'deliver_reply');
  const args = JSON.parse(call.tool_calls[0].function.arguments);
  assert.deepEqual(args, { beats: [{ action: '轻笑', say: '好呀。' }, { say: '那就这首。' }] });
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, 'replay_turn_abc');
  assert.match(result.content, /已送达/);
  assert.match(result.content, /\[当时你的发声状态：放慢\]/);

  const [radioCall, radioResult] = replayDeliveredBeatMessages(turn, { allowAction: false });
  assert.deepEqual(JSON.parse(radioCall.tool_calls[0].function.arguments), { beats: [{ say: '好呀。' }, { say: '那就这首。' }] });
  assert.doesNotMatch(radioResult.content, /发声状态/);
});

test('私语房间回放前把混排的单拍旧回合拆开', () => {
  const turn = { turnId: 't1', message: { role: 'assistant', content: NARRATED, beats: [{ index: 0, say: NARRATED, pauseAfterMs: 0 }] } };
  const [call] = replayDeliveredBeatMessages(turn, { allowAction: true });
  const { beats } = JSON.parse(call.tool_calls[0].function.arguments);
  assert.equal(beats.length, 2);
  assert.equal(beats[0].say, '别急，慢慢来。');
  assert.match(beats[0].action, /顺着你躺下去/);
});

test('spoken 里写坏的类标记被拒绝，普通花括号保留', () => {
  for (const spoken of ['想摸就轻一点。{u6362气}今天整天都在。', '不老实{u2026}你看。', '别叫我。{pause:0.4}叫柔姐。', '慢一点{顿:0.4}好吗。']) {
    const result = validateReplyBeats([{ say: '好的。', spoken }], { allowAction: true });
    assert.equal(result.ok, false, spoken);
    assert.equal(result.reason, 'invalid_spoken_markers', spoken);
  }
  assert.equal(validateReplyBeats([{ say: '放这首。', spoken: '放这首 {Love}。' }], { allowAction: true }).ok, true);
});

test('连着几句引号台词拆开后不留残余引号', () => {
  const text = '我肩往下塌了一点，胸口跟着你的手轻轻一颤，气音断成几截，整个人往你怀里靠过去，手指揪着你的衣角不肯松开，眼睛却一直没敢抬起来看你。\n\n“轻一点，好麻。”\n\n“叫就叫……别停。”';
  const beats = fallbackBeatsForPlainText(text, { allowAction: true });
  assert.equal(beats.length, 1);
  assert.match(beats[0].action, /肩往下塌/);
  assert.equal(beats[0].say, '轻一点，好麻。\n叫就叫……别停。');
});
