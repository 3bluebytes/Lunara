import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHttpApp } from '../app/createHttpApp.js';
import {
  allowedHostNames,
  hostNameOf,
  isStateChangingMethod,
  localRequestAllowed,
  originMatchesHost,
  portOf,
  requireJsonForStateChange,
  requireLocalHost,
} from './requestBoundary.js';

async function withApp(options, run) {
  const app = createHttpApp({
    ...options,
    configure: ({ app: instance }) => {
      let ran = 0;
      instance.post('/probe', (_req, res) => res.json({ ok: true, ran: (ran += 1) }));
      instance.get('/probe', (_req, res) => res.json({ ok: true, ran: (ran += 1) }));
      instance.all('/ran', (_req, res) => res.json({ ran }));
    },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ port, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/** Send a raw request so the Host header can be chosen, which fetch forbids. */
function rawRequest({ port, method = 'GET', path = '/probe', host, contentType, body }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== undefined) headers.host = host;
    if (contentType !== undefined) headers['content-type'] = contentType;
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: safeJson(text) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

test('hostNameOf strips ports and unwraps IPv6 literals', () => {
  assert.equal(hostNameOf('127.0.0.1:8080'), '127.0.0.1');
  assert.equal(hostNameOf('LOCALHOST:8080'), 'localhost');
  assert.equal(hostNameOf('localhost'), 'localhost');
  assert.equal(hostNameOf('[::1]:8080'), '::1');
  assert.equal(hostNameOf('[::1]'), '::1');
  assert.equal(hostNameOf('::1'), '::1');
  assert.equal(hostNameOf('example.test:80'), 'example.test');
  assert.equal(hostNameOf(''), '');
  assert.equal(hostNameOf(undefined), '');
});

test('isStateChangingMethod covers every mutating verb', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(isStateChangingMethod(method), true, method);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(isStateChangingMethod(method), false, method);
  }
});

test('allowedHostNames accepts loopback plus a concrete bind address only', () => {
  const loopback = allowedHostNames('127.0.0.1');
  for (const name of ['127.0.0.1', 'localhost', '::1']) assert.equal(loopback.has(name), true, name);

  const lan = allowedHostNames('192.168.1.5');
  assert.equal(lan.has('192.168.1.5'), true);

  // A wildcard bind names no single host, so it must not widen the accepted set.
  for (const wildcard of ['0.0.0.0', '::', '*']) {
    const names = allowedHostNames(wildcard);
    assert.equal(names.has('0.0.0.0'), false, wildcard);
    assert.equal(names.has('127.0.0.1'), true, wildcard);
    assert.equal(names.has('192.168.1.5'), false, wildcard);
  }
});

test('a state-changing request without a JSON content type is rejected before the route runs', async () => {
  await withApp({}, async ({ port, baseUrl }) => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
      const rejected = await rawRequest({ port, method: 'POST', contentType, body: 'x=1' });
      assert.equal(rejected.status, 415, `content-type: ${contentType}`);
      assert.deepEqual(rejected.json, { ok: false, error: 'application/json required' });
    }
    const ran = await rawRequest({ port, method: 'GET', path: '/ran' });
    assert.deepEqual(ran.json, { ran: 0 });

    const accepted = await rawRequest({
      port, method: 'POST', contentType: 'application/json; charset=utf-8', body: '{}',
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.json, { ok: true, ran: 1 });

    // The guard must not touch read paths.
    const read = await fetch(`${baseUrl}/probe`);
    assert.equal(read.status, 200);
  });
});

test('a request whose Host is not local is rejected before the route runs', async () => {
  await withApp({}, async ({ port }) => {
    for (const host of ['evil.test', 'evil.test:8080', '192.168.1.5:8080', '127.0.0.1.evil.test']) {
      const rejected = await rawRequest({ port, host });
      assert.equal(rejected.status, 403, `host: ${host}`);
      assert.deepEqual(rejected.json, { ok: false, error: 'forbidden host' });
    }
    const ran = await rawRequest({ port, path: '/ran' });
    assert.deepEqual(ran.json, { ran: 0 });

    for (const host of ['127.0.0.1', '127.0.0.1:8080', 'localhost:8080', '[::1]:8080', 'localhost']) {
      const accepted = await rawRequest({ port, host });
      assert.equal(accepted.status, 200, `host: ${host}`);
    }
  });
});

