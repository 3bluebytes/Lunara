import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 子进程隔离 console 分发器，避免测试框架或其他用例的日志捕获与它互相包裹。
test('NCM log boundary protects async and HTTP scopes without muting unrelated logs', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    const captured = [];
    const output = console.log.bind(console);
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      console[method] = (...args) => captured.push({ method, args });
    }
    // QQ 必须先载入稳定分发器，不能在认证包装器活动期间才安装。
    const { createQqMusicProvider } = await import(new URL('./server/qq.js', import.meta.url));
    const { runWithNcmLogBoundary, protectNcmServerLogs } = await import(new URL('./server/ncmLogBoundary.js', import.meta.url));
    let releaseQq, startedQq;
    const qqStarted = new Promise(resolve => { startedQq = resolve; });
    const qqWaiting = new Promise(resolve => { releaseQq = resolve; });
    const qq = createQqMusicProvider({ getCookieValue: () => 'qq-fixture-credential',
      userPlaylistsApi: async () => { startedQq(); await qqWaiting; return { status: 200, body: { data: { playlists: [] } } }; },
    });
    const qqWork = qq.userPlaylists('42');
    await qqStarted;
    const privateObject = { status: 400, body: { code: -460, message: 'private-provider-message' },
      cookie: ['NMTID=private-response-cookie'], config: { headers: { Cookie: 'MUSIC_U=private-login' } } };
    let finish;
    const waiting = new Promise(resolve => { finish = resolve; });
    const scoped = runWithNcmLogBoundary(async () => {
      console.log('[ERR]', privateObject);
      await waiting;
      console.warn('[ERR]', '/song/url/v1?cookie=private-query', privateObject);
      console.error(new Error('private-exception'));
      console.info('private-other-message');
      console.debug('private-debug');
    });
    const other = { subsystem: 'model', unchanged: true };
    console.log('other-subsystem', other);
    releaseQq();
    await qqWork; // 恢复临时 console 后，NCM 在途任务也必须仍受保护。
    finish();
    await scoped;
    const wrapper = console.log;
    runWithNcmLogBoundary(() => console.log('[OK]', '/lyric?uid=private-uid'));
    assert.equal(console.log, wrapper, 'repeated scopes do not stack wrappers');
    const server = createServer((req, res) => {
      setTimeout(() => { console.log('[ERR]', privateObject); res.end('ok'); }, 1);
    });
    protectNcmServerLogs(server);
    protectNcmServerLogs(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fetch('http://127.0.0.1:' + server.address().port);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const { startEmbeddedNcm, findFreePort } = await import(new URL('./server/ncmEmbedded.js', import.meta.url));
    const port = await findFreePort();
    const managed = await startEmbeddedNcm({
      env: { NCM_BASE_URL: 'http://127.0.0.1:' + port },
      log: { info() {}, warn() {} },
      probeOptions: { fetchImpl: async () => ({ ok: false }) },
      requireFn: name => name.endsWith('/util/index.js')
        ? { generateRandomChineseIP: () => '1.1.1.1' }
        : { serveNcmApi: async ({ port, host }) => {
          const server = createServer((req, res) => {
            setTimeout(() => { console.log('[ERR]', privateObject); res.end('fixture'); }, 1);
          });
          await new Promise(resolve => server.listen(port, host, resolve));
          return { server };
        } },
    });
    assert.ok(managed);
    try { await fetch(managed.baseUrl); } finally { await managed.stop(); }
    let delayed;
    const late = new Promise(resolve => { delayed = resolve; });
    runWithNcmLogBoundary(() => setTimeout(() => { console.log('[ERR]', privateObject); delayed(); }, 1));
    await late;
    assert.equal(captured.find(x => x.args[0] === 'other-subsystem').args[1], other);
    assert.doesNotMatch(JSON.stringify(captured), /private-/);
    assert.ok(captured.some(x => x.args[1]?.status === 400 && x.args[1]?.code === -460));
    // 各条受管路径（同步任务、真实监听请求、受管服务、迟到异步）都必须被投影。
    assert.ok(captured.filter(x => x.args[1]?.code === -460).length >= 4,
      'every managed path must be projected, got ' + captured.filter(x => x.args[1]?.code === -460).length);
    output('boundary-passed');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /boundary-passed/);
});

test('real NCM dependency error logs are sanitized while HTTP response and Set-Cookie stay unchanged', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'lunara-ncm-dependency-'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { createRequire } from 'node:module';
    const output = console.log.bind(console);
    const captured = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = (...args) => captured.push(args);
    const { startEmbeddedNcm, findFreePort } = await import(new URL('./server/ncmEmbedded.js', import.meta.url));
    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'NMTID=private-response-cookie; Path=/' });
      res.end(JSON.stringify({ code: -460, message: 'private-provider-message' }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const require = createRequire(import.meta.url);
    let handle;
    try {
      const port = await findFreePort();
      handle = await startEmbeddedNcm({
        env: { NCM_BASE_URL: 'http://127.0.0.1:' + port },
        log: { info() {}, warn() {} },
        probeOptions: { fetchImpl: async () => ({ ok: false }) },
        requireFn: name => {
          if (!name.endsWith('/server.js')) return require(name);
          const real = require(name);
          return { serveNcmApi: options => real.serveNcmApi({ ...options, moduleDefs: [{ route: '/risk',
            module: (query, request) => request('/api/fixture', {}, { crypto: 'weapi',
              domain: 'http://127.0.0.1:' + upstream.address().port, cookie: { MUSIC_U: 'private-login' } }),
          }] }) };
        },
      });
      assert.ok(handle);
      const response = await fetch(handle.baseUrl + '/risk?cookie=MUSIC_U%3Dprivate-query');
      assert.equal(response.status, 400);
      assert.match(response.headers.get('set-cookie'), /private-response-cookie/);
      assert.equal((await response.json()).message, 'private-provider-message');
      assert.doesNotMatch(JSON.stringify(captured), /private-/);
      assert.ok(captured.some(args => args[1]?.code === -460));
    } finally {
      await handle?.stop();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
    output('upstream-fixture-passed');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, env: { ...process.env, TMPDIR: temporary } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /upstream-fixture-passed/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-/);
});
