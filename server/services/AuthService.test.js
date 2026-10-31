import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from './AuthService.js';

function fixture({ ncmCookie = '', qqCookie = '', qqUserId = '10001', qqLoggedIn = true } = {}) {
  const calls = [];
  let currentNcmCookie = ncmCookie;
  let currentQqCookie = qqCookie;
  const ncm = {
    getCookie: () => currentNcmCookie,
    clearCookie: () => { calls.push(['ncm.clearCookie']); currentNcmCookie = ''; },
    setCookie: cookie => { calls.push(['ncm.setCookie', cookie]); currentNcmCookie = cookie; },
    logout: async () => calls.push(['ncm.logout']),
    qrKey: async () => 'ncm-key',
    qrCreate: async key => ({ qrimg: `img:${key}` }),
    qrCheck: async key => ({ code: 803, cookie: `cookie:${key}` }),
    loginStatus: async () => ({ loggedIn: true, userId: 'ncm-user', nickname: 'Moon' }),
  };
  const qq = {
    getCookie: () => currentQqCookie,
    clearCookie: () => { calls.push(['qq.clearCookie']); currentQqCookie = ''; },
    setCookie: cookie => { calls.push(['qq.setCookie', cookie]); currentQqCookie = cookie; },
    logout: async () => calls.push(['qq.logout']),
    qrKey: async () => 'qq-key',
    qrCreate: async key => ({ qrimg: `qq-img:${key}` }),
    qrCheck: async key => ({ code: 803, cookie: `uin=${qqUserId}; key=${key}`, message: '登录成功' }),
    loginStatus: async () => qqLoggedIn
      ? ({ loggedIn: true, userId: qqUserId, nickname: 'Luna' })
      : ({ loggedIn: false, reason: 'invalid cookie' }),
  };
  const prefs = {
    setPref: (key, value) => calls.push(['pref', key, value]),
  };
  const service = new AuthService({
    providers: { ncm, qq },
    prefs,
    onLoggedIn: input => calls.push(['logged-in', input]),
  });
  return { service, calls };
}

test('starting NCM QR login clears stale identity before creating a key', async () => {
  const { service, calls } = fixture({ ncmCookie: 'stale' });
  assert.deepEqual(await service.startQr('ncm'), { ok: true, key: 'ncm-key', qrimg: 'img:ncm-key' });
  assert.deepEqual(calls, [
    ['ncm.logout'],
    ['pref', 'ncm_cookie', ''],
  ]);
});

test('successful NCM QR check replaces cookie and emits login callback', async () => {
  const { service, calls } = fixture();
  const result = await service.checkQr('ncm', 'abc');
  assert.deepEqual(result, {
    ok: true, code: 803, loggedIn: true,
    userId: 'ncm-user', nickname: 'Moon', avatarUrl: '', vipType: 0,
  });
  assert.deepEqual(calls, [
    ['ncm.setCookie', 'cookie:abc'],
    ['pref', 'ncm_cookie', 'cookie:abc'],
    ['logged-in', { source: 'ncm', userId: 'ncm-user', nickname: 'Moon' }],
  ]);
});

test('QQ cookie login persists a verified cookie without requiring process restart', async () => {
  const { service, calls } = fixture({ qqUserId: '10001' });
  const result = await service.loginWithCookie('qq', 'uin=10001; skey=x');
  assert.equal(result.ok, true);
  assert.equal(result.loggedIn, true);
  assert.equal(result.userId, '10001');
  assert.equal(result.warning, undefined);
  assert.deepEqual(calls, [
    ['qq.setCookie', 'uin=10001; skey=x'],
    ['pref', 'qq_cookie', 'uin=10001; skey=x'],
    ['logged-in', { source: 'qq', userId: '10001', nickname: 'Luna' }],
  ]);
});

test('QQ QR starts, saves the verified cookie, and never returns it to the client', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.startQr('qq'), { ok: true, key: 'qq-key', qrimg: 'qq-img:qq-key' });
  const result = await service.checkQr('qq', 'scan');
  assert.deepEqual(result, {
    ok: true, code: 803, message: '登录成功', loggedIn: true,
    userId: '10001', nickname: 'Luna', avatarUrl: '', vipType: 0,
  });
  assert.equal('cookie' in result, false);
  assert.deepEqual(calls, [
    ['qq.setCookie', 'uin=10001; key=scan'],
    ['pref', 'qq_cookie', 'uin=10001; key=scan'],
    ['logged-in', { source: 'qq', userId: '10001', nickname: 'Luna' }],
  ]);
});

test('starting a QQ QR keeps the current verified session until replacement succeeds', async () => {
  const { service, calls } = fixture({ qqCookie: 'uin=old; key=old' });
  assert.deepEqual(await service.startQr('qq'), { ok: true, key: 'qq-key', qrimg: 'qq-img:qq-key' });
  assert.deepEqual(calls, []);
});

test('invalid QR cookie restores the previous QQ runtime cookie and does not persist', async () => {
  const { service, calls } = fixture({ qqCookie: 'uin=old; key=old', qqLoggedIn: false });
  const result = await service.checkQr('qq', 'scan');
  assert.deepEqual(result, { ok: false, code: 500, error: 'invalid cookie' });
  assert.deepEqual(calls, [
    ['qq.setCookie', 'uin=10001; key=scan'],
    ['qq.setCookie', 'uin=old; key=old'],
  ]);
});

test('logout remains source-aware', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.logout('qq'), { ok: true, source: 'qq' });
  assert.deepEqual(calls, [['qq.logout'], ['pref', 'qq_cookie', '']]);
});
