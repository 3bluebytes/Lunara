// ncmEmbedded.test.js — 内置网易云服务的地址解析、探针、降级与停机契约
// 契约见 openspec/changes/embed-netease-api-service（local-music-source-service）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  resolveNcmEmbedding,
  probeNcmIdentity,
  isPortFree,
  findFreePort,
  startEmbeddedNcm,
} from './ncmEmbedded.js';

const silentLog = () => {
  const lines = { info: [], warn: [] };
  return {
    lines,
    info: message => lines.info.push(message),
    warn: message => lines.warn.push(message),
  };
};

test('resolveNcmEmbedding 默认内嵌到 127.0.0.1:3000', () => {
  assert.deepEqual(resolveNcmEmbedding({ env: {} }), {
    mode: 'embed',
    host: '127.0.0.1',
    port: 3000,
    baseUrl: 'http://127.0.0.1:3000',
    configured: false,
  });
});

test('resolveNcmEmbedding 采用 loopback 自定义端口，并统一成 127.0.0.1', () => {
  const target = resolveNcmEmbedding({ env: { NCM_BASE_URL: 'http://localhost:3011/' } });
  assert.equal(target.mode, 'embed');
  assert.equal(target.port, 3011);
  assert.equal(target.baseUrl, 'http://127.0.0.1:3011');
  assert.equal(target.configured, true);
});

test('resolveNcmEmbedding 把远端、https 与不可解析地址当作外部服务', () => {
  const remote = resolveNcmEmbedding({ env: { NCM_BASE_URL: 'http://ncm.example.com:3000' } });
  assert.equal(remote.mode, 'external');
  assert.equal(remote.baseUrl, 'http://ncm.example.com:3000');

  const tls = resolveNcmEmbedding({ env: { NCM_BASE_URL: 'https://127.0.0.1:3000' } });
  assert.equal(tls.mode, 'external');

  const broken = resolveNcmEmbedding({ env: { NCM_BASE_URL: 'not a url' } });
  assert.equal(broken.mode, 'external');
});

test('resolveNcmEmbedding 尊重显式关闭开关', () => {
  for (const value of ['0', 'false', 'OFF', ' no ']) {
    assert.equal(resolveNcmEmbedding({ env: { LUNARA_EMBEDDED_NCM: value } }).mode, 'disabled');
  }
  assert.equal(resolveNcmEmbedding({ env: { LUNARA_EMBEDDED_NCM: '1' } }).mode, 'embed');
});

test('probeNcmIdentity 只认网易云首页标记，且不因异常抛错', async () => {
  const withMarker = async () => ({ ok: true, text: async () => '<title>网易云音乐 API</title>' });
  const withoutMarker = async () => ({ ok: true, text: async () => '<title>别的服务</title>' });
  const failing = async () => ({ ok: false, text: async () => 'boom' });
  const throwing = async () => { throw new Error('ECONNREFUSED'); };

  assert.equal(await probeNcmIdentity('http://127.0.0.1:3000', { fetchImpl: withMarker }), true);
  assert.equal(await probeNcmIdentity('http://127.0.0.1:3000/', { fetchImpl: withoutMarker }), false);
  assert.equal(await probeNcmIdentity('http://127.0.0.1:3000', { fetchImpl: failing }), false);
  assert.equal(await probeNcmIdentity('http://127.0.0.1:3000', { fetchImpl: throwing }), false);
});

test('端口工具有效：空闲端口可绑定，重监听连接 / 双栈监听都算占用', async () => {
  const port = await findFreePort();
  assert.equal(await isPortFree(port), true);

  const blocker = createServer((_, res) => res.end('busy'));
  await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }

  // macOS 上监听 `::`（双栈）时，再 bind 127.0.0.1 会成功；
  // 只看 bind 结果会把已被占用的端口当成空闲，必须靠连接探测盖住。
  const dual = createServer((_, res) => res.end('busy'));
  const dualPort = await findFreePort();
  try {
    await new Promise((resolve, reject) => {
      dual.once('error', reject);
      dual.listen(dualPort, resolve);
    });
    assert.equal(await isPortFree(dualPort), false, '双栈监听也必须判定为占用');
  } finally {
    if (dual.listening) await new Promise(resolve => dual.close(resolve));
  }
});

