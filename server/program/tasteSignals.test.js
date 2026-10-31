// tasteSignals.test.js — claim 信号解析与候选匹配（add-taste-probe-signals）
//
// 覆盖：music.* key 解析、非音乐/低置信度/无 value 拒绝、极性与次数加权、
// genre 归一化匹配（R&B↔rnb）、artist/mood/language 匹配、无标签行不命中、偏置符号。

import assert from 'node:assert/strict';
import test from 'node:test';
import { tasteSignalFromInsight, trackMatchesSignal, tasteBiasForTrack } from './tasteSignals.js';

const insight = (tags, evidence, confidence = 0.4) => ({ tags, evidence: JSON.stringify(evidence), confidence });

test('解析 music.* claim：极性、次数加权与上限', () => {
  const signal = tasteSignalFromInsight(insight('reflection-insight,claim:music.genre.rnb',
    { claim: { key: 'music.genre.rnb', polarity: 'positive' }, occurrences: 3 }, 0.4));
  assert.ok(signal);
  assert.equal(signal.attribute, 'genre');
  assert.equal(signal.value, 'rnb');
  assert.equal(signal.polarity, 'positive');
  assert.ok(Math.abs(signal.weight - 1.2) < 1e-9, '0.4 × min(3,5) = 1.2');
  const capped = tasteSignalFromInsight(insight('claim:music.genre.rnb',
    { claim: { key: 'music.genre.rnb', polarity: 'positive' }, occurrences: 9 }, 0.5));
  assert.equal(capped.weight, 1.5, '权重封顶 1.5');
});

test('非音乐 claim、低置信度、缺 value、非法属性被拒绝', () => {
  assert.equal(tasteSignalFromInsight(insight('claim:recommendation.routine',
    { claim: { key: 'recommendation.routine', polarity: 'negative' } }, 0.5)), null, '非 music.* 不参与排序');
  assert.equal(tasteSignalFromInsight(insight('claim:music.genre.rnb',
    { claim: { key: 'music.genre.rnb', polarity: 'positive' } }, 0.2)), null, '置信度下限');
  assert.equal(tasteSignalFromInsight(insight('claim:music.genre',
    { claim: { key: 'music.genre', polarity: 'positive' } }, 0.5)), null, '缺 value');
  assert.equal(tasteSignalFromInsight(insight('claim:music.context.night',
    { claim: { key: 'music.context.night', polarity: 'positive' } }, 0.5)), null, 'context 不在白名单（只进简报文字）');
});

const tagStore = {
  getTags(songId) {
    if (songId === 'rnb') return { genres: ['R&B', 'soul'] };
    if (songId === 'pop') return { genres: ['pop'] };
    if (songId === 'moodful') return { mood: 'chill', language: 'mandarin' };
    return null;
  },
};

test('匹配：genre 归一化、artist/mood/language、无标签行', () => {
  const genre = tasteSignalFromInsight(insight('claim:music.genre.rnb',
    { claim: { key: 'music.genre.rnb', polarity: 'positive' } }, 0.4));
  assert.ok(trackMatchesSignal(genre, { songId: 'rnb', source: 'qq' }, tagStore), 'R&B 归一化命中 rnb');
  assert.equal(trackMatchesSignal(genre, { songId: 'pop', source: 'qq' }, tagStore), false);
  assert.equal(trackMatchesSignal(genre, { songId: 'unknown', source: 'qq' }, tagStore), false, '无标签行不命中');

  const artist = tasteSignalFromInsight(insight('claim:music.artist.dangelo',
    { claim: { key: 'music.artist.dangelo', polarity: 'positive' } }, 0.4));
  assert.ok(trackMatchesSignal(artist, { songId: 'x', artist: 'D\x27Angelo' }, tagStore));

  const mood = tasteSignalFromInsight(insight('claim:music.mood.chill',
    { claim: { key: 'music.mood.chill', polarity: 'positive' } }, 0.4));
  assert.ok(trackMatchesSignal(mood, { songId: 'moodful', source: 'qq' }, tagStore));

  const language = tasteSignalFromInsight(insight('claim:music.language.mandarin',
    { claim: { key: 'music.language.mandarin', polarity: 'positive' } }, 0.4));
  assert.ok(trackMatchesSignal(language, { songId: 'moodful', source: 'qq' }, tagStore));
});

