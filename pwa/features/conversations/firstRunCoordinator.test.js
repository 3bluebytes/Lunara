import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppState } from '../../core/appState.js';
import { STORAGE_KEYS } from '../../core/storageKeys.js';
import { canDismissRequiredSetup, createFirstRunCoordinator, firstRunChecklist, firstRunReadiness } from './firstRunCoordinator.js';

const settings = { current: { llm: { ready: true }, primarySource: 'qq' } };
const loggedIn = { qq: { loggedIn: true }, ncm: { loggedIn: false } };
const rooms = [{ sessionId: 'conversation:primary', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' }];
const emptyRuntime = () => ({
  activeListeningSessionId: 'conversation:primary', queue: [], currentIndex: -1,
  currentSongId: null, queueVersion: 0, suspendedSessions: {},
});

function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('returning runtime queue is restored without starting a new request', async () => {
  const runtime = { ...emptyRuntime(), queue: [{ songId: 'known' }], currentIndex: 0, currentSongId: 'known' };
  const store = createAppState({ runtimeState: runtime });
  const storage = memoryStorage();
  let requests = 0, focused = 0;
  const coordinator = createFirstRunCoordinator({
    store, storage,
    requestDefaultMusic: async () => { requests += 1; return { ok: true }; },
    focusRoot: () => { focused += 1; },
  });

  const state = await coordinator.start({ runtime, settings, auth: loggedIn, rooms });

  assert.equal(state.kind, 'returning-session');
  assert.equal(requests, 0);
  assert.equal(focused, 0);
  assert.equal(storage.getItem(STORAGE_KEYS.firstRunCompleted), '1');
});

test('已存凭据但登录态核验失败（上游故障）不判为 source-login 缺失', () => {
  const authStoredButUnverified = { qq: { loggedIn: false, reason: '获取用户歌单失败', cookieStored: true } };
  assert.deepEqual(
    firstRunReadiness({ settings, auth: authStoredButUnverified }),
    { ready: true, source: 'qq' },
  );
  // canDismissRequiredSetup 同样放行：自动弹出的首启设置可以关掉。
  assert.equal(
    canDismissRequiredSetup({ status: { kind: 'returning-session' }, settings, auth: authStoredButUnverified }),
    true,
  );
  // 从未登录（无凭据）仍然保持原判定。
  assert.deepEqual(
    firstRunReadiness({ settings, auth: { qq: { loggedIn: false, cookieStored: false } } }),
    { ready: false, missing: 'source-login', source: 'qq' },
  );
  assert.equal(
    canDismissRequiredSetup({ status: { kind: 'returning-session' }, settings, auth: { qq: { loggedIn: false } } }),
    false,
  );
});

test('empty ready install focuses Lunara and submits one idempotent replace request', async () => {
  const runtime = emptyRuntime();
  const store = createAppState({ runtimeState: runtime });
  const storage = memoryStorage();
  const calls = [];
  const coordinator = createFirstRunCoordinator({
    store, storage, requestIdFactory: () => 'install-1',
    focusRoot: async id => calls.push(['focus', id]),
    requestDefaultMusic: async input => { calls.push(['request', input]); return { ok: true }; },
  });

  const [first, second] = await Promise.all([
    coordinator.init({ runtime, settings, auth: loggedIn, rooms }),
    coordinator.start({ runtime, settings, auth: loggedIn, rooms }),
  ]);

  assert.equal(first.kind, 'started');
  assert.equal(second.kind, 'started');
  assert.deepEqual(calls.map(([kind]) => kind), ['focus', 'request']);
  assert.deepEqual(calls[1][1], {
    sessionId: 'conversation:primary', requestId: 'first-run:install-1',
    mode: 'discovery', delivery: 'replace_now', count: 2,
  });
  assert.equal(storage.getItem(STORAGE_KEYS.firstRunRequestId), 'first-run:install-1');
  assert.equal(storage.getItem(STORAGE_KEYS.firstRunCompleted), '1');
});

test('bootDone cannot bypass missing primary-source login', async () => {
  const runtime = emptyRuntime();
  const store = createAppState({ runtimeState: runtime });
  const storage = memoryStorage([[STORAGE_KEYS.bootDone, '1']]);
  const requestedSetup = [];
  let requests = 0;
  const coordinator = createFirstRunCoordinator({
    store, storage,
    requestDefaultMusic: async () => { requests += 1; return { ok: true }; },
    onSetupRequired: state => requestedSetup.push(state),
  });

  const state = await coordinator.start({
    runtime, settings,
    auth: { qq: { loggedIn: false }, ncm: { loggedIn: true } },
    rooms,
  });

  assert.equal(state.kind, 'needs-setup');
  assert.equal(state.missing, 'source-login');
  assert.equal(state.source, 'qq');
  assert.equal(requests, 0);
  assert.equal(requestedSetup.length, 1);
  assert.equal(storage.getItem(STORAGE_KEYS.firstRunRequestId), null);
});

test('uncertain request retries with the same persisted id', async () => {
  const runtime = emptyRuntime();
  const store = createAppState({ runtimeState: runtime });
  const storage = memoryStorage();
  const requestIds = [];
  let idsGenerated = 0;
  const coordinator = createFirstRunCoordinator({
    store, storage,
    requestIdFactory: () => 'install-' + (++idsGenerated),
    requestDefaultMusic: async input => {
      requestIds.push(input.requestId);
      if (requestIds.length === 1) throw new Error('connection lost');
      return { ok: true };
    },
  });

  assert.equal((await coordinator.start({ runtime, settings, auth: loggedIn, rooms })).kind, 'request-failed');
  assert.equal((await coordinator.start({ runtime, settings, auth: loggedIn, rooms })).kind, 'started');
  assert.deepEqual(requestIds, ['first-run:install-1', 'first-run:install-1']);
  assert.equal(idsGenerated, 1);
});

test('autoplay recovery retries the confirmed queue item without another music request', async () => {
  const runtime = emptyRuntime();
  const store = createAppState({ runtimeState: runtime });
  const storage = memoryStorage();
  const track = { queueItemId: 'occurrence-1', songId: 'song-1', url: '/audio/song-1' };
  let requests = 0, retries = 0;
  const coordinator = createFirstRunCoordinator({
    store, storage,
    requestDefaultMusic: async () => {
      requests += 1;
      store.update({ runtimeState: {
        ...runtime, queue: [track], currentIndex: 0, currentSongId: 'song-1',
        txn: { queueItemId: 'occurrence-1', correlationId: 'txn-1' },
      } });
      return { ok: true };
    },
    playbackRuntimeClient: { retry: async () => { retries += 1; return true; } },
  });
  await coordinator.start({ runtime, settings, auth: loggedIn, rooms });

  const accepted = coordinator.handleAutoplayBlocked(
    Object.assign(new Error('user gesture required'), { name: 'NotAllowedError' }),
    { queueItemId: 'occurrence-1', songId: 'song-1', correlationId: 'txn-1', listeningSessionId: 'conversation:primary' },
  );
  assert.equal(accepted, true);
  assert.equal(coordinator.getSnapshot().kind, 'autoplay-blocked');
  assert.equal(await coordinator.startPreparedPlayback(), true);
  assert.equal(retries, 1);
  assert.equal(requests, 1);
});

test('missing authoritative runtime state fails closed even when local setup is marked done', async () => {
  const store = createAppState({ runtimeState: null });
  const storage = memoryStorage([[STORAGE_KEYS.bootDone, '1']]);
  let requests = 0;
  const coordinator = createFirstRunCoordinator({
    store, storage,
    requestDefaultMusic: async () => { requests += 1; return { ok: true }; },
  });

  const state = await coordinator.start({ runtime: null, settings, auth: loggedIn, rooms });

  assert.equal(state.kind, 'bootstrap-unavailable');
  assert.equal(requests, 0);
  assert.equal(storage.getItem(STORAGE_KEYS.firstRunRequestId), null);
});

const XIAOXIAO_ID = 'vp_cx_a0c168ef';
const xiaoxiao = {
  id: XIAOXIAO_ID,
  sourceProvider: 'free-edge',
  sourceVoiceId: 'zh-CN-XiaoxiaoNeural',
  displayName: '晓晓',
  sourceLabel: '免费声音（Edge）· 未启用',
  resolvedProviderId: null,
  unavailable: true,
};
const consentedFallback = { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' };

test('新安装只预选晓晓且用户未同意时，声音项缺失，且不挡住播放就绪', async () => {
  const checklist = firstRunChecklist({
    settings: { ...settings, fallback: { freeVoicesEnabled: false, consentAt: null } },
    auth: loggedIn,
    voices: [xiaoxiao],
    rootVoiceId: XIAOXIAO_ID,
  });
  assert.equal(checklist.voice, 'missing');
  assert.equal(firstRunChecklist({
    settings,
    auth: loggedIn,
    voices: [{ ...xiaoxiao, unavailable: false, sourceLabel: '免费声音（Edge）' }],
    rootVoiceId: XIAOXIAO_ID,
  }).voice, 'missing');
  assert.equal(firstRunChecklist({
    settings: { ...settings, fallback: { freeVoicesEnabled: true, consent: true, consentAt: null } },
    auth: loggedIn,
    voices: [{ ...xiaoxiao, unavailable: false }],
    rootVoiceId: XIAOXIAO_ID,
  }).voice, 'missing');
  assert.deepEqual(
    firstRunReadiness({ settings, auth: loggedIn, voices: [xiaoxiao], rootVoiceId: XIAOXIAO_ID }),
    { ready: true, source: 'qq' },
  );

  const runtime = emptyRuntime();
  const store = createAppState({ runtimeState: runtime });
  let requests = 0;
  const coordinator = createFirstRunCoordinator({
    store, storage: memoryStorage(),
    requestDefaultMusic: async () => { requests += 1; return { ok: true }; },
  });
  const state = await coordinator.start({ runtime, settings, auth: loggedIn, rooms });
  assert.equal(state.kind, 'started');
  assert.equal(requests, 1);
});

test('模型已就绪且音乐账号未登录时，只有模型一项完成', () => {
  assert.deepEqual(firstRunChecklist({
    settings,
    auth: { qq: { loggedIn: false, cookieStored: false } },
    voices: [xiaoxiao],
    rootVoiceId: XIAOXIAO_ID,
  }), { model: 'complete', music: 'missing', voice: 'missing' });
  assert.deepEqual(
    firstRunReadiness({ settings, auth: { qq: { loggedIn: false, cookieStored: false } } }),
    { ready: false, missing: 'source-login', source: 'qq' },
  );
});

test('已存凭据时音乐账号完成，播放就绪保持放行', () => {
  const auth = { qq: { loggedIn: false, reason: '获取用户歌单失败', cookieStored: true } };
  assert.equal(firstRunChecklist({ settings, auth, voices: [], rootVoiceId: XIAOXIAO_ID }).music, 'complete');
  assert.deepEqual(firstRunReadiness({ settings, auth }), { ready: true, source: 'qq' });
});

test('三项都完成后，原播放就绪和首启请求不变', async () => {
  const readySettings = { ...settings, fallback: consentedFallback };
  const voices = [{ ...xiaoxiao, unavailable: false, sourceLabel: '免费声音（Edge）', resolvedProviderId: 'free-edge' }];
  assert.deepEqual(firstRunChecklist({
    settings: readySettings, auth: loggedIn, voices, rootVoiceId: XIAOXIAO_ID,
  }), { model: 'complete', music: 'complete', voice: 'complete' });
  assert.equal(firstRunChecklist({
    settings,
    auth: loggedIn,
    voices: [{ id: 'vp_cx_custom01', sourceProvider: 'custom', unavailable: false }],
    rootVoiceId: 'vp_cx_custom01',
  }).voice, 'complete');
  assert.deepEqual(firstRunReadiness({ settings: readySettings, auth: loggedIn, voices, rootVoiceId: XIAOXIAO_ID }), {
    ready: true, source: 'qq',
  });

  const runtime = emptyRuntime();
  const store = createAppState({ runtimeState: runtime });
  const calls = [];
  const coordinator = createFirstRunCoordinator({
    store, storage: memoryStorage(), requestIdFactory: () => 'install-1',
    focusRoot: async id => calls.push(['focus', id]),
    requestDefaultMusic: async input => { calls.push(['request', input]); return { ok: true }; },
  });
  const state = await coordinator.start({ runtime, settings: readySettings, auth: loggedIn, rooms });
  assert.equal(state.kind, 'started');
  assert.deepEqual(calls[1][1], {
    sessionId: 'conversation:primary', requestId: 'first-run:install-1',
    mode: 'discovery', delivery: 'replace_now', count: 2,
  });
});

test('returning or recovered startup dismisses required setup only after settings and source login are ready', () => {
  assert.equal(canDismissRequiredSetup({ status: { kind: 'returning-session' }, settings, auth: loggedIn }), true);
  assert.equal(canDismissRequiredSetup({ status: { kind: 'autoplay-blocked' }, settings, auth: loggedIn }), true);
  assert.equal(canDismissRequiredSetup({ status: { kind: 'returning-session' }, settings,
    auth: { ...loggedIn, qq: { loggedIn: false } } }), false);
  assert.equal(canDismissRequiredSetup({ status: { kind: 'started' },
    settings: { current: { ...settings.current, llm: { ready: false } } }, auth: loggedIn }), false);
  assert.equal(canDismissRequiredSetup({ status: { kind: 'request-failed' }, settings, auth: loggedIn }), false);
});
