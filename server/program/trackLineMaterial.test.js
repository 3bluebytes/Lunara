// 串词素材：host 写串词时除了自己的上下文，多看这份帮它聊这首歌的简报。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackLineMaterial, renderTrackLineTrigger, recentSpokenIntros, pendingTrackLines, createTrackLineMaterialProvider, estimatedStartTimes } from './trackLineMaterial.js';

const track = { songId: '1', source: 'qq', title: '晴天', artist: '周杰伦', album: '叶惠美',
  lyric: { lrc: '[00:01.00]作词：周杰伦\n[00:02.00]故事的小黄花\n[00:03.00]从出生那年就飘着' },
  // track 自己身上的这些不进素材；曲库标签只从 sound 参数来：
  genre: '流行', mood: '怀旧', tempo: 'slow', instruments: ['钢琴', '弦乐'], narration: { text: '上一条旧串词' } };

test('素材：歌词节选、目录事实、记忆、收藏、推荐和试探都在；篇幅只留下限', () => {
  const material = buildTrackLineMaterial({ ref: 't1', track, year: 2003,
    memories: ['听众说最喜欢《晴天》的前奏'], liked: true,
    recommendation: { recommender: '小满', publicNote: '下雨天该听' },
    probe: { topic: 'rnb' }, chatIntroduced: false });
  assert.equal(material.ref, 't1');
  assert.deepEqual(material.catalogue, { title: '晴天', artist: '周杰伦', album: '叶惠美', year: 2003 });
  assert.match(material.lyrics, /故事的小黄花/u);
  assert.doesNotMatch(material.lyrics, /作词/u);
  assert.deepEqual(material.memories, ['听众说最喜欢《晴天》的前奏']);
  assert.equal(material.liked, true);
  assert.deepEqual(material.recommendation, { recommender: '小满', publicNote: '下雨天该听' });
  assert.deepEqual(material.probe, { topic: 'rnb' });
  assert.deepEqual(material.length, { minChars: 12, minSentences: 1 });
});

test('素材：track 上顺带的标签、旧串词、软偏好和情境分类都不带出去', () => {
  const material = buildTrackLineMaterial({ ref: 't1', track, softPreference: '别太吵', occasion: 'continuation' });
  const rendered = JSON.stringify(material);
  for (const banned of ['钢琴', '弦乐', '流行', '怀旧', 'slow', '旧串词', '别太吵', 'continuation', 'occasion', 'instruments', 'genre']) {
    assert.ok(!rendered.includes(banned), banned);
  }
});

test('素材：创作署名、时长和曲库标签列给 host，标签标明可能不准', () => {
  const material = buildTrackLineMaterial({ ref: 't1', track: { ...track, duration: 269 },
    sound: { genre: '流行', instruments: ['钢琴', '弦乐'], has_vocal: true, tempo: 'slow', mood: '怀旧', themes: ['青春'], valence: 0.4, source: 'llm' } });
  assert.deepEqual(material.credits, ['作词：周杰伦']);
  assert.equal(material.duration, '4 分 29 秒');
  assert.deepEqual(material.sound, { genre: '流行', instruments: ['钢琴', '弦乐'], vocal: true, tempo: '慢', mood: '怀旧', themes: ['青春'] });
  const { content } = renderTrackLineTrigger({ tracks: [material] });
  assert.match(content, /创作署名：作词：周杰伦/u);
  assert.match(content, /时长：4 分 29 秒/u);
  assert.match(content, /曲库标签（自动打的，可能不准，当线索用）：风格 流行；乐器 钢琴、弦乐；有人声；速度 慢；情绪 怀旧；主题 青春/u);
  assert.doesNotMatch(content, /valence|llm|has_vocal/u, '内部字段不带出去');
});

test('素材：纯音乐没有歌词，也有标签可说', () => {
  const material = buildTrackLineMaterial({ ref: 't2', track: { songId: '2', source: 'qq', title: '如诗般宁静', artist: '某人', lyric: { lrc: '此歌曲为纯音乐，没有填词' } },
    sound: { instruments: ['钢琴'], has_vocal: false } });
  assert.equal(material.lyrics, null);
  assert.match(renderTrackLineTrigger({ tracks: [material] }).content, /乐器 钢琴；纯音乐、没有人声/u);
  assert.equal(buildTrackLineMaterial({ ref: 't3', track, sound: { year: 2003 } }).sound, null, '没有可用的项就不列');
});

