import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAG1Request } from '@jixun/qmweb-sign';

import {
  QQ_SIGNED_ENDPOINT,
  buildQqSignedRequest,
  decodeQqSignedResponse,
  postQqSigned,
} from './qqWebSign.js';

// 与依赖里 encodeAG1Response 相同的响应混淆键（官方实现只导出解码方向，
// 这里为了能造出「上游真的会发的东西」自己写一遍；键变了这个测试会先红）。
const RESPONSE_KEY = [
  122, 63, 140, 29, 94, 155, 47, 10, 108, 77, 126, 139, 31, 58, 92, 157, 14, 43, 111, 74, 129,
];

function xorEncode(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.from(bytes.map((byte, index) => byte ^ RESPONSE_KEY[index % RESPONSE_KEY.length]));
}

const PAYLOAD = JSON.stringify({
  comm: { uin: '1234567890', authst: 'SECRET-AUTHST' },
  req_1: {
    module: 'music.musicasset.PlaylistDetailWrite',
    method: 'AddSonglist',
    param: { dirId: 201, v_songInfo: [{ songType: 0, songId: 97773 }] },
  },
});

test('the signed request signs the exact JSON string it encrypts', async () => {
  const request = await buildQqSignedRequest(PAYLOAD, 1_700_000_000_000);
  // 回归锚点：zzc 签名是纯函数，上游换版本时这里会先红，提醒升级而不是改常量。
  assert.equal(request.sign, 'zzc5919e5fxdtvgv5dgjd24eefje1wsx5zue5e4f83c');
  assert.deepEqual(request.url, `${QQ_SIGNED_ENDPOINT}?_=1700000000000&encoding=ag-1&sign=${request.sign}`);
  // body 是 base64 的 AES-GCM 密文，能被同一份密钥解回原 payload。
  assert.equal(await decodeAG1Request(String(request.body)), PAYLOAD);
});

test('different payloads never share a signature', async () => {
  const a = await buildQqSignedRequest(PAYLOAD, 1);
  const b = await buildQqSignedRequest(PAYLOAD.replace('97773', '97774'), 1);
  assert.notEqual(a.sign, b.sign);
  assert.ok(a.sign.startsWith('zzc'));
  // base64 段会按 20 字节做 padding 裁剪，所以总长度在 43~44 之间浮动。
  assert.ok([43, 44].includes(a.sign.length));
});

test('ag-1 encoded and plain JSON responses are both understood', () => {
  const body = '{"code":0,"req_1":{"code":0}}';
  assert.equal(decodeQqSignedResponse(xorEncode(body)), body);
  assert.equal(decodeQqSignedResponse(Buffer.from(body, 'utf8')), body);
});

test('credentials stay in the cookie header and out of the URL', async () => {
  const captured = [];
  const fetchImpl = async (url, init) => {
    captured.push({ url, init });
    return new Response(xorEncode('{"code":0,"req_1":{"code":0}}'), { status: 200 });
  };
  const body = await postQqSigned({
    payload: PAYLOAD,
    cookie: 'uin=1234567890; qm_keyst=SECRET-AUTHST',
    fetchImpl,
    now: () => 1_700_000_000_000,
  });

  assert.deepEqual(body, { code: 0, req_1: { code: 0 } });
  const [{ url, init }] = captured;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.cookie, 'uin=1234567890; qm_keyst=SECRET-AUTHST');
  assert.equal(init.headers['content-type'], 'text/plain');
  assert.ok(!url.includes('SECRET'));
  assert.ok(!url.includes('1234567890'));
  assert.equal(await decodeAG1Request(String(init.body)), PAYLOAD);
});

test('a transport failure surfaces as a thrown error the caller can attribute', async () => {
  await assert.rejects(
    postQqSigned({ payload: PAYLOAD, cookie: 'c', fetchImpl: async () => new Response('x', { status: 502 }) }),
    /qq musics → 502/,
  );
});
