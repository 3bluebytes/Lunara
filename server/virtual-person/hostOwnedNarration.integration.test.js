// 整条链路（只替换模型与供应商）：续播边界 → host 选歌回合 → 提交 → line pass → 存放 →
// 激活 → 合成 → WebSocket 命令 → 账本。文字到开口才出现，host 自始至终是同一个人。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVirtualPersonRuntimeComposition } from './createVirtualPersonRuntimeComposition.js';
import { createHostMusicRunner } from './hostMusicRunner.js';
import { createNarrationWiring } from '../app/createNarrationWiring.js';
import { recordTrackIntroTurn } from '../app/createSessionTraceWiring.js';
import { createPlaybackRuntimeComposition } from '../playback/createPlaybackRuntimeComposition.js';
import { QueueService } from '../playback/QueueService.js';
import { MusicSelectionService } from '../program/MusicSelectionService.js';
import { ProgramCommitService } from '../program/ProgramCommitService.js';
import { validateResolvedTrackAgainstRequest } from '../program/programConstraintValidation.js';
import { createTrackLineFreshness } from '../program/trackLineFreshness.js';
import { RadioRequestService } from '../requests/RadioRequestService.js';
import { createPresenceWiring } from '../presence/createPresenceWiring.js';
import { WebSocketHub } from '../realtime/WebSocketHub.js';

