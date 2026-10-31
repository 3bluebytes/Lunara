// ProgramNarrationComposer：串词的确定性技能（场合/素材装配/机械校验/兜底）
// 与已持久化串词的 TTS 资产解析。
//
// 串词正文的生成路径在 NarrationAgent.test.js / narrationTools.test.js 覆盖；这里锁定
// “本模块不再持有 chat、也不存在内部模型调用”，以及确定性函数的既有质量期望。
//
// Run: node --test server/program/ProgramNarrationComposer.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleNarrationMaterial, buildFallbackTrackNarration,
  narrationDefect, narrationRuleFeedback, ProgramNarrationComposer } from './ProgramNarrationComposer.js';

const effect = (origin = 'prepared', reason = 'user_request') => ({ track: { title: '晴天', artist: '周杰伦', voiceProfileId: 'voice-a',
  album: '叶惠美', intro: { context: { origin, reason, mode: 'discovery', softPreferences: '熟悉的华语旋律' } } },
previousTrack: { title: '花海', artist: '周杰伦' } });

const trackFacts = {
  song: { year: 2003, genre: '流行', mood: '怀旧', tempo: 'mid', themes: ['青春', '错过'], instruments: ['吉他'] },
  artist: { genre: '华语流行', region: '华语' },
};

const richFacts = { album: '叶惠美', year: 2003, genre: '流行', mood: '怀旧', tempo: 'mid', language: '',
  instruments: ['吉他'], themes: ['青春', '错过'], scenes: [], artistGenre: '华语流行', artistRegion: '华语' };

const canonicalFallback = buildFallbackTrackNarration(effect().track, { previousTrack: effect().previousTrack });

test('the composer exposes no chat path and ignores one passed at construction', () => {
  let calls = 0;
  const composer = new ProgramNarrationComposer({
    chat: async () => { calls += 1; return { message: { content: '不应被调用' } }; },
    getContext: () => ({ shouldNotBeStored: true }),
    synthesize: async () => ({ url: '/a.mp3' }),
  });
  assert.equal('chat' in composer, false, '组件不得持有 chat');
  assert.equal('getContext' in composer, false);
  assert.equal(composer.prepareTrack, undefined, '串词准备已迁到 NarrationAgent.prepareTrack');
  assert.equal(calls, 0);
});

test('persisted narration asset recovery reuses canonical text and voice without invoking the model', async () => {
  const modelCalls = [];
  const synthCalls = [];
  const composer = new ProgramNarrationComposer({
    chat: async (...args) => { modelCalls.push(args); return { message: { content: '不应重新生成。' } }; },
    synthesize: async (text, options) => { synthCalls.push({ text, ...options }); return { url: '/restored.mp3', hash: 'hash-restored' }; },
  });
  const result = await composer.resolveTrackNarrationAsset({
    track: {
      title: '晴天', artist: '周杰伦', voiceProfileId: 'track-voice',
      narration: { text: '已经持久化的 canonical 串词。', voiceProfileId: 'stored-voice', contentHash: 'old-hash' },
    },
  });
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(synthCalls.map(({ signal, ...call }) => call),
    [{ text: '已经持久化的 canonical 串词。', voiceProfileId: 'stored-voice', performance: null }]);
  assert.ok(synthCalls[0].signal instanceof AbortSignal, '资产恢复有独立可取消的合成信号');
  assert.deepEqual({ ...result, narrationSynthesisElapsedMs: 0 }, { ttsUrl: '/restored.mp3', contentHash: 'hash-restored',
    voiceProfileId: 'stored-voice', narrationSynthesisReason: null, narrationSynthesisElapsedMs: 0 });
});

test('persisted asset recovery is bounded and never returns late audio', async () => {
  const composer = new ProgramNarrationComposer({ timeoutMs: 20, synthesize: () => new Promise(() => {}) });
  const started = Date.now();
  const result = await composer.resolveTrackNarrationAsset({ track: { title: 'a', artist: 'b', narration: { text: '已有串词。' } } });
  assert.equal(result.ttsUrl, null);
  assert.ok(Date.now() - started < 500);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(composer.resolveTrackNarrationAsset({ track: { title: 'a', artist: 'b', narration: { text: 'x' } } },
    { signal: controller.signal }), { name: 'AbortError' });
});

test('assembleNarrationMaterial only promotes structured request intent to a listener preference', () => {
  const withoutPreference = { ...effect(), track: { ...effect().track, intro: { context: { origin: 'live', reason: 'user_request', mode: 'discovery' } } } };
  const freeForm = { trackFacts, recentConversation: [{ role: 'user', presentation: null, text: '怎么又推荐了同一首歌' }] };
  assert.equal(assembleNarrationMaterial(withoutPreference, freeForm).situation.softPreference, null, '自由对话不得变成听歌偏好');
  assert.equal(assembleNarrationMaterial(effect(), { trackFacts, recentConversation: [] }).situation.softPreference,
    '熟悉的华语旋律', '结构化 softPreferences 才进入场合');
});