test('偏置符号：正 claim 提前（负值），负 claim 靠后（正值）', () => {
  const positive = [tasteSignalFromInsight(insight('claim:music.genre.rnb',
    { claim: { key: 'music.genre.rnb', polarity: 'positive' } }, 0.4))];
  const negative = [tasteSignalFromInsight(insight('claim:music.genre.rnb',
    { claim: { key: 'music.genre.rnb', polarity: 'negative' } }, 0.4))];
  const track = { songId: 'rnb', source: 'qq' };
  assert.ok(tasteBiasForTrack(positive, track, tagStore) < 0, '正 claim 偏置为负=提前');
  assert.ok(tasteBiasForTrack(negative, track, tagStore) > 0, '负 claim 偏置为正=靠后');
  assert.equal(tasteBiasForTrack(positive, { songId: 'pop', source: 'qq' }, tagStore), 0, '不命中为零偏置');
});

const signalOf = key => tasteSignalFromInsight(insight(`claim:${key}`, { claim: { key, polarity: 'positive' } }, 0.6));

test('扩展属性：album / style / instrumental / tempo 匹配，无标签不命中（ground-music-selection-in-taste 6.4）', () => {
  const tags = { getTags: songId => ({
    vocal: { genres: ['city pop'], tempo: 'slow', has_vocal: 1 },
    inst: { genres: ['post-rock'], tempo: 'fast', has_vocal: 0 },
    state: { vocal_state: 'instrumental' },
  }[songId] || null) };
  const album = signalOf('music.album.叶惠美');
  assert.ok(trackMatchesSignal(album, { songId: 'x', artist: '周杰伦', album: '叶惠美' }, tags), '只写专辑名按专辑名相等');
  assert.ok(trackMatchesSignal(signalOf('music.album.周杰伦叶惠美'), { songId: 'x', artist: '周杰伦', album: '叶惠美' }, tags));
  assert.equal(trackMatchesSignal(album, { songId: 'x', artist: '周杰伦', album: '叶惠美（现场版）' }, tags), false, '不做模糊包含');
  assert.equal(trackMatchesSignal(album, { songId: 'x', artist: '周杰伦' }, tags), false, '没有专辑字段不命中');

  const style = signalOf('music.style.citypop');
  assert.ok(trackMatchesSignal(style, { songId: 'vocal', source: 'qq' }, tags), 'style 与 genre 同口径归一');
  assert.equal(trackMatchesSignal(style, { songId: 'none', source: 'qq' }, tags), false, '无标签行不命中');

  const instrumental = signalOf('music.instrumental.true');
  assert.ok(instrumental, 'instrumental 不受两字符下限');
  assert.ok(trackMatchesSignal(instrumental, { songId: 'inst', source: 'qq' }, tags));
  assert.ok(trackMatchesSignal(instrumental, { songId: 'state', source: 'qq' }, tags), 'vocal_state 也可判断');
  assert.equal(trackMatchesSignal(instrumental, { songId: 'vocal', source: 'qq' }, tags), false);
  assert.equal(trackMatchesSignal(instrumental, { songId: 'none', source: 'qq' }, tags), false, '人声未知不算命中');
  assert.ok(trackMatchesSignal(signalOf('music.instrumental.false'), { songId: 'vocal', source: 'qq' }, tags));

  const tempo = signalOf('music.tempo.slow');
  assert.ok(trackMatchesSignal(tempo, { songId: 'vocal', source: 'qq' }, tags));
  assert.equal(trackMatchesSignal(tempo, { songId: 'inst', source: 'qq' }, tags), false);
  assert.equal(tasteBiasForTrack([tempo], { songId: 'none', source: 'qq' }, tags), 0, '无标签不受惩罚');
});
