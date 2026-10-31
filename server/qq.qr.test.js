import assert from 'node:assert/strict';
import test from 'node:test';
import { createQqQrLogin } from './qq.js';

function fixture({ checkBody, now = () => 100 } = {}) {
  const calls = [];
  const qr = createQqQrLogin({
    now,
    createKey: () => 'opaque-key',
    getLoginQr: async () => ({
      status: 200,
      body: { img: 'data:image/png;base64,abc', ptqrtoken: 42, qrsig: 'secret-qrsig' },
    }),
    checkLoginQr: async input => {
      calls.push(input);
      return { status: 200, body: checkBody || { isOk: false, refresh: false, message: '未扫描二维码' } };
    },
  });
  return { qr, calls };
}

test('QQ QR keeps upstream qrsig behind an opaque local key', async () => {
  const { qr, calls } = fixture();
  const key = await qr.qrKey();
  assert.equal(key, 'opaque-key');
  assert.deepEqual(await qr.qrCreate(key), { qrimg: 'data:image/png;base64,abc', qrurl: '' });
  assert.deepEqual(await qr.qrCheck(key), { code: 801, cookie: '', message: '未扫描二维码' });
  assert.deepEqual(calls, [{ ptqrtoken: '42', qrsig: 'secret-qrsig' }]);
});

test('QQ QR normalizes successful login and invalidates the one-time session', async () => {
  const { qr } = fixture({
    checkBody: { isOk: true, message: '登录成功', session: { cookie: 'uin=42; qqmusic_key=secret' } },
  });
  const key = await qr.qrKey();
  assert.deepEqual(await qr.qrCheck(key), {
    code: 803,
    cookie: 'uin=42; qqmusic_key=secret',
    message: '登录成功',
  });
  assert.equal((await qr.qrCheck(key)).code, 800);
});

test('QQ QR expires locally without calling the upstream checker', async () => {
  let clock = 100;
  const { qr, calls } = fixture({ now: () => clock });
  const key = await qr.qrKey();
  clock = 180_101;
  const result = await qr.qrCheck(key);
  assert.equal(result.code, 800);
  assert.deepEqual(calls, []);
});
