import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatMessageHtml, buildTrackCardHtml, parsePersistedChats } from './chatMarkup.js';

test('chat markup escapes untrusted text and preserves existing CSS/data contracts', () => {
  const html = buildChatMessageHtml({
    role: 'assistant',
    segments: [{ type: 'opening', content: '<script>bad()</script>' }],
    tracks: [{ songId: 's&1', batchId: 'b1', title: '<One>', artist: 'A&B', url: '/one' }],
    time: '20:08',
  });
  assert.match(html, /chat-segment chat-seg-opening/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /class="chat-track"/);
  assert.match(html, /data-song-id="s&amp;1"/);
  assert.match(html, /&lt;One&gt;/);
  assert.match(html, /20:08/);
});

test('a card without any playback identity stays visible but disabled', () => {
  const html = buildTrackCardHtml({ title: 'Ghost', artist: 'Nobody' });
  assert.match(html, /chat-track unavailable/);
  assert.match(html, /disabled/);
});

test('history cards keep their committed identity: selectable, with album art', () => {
  // 账本里的曲目只有 canonical identity 与封面，没有媒体 url。
  // 拿 url 当可选门槛会让全部历史卡片变成不可点的死卡。
  const html = buildTrackCardHtml({
    queueItemId: 'queue:7', songId: 'qq:1', title: '孤鸟的歌', artist: '马頔',
    pic_url: 'https://example.test/a.jpg?x=1&y=2',
  });
  assert.match(html, /class="chat-track"/);
  assert.doesNotMatch(html, /disabled/);
  assert.match(html, /data-queue-item-id="queue:7"/);
  assert.match(html, /data-song-id="qq:1"/);
  assert.match(html, /class="ct-cover"/);
  assert.match(html, /src="https:\/\/example\.test\/a\.jpg\?x=1&amp;y=2"/);
  assert.match(html, /aria-label="播放《孤鸟的歌》 — 马頔"/);
});

test('a card without a cover keeps the same tile with a fallback glyph', () => {
  const html = buildTrackCardHtml({ songId: 'qq:2', artwork: '', title: '无封面', artist: 'A' });
  assert.match(html, /class="ct-cover"/);
  assert.match(html, /ct-cover-glyph/);
  assert.doesNotMatch(html, /<img/);
});

test('a card without a queue occurrence still resolves by canonical song id', () => {
  const html = buildTrackCardHtml({ songId: 'qq:9', title: 'T', artist: 'A', artwork: 'https://example.test/b.jpg' });
  assert.match(html, /class="chat-track"/);
  assert.doesNotMatch(html, /data-queue-item-id/);
  assert.match(html, /src="https:\/\/example\.test\/b\.jpg"/);
});

test('persisted chat parser keeps the existing radiohost-to-html shape and migrates old assistant class', () => {
  assert.deepEqual(parsePersistedChats(JSON.stringify({
    'radiohost-a': '<div class="chat-msg claudio">old</div>',
  })), {
    'radiohost-a': '<div class="chat-msg assistant">old</div>',
  });
  assert.deepEqual(parsePersistedChats('not-json'), {});
});

// ---- 统一无框助手消息排版 ----

const longSingleParagraph = '这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱。副歌那句「那些年错过的大雨」在录音室里是一遍过的，尾音有一点沙，反而更像人。我把它放在今晚第一位，后面接一首把不甘心唱得很轻的歌，连着听，情绪是往下走的，不用急着换心情。';

test('long assistant reply uses the same unified chat-bubble layout as short replies and keeps card/time', () => {
  const html = buildChatMessageHtml({
    role: 'assistant',
    text: '那就从《那些年》开始\n这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱，尾音有一点沙，反而更像人。\n我把它放在今晚第一位，后面接五月天的《温柔》，两首都是把不甘心唱得很轻的歌，连着听，情绪是往下走的。',
    tracks: [{ songId: 's1', title: '那些年', artist: '胡夏', url: '/one' }],
    time: '22:41',
    speakerName: 'Lunara',
  });
  assert.doesNotMatch(html, /chat-editorial/);
  assert.match(html, /^<div class="chat-speaker">[\s\S]*?<\/div><div class="chat-bubble"><div class="chat-text">/);
  assert.match(html, /那就从《那些年》开始\n这首歌最慢的地方/);
  assert.match(html, /class="chat-track"/);
  assert.match(html, /chat-time[^>]*>22:41/);
});

