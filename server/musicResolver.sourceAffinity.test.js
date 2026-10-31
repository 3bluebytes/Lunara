import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicResolver } from './musicResolver.js';
import { ProgramCommitService } from './program/ProgramCommitService.js';
import { createCandidateProgram } from './program/programTypes.js';
const qqTrack = { source:'qq:library',provider:'qq',song_id:'qq-mid',title:'飞花',artist:'歌手',album:'原版' };
const ncTrack = { provider:'ncm',song_id:'ncm-id',title:'飞花',artist:'歌手',album:'该源专辑' };
function fixture({rows=[qqTrack],qqUrl='/qq.mp3',policy={mode:'multi',sources:['ncm','qq']},equivalent=false}={}) {
 const calls=[];
 const provider = name => ({
  songUrl: async id => {calls.push([name,'url',id]);return name==='qq'?qqUrl:'/ncm.mp3';},
  lyric:async()=>({lrc:''}),cacheAudio:async(id,url)=>({url}),
  resolveQuery:async()=>{calls.push([name,'search']);return {ok:true,...ncTrack,source:name,url:'/search.mp3'};}
 });
 const resolve=createMusicResolver({providers:{qq:provider('qq'),ncm:provider('ncm')},getSourcePolicy:()=>policy,
  getCollectionTracks:()=>rows,getRememberedCollectionTracks:()=>[],
  findRememberedTrack:()=>({...ncTrack,source:'ncm:daily'}),
  findRememberedIdentity:(p,id)=>p==='ncm'&&id==='ncm-id'?ncTrack:null,
  getRecordingStore:()=>({recordingOf:()=>({isSelf:!equivalent,recordingId:'rec'}),membersOf:()=>[{provider:'qq',songId:'qq-mid'},{provider:'ncm',songId:'ncm-id'}]}),
  maybeAutoTag(){},rememberTracks(){},trace(){},resolveArtwork:async()=>''});
 return {resolve,calls};
}
test('unbound queries prefer the persistent QQ collection reference over an NCM search cache',async()=>{
 const h=fixture();const result=await h.resolve('歌手 — 飞花',{primarySource:'ncm'});
 assert.equal(result.source,'qq');assert.equal(result.song_id,'qq-mid');assert.deepEqual(h.calls,[['qq','url','qq-mid']]);
});
test('an explicit native identity is never rewritten by collection preference',async()=>{
 const h=fixture();const result=await h.resolve('飞花',{candidate:{sourceSongId:'ncm-id',evidence:{source:'ncm'},orderedTarget:ncTrack}});
 assert.equal(result.source,'ncm');assert.deepEqual(h.calls,[['ncm','url','ncm-id']]);
});
test('a failed collection reference only falls back to confirmed recording members with their own metadata',async()=>{
 const h=fixture({qqUrl:null,equivalent:true});const result=await h.resolve('歌手 — 飞花');
 assert.equal(result.source,'ncm');assert.equal(result.album,'该源专辑');
 assert.equal(result.sourcePreference.reason,'preferred-resource-unavailable');
 assert.deepEqual(h.calls,[['qq','url','qq-mid'],['ncm','url','ncm-id']]);
});
test('without confirmed equivalence, collection failure never searches a same-title replacement',async()=>{
 const h=fixture({qqUrl:null});const result=await h.resolve('歌手 — 飞花');
 assert.equal(result.ok,false);assert.equal(result.error,'canonical-resource-unavailable');
 assert.deepEqual(h.calls,[['qq','url','qq-mid']]);
});
test('single-source policy wins over the collection preference',async()=>{
 const h=fixture({policy:{mode:'single',sources:['ncm']}});const result=await h.resolve('飞花');
 assert.equal(result.source,'ncm');assert.ok(h.calls.every(c=>c[0]==='ncm'));
});
test('collection resolution enters the normal program validation path with the actual native identity',async()=>{
 for (const fallback of [false,true]) {
  const h=fixture({qqUrl:fallback?null:'/qq.mp3',equivalent:fallback});
  const commit=new ProgramCommitService({resolveTrack:h.resolve});
  const program=createCandidateProgram({requestId:'collection-test',mode:'explicit',requestedCount:1,candidates:[{
   candidateId:'one',query:'歌手 — 飞花',sourceSongId:null,evidence:{source:null},orderedTarget:{title:'飞花',artist:'歌手'}
  }]});
  const resolved=await commit.resolveProgram(program);
  assert.equal(resolved.ok,true);
  const actual=resolved.resolvedProgram.tracks[0];
  assert.equal(actual.source,fallback?'ncm':'qq');
  assert.equal(actual.songId,fallback?'ncm-id':'qq-mid');
  if (fallback) assert.equal(actual.evidence.sourcePreference.reason,'preferred-resource-unavailable');
 }
});

test('verified alternatives still cannot escape a single-source policy',async()=>{
 const h=fixture({qqUrl:null,equivalent:true,policy:{mode:'single',sources:['qq']}});
 const result=await h.resolve('飞花');assert.equal(result.ok,false);
 assert.deepEqual(h.calls,[['qq','url','qq-mid']]);
});
test('ambiguous collected titles fail closed with no provider request',async()=>{
 const h=fixture({rows:[qqTrack,{...qqTrack,song_id:'other',artist:'另一个歌手'}]});
 const result=await h.resolve('飞花');assert.equal(result.error,'collection-reference-ambiguous');assert.deepEqual(h.calls,[]);
});
