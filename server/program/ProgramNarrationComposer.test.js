// ProgramNarrationComposer：串词的机械校验与已持久化串词的 TTS 资产解析。
//
// 串词正文由 host 在 line pass 里写（trackLineTools.test.js）；这里锁定本模块不持有 chat、
// 没有内部模型调用，以及确定性函数的质量期望。
//
// Run: node --test server/program/ProgramNarrationComposer.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { narrationDefect, narrationRuleFeedback, ProgramNarrationComposer } from './ProgramNarrationComposer.js';

const richFacts = { album: '叶惠美', year: 2003, genre: '流行', mood: '怀旧', tempo: 'mid', language: '',
  instruments: ['吉他'], themes: ['青春', '错过'], scenes: [], artistGenre: '华语流行', artistRegion: '华语' };

test('the composer exposes no chat path and ignores one passed at construction', () => {
  let calls = 0;
  const composer = new ProgramNarrationComposer({
    chat: async () => { calls += 1; return { message: { content: '不应被调用' } }; },
    getContext: () => ({ shouldNotBeStored: true }),
    synthesize: async () => ({ url: '/a.mp3' }),
  });
  assert.equal('chat' in composer, false, '组件不得持有 chat');
  assert.equal('getContext' in composer, false);
  assert.equal(composer.prepareTrack, undefined, '串词正文不由本模块生成');
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

test('narrationDefect stays the single rejection source and feedback names the rule', () => {
  const inputs = { track: { title: '晴天', artist: '周杰伦' }, facts: richFacts, recentIntroductions: [], recentConversation: [],
    minSentences: 3, previousTrack: { title: '花海', artist: '周杰伦' }, chatIntroduced: false, minChars: 60 };
  assert.equal(narrationDefect('', inputs), 'too-short');
  assert.equal(narrationDefect('周杰伦的《晴天》' + '好听'.repeat(330), inputs), 'too-long');
  assert.equal(narrationDefect('接下来听周杰伦的《晴天》。它收录在《叶惠美》里，发行年份是2003年。这张专辑听到这里差不多过半，歌词也是这几年写的，放着正合适，不用特意去听它。', inputs), null);
  assert.equal(narrationDefect('《晴天》你刚才说想听，放给你，这首写的是那些年的事，歌词也还算耐听，不用特意去听它。', { ...inputs, minChars: 12, minSentences: 1 }), 'immediate-reference', '到点才说的话不提“刚才”');
  assert.match(narrationRuleFeedback('missing-artist', { track: { artist: '周杰伦' }, minChars: 60 }, '短文'), /违反校验规则「missing-artist」/u);
  assert.match(narrationRuleFeedback('too-short', { minChars: 60 }, '短文'), /至少需要 60 个字符/u);
});
