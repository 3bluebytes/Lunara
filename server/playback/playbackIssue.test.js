// playbackIssue.test.js — 播放问题摘要（surface-playback-issue-to-agent）。
//
// Run: node --test server/playback/playbackIssue.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { describePlaybackIssue } from './playbackIssue.js';
import { sanitizeFacts } from '../virtual-person/toolFacts.js';

const queue = [{ songId: 's1', title: '夜航星', artist: '不才' }, { songId: 's2', title: '晚风', artist: '陈婧霏' }];

test('播放失败给一句人话和那首歌，不带原始异常', () => {
  const issue = describePlaybackIssue({ queue, lastError: { type: 'track-failed', songId: 's2',
    message: 'MEDIA_ERR_SRC_NOT_SUPPORTED https://m.example/a.mp3?vkey=secret' } });
  assert.equal(issue.title, '晚风');
  assert.equal(issue.artist, '陈婧霏');
  assert.match(issue.summary, /没能播放出来/u);
  assert.doesNotMatch(JSON.stringify(issue), /MEDIA_ERR|https|vkey|secret/u);
});

test('续播失败与快照恢复各有说法；没有问题或类型不认识时不给', () => {
  assert.match(describePlaybackIssue({ queue, lastError: { type: 'continuation-failed', message: 'boom' } }).summary, /自动续播/u);
  assert.match(describePlaybackIssue({ queue: [], lastError: { type: 'invalid-snapshot-safe-idle', message: 'x' } }).summary, /安全停下/u);
  assert.equal(describePlaybackIssue({ queue, lastError: null }), null);
  assert.equal(describePlaybackIssue({ queue, lastError: { type: 'something-new', message: 'raw' } }), null);
  assert.equal(describePlaybackIssue(null), null);
});

test('摘要的键名能通过上下文清洗，lastError 本身照旧被清掉', () => {
  const snapshot = { queue, lastError: { type: 'track-failed', songId: 's1', message: 'raw provider text' } };
  const facts = sanitizeFacts({ playback: snapshot, playbackIssue: describePlaybackIssue(snapshot) });
  assert.equal(facts.playbackIssue.title, '夜航星');
  assert.equal(facts.playback.lastError, undefined);
  assert.doesNotMatch(JSON.stringify(facts), /raw provider text/u);
});