test('素材：取不到歌词时不影响写作，没有的字段就是空的', () => {
  const material = buildTrackLineMaterial({ ref: 't2', track: { songId: '2', source: 'qq', title: '纯音乐一首', artist: '某人', lyric: { lrc: '此歌曲为纯音乐，没有填词' } } });
  assert.equal(material.lyrics, null);
  assert.deepEqual(material.memories, []);
  assert.equal(material.liked, null);
  assert.equal(material.recommendation, null);
  assert.equal(material.probe, null);
});

test('触发消息：不给每首歌的句数字数；有话才写，没写的安静播放', () => {
  const content = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track })] }).content;
  assert.doesNotMatch(content, /篇幅|\d+\s*[–-]\s*\d+\s*[句字]|约\s*\d+/u, '没有篇幅规定');
  assert.doesNotMatch(content, /为下面每首歌写一段/u, '不是每首都得写');
  assert.match(content, /有话想说/u);
  assert.match(content, /没话想说的不用写，那首会安静地放/u);
});

const material = buildTrackLineMaterial({ ref: 't1', track, chatIntroduced: true });

test('触发消息：说明这是到点才说的话、不是听众消息，歌词标为不可信', () => {
  const trigger = renderTrackLineTrigger({ tracks: [material], overusedPhrases: ['不碍事'], expressionPreferences: [{ content: '别提点我' }], performance: null });
  assert.equal(trigger.role, 'user');
  for (const expected of ['不是听众', '开始', 'write_track_lines', '不碍事', '别提点我', 't1', '不可信']) {
    assert.ok(trigger.content.includes(expected), expected);
  }
  assert.doesNotMatch(trigger.content, /不肯|判断/u, '不给写法配方');
  assert.ok(!trigger.content.includes('钢琴'));
});

test('触发消息：推荐要用自己的话归功于推荐人；试探可以坦白，不能说成已经喜欢', () => {
  const recommended = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track, recommendation: { recommender: '小满', publicNote: null } })] });
  assert.match(recommended.content, /小满/u);
  assert.match(recommended.content, /不要说成是你挑的/u);
  const probed = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track, probe: { topic: 'rnb' } })] });
  assert.match(probed.content, /不能说成对方已经喜欢/u);
  assert.doesNotMatch(probed.content, /claimKey|music\.genre/u, '不暴露内部键');
});

test('触发消息：有表演能力才列语气标记，没有就不提', () => {
  const plain = renderTrackLineTrigger({ tracks: [material], performance: null });
  assert.doesNotMatch(plain.content, /语气标记/u);
  const capable = renderTrackLineTrigger({ tracks: [material], performance: { markers: ['{笑}'], emotions: ['calm'], pace: true, intensity: false, direction: false,
    limits: { maxInlineEvents: 1, maxPauses: 0, pauseSeconds: null } } });
  assert.match(capable.content, /\{笑\}/u);
});

test('触发消息：回应听众的 pass 才允许接听众的请求，其他情况不许代听众说话', () => {
  assert.match(renderTrackLineTrigger({ tracks: [material], listenerAsked: true }).content, /刚才的请求/u);
  assert.match(renderTrackLineTrigger({ tracks: [material], listenerAsked: false }).content, /不要替听众说话|不是听众/u);
});

test('recentSpokenIntros：只取真正说出口的 track_intro，带所属歌曲', () => {
  const turns = [
    { role: 'user', message: { content: '来首歌' } },
    { role: 'assistant', message: { content: '普通聊天', presentation: null } },
    { role: 'assistant', message: { content: '说出口的串词', presentation: 'track_intro', tracks: [{ title: '晴天', artist: '周杰伦' }] } },
  ];
  assert.deepEqual(recentSpokenIntros({ listTurns: (_id, options) => { assert.equal(options.visibleOnly, true); return turns; } }, 's1'),
    [{ text: '说出口的串词', title: '晴天', artist: '周杰伦', about: null }]);
});

