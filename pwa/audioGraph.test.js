// audioGraph.test.js — pure Web Audio graph regressions.
//
// Run: node pwa/audioGraph.test.js

import assert from 'node:assert/strict';
import { createAudioGraphController, isSameOriginMedia } from './audioGraph.js';

function fakeAudioContext() {
  const createdFor = [];
  const gainEvents = [];
  const destination = { name: 'destination' };
  const ctx = {
    currentTime: 0,
    destination,
    createMediaElementSource(el) {
      createdFor.push(el.id);
      if (el._sourceCreated) throw new Error(`duplicate source for ${el.id}`);
      el._sourceCreated = true;
      return {
        connections: [],
        connect(node) { this.connections.push(node); },
      };
    },
    createGain() {
      return {
        connections: [],
        gain: {
          value: 1,
          cancelScheduledValues(time) { gainEvents.push(['cancel', time]); },
          setValueAtTime(value, time) { this.value = value; gainEvents.push(['set', value, time]); },
          linearRampToValueAtTime(value, time) { this.value = value; gainEvents.push(['ramp', value, time]); },
          setTargetAtTime(value, time, constant) { this.value = value; gainEvents.push(['target', value, time, constant]); },
        },
        connect(node) { this.connections.push(node); },
      };
    },
    createAnalyser() {
      return {
        fftSize: 0,
        frequencyBinCount: 128,
        getByteFrequencyData() {},
      };
    },
  };
  return { ctx, createdFor, gainEvents };
}

function testMediaElementSourcesAreCreatedOncePerElement() {
  const { ctx, createdFor } = fakeAudioContext();
  const music = { id: 'music' };
  const voice = { id: 'voice' };
  const graph = createAudioGraphController({ getAudioContext: () => ctx, musicAudio: music });

  graph.setupAnalyser(music);
  graph.setupAnalyser(voice);
  graph.setupAnalyser(music);
  graph.setupAnalyser(voice);

  assert.deepEqual(createdFor, ['music', 'voice']);
}

function testSwitchingAnalyserDoesNotDisconnectAudioOutput() {
  const { ctx } = fakeAudioContext();
  const music = { id: 'music' };
  const voice = { id: 'voice' };
  const graph = createAudioGraphController({ getAudioContext: () => ctx, musicAudio: music });

  const musicNode = graph.setupAnalyser(music);
  graph.setupAnalyser(voice);

  assert(musicNode.gain.connections.includes(ctx.destination));
}

function testMusicGainHonorsConfiguredDuckAndRestoreRamps() {
  const { ctx, gainEvents } = fakeAudioContext();
  const graph = createAudioGraphController({ getAudioContext: () => ctx, musicAudio: { id: 'music' } });
  graph.setupAnalyser({ id: 'music' });

  assert.equal(graph.setMusicGain(0.25, 300), true);
  assert.deepEqual(gainEvents, [['cancel', 0], ['set', 1, 0], ['ramp', 0.25, 0.3]]);
  gainEvents.length = 0;
  ctx.currentTime = 1;
  assert.equal(graph.setMusicGain(1, 500), true);
  assert.deepEqual(gainEvents, [['cancel', 1], ['set', 0.25, 1], ['ramp', 1, 1.5]]);
}

testMediaElementSourcesAreCreatedOncePerElement();
testSwitchingAnalyserDoesNotDisconnectAudioOutput();
testMusicGainHonorsConfiguredDuckAndRestoreRamps();

function testSuspendedContextDoesNotCaptureNativeMediaOutput() {
  const { ctx, createdFor } = fakeAudioContext();
  ctx.state = 'suspended';
  ctx.resume = () => Promise.resolve();
  const music = { id: 'first-run-music' };
  const graph = createAudioGraphController({ getAudioContext: () => ctx, musicAudio: music });
  assert.equal(graph.setupAnalyser(music), null);
  assert.equal(graph.setMusicGain(0.25), false, 'use native media volume while the graph is locked');
  assert.deepEqual(createdFor, [], 'a suspended source node would silence the native output');
  ctx.state = 'running';
  assert.ok(graph.setupAnalyser(music));
  assert.equal(graph.setMusicGain(1), true);
  assert.deepEqual(createdFor, ['first-run-music']);
}
testSuspendedContextDoesNotCaptureNativeMediaOutput();

function testCrossOriginMediaNeverEntersTheGraph() {
  const { ctx, createdFor } = fakeAudioContext();
  const app = 'http://127.0.0.1:8080/';
  const remote = { id: 'remote-music', src: 'http://aqqmusic.tc.qq.com/F000003DVaFX0R0baW.flac?vkey=SECRET' };
  const local = { id: 'local-music', src: '/audio/6479f66fa3574baf26a652294b7def3e.mp3' };
  const graph = createAudioGraphController({
    getAudioContext: () => ctx,
    musicAudio: remote,
    locationHref: app,
  });

  assert.equal(graph.setupAnalyser(remote), null, 'cross-origin sources must keep native output');
  assert.equal(graph.setMusicGain(0.25), false, 'gain-only commands must not attach the graph either');
  assert.deepEqual(createdFor, [], 'attaching a cross-origin element would silence playback while it keeps advancing');

  const localGraph = createAudioGraphController({ getAudioContext: () => ctx, musicAudio: local, locationHref: app });
  assert.ok(localGraph.setupAnalyser(local), 'same-origin sources still get an analyser');
  assert.deepEqual(createdFor, ['local-music']);
}
testCrossOriginMediaNeverEntersTheGraph();

function testSameOriginComparisonCoversRelativeAndBlobSources() {
  const app = 'http://127.0.0.1:8080/';
  assert.equal(isSameOriginMedia('/audio/a.mp3', app), true);
  assert.equal(isSameOriginMedia('http://127.0.0.1:8080/audio/a.mp3', app), true);
  assert.equal(isSameOriginMedia('blob:http://127.0.0.1:8080/abc', app), true);
  assert.equal(isSameOriginMedia('http://aqqmusic.tc.qq.com/a.flac', app), false);
  assert.equal(isSameOriginMedia('https://127.0.0.1:8080/a.mp3', app), false, 'scheme change is cross-origin');
  assert.equal(isSameOriginMedia('', app), true, 'no source yet is not a cross-origin source');
  assert.equal(isSameOriginMedia('/audio/a.mp3', ''), true, 'without a location the guard stays out of the way');
}
testSameOriginComparisonCoversRelativeAndBlobSources();

console.log('audio graph regressions passed');