const SESSION = 'room';
const HOST = 'host';
const LIBRARY = [1, 2, 3, 4, 5, 6].map(id => ({ song_id: String(id), title: `歌${id}`, artist: '歌手', source: 'qq', album: '录音室', duration: 200 }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const settled = async (check, attempts = 80) => {
  for (let attempt = 0; attempt < attempts && !check(); attempt += 1) await tick();
  assert.ok(check(), 'condition not reached');
};

const toolCall = (name, args = {}) => ({ message: { role: 'assistant', content: '', tool_calls: [
  { id: `${name}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
const offerIdIn = messages => [...JSON.stringify(messages).matchAll(/offerId\\*":\\*"([^"\\]+)/g)].at(-1)?.[1] || null;

/** 模型替身：只看开放了哪些工具、聊到哪一步。 */
function modelDouble() {
  const model = { calls: [], writes: 0, lines: refs => refs.map(({ ref, title }) => ({ ref, text: `《${title}》放到这里正好，歇一下。` })),
    chatTurn: null, gate: null };
  model.chat = async (messages, definitions) => {
    const tools = (definitions || []).map(item => item.function.name);
    model.calls.push({ tools, messages: structuredClone(messages) });
    if (model.gate) await model.gate;
    if (tools.includes('presence_respond')) return toolCall('presence_respond', { action: 'speak', text: '你回来了。' });
    if (tools.includes('write_track_lines')) {
      model.writes += 1;
      const trigger = messages.findLast(item => item.role === 'user')?.content || '';
      const refs = [...trigger.matchAll(/【(t\d+)】\n歌名：([^\n]+)/g)].map(match => ({ ref: match[1], title: match[2] }));
      const lines = model.lines(refs);
      return lines ? toolCall('write_track_lines', { lines }) : { message: { role: 'assistant', content: '算了。' } };
    }
    if (tools.includes('select_music') && !tools.includes('get_listening_state')) {
      const offerId = offerIdIn(messages.slice(-2));
      return offerId ? toolCall('commit_music_selection', { offerId, indexes: [1, 2] }) : toolCall('select_music', {});
    }
    return model.chatTurn ? model.chatTurn(messages, tools) : { message: { role: 'assistant', content: '好的。' } };
  };
  return model;
}

function chain(t, { modeId = 'conversational', greeting = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-host-narration-'));
  const messages = [];
  let clientHub = null;
  const publish = message => { messages.push(message); clientHub?.broadcast(message); };
  const prefs = new Map();
  const queueService = new QueueService({ publish });
  const timers = new Map();
  let timerId = 0;
  // 开口窗口看的是播放时长：触发定时器时时钟跟着走到“已经站稳”。
  let clock = greeting ? Date.UTC(2026, 10, 13, 4) : Date.now();
  const model = modelDouble();
  const spoken = [];
  const refs = {};
  const playbackRuntime = createPlaybackRuntimeComposition({
    prefs: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    queueService, publish, now: () => clock,
    schedule: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    cancelSchedule: id => timers.delete(id),
    getRadioRequestService: () => refs.radio,
    resolveTrackNarrationAsset: (effect, options) => refs.composer.resolveTrackNarrationAsset(effect, options),
    lineDropReason: (track, sessionId) => refs.freshness(track, sessionId),
    onTrackNarrationStarted: (snapshot, event, track) => recordTrackIntroTurn({
      conversationStore: refs.composition.conversationStore, queueService, publish, snapshot, event, track }),
  });
  const tags = { getTags: () => ({ language: 'zh', genres: ['pop'], artist_key: 'artist' }), getArtistTags: () => ({ gender: 'female' }) };
  let service;
  const composition = createVirtualPersonRuntimeComposition({
    dbPath: join(dir, 'state.db'), chat: model.chat,
    synthesize: async () => null, publish, queueService, playbackRuntime,
    getMusicService: () => service, logger: { error() {}, warn() {} },
  });
  const { registry, conversationStore, runtime, agentLoop, toolRegistry } = composition;
  refs.composition = composition;
  runtime.initialize();
  registry.createRadiohost({ id: HOST, displayName: '主播', voiceProfileId: 'voice-host' });
  conversationStore.createRoom({ sessionId: SESSION, memberIds: [HOST], hostId: HOST });
  refs.composer = createNarrationWiring({ agentLoop, toolRegistry, registry, conversationStore, host: runtime,
    getSongTagStore: () => tags, getMemoryService: () => null, getTrackLikeService: () => null,
    getMusicService: () => service,
    synthesize: async text => { spoken.push(text); return { url: `/tts/${spoken.length}.mp3`, contentHash: `hash-${spoken.length}` }; },
  }).programNarrationComposer;
  refs.freshness = createTrackLineFreshness({ conversationStore });
  const programCommitService = new ProgramCommitService({ playbackRuntime, queueService,
    resolveTrack: async (_query, { candidate }) => {
      const track = LIBRARY.find(row => row.song_id === candidate.sourceSongId);
      return track ? { ...track, ok: true, url: `/audio/${track.song_id}.mp3`, lyric: { lrc: '[00:01.00] 第一句歌词\n[00:02.00] 第二句歌词' } } : { ok: false };
    },
    validateResolvedTrack: (track, context) => validateResolvedTrackAgainstRequest(track,
      { request: context.candidateProgram.metadata.musicSelection, songTagStore: tags }) });
  service = new MusicSelectionService({ programCommitService, playbackRuntime, registry, conversationStore,
    preResolveConcurrency: 4,
    getCandidates: async () => LIBRARY, getSongTagStore: () => tags, getFamiliarArtists: () => [], getRecentPlays: () => [] });
  const runner = createHostMusicRunner({ agentLoop, toolRegistry, host: runtime, registry });
  refs.radio = new RadioRequestService({ conversationService: composition.chatService, musicService: service,
    getHostMusicRunner: () => runner, playbackRuntime, conversationStore });
  clientHub = new WebSocketHub();
  if (greeting) prefs.set('app_open_greeting_v1', { version: 1, lastVisibleAt: clock - 10 * 3_600_000 });
  const presence = greeting ? createPresenceWiring({ playbackRuntime, virtualPerson: composition, queueService, clientHub,
    state: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    now: () => clock, timeZone: 'Asia/Shanghai', getActivity: sid => runtime.presenceActivity(sid), logger: { warn() {} } }) : null;
  t.after(async () => {
    presence?.stop();
    await playbackRuntime.stop();
    conversationStore.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const h = { model, messages, spoken, timers, playbackRuntime, conversationStore, runtime, service, radio: refs.radio, modeId,
    presence, clientHub,
    show: () => { const ws = { readyState: 1, send() {} }; clientHub.clients.add(ws); clientHub._notifyClients(); return ws; },
    snapshot: () => playbackRuntime.snapshot(),
    flushTimers: async () => { clock += 6000; for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } await tick(); await tick(); },
    commands: type => messages.filter(message => message.type === 'runtime-command' && message.command.type === type).map(message => message.command),
    turns: () => conversationStore.listTurns(SESSION, { visibleOnly: false }),
    intros: () => conversationStore.listTurns(SESSION, { visibleOnly: true }).filter(turn => turn.message?.presentation === 'track_intro'),
    start: async () => {
      const state = playbackRuntime.snapshot();
      return playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: `started-${state.version}`, runtimeVersion: state.version,
        songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
        outputGeneration: state.outputGeneration, listeningSessionId: state.activeListeningSessionId });
    },
    end: async () => {
      const state = playbackRuntime.snapshot();
      return playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: `ended-${state.version}`, runtimeVersion: state.version, natural: true,
        songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
        outputGeneration: state.outputGeneration, listeningSessionId: state.activeListeningSessionId });
    },
    /** 用户点第一首：没有 line pass，安静开播，低队列边界由 runtime 自己发起续播。 */
    seed: async () => {
      await playbackRuntime.submit({ type: 'COMPANION_MODE_CHANGED', eventId: 'mode', listeningSessionId: SESSION, modeId, requestId: 'mode' });
      const committed = await service.execute({ mode: 'exact', delivery: 'replace_now', count: 1,
        targets: [{ songId: '1', source: 'qq', title: '歌1', artist: '歌手' }] },
      { sessionId: SESSION, virtualPersonId: HOST, requestId: 'seed' });
      assert.equal(committed.ok, true, committed.code);
    },
  };
  return h;
}

const unspokenLineIn = value => /放到这里正好/u.test(JSON.stringify(value));

test('启动恢复先于可见客户端：真实 host 先交付问候，再执行续播和串词，当前歌曲不停', async t => {
  const h = chain(t, { greeting: true });
  let release;
  h.model.gate = new Promise(resolve => { release = resolve; });
  await h.seed();
  await h.start();
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(h.model.calls.length, 0, '客户端尚未连入，恢复续播不能抢先调模型');
  assert.equal(h.runtime.hostBusy(SESSION), false, '入场等待不能让问候误判 host 忙');
  const before = h.snapshot();
  h.show();
  await settled(() => h.model.calls.length > 0);
  assert.ok(h.model.calls[0].tools.includes('presence_respond'), '首个模型回合必须是问候，而不是选歌');
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.snapshot().phase, 'playing');
  assert.equal(h.snapshot().currentSongId, before.currentSongId);
  h.model.gate = null;
  release();
  // 真实 ambient 文字揭示延迟一秒，使用有引用的短计时器保持测试进程存活。
  await new Promise(resolve => setTimeout(resolve, 1200));
  await h.presence.greeter.settled();
  await settled(() => h.snapshot().queue.length >= 3 && h.snapshot().queue[2].narration.status === 'ready');
  const presenceTurn = h.turns().filter(turn => turn.message?.presentation === 'presence');
  assert.equal(presenceTurn.length, 1);
  assert.equal(presenceTurn[0].visibleText, '你回来了。');
  assert.ok(h.messages.some(event => event.message?.sourceTurnId === presenceTurn[0].turnId), '文字已通过生产交付链发布');
  assert.ok(h.model.calls.slice(1).some(call => call.tools.includes('select_music')), '问候后恢复原续播任务');
  assert.equal(h.snapshot().phase, 'playing');
  assert.equal(h.snapshot().currentSongId, before.currentSongId);
});

test('隔离 Electron 窗口 E2E：可见性→问候模型→SQLite→WebSocket→DOM，真实 audio 持续播放',
  { skip: process.env.LUNARA_GREETING_E2E !== '1' }, async t => {
    const h = chain(t, { greeting: true });
    await h.seed();
    await h.start();
    const before = h.snapshot();
    const qaDir = mkdtempSync(join(tmpdir(), 'lunara-greeting-window-'));
    const wav = Buffer.alloc(44 + 30 * 8000 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>回窗问候隔离验收</title>
      <style>body{background:#20251f;color:#f2ead5;font:24px system-ui;padding:32px}small{font-size:15px}</style>
      <h1>回窗问候</h1><p id="greeting">窗口刚打开，等待伙伴…</p><small>本地静音 WAV · 不接真实账号或模型</small>
      <audio id="music" src="/fixture.wav" loop></audio><input id="draft" aria-label="输入">
      <script type="module">
      import { createClientPresence } from '/clientPresence.js';
      const audio = document.querySelector('audio');
      let resolve, reject, openedAt, before, pauses = 0;
      window.greetingResult = new Promise((yes, no) => { resolve = yes; reject = no; });
      const deadline = setTimeout(() => reject(new Error('window greeting timed out')), 10000);
      await audio.play();
      while (audio.currentTime < 0.1) await new Promise(r => setTimeout(r, 20));
      before = audio.currentTime;
      audio.addEventListener('pause', () => { pauses += 1; });
      const socket = new WebSocket('ws://' + location.host + '/stream');
      const presence = createClientPresence({ getSocket: () => socket, input: document.querySelector('input') });
      presence.init();
      socket.onopen = () => { openedAt = performance.now(); presence.connected(); };
      socket.onmessage = async event => {
        const data = JSON.parse(event.data);
        if (data.message?.presentation !== 'presence') return;
        document.querySelector('#greeting').textContent = data.message.say;
        const visibleAfterMs = performance.now() - openedAt;
        await new Promise(r => setTimeout(r, 150));
        clearTimeout(deadline);
        resolve({ text: document.querySelector('#greeting').textContent, visibleAfterMs,
          visibility: document.visibilityState, audioBefore: before, audioAfter: audio.currentTime,
          audioPaused: audio.paused, pauseEvents: pauses, sourceTurnId: data.message.sourceTurnId });
      };
      </script></html>`;
    const server = createServer((req, res) => {
      if (req.url === '/clientPresence.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(readFileSync(new URL('../../pwa/core/clientPresence.js', import.meta.url))); return;
      }
      if (req.url === '/fixture.wav') { res.setHeader('Content-Type', 'audio/wav'); res.end(wav); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page);
    });
    h.clientHub.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await h.clientHub.close(); await new Promise(resolve => server.close(resolve)); });
    const env = { ...process.env, LUNARA_GREETING_QA_DIR: qaDir,
      LUNARA_GREETING_QA_URL: `http://127.0.0.1:${server.address().port}` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../electron/appOpenGreeting.fixture.cjs', import.meta.url))],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const watchdog = setTimeout(() => child.kill(), 15000);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(watchdog);
    assert.equal(code, 0, output);
    const result = JSON.parse(output.match(/GREETING_QA_RESULT (.+)/)?.[1] || '{}');
    assert.equal(result.text, '你回来了。');
    assert.equal(result.visibility, 'visible');
    assert.ok(result.visibleAfterMs < 5000, JSON.stringify(result));
    assert.ok(result.audioAfter > result.audioBefore + 0.5, JSON.stringify(result));
    assert.equal(result.audioPaused, false);
    assert.equal(result.pauseEvents, 0);
    assert.ok(h.model.calls[0].tools.includes('presence_respond'));
    assert.ok(h.turns().some(turn => turn.turnId === result.sourceTurnId && turn.visibleText === result.text));
    await settled(() => h.model.calls.some(call => call.tools.includes('select_music')));
    assert.equal(h.snapshot().phase, 'playing');
    assert.equal(h.snapshot().currentSongId, before.currentSongId);
    console.log(`GREETING_E2E_EVIDENCE ${JSON.stringify(result)}`);
  });

test('续播边界到开口：同一个 host 选歌写词，文字和声音都等到这首真的开始', async t => {
  const h = chain(t);
  await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'earlier', userText: '昨天你说想听点慢的', speak: false });
  await h.seed();
  await h.start();
  // 续播回合 + 写串词回合都在后台结束。
  await settled(() => h.snapshot().queue.length >= 3 && h.snapshot().queue[1].narration.status === 'ready');
  await settled(() => h.snapshot().queue[2].narration.status === 'ready');

  const selection = h.model.calls.find(call => call.tools.includes('commit_music_selection') && !call.tools.includes('get_listening_state'));
  const pass = h.model.calls.find(call => call.tools.includes('write_track_lines'));
  assert.deepEqual(pass.tools, ['write_track_lines'], 'line pass 只能写串词');
  assert.equal(pass.messages[0].role, 'system');
  assert.ok(pass.messages[0].content.length > 500 && selection.messages[0].content.startsWith(pass.messages[0].content),
    '同一份 host system prompt，没有另一个人设；选歌只是多了音乐工具说明');
  assert.match(JSON.stringify(selection.messages), /昨天你说想听点慢的/u, '选歌带着聊天上下文');
  assert.match(JSON.stringify(pass.messages), /commit_music_selection/u, '写词记得自己刚才选了什么');
  assert.match(JSON.stringify(pass.messages.at(-1)), /第一句歌词/u, '写词拿得到歌词');

  // 存着，但还没有说：聊天、账本、推给 PWA 的状态里都没有。
  assert.equal(h.commands('PLAY_TRACK_NARRATION').length, 0);
  assert.equal(h.intros().length, 0);
  assert.equal(unspokenLineIn(h.turns()), false, '账本里没有');
  assert.equal(unspokenLineIn(h.messages), false, '推送里没有');
  assert.equal(h.turns().some(turn => /不是听众的消息/u.test(JSON.stringify(turn.message))), false, '触发消息不入账');
  const pendingLine = h.snapshot().queue[1].narration.text;
  assert.match(pendingLine, /放到这里正好/u);

  // 第一首放完，第二首开始：到点才合成、才下发。
  await h.end();
  await settled(() => h.snapshot().currentSongId === h.snapshot().queue[1].songId);
  await h.start();
  await h.flushTimers();
  await settled(() => h.commands('PLAY_TRACK_NARRATION').length === 1);
  const [command] = h.commands('PLAY_TRACK_NARRATION');
  assert.equal(command.text, pendingLine, '说出来的就是写好的那句');
  assert.equal(h.spoken.includes(pendingLine), true, '合成的也是那句');
  assert.equal(command.url.startsWith('/tts/'), true);
  const callsBefore = h.model.calls.length;

  const voiceEvent = (type, eventId) => h.playbackRuntime.submit({ type, eventId, runtimeVersion: h.snapshot().version,
    queueItemId: command.queueItemId, songId: command.songId, programId: command.programId, correlationId: command.correlationId,
    narrationContentHash: command.narrationContentHash, listeningSessionId: SESSION, outputGeneration: h.snapshot().outputGeneration,
    positionSeconds: 6, durationSeconds: 200 });
  assert.equal((await voiceEvent('NARRATION_DELIVERY_STARTED', 'voice-start')).accepted, true);
  assert.equal(h.intros().length, 0, '还没出声，不入账');
  assert.equal((await voiceEvent('NARRATION_DELIVERY_AUDIBLE', 'voice-audible')).accepted, true);
  await tick();
  assert.deepEqual(h.intros().map(turn => turn.message.content), [pendingLine], '开口才入账，只入一次');
  assert.equal(h.model.calls.length, callsBefore, '开口不调模型：没有逐首叫醒');
});

test('预热：这个边界落定、串词写完才备下一批；下一个边界直接采用，带着写好的话，不再调模型', async t => {
  const h = chain(t);
  await h.seed();
  await h.start();
  const batch = () => h.service.prepared.listReady({ sessionId: SESSION, personId: HOST })[0];
  await settled(() => h.snapshot().queue[2]?.narration.status === 'ready');
  await settled(() => Object.keys(batch()?.lines || {}).length === batch()?.indexes.length && batch()?.indexes.length > 0, 400);
  const selections = h.model.calls.filter(call => call.tools.includes('commit_music_selection'));
  assert.equal(selections.some(call => call.tools.includes('write_track_lines')), false, '选歌回合不能写串词');
  // 顺序：实时选歌 → 写词 → 预热选歌 → 预热写词。同一时间只有一个后台 host 活动。
  const order = h.model.calls.map(call => (call.tools.includes('write_track_lines') ? 'line' : 'select'));
  assert.deepEqual(order.filter((kind, index) => kind !== order[index - 1]), ['select', 'line', 'select', 'line']);
  const prepPass = h.model.calls.findLast(call => call.tools.includes('write_track_lines'));
  assert.match(JSON.stringify(prepPass.messages.at(-1)), /第一句歌词/u, '预热写词也拿得到歌词');

  // 预热写好的话同样不外露。
  assert.equal(h.intros().length, 0);
  assert.equal(unspokenLineIn(h.turns()), false);
  assert.equal(unspokenLineIn(h.messages), false);

  const queuedBefore = h.snapshot().queue.length;
  await h.end();
  await settled(() => h.snapshot().currentSongId === h.snapshot().queue[1].songId);
  await h.start();
  await settled(() => h.snapshot().queue.length > queuedBefore, 400);
  const adopted = h.snapshot().queue.slice(queuedBefore);
  assert.ok(adopted.length > 0);
  for (const track of adopted) {
    assert.equal(track.narration.status, 'ready', `${track.title} 带着写好的话进队列`);
    assert.match(track.narration.text, new RegExp(`《${track.title}》放到这里正好`, 'u'), '话跟着自己那首歌');
  }
  assert.equal(h.service.preparedStats().consumed, 1, '这批是采用来的，不是当场再选一次');
});

test('写串词失败不影响音乐：这首安静播放，也不补一句模板', async t => {
  const h = chain(t);
  h.model.lines = () => null;
  await h.seed();
  await h.start();
  await settled(() => h.snapshot().queue.length >= 3 && h.snapshot().queue[1].narration.status === 'absent');
  await settled(() => h.snapshot().queue[2].narration.status === 'absent');
  assert.ok(h.snapshot().diagnostics.some(entry => entry.type === 'track-line-not-written'));
  await h.end();
  await settled(() => h.snapshot().currentSongId === h.snapshot().queue[1].songId);
  await h.start();
  await h.flushTimers();
  assert.equal(h.commands('PLAY_TRACK_NARRATION').length, 0);
  assert.equal(h.intros().length, 0);
  assert.equal(h.snapshot().phase, 'playing');
  assert.equal(h.spoken.length, 0);
});

test('music_only 不写串词：选歌照常，没有 line pass', async t => {
  const h = chain(t, { modeId: 'music_only' });
  await h.seed();
  await h.start();
  await settled(() => h.snapshot().queue.length >= 3);
  for (let attempt = 0; attempt < 10; attempt += 1) await tick();
  assert.equal(h.model.writes, 0);
  assert.equal(h.snapshot().queue[1].narration.status, 'absent');
});

test('host 在选歌或写词时 ambient 不插话；结束后恢复', async t => {
  const h = chain(t);
  await h.seed();
  let release;
  h.model.gate = new Promise(resolve => { release = resolve; });
  await h.start();
  await settled(() => h.model.calls.length > 0);
  assert.equal(h.runtime.hostBusy(SESSION), true);
  const ambient = await h.runtime.handleAmbientTurn({ sessionId: SESSION, personId: HOST, wake: { id: 'wake-1' } });
  assert.deepEqual(ambient, { action: 'silent', reason: 'turn-busy' });
  h.model.gate = null;
  release();
  await settled(() => h.snapshot().queue.length >= 3 && h.snapshot().queue[2].narration.status === 'ready');
  await settled(() => h.runtime.hostBusy(SESSION) === false);
});

test('聊天点歌：回复先走，串词在这一轮结束后写，不进聊天', async t => {
  const h = chain(t);
  h.model.chatTurn = (messages, tools) => {
    const offerId = offerIdIn(messages.slice(-2));
    if (offerId) return toolCall('commit_music_selection', { offerId, indexes: [1, 2] });
    if (JSON.stringify(messages.at(-1)).includes('来两首')) return toolCall('select_music', { mode: 'discovery', delivery: 'replace_now', count: 2 });
    return { message: { role: 'assistant', content: `好的。${tools.length}` } };
  };
  const response = await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'chat-1', userText: '来两首', speak: false });
  assert.equal(response.ok, true);
  await settled(() => h.snapshot().queue.length >= 2 && h.snapshot().queue[1].narration.status === 'ready');
  const pass = h.model.calls.find(call => call.tools.includes('write_track_lines'));
  assert.match(pass.messages.at(-1).content, /可以接听众刚才的请求/u, '听众提过要求');
  assert.match(JSON.stringify(pass.messages), /来两首/u, '这一轮听众说的话在上下文里');
  assert.equal(unspokenLineIn(h.turns()), false);
  assert.equal(unspokenLineIn(h.messages), false);
});

