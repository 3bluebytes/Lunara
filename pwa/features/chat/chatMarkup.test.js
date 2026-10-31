import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatMessageHtml, buildTrackCardHtml, parsePersistedChats, shouldRenderEditorial } from './chatMarkup.js';

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

// ---- 编辑式排版（长回复阅读节奏） ----

const longSingleParagraph = '这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱。副歌那句「那些年错过的大雨」在录音室里是一遍过的，尾音有一点沙，反而更像人。我把它放在今晚第一位，后面接一首把不甘心唱得很轻的歌，连着听，情绪是往下走的，不用急着换心情。';

test('editorial threshold: length and paragraph rules', () => {
  // 单段 121 字：编辑式。
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: '这'.repeat(121) }), true);
  // 单段 120 字整：不动。
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: '这'.repeat(120) }), false);
  // 两段合计 81 字：编辑式。
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: '这'.repeat(40) + '\n' + '那'.repeat(41) }), true);
  // 空行与空白不计入字数：非空白字符仍为 81、段落数仍为 2，判定不变。
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: '这'.repeat(40) + '\n \n' + '那'.repeat(41) }), true);
  // 两段合计 80 字整：不动。
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: '这'.repeat(40) + '\n' + '那'.repeat(40) }), false);
  // 单段 80 字以内：不动。
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: '短消息' }), false);
  // 用户消息永不编辑式。
  assert.equal(shouldRenderEditorial({ role: 'user', text: longSingleParagraph }), false);
  // 未知角色（兼容旧调用）不编辑式。
  assert.equal(shouldRenderEditorial({ text: longSingleParagraph }), false);
});

test('editorial threshold: segments join for judgment; missing data degrades', () => {
  assert.equal(shouldRenderEditorial({
    role: 'assistant',
    segments: [{ type: 'opening', content: '这段开场白足够长。'.repeat(14) }],
  }), true);
  // 既无 text 也无 segments：降级为 false。
  assert.equal(shouldRenderEditorial({ role: 'assistant' }), false);
  assert.equal(shouldRenderEditorial({ role: 'assistant', text: 42 }), false);
});

test('long assistant reply renders as editorial layout with plain paragraphs and kept card/time', () => {
  const html = buildChatMessageHtml({
    role: 'assistant',
    text: '那就从《那些年》开始\n这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱，尾音有一点沙，反而更像人。\n我把它放在今晚第一位，后面接五月天的《温柔》，两首都是把不甘心唱得很轻的歌，连着听，情绪是往下走的。',
    tracks: [{ songId: 's1', title: '那些年', artist: '胡夏', url: '/one' }],
    time: '22:41',
    speakerName: 'Lunara',
  });
  assert.match(html, /class="chat-editorial" data-presentation="editorial"/);
  // 首段与其余段落同级：不存在标题段/开场段类名。
  assert.match(html, /<p>那就从《那些年》开始<\/p>/);
  assert.doesNotMatch(html, /chat-editorial-lead|chat-editorial-title/);
  assert.equal((html.match(/<p>/g) || []).length, 3);
  assert.match(html, /<p>这首歌最慢的地方不在速度，在它的呼吸——前奏进来时鼓点还没落，声线先走出来，像是把一整天的重量先放下再唱，尾音有一点沙，反而更像人。<\/p>/);
  assert.doesNotMatch(html, /chat-bubble/);
  assert.match(html, /class="chat-track"/);
  assert.match(html, /chat-time[^>]*>22:41/);
});

test('long single-paragraph reply stays editorial as one plain paragraph', () => {
  const html = buildChatMessageHtml({ role: 'assistant', text: longSingleParagraph, time: '22:41' });
  assert.match(html, /chat-editorial/);
  assert.equal((html.match(/<p>/g) || []).length, 1);
  assert.match(html, /<p>这首歌最慢/);
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