test('内置服务在指定端口起得来、页面可确认、stop 后端口能重新绑定', async () => {
  const port = await findFreePort();
  const log = silentLog();
  const handle = await startEmbeddedNcm({
    env: { NCM_BASE_URL: `http://127.0.0.1:${port}` },
    log,
  });
  try {
    assert.ok(handle, `应返回句柄，实际日志: ${JSON.stringify(log.lines)}`);
    assert.equal(handle.mode, 'embedded');
    assert.equal(handle.port, port);
    assert.equal(handle.baseUrl, `http://127.0.0.1:${port}`);

    const response = await fetch(`${handle.baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /网易云音乐 API/);
  } finally {
    await handle?.stop();
  }
  assert.equal(await isPortFree(port), true, 'stop 之后端口必须能再次绑定');
});

test('raw and managed services both omit default IP headers; fourth-slot IP is not transport options', async () => {
  // 对照真实原版服务，避免把依赖已有的默认行为误当成包装器修复效果。
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const isolated = mkdtempSync(join(tmpdir(), 'lunara-ncm-ip-baseline-'));
  writeFileSync(join(isolated, 'anonymous_token'), '');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    const { startEmbeddedNcm, findFreePort } = await import(new URL('./server/ncmEmbedded.js', import.meta.url));
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const seen = [];
    const upstream = createServer((req, res) => {
      seen.push({ url: req.url, ...req.headers });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: [{ id: 990001, url: null, code: 200 }] }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const handle = await startEmbeddedNcm({
      env: { NCM_BASE_URL: 'http://127.0.0.1:' + await findFreePort() },
      log: { info() {}, warn() {} },
      probeOptions: { fetchImpl: async () => ({ ok: false }) },
    });
    assert.ok(handle);
    const raw = await require('NeteaseCloudMusicApi/server.js').serveNcmApi({
      port: await findFreePort(), host: '127.0.0.1', checkVersion: false,
    });
    if (!raw.server.listening) await new Promise(resolve => raw.server.once('listening', resolve));
    const rawBase = 'http://127.0.0.1:' + raw.server.address().port;
    const domain = encodeURIComponent('http://127.0.0.1:' + upstream.address().port);
    for (const [base, query] of [[rawBase, 'id=990001&level=standard'],
      [handle.baseUrl, 'id=990001&level=standard'],
      [rawBase, 'id=990001&level=standard&realIP=203.0.113.9']]) {
      const response = await fetch(base + '/song/url/v1?' + query + '&domain=' + domain,
        { headers: { 'x-apicache-bypass': '1' } });
      assert.equal(response.status, 200);
      await response.json();
    }
    await handle.stop();
    raw.server.closeAllConnections();
    await new Promise(resolve => raw.server.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(require('NeteaseCloudMusicApi/util/request.js').length, 3);
    assert.equal(seen.length, 3, 'all controls reach the local fake upstream');
    for (const headers of seen.slice(0, 2)) {
      assert.equal('x-real-ip' in headers, false, 'raw baseline already omits default IP headers');
      assert.equal('x-forwarded-for' in headers, false);
    }
    assert.equal(seen[2]['x-real-ip'], '203.0.113.9', 'explicit realIP is still forwarded');
    assert.equal(seen[2]['x-forwarded-for'], '203.0.113.9');
    console.log('loopback-header-check-passed');
    process.exit(0);
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, env: { ...process.env, TMPDIR: isolated } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /loopback-header-check-passed/);
});

test('standalone launcher reuses the embedded assembly and exits cleanly on SIGTERM', async t => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const port = await findFreePort();
  const isolated = mkdtempSync(join(tmpdir(), 'lunara-ncm-standalone-'));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/ncm-server.mjs'], {
    cwd: resolve(dirname(import.meta.filename), '..'),
    env: { ...process.env, PORT: String(port), TMPDIR: isolated },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const deadline = Date.now() + 10_000;
  let marker = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok && (await response.text()).includes('网易云音乐 API')) { marker = true; break; }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(marker, `独立入口应在 PORT=${port} 提供网易云服务，stdout: ${stdout}`);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve([code, signal])));
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(signal, null, '应通过 SIGTERM 处理器干净退出');
  assert.equal(code, 0);
});

test('端口被非网易云服务占用时改听空闲端口并标记 fallback', async () => {
  const blockerPort = await findFreePort();
  const blocker = createServer((_, res) => res.end('<title>别的服务</title>'));
  // 不指定 host：模拟 `::` 双栈监听（另一个程序的常见形态）。
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(blockerPort, resolve);
  });

  const log = silentLog();
  let handle = null;
  try {
    handle = await startEmbeddedNcm({
      env: { NCM_BASE_URL: `http://127.0.0.1:${blockerPort}` },
      log,
    });
    assert.ok(handle, `应降级启动，实际日志: ${JSON.stringify(log.lines)}`);
    assert.equal(handle.mode, 'embedded');
    assert.equal(handle.fallback, true);
    assert.notEqual(handle.port, blockerPort);
    assert.equal(handle.baseUrl, `http://127.0.0.1:${handle.port}`);
    assert.ok(log.lines.warn.some(line => line.includes('被其它程序占用')), '应留下可见警告');
  } finally {
    await handle?.stop();
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('目标端口上已是网易云服务时复用，不重复监听', async () => {
  const port = await findFreePort();
  const first = await startEmbeddedNcm({ env: { NCM_BASE_URL: `http://127.0.0.1:${port}` }, log: silentLog() });
  assert.ok(first);
  const log = silentLog();
  let second = null;
  try {
    second = await startEmbeddedNcm({ env: { NCM_BASE_URL: `http://127.0.0.1:${port}` }, log });
    assert.ok(second);
    assert.equal(second.mode, 'reused');
    assert.equal(second.baseUrl, first.baseUrl);
    // 复用的句柄不得关闭别人的监听。
    await second.stop();
    const response = await fetch(`${first.baseUrl}/`);
    assert.equal(response.status, 200);
  } finally {
    await first.stop();
  }
});

test('依赖缺失或外部地址时返回 null 而不是抛错', async () => {
  const disabled = await startEmbeddedNcm({ env: { LUNARA_EMBEDDED_NCM: '0' }, log: silentLog() });
  assert.equal(disabled, null);

  const external = await startEmbeddedNcm({ env: { NCM_BASE_URL: 'http://ncm.example.com:3000' }, log: silentLog() });
  assert.equal(external, null);

  const missingPort = await findFreePort();
  const log = silentLog();
  const missing = await startEmbeddedNcm({
    env: { NCM_BASE_URL: `http://127.0.0.1:${missingPort}` },
    requireFn: () => { throw Object.assign(new Error("Cannot find module 'NeteaseCloudMusicApi/server.js'"), { code: 'MODULE_NOT_FOUND' }); },
    log,
  });
  assert.equal(missing, null);
  assert.ok(log.lines.warn.some(line => line.includes('缺少依赖')), '应提示缺少依赖');
  assert.equal(await isPortFree(missingPort), true, '失败不得留下监听');
});
