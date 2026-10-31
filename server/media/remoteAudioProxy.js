// remoteAudioProxy.js — 播放地址的同源中继。
//
// 为什么不直接把供应商直链交给播放器：
// 播放器为了画波形，会把 <audio> 接进 Web Audio 图。浏览器对**跨源**媒体元素的
// MediaElementAudioSourceNode 输出静音（防止用 Web Audio 采样别人的音源），
// 而元素本身照常前进——于是出现「进度条在走、完全没声音、也没有报错」。
// 所以交给客户端的可播放地址必须与应用同源：本地资产 `/audio/<hash>.mp3` 天然满足，
// 缓存失败时由这里中继。
//
// 这一层要守住的不变量：
// 1. 中继路径由 canonical 身份 (provider, songId) 推导，绝不携带 vkey/uid/cookie；
//    因此重启后同一身份仍是同一路径，不需要留进程内会话表。
// 2. 直链只在服务端出现，按 TTL 记忆，避免拖动进度条把供应商接口打崩。
// 3. 只转流、不落盘；Range/206/416 与 Content-Range 原样透传，拖动行为等同直连。
// 4. 失败只报稳定分类，不回显直链。

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REMOTE_AUDIO_PREFIX = '/remote-audio/';
export const REMOTE_AUDIO_DEFAULT_MEMO_TTL_MS = 10 * 60_000;
const MEDIA_FILE_EXTENSION = '.mp3';
// 供应商直链带时效：被上游拒绝一次就当作过期，重取一次再试。
const REFRESH_ON_STATUS = new Set([403, 404, 410]);
// 只这些头需要透传：其余（set-cookie、供应商诊断头）不出中继。
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

function normalizeProvider(provider) {
  return String(provider ?? '').trim().toLowerCase();
}

/**
 * 由 canonical 身份构造同源中继地址。
 * token = base64url("provider:songId")：可逆、不含凭据、重启后仍一致。
 */
export function remoteAudioUrl(provider, songId) {
  const name = normalizeProvider(provider);
  const id = String(songId ?? '').trim();
  if (!name) throw new TypeError('remoteAudioUrl requires provider');
  if (!id) throw new TypeError('remoteAudioUrl requires songId');
  return `${REMOTE_AUDIO_PREFIX}${Buffer.from(`${name}:${id}`, 'utf8').toString('base64url')}${MEDIA_FILE_EXTENSION}`;
}

/** 解析中继 token；任何不能严格往返的值都视为未知身份（不猜、不查供应商）。 */
export function parseRemoteAudioToken(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const token = value.endsWith(MEDIA_FILE_EXTENSION) ? value.slice(0, -MEDIA_FILE_EXTENSION.length) : value;
  if (!token) return null;
  let decoded = null;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== token) return null;
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  const provider = normalizeProvider(decoded.slice(0, separator));
  const songId = decoded.slice(separator + 1).trim();
  if (!provider || !songId) return null;
  return { provider, songId };
}

function toReadable(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (typeof body.pipe === 'function') return body;
  return null;
}

/**
 * @param {object} options
 * @param {(provider: string, songId: string) => Promise<string|null>} options.resolveUrl
 *   现取供应商直链（qq.songUrl / ncm.songUrl）。返回 null 表示这一身份拿不到可播资源。
 */
export function createRemoteAudioProxy({
  resolveUrl,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  memoTtlMs = REMOTE_AUDIO_DEFAULT_MEMO_TTL_MS,
  upstreamTimeoutMs = 60_000,
  trace = () => {},
} = {}) {
  if (typeof resolveUrl !== 'function') throw new TypeError('createRemoteAudioProxy requires resolveUrl()');
  const memo = new Map();

  function report(event) {
    try { trace(event); } catch { /* 诊断不能影响播放 */ }
  }

  function forget(provider, songId) {
    memo.delete(`${provider}:${songId}`);
  }

  async function directUrl(provider, songId, { refresh = false } = {}) {
    const key = `${provider}:${songId}`;
    const hit = memo.get(key);
    if (!refresh && hit && now() - hit.at < memoTtlMs) return hit.url;
    const url = await resolveUrl(provider, songId);
    if (!url) {
      forget(provider, songId);
      return null;
    }
    memo.set(key, { url: String(url), at: now() });
    return String(url);
  }

  async function fetchUpstream(provider, songId, { range, method, refresh = false } = {}) {
    const url = await directUrl(provider, songId, { refresh });
    if (!url) return null;
    const headers = {};
    if (range) headers.range = String(range);
    return fetchImpl(url, { method, headers, signal: AbortSignal.timeout(upstreamTimeoutMs) });
  }

  function endWithError(res, status, message) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: message }));
  }

  async function handler(req, res) {
    const identity = parseRemoteAudioToken(req?.params?.token ?? req?.__relayToken);
    if (!identity) {
      report({ event: 'media-relay-unknown-identity' });
      endWithError(res, 404, 'unknown audio relay');
      return;
    }
    const method = req?.method === 'HEAD' ? 'HEAD' : 'GET';
    const range = req?.headers?.range || null;
    let response = null;
    try {
      response = await fetchUpstream(identity.provider, identity.songId, { range, method });
      if (response && REFRESH_ON_STATUS.has(Number(response.status))) {
        // 直链过期：清掉记忆后重取一次。第二次仍被拒就是真的不可播。
        forget(identity.provider, identity.songId);
        report({ event: 'media-relay-refresh', provider: identity.provider, songId: identity.songId, status: Number(response.status) });
        response = await fetchUpstream(identity.provider, identity.songId, { range, method, refresh: true });
      }
    } catch (error) {
      report({ event: 'media-relay-upstream-failed', provider: identity.provider, songId: identity.songId,
        reason: error?.name === 'TimeoutError' ? 'timeout' : 'transport' });
      endWithError(res, 502, 'audio relay unavailable');
      return;
    }
    if (!response) {
      report({ event: 'media-relay-unresolved', provider: identity.provider, songId: identity.songId });
      endWithError(res, 404, 'audio relay unavailable');
      return;
    }

    res.statusCode = Number(response.status) || 502;
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers?.get?.(name);
      if (value != null && value !== '') res.setHeader(name, String(value));
    }
    // 中继结果不缓存：直链会过期，播放器也不需要重复命中。
    res.setHeader('cache-control', 'no-store');

    if (method === 'HEAD' || res.statusCode === 304) {
      res.end();
      return;
    }
    const stream = toReadable(response.body);
    if (!stream) {
      res.end();
      return;
    }
    // 客户端断开（换歌、拖动）时立刻停掉上游读取，不留悬挂连接。
    const stopUpstream = () => { stream.destroy?.(); };
    req?.once?.('aborted', stopUpstream);
    res.once?.('close', stopUpstream);
    try {
      await pipeline(stream, res);
    } catch (error) {
      // 客户端提前关连接是正常路径（换歌/拖动），不当作中继故障。
      if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        report({ event: 'media-relay-stream-broken', provider: identity.provider, songId: identity.songId });
      }
      try { res.end(); } catch { /* 已结束 */ }
    } finally {
      req?.off?.('aborted', stopUpstream);
      res.off?.('close', stopUpstream);
    }
  }

  return { handler, rememberedIdentities: () => memo.size };
}
