import assert from 'node:assert/strict';
import test from 'node:test';
import { qrStatusCopy } from './authView.js';

test('QR status copy covers waiting, scanned, success, expiry and errors', () => {
  assert.equal(qrStatusCopy('qq', 801, '10:00'), '[10:00] 等待扫码中…');
  assert.equal(qrStatusCopy('qq', 802), '已扫码，请在手机上确认');
  assert.equal(qrStatusCopy('qq', 803), '登录成功！');
  assert.equal(qrStatusCopy('qq', 800), '二维码已失效');
  assert.equal(qrStatusCopy('qq', 500), 'QQ 音乐登录检查失败');
});