test('assembleNarrationMaterial keeps situation, mode guide, bounds and fallback in one deterministic snapshot', () => {
  const context = { person: { voiceProfileId: 'voice-a' }, trackFacts, companionMode: { modeId: 'occasional', label: '偶尔介绍' },
    recentConversation: [] };
  const material = assembleNarrationMaterial(effect(), context);
  assert.equal(material.modeId, 'occasional');
  assert.match(material.modeGuide, /偶尔介绍/u);
  assert.equal(material.situation.occasion, 'chosen_for_request');
  assert.equal(material.minChars, 20);
  assert.equal(material.minSentences, 1);
  assert.equal(material.targetMaxChars, 100, '偶尔介绍收紧目标上限');
  assert.equal(material.targetMaxSentences, 2);
  assert.equal(material.maxChars, 650);
  assert.equal(material.maxSentences, 6);
  assert.equal(material.fallbackText, canonicalFallback);
  assert.equal(material.previousSongId, null);
  assert.deepEqual(Object.keys(material.track).sort(), ['artist', 'songId', 'source', 'title']);
  const now = new Date('2026-10-21T08:00:00Z');
  assert.deepEqual(assembleNarrationMaterial(effect(), context, { now }), assembleNarrationMaterial(effect(), context, { now }),
    '没有随机：相同输入得到相同装配');
});

test('a chat introduction and expression preferences reach the assembly as verified inputs', () => {
  const material = assembleNarrationMaterial(effect(), {
    trackFacts,
    expressionPreferences: [{ content: '介绍歌时不要每首都以关照听众收尾' }, { content: '   ' }],
    recentConversation: [
      { role: 'assistant', presentation: null, text: '下一首是周杰伦的《晴天》，收在《叶惠美》里，钢琴和弦乐把告别铺得很开。' },
      { role: 'user', presentation: null, text: '想听熟悉的华语旋律' },
    ],
  });
  assert.equal(material.chatIntroduced, true);
  assert.equal(material.targetMaxChars, 120, '聊天已介绍本曲时按短边界写');
  assert.deepEqual(material.expressionPreferences, ['介绍歌时不要每首都以关照听众收尾']);
  assert.deepEqual(material.recentIntroductions, [], 'presentation 非 track_intro 的聊天不算最近串词');
  assert.equal(material.minSentences, 1);
});

test('thin verified material still yields a valid assembly and the canonical fallback', () => {
  const material = assembleNarrationMaterial({ ...effect(), track: { ...effect().track, album: '' } }, {});
  assert.equal(material.knowledge.lyrics, null);
  assert.deepEqual(material.knowledge.aboutThisSong, { memories: [], liked: null });
  assert.equal(material.fallbackText, '接下来是周杰伦的《晴天》，接着刚才的《花海》。');
});

test('the fallback is one canonical sentence and never a dimension template', () => {
  assert.equal(buildFallbackTrackNarration(effect().track, { previousTrack: { title: '花海' } }),
    '接下来是周杰伦的《晴天》，接着刚才的《花海》。');
  assert.equal(buildFallbackTrackNarration(effect().track), '接下来是周杰伦的《晴天》。');
  assert.equal(buildFallbackTrackNarration(effect().track, { previousTrack: { title: '晴天' } }),
    '接下来是周杰伦的《晴天》。');
  for (const value of [canonicalFallback, buildFallbackTrackNarration(effect().track)]) {
    assert.equal((value.match(/。/g) || []).length, 1);
    assert.doesNotMatch(value, /曲库|专辑|标签|至于|我记着|你刚才|推荐/u);
  }
});

test('narrationDefect stays the single rejection source and feedback names the rule', () => {
  const inputs = { track: { title: '晴天', artist: '周杰伦' }, facts: richFacts, recentIntroductions: [], recentConversation: [],
    minSentences: 3, previousTrack: { title: '花海', artist: '周杰伦' }, chatIntroduced: false, minChars: 60 };
  assert.equal(narrationDefect('', inputs), 'too-short');
  assert.equal(narrationDefect('周杰伦的《晴天》' + '好听'.repeat(330), inputs), 'too-long');
  assert.equal(narrationDefect('接下来听周杰伦的《晴天》。它收录在《叶惠美》里，曲库记录的发行年份是2003年。曲库标签把它归为流行与怀旧，节奏感偏中速，适合把注意力慢慢放回旋律。你刚才想沿着熟悉的华语旋律继续走，所以我把这一首放在这里。', inputs), null);
  assert.match(narrationRuleFeedback('missing-artist', { track: { artist: '周杰伦' }, minChars: 60 }, '短文'), /违反校验规则「missing-artist」/u);
  assert.match(narrationRuleFeedback('too-short', { minChars: 60 }, '短文'), /至少需要 60 个字符/u);
});