function askToTell(h) {
  h.model.chatTurn = (messages, tools) => (JSON.stringify(messages.at(-1)).includes('讲讲') && tools.includes('narrate_current_track')
    ? toolCall('narrate_current_track', {}) : { message: { role: 'assistant', content: '好的。' } });
}

test('“讲讲这首”：这首没有串词时只写这一次，写好才说', async t => {
  const h = chain(t);
  askToTell(h);
  await h.seed();
  await h.start();
  await settled(() => h.snapshot().queue.length >= 3 && h.snapshot().queue[2].narration.status === 'ready');
  // 第一首是手点的，没有串词。
  assert.equal(h.snapshot().queue[0].narration.status, 'absent');
  const writesBefore = h.model.writes;
  await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'tell-1', userText: '讲讲这首', speak: false });
  await settled(() => h.snapshot().queue[0].narration.assetStatus === 'ready');
  await h.flushTimers();
  await settled(() => h.commands('PLAY_TRACK_NARRATION').length === 1);
  assert.equal(h.model.writes, writesBefore + 1, '只多写一次');
  assert.match(h.commands('PLAY_TRACK_NARRATION')[0].text, /歌1/u);
  const pass = h.model.calls.findLast(call => call.tools.includes('write_track_lines'));
  assert.deepEqual([...pass.messages.at(-1).content.matchAll(/歌名：(歌\d+)/gu)].map(match => match[1]).filter((v, i, all) => all.indexOf(v) === i), ['歌1'], '这一轮只写这一首');
});