test('long single-paragraph reply also stays in unified chat-bubble without editorial split', () => {
  const html = buildChatMessageHtml({ role: 'assistant', text: longSingleParagraph, time: '22:41' });
  assert.doesNotMatch(html, /chat-editorial/);
  assert.match(html, /<div class="chat-bubble"><div class="chat-text">这首歌最慢/);
});

test('an invited group reply carries an escaped “回复 X” label beside the speaker name', () => {
  const html = buildChatMessageHtml({ role: 'assistant', text: '现场版的贝斯更松。', speakerName: 'Mio', replyToName: '<Lunara>' });
  assert.match(html, /class="chat-speaker-name">Mio<\/span><span class="chat-speaker-reply">回复 &lt;Lunara&gt;<\/span>/);
  assert.doesNotMatch(buildChatMessageHtml({ role: 'assistant', text: '嗯。', speakerName: 'Mio' }), /chat-speaker-reply/);
});

test('the host label sits after the reply label on the speaker line', () => {
  const html = buildChatMessageHtml({ role: 'assistant', text: '放这首。', speakerName: 'Mio', replyToName: 'Lunara', hostsTrack: true });
  assert.match(html, /回复 Lunara<\/span><span class="chat-speaker-reply">主持这一首<\/span><\/div>/);
});

test('a user message starting with quote lines renders a quote block above the reply', () => {
  const html = buildChatMessageHtml({ role: 'user', text: '> 引用 Lunara：三小时过去了\n\n我是在想下一首', time: '21:24' });
  assert.match(html, /<blockquote class="chat-quote"><p>引用 Lunara：三小时过去了<\/p><\/blockquote>/);
  assert.match(html, /<div class="chat-text">我是在想下一首<\/div>/);
});

test('quote blocks are escaped and only leading lines are treated as quotes', () => {
  const quoted = buildChatMessageHtml({ role: 'user', text: '> 引用 我：<img src=x onerror=bad()>\n\n正文', time: '21:24' });
  assert.match(quoted, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(quoted, /<img/);
  const later = buildChatMessageHtml({ role: 'user', text: '正文\n> 不是引用', time: '21:24' });
  assert.doesNotMatch(later, /chat-quote/);
});

test('partner messages are never re-typeset as quotes', () => {
  const assistant = buildChatMessageHtml({ role: 'assistant', text: '> 有点像引用，但这是伙伴的原话', time: '21:24' });
  assert.doesNotMatch(assistant, /chat-quote/);
  assert.match(assistant, /<div class="chat-text">&gt; 有点像引用/);
});

test('a quote-only message keeps the quote block and no empty text bubble', () => {
  const html = buildChatMessageHtml({ role: 'user', text: '> 引用 Lunara：嗯', time: '21:24' });
  assert.match(html, /class="chat-quote"/);
  assert.doesNotMatch(html, /class="chat-text"/);
});

test('roleplay action/speech segments render layered classes and voice button obeys states uniformly across short and long turns', () => {
  const bubbleHtml = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_rp_1',
    text: '（轻轻合上封套）外头风大了。',
    segments: [{ type: 'action', content: '（轻轻合上封套）' }, { type: 'speech', content: '外头风大了。' }],
    voice: { canSynthesize: true, audioUrl: null },
    time: '23:10',
  });
  assert.match(bubbleHtml, /class="chat-segment chat-seg-action">（轻轻合上封套）<\/div>/);
  assert.match(bubbleHtml, /class="chat-segment chat-seg-speech">外头风大了。<\/div>/);
  assert.match(bubbleHtml, /data-voice-turn="turn_rp_1"[^>]*data-voice-state="idle"[^>]*>生成语音<\/button>/);

  const longRoleplay = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_rp_long',
    segments: [
      { type: 'action', content: '（把黑胶收进柜子，转身看向窗外）' },
      { type: 'speech', content: '这首老爵士其实我很早就想跟你分享了，只是平时在电台里总是匆匆忙忙介绍两句就切到下一首，今天总算有整段晚上的工夫慢慢坐在桌子两边把它放完。' },
    ],
    voice: { canSynthesize: true, audioUrl: '/tts/h1.wav' },
    playingVoice: true,
    time: '23:15',
  });
  assert.doesNotMatch(longRoleplay, /chat-editorial/);
  assert.match(longRoleplay, /class="chat-bubble"/);
  assert.match(longRoleplay, /<div class="chat-segment chat-seg-action">（把黑胶收进柜子，转身看向窗外）<\/div>/);
  assert.match(longRoleplay, /<div class="chat-segment chat-seg-speech">这首老爵士其实我很早就想跟你分享了/);
  assert.match(longRoleplay, /data-voice-state="playing"[^>]*aria-pressed="true"[^>]*>■ 停止<\/button>/);

  const inlineLong = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_rp_inline',
    segments: [
      { type: 'action', content: '（把散下来的头发拢到脑后）' },
      { type: 'speech', content: '“我什么时候穿什么，那是我的事。”' },
      { type: 'action', content: '我抬眼看你，', inline: true },
      { type: 'speech', content: '“你要拿这个当话柄，那这屋里就没我坐的地方了，今天我就先话说到这里了。”', inline: true },
      { type: 'speech', content: '洗把脸，回去。明天你要还想来，好好说话，我照样给你开门。' },
    ],
    time: '16:35',
  });
  assert.doesNotMatch(inlineLong, /chat-editorial/);
  assert.match(inlineLong, /<div class="chat-segment chat-seg-action">（把散下来的头发拢到脑后）<\/div>/);
  assert.match(
    inlineLong,
    /<div class="chat-segment chat-seg-mixed"><span class="chat-seg-speech">“我什么时候穿什么，那是我的事。”<\/span><span class="chat-seg-action">我抬眼看你，<\/span><span class="chat-seg-speech">“你要拿这个当话柄，那这屋里就没我坐的地方了，今天我就先话说到这里了。”<\/span><\/div>/,
  );
  assert.match(inlineLong, /<div class="chat-segment chat-seg-speech">洗把脸，回去。明天你要还想来，好好说话，我照样给你开门。<\/div>/);

  const inlineBubble = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_rp_inline_short',
    segments: [
      { type: 'speech', content: '“算了，”' },
      { type: 'action', content: '我把视线移开。', inline: true },
    ],
    time: '16:36',
  });
  assert.match(
    inlineBubble,
    /<div class="chat-segment chat-seg-mixed"><span class="chat-seg-speech">“算了，”<\/span><span class="chat-seg-action">我把视线移开。<\/span><\/div>/,
  );
});