test('provider：把听众、记忆和表演能力落到每首歌的校验边界上', () => {
  const memoryRow = { id: 'm1', content: '听众说喜欢《晴天》的前奏', source: 'user_explicit_feedback', tags: '', updatedAt: 1 };
  const provider = createTrackLineMaterialProvider({
    registry: { get: id => ({ id, displayName: id === 'p2' ? '小满' : 'Luna', memoryNamespace: `ns-${id}`, voiceProfileId: 'v1' }) },
    conversationStore: { getSession: () => ({ memberIds: ['p1', 'p2'], membershipRevision: 3 }), canReadTurn: () => true,
      listTurns: () => [{ role: 'assistant', speakerVirtualPersonId: 'p1', message: { content: '给你放周杰伦的《晴天》。', presentation: null } }] },
    getSongTagStore: () => ({ getTags: () => ({ year: 2003, instruments: ['钢琴'], has_vocal: true }) }),
    getMemoryService: () => ({ store: { search: () => [memoryRow], getById: () => null, list: () => [] } }),
    getTrackLikeService: () => ({ getLike: () => ({ desired: true }) }),
    getProbe: () => ({ claim_key: 'music.genre.rnb' }),
    getPerformanceCapability: () => null,
  });
  const prepared = provider([{ ref: 't1', track: { ...track, recommendedBy: 'p2', virtualPersonId: 'p1', requestId: null } }],
    { sessionId: 's1', personId: 'p1', listenerAsked: false });
  const [entry] = prepared.tracks;
  assert.equal(entry.material.catalogue.year, 2003);
  assert.deepEqual(entry.material.sound.instruments, ['钢琴'], '曲库标签进素材');
  assert.equal(entry.material.liked, true);
  assert.equal(entry.material.chatIntroduced, true, '聊天点名过这首歌');
  assert.deepEqual(entry.material.length, { minChars: 12, minSentences: 1 }, '篇幅只有下限，不随模式变');
  assert.deepEqual(entry.material.probe, { topic: 'rnb' });
  assert.equal(entry.material.recommendation.recommender, '小满');
  assert.equal(entry.checks.chatIntroduced, true);
  assert.equal(entry.checks.recommendation.recommender, '小满');
  assert.deepEqual(entry.checks.recommendation.otherNames, ['Luna']);
  assert.equal(entry.checks.liked, true);
  assert.equal(entry.checks.facts.year, 2003);
  assert.equal(prepared.voiceProfileId, 'v1');
  assert.equal(prepared.membershipRevision, 3);
  assert.equal(prepared.trigger.role, 'user');
});

test('素材排法：逐项列字段，不给“《歌名》 歌手 / 专辑《X》”的开头模板；没歌词就不提歌词', () => {
  const rendered = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track, year: 2003 })] }).content;
  assert.match(rendered, /【t1】\n歌名：晴天\n歌手：周杰伦\n专辑：叶惠美\n年份：2003/u);
  assert.doesNotMatch(rendered, /《晴天》 周杰伦|专辑《叶惠美》|目录：/u);
  const noLyric = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't2',
    track: { songId: '2', source: 'qq', title: '街灯晚餐', artist: '卫兰', lyric: null } })] }).content;
  assert.doesNotMatch(noLyric, /没有拿到|歌词：/u);
  assert.match(noLyric, /听众不知道有它/u);
});

test('pendingTrackLines：队列里写好、还没说出口的串词；说过的、没写的、这次要写的歌都不算', () => {
  const queue = [
    { songId: '1', source: 'qq', title: '总结', artist: '方大同', narration: { status: 'ready', text: '《总结》……', spoken: true } },
    { songId: '2', source: 'qq', title: '每天每天', artist: '方大同', narration: { status: 'ready', text: '《每天每天》甜。' } },
    { songId: '3', source: 'qq', title: '才二十三', artist: '方大同', narration: { status: 'absent' } },
    { songId: '4', source: 'qq', title: '苏丽珍', artist: '方大同', narration: { status: 'ready', text: '《苏丽珍》犹豫。' } },
  ];
  assert.deepEqual(pendingTrackLines({ queue }, [{ songId: '4', source: 'qq' }]),
    [{ text: '《每天每天》甜。', title: '每天每天', artist: '方大同', about: null }]);
  assert.deepEqual(pendingTrackLines(null, []), []);
});

