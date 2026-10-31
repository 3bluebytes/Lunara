// 人声不进波形图：analyser 只由播放器内容（歌曲）接管。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimePlaybackCallbacks } from './runtimePlaybackCallbacks.js';

test('narration never re-points the waveform; only the music channel does', () => {
  const calls = [];
  const analysed = [];
  const musicAudio = { id: 'music' };
  const callbacks = createRuntimePlaybackCallbacks({
    playbackView: { callbacks: {
      onNarration: (command, options) => calls.push(['onNarration', command, options]),
      onTrack: item => calls.push(['onTrack', item]),
    } },
    setupAnalyser: el => analysed.push(el),
    musicAudio,
  });

  callbacks.onNarration({ text: '串词' }, { overlay: true });
  assert.deepEqual(calls, [['onNarration', { text: '串词' }, { overlay: true }]]);
  assert.deepEqual(analysed, [], 'voice must not take the waveform analyser');

  callbacks.onTrack({ title: 'song' });
  assert.deepEqual(calls, [
    ['onNarration', { text: '串词' }, { overlay: true }],
    ['onTrack', { title: 'song' }],
  ]);
  assert.deepEqual(analysed, [musicAudio], 'a song takes the waveform back');
});
