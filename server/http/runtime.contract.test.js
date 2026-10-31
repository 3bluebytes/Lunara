import assert from 'node:assert/strict';
import test from 'node:test';

async function withRuntime(services, run) {
  const [{ createRuntime }, { createHttpApp }, { startRuntime, stopRuntime }] = await Promise.all([
    import('../app/createRuntime.js'),
    import('../app/createHttpApp.js'),
    import('../app/startRuntime.js'),
  ]);

  const runtime = await createRuntime({ services });
  const app = createHttpApp({ runtime, registerDefaultRoutes: true, serveStatic: false });
  const handle = await startRuntime({ runtime, app, port: 0 });
  const baseUrl = `http://127.0.0.1:${handle.address.port}`;
  try {
    await run({ baseUrl, runtime });
  } finally {
    await stopRuntime(handle);
  }
}

function makeServices() {
  const calls = [];
  const broadcasts = [];
  const queue = {
    queue: [{ kind: 'track', song_id: 'old', title: 'Old', artist: 'Radiohost', url: '/old.mp3' }],
    cursor: 0,
  };
  const runtimeState = {
    schemaVersion: 1,
    version: 4,
    queue: [],
    currentIndex: -1,
    currentSongId: null,
    phase: 'idle',
    txn: null,
  };

  return {
    calls,
    broadcasts,
    playbackRuntime: {
      snapshot: () => structuredClone(runtimeState),
      async submit(event) {
        calls.push(['runtime.submit', event]);
        runtimeState.version += 1;
        runtimeState.queue = [];
        runtimeState.currentIndex = -1;
        runtimeState.currentSongId = null;
        runtimeState.phase = 'idle';
        return { accepted: true, state: structuredClone(runtimeState), commands: [] };
      },
    },
    radioRequestService: {
      async handleChat(input) {
        calls.push(['chat', input]);
        return { ok: true, added: 1, tracks: 1, narration: 1 };
      },
    },
    queueService: {
      snapshot: () => structuredClone(queue),
      clearAll() {
        queue.queue = [];
        queue.cursor = -1;
        calls.push(['queue.clearAll']);
        return structuredClone(queue);
      },
    },
    environmentService: {
      getNow: () => ({ local: '2026/8/12 17:00:00', slot: 'afternoon' }),
    },
    stationService: {
      list: () => [{ id: 'radiohost-a', name: 'Nono', status: 'active' }],
      active: () => ({ id: 'radiohost-a', name: 'Nono' }),
      activate(id) {
        calls.push(['radiohost.activate', id]);
        return id === 'radiohost-b' ? { active: { id: 'radiohost-b', name: 'Luna' } } : null;
      },
    },
    settingsService: {
      async snapshot() {
        return {
          current: { llm: { ready: true, model: 'fake-model' }, source: 'qq', voice: 'voice-a', primarySource: 'qq' },
          options: { source: [], tts: [] },
        };
      },
    },
    healthService: {
      async snapshot() {
        return { ok: true, ncm: false, qq: false, llm: { ready: true, model: 'fake-model' } };
      },
    },
    authService: {
      async loginWithCookie(source, cookie) {
        calls.push(['auth.cookie', source, cookie]);
        return { ok: true, loggedIn: true, nickname: 'Moon' };
      },
      async logout(source) {
        calls.push(['auth.logout', source]);
        return { ok: true };
      },
      async startQr(source) {
        calls.push(['auth.qr.start', source]);
        return { ok: true, key: `${source}-key`, qrimg: 'data:image/png;base64,AA==' };
      },
      async checkQr(source, key) {
        calls.push(['auth.qr.check', source, key]);
        return { ok: true, code: 801, message: '等待扫码' };
      },
    },
    memoryAdminService: {
      async status() {
        calls.push(['memory.status']);
        return { ok: true, working: 2, episodic: 3, semantic: 4 };
      },
      async summarize(input) {
        calls.push(['memory.summarize', input]);
        return { ok: true, summaryId: 'summary-1' };
      },
    },
    playbackOperationsService: {
      async recordOutcome(input) {
        calls.push(['playback.outcome', input]);
        return { ok: true, updated: 1 };
      },
      async dispatch(event) {
        calls.push(['playback.event', event]);
        return { ok: true, state: { mode: 'playing' }, commands: [] };
      },
    },
    eventPublisher: {
      publish(message) {
        broadcasts.push(message);
      },
    },
  };
}