test('“讲讲这首”：写好的直接说，不调写词的模型', async t => {
  const h = chain(t, { modeId: 'music_only' });
  askToTell(h);
  await h.seed();
  await h.start();
  await settled(() => h.snapshot().queue.length >= 2);
  await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'tell-1', userText: '讲讲这首', speak: false });
  await settled(() => h.snapshot().queue[0].narration.assetStatus === 'ready');
  await h.flushTimers();
  await settled(() => h.commands('PLAY_TRACK_NARRATION').length === 1);
  const writes = h.model.writes;
  const chats = h.model.calls.length;
  // 同一首再要一遍：已经写好，交付层自己处理。这一轮只有聊天那一次模型调用，没有写词。
  await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'tell-2', userText: '讲讲这首', speak: false });
  for (let index = 0; index < 20; index += 1) await tick();
  assert.equal(h.model.writes, writes, '没有再写');
  assert.equal(h.model.calls.length, chats + 1, '只有聊天那一次');
});

test('“讲讲这首”：写不成就不说，歌照常放', async t => {
  const h = chain(t);
  askToTell(h);
  await h.seed();
  await h.start();
  await settled(() => h.snapshot().queue.length >= 3 && h.snapshot().queue[2].narration.status === 'ready');
  h.model.lines = () => null;
  const song = h.snapshot().currentSongId;
  const writesBefore = h.model.writes;
  await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'tell-1', userText: '讲讲这首', speak: false });
  await settled(() => h.model.writes > writesBefore && h.snapshot().queue[0].narration.status === 'absent');
  await h.flushTimers();
  for (let index = 0; index < 20; index += 1) await tick();
  assert.equal(h.commands('PLAY_TRACK_NARRATION').length, 0);
  assert.equal(h.snapshot().phase, 'playing');
  assert.equal(h.snapshot().currentSongId, song);
  assert.equal(h.model.writes, writesBefore + 1, '不重试');
  assert.equal(h.snapshot().diagnostics.some(item => item.type === 'track-line-not-written'), true);
});