test('provider：用滥词和对比过的歌同时看最近说过的和待念的串词', () => {
  const spoken = ['《甲》放着不碍事。', '《乙》也不碍事。'].map(content => ({ role: 'assistant',
    message: { content, presentation: 'track_intro', tracks: [{ title: '甲', artist: '某人' }] } }));
  const provider = createTrackLineMaterialProvider({
    registry: { get: id => ({ id, displayName: 'Luna', memoryNamespace: 'ns', voiceProfileId: null }) },
    conversationStore: { getSession: () => ({ memberIds: ['p1'], membershipRevision: 1 }), canReadTurn: () => true, listTurns: () => spoken },
    getListening: () => ({ queue: [{ songId: '9', source: 'qq', title: '丙', artist: '某人', narration: { status: 'ready', text: '《丙》还是不碍事。' } }] }),
  });
  const prepared = provider([{ ref: 't1', track }], { sessionId: 's1', personId: 'p1' });
  assert.ok(prepared.overusedPhrases.includes('不碍事'), prepared.overusedPhrases.join('、'));
  assert.deepEqual(prepared.recentLines.map(line => line.text), ['《甲》放着不碍事。', '《乙》也不碍事。', '《丙》还是不碍事。']);
});

// 时间感：写的时候知道现在几点、每首大概什么时候开播；停了很久再接着放时，知道停在哪、隔了多久。
const at = (hours, minutes) => new Date(2026, 10, 7, hours, minutes).getTime();

test('预计开播：当前这首剩下的加上中间几首的时长；不知道时长的那首和它后面的都不估', () => {
  const queue = [
    { queueItemId: 'q0', duration: 200 },
    { queueItemId: 'q1', duration: 180 },
    { queueItemId: 'q2', duration: 0 },
    { queueItemId: 'q3', duration: 240 },
  ];
  const starts = estimatedStartTimes({ queue, currentIndex: 0, positionSeconds: 50 }, at(23, 40));
  assert.equal(starts.get('q1'), at(23, 40) + 150_000);
  assert.equal(starts.get('q2'), at(23, 40) + 330_000);
  assert.equal(starts.get('q3'), null);
  assert.equal(starts.has('q0'), false, '正在放的这首不估');
  const fresh = estimatedStartTimes({ queue, currentIndex: 0, positionSeconds: 0 }, at(23, 40));
  assert.equal(fresh.get('q0'), at(23, 40), '刚开始的这首就是现在');
});

test('触发消息：给现在的时间，放开“此刻”，预计开播只是参考', () => {
  const content = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track, expectedStart: '23:44' })],
    nowMs: at(23, 40) }).content;
  assert.match(content, /现在是.*23:40/u);
  assert.match(content, /预计开播：23:44 左右/u);
  assert.match(content, /暂停|打断/u);
  assert.doesNotMatch(content, /别写此刻/u);
  assert.match(content, /单独/u, '说明每段话是在那首歌开始时单独念的');
  assert.match(content, /跳过/u, '前一首可能被跳过');
  assert.doesNotMatch(content, /别提它前面放的是什么/u);
});

test('触发消息：停了很久再接着放时，说明停在几点、隔了多久，只让最前面那首带一下', () => {
  const content = renderTrackLineTrigger({ tracks: [material], nowMs: at(8, 10) + 86_400_000,
    playbackGap: { stoppedAtMs: at(22, 40), resumedAtMs: at(8, 10) + 86_400_000 } }).content;
  assert.match(content, /22:40/u);
  assert.match(content, /9 小时 30 分钟/u);
  assert.match(content, /接着放/u);
  assert.match(content, /最前面/u);
  assert.doesNotMatch(renderTrackLineTrigger({ tracks: [material], nowMs: at(8, 10) }).content, /隔了/u);
});

test('provider：按 runtime 的队列给每首估开播时间，并把停顿交给触发消息', () => {
  const provider = createTrackLineMaterialProvider({
    registry: { get: id => ({ id, displayName: 'Luna', memoryNamespace: 'ns', voiceProfileId: null }) },
    conversationStore: { getSession: () => ({ memberIds: ['p1'], membershipRevision: 1 }), canReadTurn: () => true, listTurns: () => [] },
    getListening: () => ({ currentIndex: 0, positionSeconds: 60, queue: [{ queueItemId: 'q0', duration: 300 }, { queueItemId: 'q1', ...track }] }),
    now: () => at(23, 40),
  });
  const prepared = provider([{ ref: 't1', track: { ...track, queueItemId: 'q1' } }], { sessionId: 's1', personId: 'p1',
    playbackGap: { stoppedAtMs: at(19, 0), resumedAtMs: at(23, 40) } });
  assert.match(prepared.trigger.content, /预计开播：23:44 左右/u);
  assert.match(prepared.trigger.content, /19:00/u);
});