test('single-beat long turn uses the unified chat-bubble without editorial split', () => {
  const longBeat = '这'.repeat(130);
  const html = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_single_beat_long',
    speakerName: 'Lunara',
    beats: [{ index: 0, say: longBeat }],
    time: '23:40',
  });
  assert.doesNotMatch(html, /chat-editorial|has-tail/);
  assert.match(html, /^<div class="chat-speaker">[\s\S]*?<\/div><div class="chat-bubble">/);
  assert.match(html, new RegExp(longBeat));
});

test('multi-beat turn places speaker header outside group and puts metadata/single voice button on last beat without tail', () => {
  const html = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_beats_1',
    interactionMode: 'roleplay',
    speakerName: 'Lunara',
    replyToName: 'Mio',
    time: '23:42',
    beats: [
      { index: 0, action: '（把黑胶封套轻轻放回架上）', say: '刚刚那张是《明年今日（2007 Live）》。', pauseAfterMs: 500 },
      { index: 1, say: '这段副歌我留给你慢慢听。', pauseAfterMs: 650 },
      { index: 2, action: '（指尖敲了敲桌沿）', say: '好了，下面接一首安静的。', pauseAfterMs: 0 },
    ],
    tracks: [{ songId: 'qq:100', title: '明年今日（2007 Live）', artist: '陈奕迅' }],
    musicRecommendation: { turnId: 'turn_beats_1', title: '夜风', artist: 'A', state: 'pending' },
    hostSuggestion: { toPersonId: 'mio', targetName: 'Mio', reason: '合适', state: 'pending' },
    webSources: [{ title: 'Concert Notes', url: 'https://example.test/notes' }],
    voice: { canSynthesize: true, status: 'missing', audioUrl: null },
    activeBeatIndex: 1,
  });

  assert.doesNotMatch(html, /chat-editorial|has-tail/);
  assert.match(html, /^<div class="chat-speaker">[\s\S]*?<\/div><div class="chat-beat-group" data-turn-id="turn_beats_1">/);
  assert.equal((html.match(/class="chat-beat-bubble /g) || []).length, 3);
  assert.equal((html.match(/class="chat-speaker"/g) || []).length, 1);
  assert.equal((html.match(/class="chat-time"/g) || []).length, 1);
  assert.equal((html.match(/class="chat-voice-bar"/g) || []).length, 1);
  assert.equal((html.match(/class="chat-tracks"/g) || []).length, 1);
  assert.equal((html.match(/class="chat-recommendation"/g) || []).length, 1);
  assert.equal((html.match(/class="chat-host-suggestion"/g) || []).length, 1);

  const b0 = html.match(/<div class="chat-beat-bubble[^"]*" data-beat-index="0"[\s\S]*?(?=<div class="chat-beat-bubble|$)/)?.[0] || '';
  const b1 = html.match(/<div class="chat-beat-bubble[^"]*" data-beat-index="1"[\s\S]*?(?=<div class="chat-beat-bubble|$)/)?.[0] || '';
  const b2 = html.match(/<div class="chat-beat-bubble[^"]*" data-beat-index="2"[\s\S]*$/)?.[0] || '';

  assert.match(b0, /is-first/);
  assert.match(b0, /class="roleplay-action">（把黑胶封套轻轻放回架上）<\/div>/);
  assert.match(b0, /class="roleplay-speech">刚刚那张是《明年今日（2007 Live）》。<\/div>/);
  assert.doesNotMatch(b0, /chat-speaker|chat-time|chat-voice-bar|has-tail/);

  assert.match(b1, /is-middle/);
  assert.match(b1, /is-speaking/);
  assert.match(b1, /data-speaking="1"/);
  assert.doesNotMatch(b1, /chat-speaker|chat-time|chat-voice-bar|has-tail/);

  assert.match(b2, /is-last/);
  assert.doesNotMatch(b2, /has-tail/);
  assert.match(b2, /chat-tracks/);
  assert.match(b2, /chat-recommendation/);
  assert.match(b2, /chat-host-suggestion/);
  assert.match(b2, /chat-time[^>]*>23:42/);
  assert.match(b2, /data-voice-turn="turn_beats_1"[^>]*>生成语音<\/button>/);
});

