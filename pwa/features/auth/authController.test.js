import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthController } from './authController.js';

test('auth controller normalizes both source login states from health', async () => {
  const controller = createAuthController({
    apiClient: { get: async () => ({ ncmLogin: { loggedIn: true, nickname: 'N' }, qqLogin: null }) },
  });
  assert.deepEqual(await controller.refresh(), {
    ncm: { loggedIn: true, nickname: 'N' },
    qq: { loggedIn: false },
  });
});

test('cookieStored 在登录态核验失败时仍然透传，供首跑协调器区分「未登录」与「暂无法核验」', async () => {
  const controller = createAuthController({
    apiClient: { get: async () => ({
      ncmLogin: { loggedIn: false, reason: 'no cookie set', cookieStored: false },
      qqLogin: { loggedIn: false, reason: '获取用户歌单失败', cookieStored: true },
    }) },
  });
  assert.deepEqual(await controller.refresh(), {
    ncm: { loggedIn: false, reason: 'no cookie set', cookieStored: false },
    qq: { loggedIn: false, reason: '获取用户歌单失败', cookieStored: true },
  });
});

test('cookie login and logout preserve current API paths', async () => {
  const calls = [];
  const controller = createAuthController({
    apiClient: {
      get: async () => ({}),
      post: async (...args) => { calls.push(args); return { loggedIn: true }; },
    },
  });
  await controller.loginWithCookie('qq', 'uin=1');
  await controller.loginWithCookie('ncm', 'MUSIC_U=x');
  await controller.logout('qq');
  assert.deepEqual(calls, [
    ['/api/login/qq/cookie', { cookie: 'uin=1' }],
    ['/api/login/cookie', { cookie: 'MUSIC_U=x' }],
    ['/api/logout?source=qq', {}],
  ]);
});

test('QR creation is a POST while QR polling stays a GET, for both sources', async () => {
  const calls = [];
  const controller = createAuthController({
    apiClient: {
      get: async path => { calls.push({ method: 'GET', path }); return { code: 801 }; },
      post: async (path, body) => { calls.push({ method: 'POST', path, body }); return { ok: true, key: 'a b', qrimg: 'x' }; },
    },
  });
  await controller.createQr('ncm');
  await controller.checkQr('ncm', 'a b');
  await controller.createQr('qq');
  await controller.checkQr('qq', 'a b');
  assert.deepEqual(calls, [
    { method: 'POST', path: '/api/login/qr', body: {} },
    { method: 'GET', path: '/api/login/qr/check?key=a%20b' },
    { method: 'POST', path: '/api/login/qq/qr', body: {} },
    { method: 'GET', path: '/api/login/qq/qr/check?key=a%20b' },
  ]);
});

test('a future provider never silently opens another provider login endpoint', async () => {
  const calls = [];
  const controller = createAuthController({ apiClient: { post: async path => { calls.push(path); } } });
  assert.equal(controller.canLogin('qq'), true);
  assert.equal(controller.canLogin('ncm'), true);
  assert.equal(controller.canLogin('future-source'), false);
  await assert.rejects(() => controller.createQr('future-source'), /暂未提供登录入口/);
  await assert.rejects(() => controller.loginWithCookie('future-source', 'fixture'), /暂未提供登录入口/);
  assert.deepEqual(calls, []);
});

test('QR creation rejects malformed provider responses', async () => {
  const controller = createAuthController({
    apiClient: { post: async () => ({ ok: false, error: 'upstream unavailable' }) },
  });
  await assert.rejects(() => controller.createQr('qq'), /upstream unavailable/);
});
