import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourcePolicy } from '../music/sourcePolicy.js';
import { MusicCandidateSupply } from './musicCandidateSupply.js';
import { searchArtistTracks } from './artistCatalog.js';
import { createMusicResolver } from '../musicResolver.js';
import { ProgramCommitService } from './ProgramCommitService.js';
import { ProgramMode, createCandidateProgram } from './programTypes.js';

const single = normalizeSourcePolicy({ playbackSourceMode: 'single', primarySource: 'qq' });
const multi = normalizeSourcePolicy({});
const track = (source, song_id = 'id') => ({ source, song_id, title: '曲目', artist: '艺人' });
const program = (source = 'ncm') => createCandidateProgram({ requestId: 'mode-test',
  mode: ProgramMode.EXPLICIT, requestedCount: 1, candidates: [
    { candidateId: 'c1', query: '艺人 — 曲目', sourceSongId: 'id', evidence: { source } }] });
const resource = source => ({ ...track(source), ok: true, url: '/fixture.wav' });

test('single filters local, online and already cached candidates; multi restores without refetch', async () => {
  let policy = multi, loads = 0;
  const supply = new MusicCandidateSupply({ readLocal: () => [track('qq:library'), track('ncm:library')],
    loadOnline: async () => { loads++; return [track('ncm:daily', 'new')]; },
    getSourcePolicy: () => policy });
  assert.equal((await supply.getCandidates()).length, 3);
  policy = single;
  assert.deepEqual((await supply.getCandidates()).map(row => row.source), ['qq:library']);
  policy = multi;
  assert.equal((await supply.getCandidates()).length, 3);
  assert.equal(loads, 1);
});
test('single artist lookup never queries the excluded provider', async () => {
  const calls = [];
  const sources = ['qq', 'ncm'].map(name => ({ name, provider: { search: async () => {
    calls.push(name); return [track(name)]; } } }));
  assert.equal((await searchArtistTracks('艺人', { sources, allowedSources: single.sources })).length, 1);
  assert.deepEqual(calls, ['qq']);
});
test('single blocks remembered other-provider hits, cross-source fallback and canonical targets', async () => {
  const calls = [];
  const resolve = createMusicResolver({ getSourcePolicy: () => single,
    providers: Object.fromEntries(['qq', 'ncm'].map(name => [name, {
      resolveQuery: async () => { calls.push(name); return { ok: false, code: 'not-found' }; },
      songUrl: async () => { calls.push('direct:' + name); return '/fixture.wav'; },
      lyric: async () => ({}), cacheAudio: async () => ({}) }])),
    findRememberedTrack: () => ({ ...track('ncm'), provider: 'ncm' }),
    findRememberedIdentity: () => null, rememberTracks() {}, maybeAutoTag() {}, trace() {},
  });
  const failed = await resolve('歌手 — 歌');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.tried, ['qq']);
  assert.equal((await resolve('歌手 — 歌', { candidate: program().candidates[0] })).error, 'source-mode-restricted');
  assert.deepEqual(calls, ['qq']);
});
test('cached canonical resources cannot bypass single-source restrictions', async () => {
  let network = 0;
  const service = new ProgramCommitService({ getSourcePolicy: () => single,
    resolveTrack: async () => { network++; return resource('ncm'); } });
  const result = await service.resolveProgram(program(), { resolutionCache: { get: () => resource('ncm') } });
  assert.equal(result.ok, false);
  assert.equal(network, 0);
  assert.equal(result.resolvedProgram.failures[0].reason, 'source-mode-restricted');
});
test('mode changed during resolution is rechecked before runtime submit', async () => {
  let policy = multi, submits = 0;
  const service = new ProgramCommitService({ getSourcePolicy: () => policy,
    resolveTrack: async () => resource('ncm'), playbackRuntime: { submit() { submits++; } } });
  const original = service.resolveProgram.bind(service);
  service.resolveProgram = async (...args) => { const result = await original(...args); policy = single; return result; };
  const result = await service.commit(program());
  assert.equal(result.ok, false);
  assert.equal(result.status, 'commit-rejected');
  assert.equal(submits, 0);
});