test('聊天点歌复用本轮上下文启动 line pass：不重查记忆，并剔除历史 track_intro', async t => {
  const h = chain(t);
  // 写入一条历史上已说出口的串词与一条正常聊天，确认 line pass 跳过前者而保留后者。
  h.conversationStore.ensureSession(SESSION, HOST);
  h.conversationStore.beginRequest({ sessionId: SESSION, requestId: 'prev', virtualPersonId: HOST, userText: '之前聊天气不错' });
  h.conversationStore.completeRequest({ requestId: 'prev', virtualPersonId: HOST, message: { role: 'assistant', content: '确实挺舒服。' } });
  h.conversationStore.recordTrackIntro({
    sessionId: SESSION, personId: HOST, correlationId: 'prev-intro', queueItemId: 'queue:old',
    text: '这首旧串词绝不该进写词上下文', track: { songId: '0', title: '旧歌', artist: '旧歌手', source: 'qq' },
  });
  let chatReuseHostCalls = 0;
  const origAssembleHostContext = h.runtime.assembleHostContext.bind(h.runtime);
  h.runtime.assembleHostContext = async (...args) => {
    if (args[0]?.requestId === 'chat-reuse') chatReuseHostCalls += 1;
    return origAssembleHostContext(...args);
  };
  h.model.chatTurn = (messages, tools) => {
    const offerId = offerIdIn(messages.slice(-2));
    if (offerId) return toolCall('commit_music_selection', { offerId, indexes: [1] });
    if (JSON.stringify(messages.at(-1)).includes('再点一首')) {
      return toolCall('select_music', { mode: 'discovery', delivery: 'replace_now', count: 1 });
    }
    return { message: { role: 'assistant', content: `好的。${tools.length}` } };
  };
  const response = await h.runtime.handleTurn({ sessionId: SESSION, requestId: 'chat-reuse', userText: '再点一首', speak: false });
  assert.equal(response.ok, true);
  await settled(() => h.snapshot().queue.length >= 1 && h.snapshot().queue[0].narration.status === 'ready');
  assert.equal(chatReuseHostCalls, 0, '本轮聊天点歌复用上下文时不得再调用 assembleHostContext');
  const pass = h.model.calls.find(call => call.tools.includes('write_track_lines'));
  const serialized = JSON.stringify(pass.messages);
  assert.match(serialized, /之前聊天气不错/u);
  assert.match(serialized, /再点一首/u);
  assert.doesNotMatch(serialized, /这首旧串词绝不该进写词上下文/u);
});