test('radio, now, radiohost, settings, and health routes preserve baseline shapes', async () => {
  const services = makeServices();
  await withRuntime(services, async ({ baseUrl }) => {
    const empty = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: 'empty message' });

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '来两首' }),
    });
    assert.equal(chat.status, 200);
    assert.deepEqual(await chat.json(), { ok: true, added: 1, tracks: 1, narration: 1 });
    assert.deepEqual(services.calls[0], ['chat', { message: '来两首' }]);

    const retriedOperation = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'rq-client-stable' },
      body: JSON.stringify({ message: '删除第二首' }),
    });
    assert.equal(retriedOperation.status, 200);
    assert.deepEqual(services.calls[1], ['chat', {
      message: '删除第二首',
      requestId: 'rq-client-stable',
    }]);

    const now = await fetch(`${baseUrl}/api/now`);
    assert.equal(now.status, 200);
    assert.deepEqual(await now.json(), {
      runtime: {
        schemaVersion: 1, version: 4, queue: [], currentIndex: -1,
        currentSongId: null, phase: 'idle', txn: null,
      },
      queue: [{ kind: 'track', song_id: 'old', title: 'Old', artist: 'Radiohost', url: '/old.mp3' }],
      cursor: 0,
      env: { now: { local: '2026/8/12 17:00:00', slot: 'afternoon' } },
    });

    const list = await fetch(`${baseUrl}/api/radiohost/list`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { ok: true, hosts: [{ id: 'radiohost-a', name: 'Nono', status: 'active' }] });

    const settings = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settings.status, 200);
    const settingsJson = await settings.json();
    assert.equal(settingsJson.ok, true);
    assert.equal(settingsJson.current.llm.model, 'fake-model');
    assert.deepEqual(settingsJson.options, { source: [], tts: [] });

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true, ncm: false, qq: false, llm: { ready: true, model: 'fake-model' },
    });
  });
});

test('Radiohost activation changes the conversation host and preserves playback', async () => {
  const services = makeServices();
  await withRuntime(services, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/radiohost/radiohost-b/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, active: { id: 'radiohost-b', name: 'Luna' } });
    assert.deepEqual(services.calls, [
      ['radiohost.activate', 'radiohost-b'],
    ]);
    assert.deepEqual(services.broadcasts, []);
  });
});

test('missing radiohost keeps queue unchanged', async () => {
  const services = makeServices();
  await withRuntime(services, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/radiohost/missing/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: 'radiohost not found' });
    assert.equal(services.queueService.snapshot().queue.length, 1);
    assert.deepEqual(services.broadcasts, []);
  });
});

test('auth routes validate and delegate without owning provider clients', async () => {
  const services = makeServices();
  await withRuntime(services, async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/api/login/qq/cookie`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(missing.status, 400);

    const login = await fetch(`${baseUrl}/api/login/qq/cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: 'uin=123; skey=secret' }),
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { ok: true, loggedIn: true, nickname: 'Moon' });
    assert.deepEqual(services.calls, [['auth.cookie', 'qq', 'uin=123; skey=secret']]);

    const qr = await fetch(`${baseUrl}/api/login/qq/qr`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(qr.status, 200);
    assert.deepEqual(await qr.json(), {
      ok: true, key: 'qq-key', qrimg: 'data:image/png;base64,AA==',
    });
    // The GET form must not exist: creating a QR session ends the current NCM
    // session, so a cross-site GET could log the account out.
    const qrViaGet = await fetch(`${baseUrl}/api/login/qq/qr`);
    assert.equal(qrViaGet.status, 404);
    const check = await fetch(`${baseUrl}/api/login/qq/qr/check?key=qq-key`);
    assert.equal(check.status, 200);
    const checkBody = await check.json();
    assert.deepEqual(checkBody, { ok: true, code: 801, message: '等待扫码' });
    assert.equal('cookie' in checkBody, false);
    assert.deepEqual(services.calls.slice(-2), [
      ['auth.qr.start', 'qq'],
      ['auth.qr.check', 'qq', 'qq-key'],
    ]);

    const logout = await fetch(`${baseUrl}/api/logout?source=qq`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });
    assert.deepEqual(services.calls.at(-1), ['auth.logout', 'qq']);
  });
});

test('memory routes delegate status and summarize operations', async () => {
  const services = makeServices();
  await withRuntime(services, async ({ baseUrl }) => {
    const status = await fetch(`${baseUrl}/api/memory/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true, working: 2, episodic: 3, semantic: 4 });

    const summarize = await fetch(`${baseUrl}/api/memory/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(summarize.status, 200);
    assert.deepEqual(await summarize.json(), { ok: true, summaryId: 'summary-1' });
    assert.deepEqual(services.calls, [
      ['memory.status'],
      ['memory.summarize', { force: true }],
    ]);
  });
});

test('operations routes validate and delegate playback outcomes', async () => {
  const services = makeServices();
  await withRuntime(services, async ({ baseUrl }) => {
    const invalid = await fetch(`${baseUrl}/api/play-outcome`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(invalid.status, 400);

    const outcome = await fetch(`${baseUrl}/api/play-outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ song_id: 'song-1', outcome: 'skipped', played_seconds: 12 }),
    });
    assert.equal(outcome.status, 200);
    assert.deepEqual(await outcome.json(), { ok: true, updated: 1 });
    assert.deepEqual(services.calls, [[
      'playback.outcome',
      { song_id: 'song-1', outcome: 'skipped', played_seconds: 12 },
    ]]);
  });
});