test('选歌理由：素材里作为你自己的理由给出，没有就不提', () => {
  const material = buildTrackLineMaterial({ ref: 't1', track, selectionNote: '  下雨天想放点老歌  ' });
  assert.equal(material.selectionNote, '下雨天想放点老歌');
  const { content } = renderTrackLineTrigger({ tracks: [material], nowMs: Date.UTC(2026, 10, 7, 12) });
  assert.match(content, /你选它时记下的理由[^\n]*下雨天想放点老歌/u);
  const without = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track })], nowMs: Date.UTC(2026, 10, 7, 12) });
  assert.doesNotMatch(without.content, /你选它时记下的理由/u);
});

test('触发消息：对听众说话，可以讲创作背景、想象里的听感和自己的评价，同一批各挑不同说法，歌词最多借一句', () => {
  const { content } = renderTrackLineTrigger({ tracks: [buildTrackLineMaterial({ ref: 't1', track })], nowMs: Date.UTC(2026, 10, 7, 12) });
  assert.match(content, /对听众说/u);
  assert.match(content, /为什么这会儿想放它/u);
  assert.match(content, /同一批/u);
  assert.match(content, /最多借一句/u);
  assert.match(content, /创作信息和背景/u);
  assert.match(content, /想象里它听起来/u);
  assert.match(content, /你自己对它的评价/u);
  assert.doesNotMatch(content, /不是乐评|不用点评|不要说/u);
});

test('触发消息：列出最近用滥的句式，没有就不提', () => {
  const nowMs = Date.UTC(2026, 10, 7, 12);
  const tracks = [buildTrackLineMaterial({ ref: 't1', track })];
  const { content } = renderTrackLineTrigger({ tracks, nowMs, overusedShapes: ['contrast', 'dash'] });
  assert.match(content, /最近几条都用了这些句式[^\n]*不是 A，是 B[^\n]*破折号/u);
  assert.doesNotMatch(renderTrackLineTrigger({ tracks, nowMs }).content, /最近几条都用了这些句式/u);
});

test('provider：target 带的选歌理由进素材；最近用滥的句式进触发消息和校验边界', () => {
  const shaped = ['《甲》写的不是雨，是人。', '《乙》唱的不是离开，是留下。', '《丙》说的不是爱，是怕。']
    .map((content, index) => ({ role: 'assistant', message: { content, presentation: 'track_intro', tracks: [{ title: '甲乙丙'[index] }] } }));
  const provider = createTrackLineMaterialProvider({
    registry: { get: id => ({ id, displayName: 'Luna', memoryNamespace: 'ns', voiceProfileId: 'v1' }) },
    conversationStore: { getSession: () => ({ memberIds: ['p1'], membershipRevision: 1 }), canReadTurn: () => true, listTurns: () => shaped },
  });
  const prepared = provider([{ ref: 't1', track, note: '想放点老歌' }], { sessionId: 's1', personId: 'p1' });
  assert.equal(prepared.tracks[0].material.selectionNote, '想放点老歌');
  assert.deepEqual(prepared.overusedShapes, ['contrast']);
  assert.match(prepared.trigger.content, /最近几条都用了这些句式[^\n]*不是 A，是 B/u);
});

// 记得自己聊过什么，但不照着原话写：前面聊过的歌只列歌名和当时记下的意思。
test('触发消息：前面聊过的歌只列歌名和要点备忘，不列原话；没有备忘的只列歌名；没有就不提', () => {
  const content = renderTrackLineTrigger({ tracks: [material], ownLines: {
    spoken: [{ title: '蜗牛', text: '上午这会儿放《蜗牛》，节奏不催人。', about: '上午放它不催人' },
      { title: '稻香', text: '《稻香》，周杰伦，2008 年的歌。' }],
    pending: [{ title: '花海', text: '接着还是他，《花海》。', about: '还是同一个人，换一首软的' }] } }).content;
  assert.match(content, /前面这些歌你已经聊过/u);
  assert.match(content, /不是原话/u);
  assert.match(content, /- 《蜗牛》：上午放它不催人\n/u);
  assert.match(content, /- 《稻香》\n/u, '没有备忘的只列歌名');
  assert.match(content, /- 《花海》（写好了，还没念）：还是同一个人，换一首软的/u);
  for (const verbatim of ['上午这会儿放', '节奏不催人。', '2008 年的歌', '接着还是他']) {
    assert.ok(!content.includes(verbatim), `原话不该出现：${verbatim}`);
  }
  assert.doesNotMatch(renderTrackLineTrigger({ tracks: [material] }).content, /已经聊过/u);
  assert.doesNotMatch(renderTrackLineTrigger({ tracks: [material], ownLines: { spoken: [], pending: [] } }).content, /已经聊过/u);
});

