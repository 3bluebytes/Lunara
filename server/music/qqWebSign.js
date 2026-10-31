// qqWebSign.js — QQ 网页端写请求的签名（zzc）与请求/响应封装（ag-1）
//
// 为什么需要它（2026-03 真实账号实测结论，不再靠猜）：
//   y.qq.com 现在的客户端把所有 musicu.fcg 请求都改写成
//     POST https://u6.y.qq.com/cgi-bin/musics.fcg?_=<ms>&encoding=ag-1&sign=<zzc签名>
//   body 是 AES-GCM 加密后的二进制，响应同样带 ag-1 编码。
//   明文 POST musicu.fcg 仍然可用，但能力不对等：
//     · 读接口（IsSongFanById / GetPlaylistByUin / 搜索）→ code 0，正常；
//     · 普通歌单写入（dirId≠201 的 AddSonglist/DelSonglist）→ code 0，正常；
//     · 「我喜欢」（dirId 201）**加歌** → 一律 80105，删歌 → code 0。
//   同一请求改走签名后：加歌 code 0，IsSongFanById 读回 true，数量 +1；删歌同样 code 0。
//   所以 80105 不是 songType 枚举问题（0 和 13 都一样），也不是登录态问题
//   （同一账号同一分钟里明文读是 0），而是「我喜欢」写入需要签名+加密通道。
//
// 签名算法是该站点目前的 zzc 版本（SHA-1 + 固定索引重排 + XOR 混淆 + base64），
// 加密是固定密钥的 AES-GCM。上游换版本时（zzb→zzc 已经发生过一次）需要升级
// 依赖，而不是去改这里的常量。
//
// 安全：payload 里有 uin/authst，但只进请求体，不进 URL、不进日志；异常只抛出
// 稳定错误码，不夹带响应原文。

import {
  decodeAG1Response,
  encodeAG1Request,
  zzcSign,
} from '@jixun/qmweb-sign';

export const QQ_SIGNED_ENDPOINT = 'https://u6.y.qq.com/cgi-bin/musics.fcg';

/** 供测试断言用；真实请求总是带当前时间戳。 */
export function qqSignedUrl(sign, now = Date.now()) {
  return `${QQ_SIGNED_ENDPOINT}?_=${now}&encoding=ag-1&sign=${encodeURIComponent(sign)}`;
}

/**
 * 生成一次签名写请求的 URL 与 body。
 * payload 必须是**最终要发送的同一份 JSON 字符串**：签名与加密都基于它。
 */
export async function buildQqSignedRequest(payload, now = Date.now()) {
  const text = String(payload);
  const [body, sign] = await Promise.all([encodeAG1Request(text), Promise.resolve(zzcSign(text))]);
  return { url: qqSignedUrl(sign, now), body, sign };
}

/**
 * 响应是 ag-1 编码的 JSON（真机实测：量化后确实带 ag-1 编码）。
 * 上游偶发回纯 JSON，所以解码后不像 JSON 就退回原文，两种都能解析。
 */
export function decodeQqSignedResponse(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let decoded = '';
  try { decoded = decodeAG1Response(bytes); } catch { /* fall through */ }
  const head = decoded.trim()[0];
  if (head === '{' || head === '[') return decoded;
  return bytes.toString('utf8');
}

/**
 * 发一次签名请求并解析 JSON。
 * fetchImpl 可注入，测试不需要联网；失败返回 null，由调用方决定语义。
 */
export async function postQqSigned({
  payload,
  cookie,
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now,
} = {}) {
  const { url, body } = await buildQqSignedRequest(payload, now());
  const response = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'text/plain',
      accept: 'application/json',
      referer: 'https://y.qq.com/',
      'user-agent': 'Mozilla/5.0',
      cookie: String(cookie || ''),
    },
    body,
  });
  if (!response.ok) throw new Error(`qq musics → ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = decodeQqSignedResponse(buffer);
  return JSON.parse(text);
}