test('unfinished beatProgress keeps metadata on the last delivered beat without tail and moves it once complete', () => {
  const partialHtml = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_pipe_1',
    speakerName: 'Lunara',
    time: '00:10',
    beats: [
      { index: 0, say: '第一拍先到了。', pauseAfterMs: 400 },
      { index: 1, say: '第二拍也到了。', pauseAfterMs: 400 },
      { index: 2, say: '第三拍还没到。', pauseAfterMs: 0 },
    ],
    beatProgress: { deliveredCount: 2, totalCount: 3, done: false },
    voice: { canSynthesize: true, audioUrl: '/tts/b0.wav' },
  });
  assert.match(partialHtml, /data-beat-pending="1"/);
  assert.equal((partialHtml.match(/data-beat-index="/g) || []).length, 2);
  assert.doesNotMatch(partialHtml, /第三拍还没到|has-tail/);
  const b1 = partialHtml.match(/<div class="chat-beat-bubble[^"]*" data-beat-index="1"[\s\S]*$/)?.[0] || '';
  assert.match(b1, /is-last/);
  assert.match(b1, /00:10/);
  assert.match(b1, /data-has-audio="1"[^>]*>▶ 重听<\/button>/);

  const doneHtml = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_pipe_1',
    speakerName: 'Lunara',
    time: '00:10',
    beats: [
      { index: 0, say: '第一拍先到了。', pauseAfterMs: 400 },
      { index: 1, say: '第二拍也到了。', pauseAfterMs: 400 },
      { index: 2, say: '第三拍也齐了。', pauseAfterMs: 0 },
    ],
    beatProgress: { deliveredCount: 3, totalCount: 3, done: true },
  });
  assert.doesNotMatch(doneHtml, /data-beat-pending|has-tail/);
  assert.equal((doneHtml.match(/data-beat-index="/g) || []).length, 3);
  const doneB2 = doneHtml.match(/<div class="chat-beat-bubble[^"]*" data-beat-index="2"[\s\S]*$/)?.[0] || '';
  assert.match(doneB2, /is-last/);
  assert.match(doneB2, /00:10/);
});

test('legacy roleplay turn without beats falls back cleanly to parseRoleplaySegments', () => {
  const html = buildChatMessageHtml({
    role: 'assistant',
    turnId: 'turn_legacy_rp',
    interactionMode: 'roleplay',
    text: '（轻轻叹了口气）刚才那首《明年今日（2007）》真不错。',
    time: '21:15',
  });
  assert.doesNotMatch(html, /chat-editorial/);
  assert.match(html, /class="chat-segment chat-seg-action">（轻轻叹了口气）<\/div>/);
  assert.match(html, /《明年今日（2007）》/);
});