test('provider：说出口的和待念的串词以要点进触发消息，原话只留给重复检查', () => {
  const spoken = [{ role: 'assistant', message: { content: '上午放一首《囍帖街》。', presentation: 'track_intro', about: '上午想起这条街',
    tracks: [{ title: '囍帖街', artist: '谢安琪' }] } }];
  const provider = createTrackLineMaterialProvider({
    registry: { get: id => ({ id, displayName: 'Luna', memoryNamespace: 'ns', voiceProfileId: null }) },
    conversationStore: { getSession: () => ({ memberIds: ['p1'], membershipRevision: 1 }), canReadTurn: () => true, listTurns: () => spoken },
    getListening: () => ({ queue: [{ songId: '9', source: 'qq', title: '枫', artist: '周杰伦',
      narration: { status: 'ready', text: '上午这个点放《枫》。', about: '这个点听它正好' } }] }),
  });
  const { trigger, recentLines } = provider([{ ref: 't1', track }], { sessionId: 's1', personId: 'p1' });
  assert.match(trigger.content, /- 《囍帖街》：上午想起这条街/u);
  assert.match(trigger.content, /- 《枫》（写好了，还没念）：这个点听它正好/u);
  assert.ok(!trigger.content.includes('上午放一首') && !trigger.content.includes('上午这个点放'), '原话不进触发消息');
  assert.deepEqual(recentLines.map(line => line.text), ['上午放一首《囍帖街》。', '上午这个点放《枫》。'], '重复检查仍用原话');
});

test('同轮聊天只给固定确认句不算介绍过；带选歌理由则标为聊过并提示错落留白', () => {
  const mkProvider = text => createTrackLineMaterialProvider({
    registry: { get: id => ({ id, displayName: 'Luna', memoryNamespace: 'ns', voiceProfileId: null }) },
    conversationStore: {
      getSession: () => ({ memberIds: ['p1'], membershipRevision: 1 }),
      canReadTurn: () => true,
      listTurns: () => [{ role: 'assistant', requestId: 'req-same', speakerVirtualPersonId: 'p1', message: { content: text, presentation: null } }],
    },
  });

  const confirmed = mkProvider('好，《晴天》已经安排上了。')([{ ref: 't1', track: { ...track, requestId: 'req-same' } }],
    { sessionId: 's1', personId: 'p1' });
  assert.equal(confirmed.tracks[0].material.chatIntroduced, false, '固定确认文案不算介绍过');
  assert.equal(confirmed.tracks[0].checks.chatIntroduced, false);
  assert.doesNotMatch(confirmed.trigger.content, /这一批不止一首/u, '单首不给多首错落提示');

  const explained = mkProvider('我挑了《晴天》，前奏那把吉他一响特别适合今晚的风。')([
    { ref: 't1', track: { ...track, requestId: 'req-same' } },
    { ref: 't2', track: { ...track, songId: '2', title: '稻香', requestId: 'req-same' } },
  ], { sessionId: 's1', personId: 'p1' });
  assert.equal(explained.tracks[0].material.chatIntroduced, true, '带实质理由的同轮回复算聊过');
  assert.match(explained.tracks[0].material.chatIntroExcerpt, /前奏那把吉他一响/u);
  assert.equal(explained.tracks[0].checks.chatIntroduced, true);
  assert.match(explained.trigger.content, /刚提过|说过「.*前奏那把吉他/u);
  assert.match(explained.trigger.content, /这一批不止一首.*留几首安静/u, '多首批次补充错落留白引导');
  assert.equal(explained.tracks[1].material.chatIntroduced, false, '未在同轮聊天里提及的另一首不算聊过');
});