test('a missing Host header fails closed', async () => {
  const middleware = requireLocalHost({ bindHost: '127.0.0.1' });
  const result = await new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); return this; } };
    middleware({ headers: {} }, res, () => resolve({ next: true }));
  });
  assert.deepEqual(result, { code: 403, body: { ok: false, error: 'forbidden host' } });
});

test('the guard accepts the address the process is actually bound to', async () => {
  await withApp({ bindHost: () => '192.168.1.5' }, async ({ port }) => {
    assert.equal((await rawRequest({ port, host: '192.168.1.5:8080' })).status, 200);
    assert.equal((await rawRequest({ port, host: 'localhost:8080' })).status, 200);
    assert.equal((await rawRequest({ port, host: '10.0.0.1' })).status, 403);
  });
});

test('the JSON guard only inspects mutating methods', () => {
  const middleware = requireJsonForStateChange();
  const run = (method, headers) => new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); return this; } };
    middleware({ method, headers }, res, () => resolve({ next: true }));
  });
  return Promise.all([
    run('GET', {}).then(r => assert.deepEqual(r, { next: true })),
    run('POST', { 'content-type': 'application/json' }).then(r => assert.deepEqual(r, { next: true })),
    run('POST', {}).then(r => assert.equal(r.code, 415)),
    run('DELETE', { 'content-type': 'text/plain' }).then(r => assert.equal(r.code, 415)),
  ]);
});

// ---- 本地边界（fix-release-blocking-defects）：upgrade 与 HTTP 共用同一条规则 ----

test('portOf reads the port without confusing IPv6 literals', () => {
  assert.equal(portOf('127.0.0.1:8080'), '8080');
  assert.equal(portOf('localhost'), '');
  assert.equal(portOf('[::1]:8080'), '8080');
  assert.equal(portOf('::1'), '');
  assert.equal(portOf('[::1]'), '');
});

test('an absent Origin is allowed and an opaque one is not', () => {
  assert.equal(originMatchesHost(undefined, '127.0.0.1:8080').ok, true);
  assert.equal(originMatchesHost('', '127.0.0.1:8080').ok, true);
  assert.deepEqual(originMatchesHost('null', '127.0.0.1:8080'), { ok: false, reason: 'opaque-origin' });
  assert.equal(originMatchesHost('file:///tmp/x.html', '127.0.0.1:8080').ok, false);
  assert.equal(originMatchesHost('https://outside.invalid', '127.0.0.1:8080').ok, false);
});

test('a present Origin must name the same host and port as the request Host', () => {
  assert.equal(originMatchesHost('http://127.0.0.1:8080', '127.0.0.1:8080').ok, true);
  assert.equal(originMatchesHost('http://localhost:8080', '127.0.0.1:8080').ok, false, '名字不同即不同源');
  assert.equal(originMatchesHost('http://127.0.0.1:9999', '127.0.0.1:8080').ok, false);
  assert.equal(originMatchesHost('http://[::1]:8080', '[::1]:8080').ok, true);
});

test('localRequestAllowed requires a local Host and a self-consistent Origin', () => {
  const bindHost = () => '127.0.0.1';
  assert.deepEqual(localRequestAllowed({ host: '127.0.0.1:8080' }, { bindHost }), { ok: true, reason: null });
  assert.deepEqual(localRequestAllowed({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, { bindHost }),
    { ok: true, reason: null });
  assert.equal(localRequestAllowed({}, { bindHost }).reason, 'forbidden-host');
  assert.equal(localRequestAllowed({ host: 'rebound.example' }, { bindHost }).reason, 'forbidden-host');
  assert.equal(localRequestAllowed({ host: '127.0.0.1:8080', origin: 'https://evil.example' }, { bindHost }).reason,
    'origin-host-mismatch');
});