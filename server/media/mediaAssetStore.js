// mediaAssetStore.js — 音频媒体资产库：获取、校验、原子发布、隔离。
//
// 这一层要守住的不变量：
// 1. 只有「字节完整且通过校验」的文件才会出现在 /audio/<hash>.mp3 这个公开路径上；
// 2. 同一 (provider, songId) 的并发请求共享同一次下载，不会有两个写流叠加到同一文件；
// 3. 失败不产生可命中的半成品；坏资产被记在 sidecar 里，下一次解析重新下载；
// 4. 播放失败能把对应资产隔离，形成「坏 → 发现 → 替换」的闭环。

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MEDIA_ASSET_SCHEMA_VERSION = 1;
export const MEDIA_URL_PREFIX = '/audio/';
export const DEFAULT_BROKEN_COOLDOWN_MS = 10 * 60_000;

const MEDIA_FILE_EXTENSION = '.mp3';
const SIDECAR_EXTENSION = '.json';
const HASH_PATTERN = /^[a-f0-9]{32}$/;

const KNOWN_REASONS = ['download-failed', 'download-empty', 'byte-count-mismatch', 'decode-failed', 'decode-timeout',
  'duration-short', 'verifier-unavailable', 'unreadable'];
// 下载阶段的失败是瞬时抖动（断流、超时、字节数对不上的半截）：同一 acquire 内重试一次，
// 而且**不进冷却**——下一次解析应该立刻重试，而不是把歌锁十弱。
// 解码/时长类失败是真的字节坏了，保留冷却，避免反复下载坏资产。
const RETRYABLE_DOWNLOAD_REASONS = new Set(['download-failed', 'download-empty', 'byte-count-mismatch']);
const TRANSIENT_ERROR_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ABORT_ERR', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const TRANSIENT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError', 'FetchError']);
const DOWNLOAD_ATTEMPTS = 2;

function md5(value) {
  return createHash('md5').update(String(value)).digest('hex');
}

/**
 * 资产身份沿用历史命名（qq: md5("qq:"+songId)，ncm: md5(songId)），
 * 这样既有 URL、播放账本和队列项仍然有效。
 *
 * 「裸命名空间」（md5(songId)）被网易云**永久独占**：中文流媒体的 songId 普遍是
 * 纯数字，两个源同号很常见，共享命名空间会把别人的音频当成本歌交出去。
 * 新增 provider 一律带 `provider:` 前缀，MUST NOT 再往裸空间里加人。
 */
const LEGACY_BARE_NAMESPACE_PROVIDER = 'ncm';

export function normalizeMediaProvider(provider) {
  const name = String(provider ?? '').trim().toLowerCase();
  if (!name) throw new TypeError('mediaAssetHash requires provider');
  return name;
}

export function mediaAssetHash(provider, songId) {
  const id = String(songId ?? '').trim();
  if (!id) throw new TypeError('mediaAssetHash requires songId');
  const name = normalizeMediaProvider(provider);
  if (name === 'qq') return md5(`qq:${id}`);
  if (name === LEGACY_BARE_NAMESPACE_PROVIDER) return md5(id);
  return md5(`${name}:${id}`);
}

export function mediaAssetUrl(hash) {
  return `${MEDIA_URL_PREFIX}${hash}${MEDIA_FILE_EXTENSION}`;
}

/** 从本地媒体 URL 解析资产哈希；非本地 URL 返回 null（绝不误伤外部地址）。 */
export function mediaHashFromUrl(url) {
  const value = String(url || '').trim();
  if (!value.startsWith(MEDIA_URL_PREFIX)) return null;
  const name = value.slice(MEDIA_URL_PREFIX.length).split(/[?#]/)[0];
  if (!name.endsWith(MEDIA_FILE_EXTENSION)) return null;
  const hash = name.slice(0, -MEDIA_FILE_EXTENSION.length);
  return HASH_PATTERN.test(hash) ? hash : null;
}

function readyMeta({ provider, songId, hash, bytes, sha256, format, durationSeconds, verifiedBy, note, fetchedAt }) {
  return {
    schemaVersion: MEDIA_ASSET_SCHEMA_VERSION,
    status: 'ready',
    hash,
    provider,
    songId,
    bytes,
    sha256,
    format,
    durationSeconds,
    verifiedBy,
    note: note ?? null,
    fetchedAt,
  };
}

function brokenMeta({ provider = null, songId = null, hash, reason, bytes = 0, failedAt, retryable = false, previous = null }) {
  return {
    schemaVersion: MEDIA_ASSET_SCHEMA_VERSION,
    status: 'broken',
    hash,
    provider: provider ?? previous?.provider ?? null,
    songId: songId ?? previous?.songId ?? null,
    reason,
    bytes,
    failedAt,
    // retryable = 瞬时下载失败：下一次解析立刻重试，不把歌锁进冷却窗口。
    retryable: retryable === true,
  };
}

async function readSidecar(metaPath) {
  try {
    const parsed = JSON.parse(await readFile(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function statSize(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function sha256Of(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function streamOf(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
    return Readable.from([body]);
  }
  return body;
}

function stableReason(error) {
  // 传输层中断（连接被掐、超时、流半截）不是资产坏：单独归为可重试的 download-failed。
  // 以前这些错误只留下 message（如 'Premature close'），被统一堆成 verify-failed，
  // 既看不出原因，又跟着冷却十弱。
  const code = String(error?.code || '');
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  if (TRANSIENT_ERROR_CODES.has(code)
    || TRANSIENT_ERROR_NAMES.has(name)
    || /premature close|socket hang up|terminated/i.test(message)) {
    return 'download-failed';
  }
  const reason = String(error?.reason || error?.message || error || 'verify-failed');
  return KNOWN_REASONS.includes(reason) ? reason : 'verify-failed';
}

class AssetFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export function createMediaAssetStore({
  getDir,
  fetchImpl = (...args) => globalThis.fetch(...args),
  verifier = null,
  now = Date.now,
  trace = () => {},
  // 资产就绪后的**旁路**回调（例如排队算指纹）：不允许影响缓存结果或抛出。
  onAssetReady = null,
  downloadTimeoutMs = 60_000,
  brokenCooldownMs = DEFAULT_BROKEN_COOLDOWN_MS,
} = {}) {
  if (typeof getDir !== 'function') throw new TypeError('createMediaAssetStore requires getDir()');
  const notifyReady = (provider, songId, filePath, meta) => {
    if (typeof onAssetReady !== 'function') return;
    try { onAssetReady({ provider, songId, filePath, durationSeconds: meta?.durationSeconds ?? null }); }
    catch { /* 旁路失败不影响资产与播放 */ }
  };
  const inFlight = new Map();

  async function ensureDir() {
    const dir = await getDir();
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function report(event) {
    try { trace(event); } catch { /* 诊断不能影响播放主路径 */ }
  }

  async function verify(filePath, expectedDurationSeconds) {
    if (!verifier) return { ok: true, reason: null, format: null, durationSeconds: null, verifiedBy: 'none' };
    try {
      return await verifier(filePath, { expectedDurationSeconds });
    } catch (error) {
      return { ok: false, reason: stableReason(error), format: null, durationSeconds: null, verifiedBy: 'error' };
    }
  }

  async function downloadOnce({ provider, songId, hash, url, expectedDurationSeconds, dir }) {
    const finalPath = join(dir, `${hash}${MEDIA_FILE_EXTENSION}`);
    const metaPath = join(dir, `${hash}${SIDECAR_EXTENSION}`);
    const partPath = `${finalPath}.part-${randomUUID()}`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(downloadTimeoutMs) });
      if (!response?.ok) throw new AssetFailure('download-failed');
      const body = streamOf(response.body);
      if (!body) throw new AssetFailure('download-empty');
      await pipeline(body, createWriteStream(partPath));
      const written = await statSize(partPath);
      if (written <= 0) throw new AssetFailure('download-empty');
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > 0 && declared !== written) throw new AssetFailure('byte-count-mismatch');
      const verdict = await verify(partPath, expectedDurationSeconds);
      if (!verdict.ok) throw new AssetFailure(verdict.reason || 'verify-failed');
      await rename(partPath, finalPath);
      const meta = readyMeta({
        provider, songId, hash, bytes: written, sha256: await sha256Of(finalPath).catch(() => null),
        format: verdict.format, durationSeconds: verdict.durationSeconds, verifiedBy: verdict.verifiedBy,
        note: verdict.note, fetchedAt: now(),
      });
      await writeFile(metaPath, JSON.stringify(meta));
      // download() 里身份参数叫 provider/songId；acquire() 里才归一化成 name/id。
      notifyReady(provider, songId, finalPath, meta);
      return {
        file: finalPath, url: mediaAssetUrl(hash), cached: false,
        format: meta.format, durationSeconds: meta.durationSeconds, verifiedBy: meta.verifiedBy,
      };
    } catch (error) {
      await unlink(partPath).catch(() => {});
      throw error;
    }
  }

  async function download({ provider, songId, hash, url, expectedDurationSeconds, dir }) {
    const metaPath = join(dir, `${hash}${SIDECAR_EXTENSION}`);
    let reason = 'download-failed';
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        return await downloadOnce({ provider, songId, hash, url, expectedDurationSeconds, dir });
      } catch (error) {
        reason = stableReason(error);
        if (!RETRYABLE_DOWNLOAD_REASONS.has(reason) || attempt === DOWNLOAD_ATTEMPTS) break;
        report({ event: 'media-asset-retry', provider, songId, reason, attempt });
      }
    }
    const previous = await readSidecar(metaPath);
    // 下载类失败是瞬时抖动：标 retryable，下一次解析立刻重试，不进冷却窗口。
    const retryable = RETRYABLE_DOWNLOAD_REASONS.has(reason);
    await writeFile(metaPath, JSON.stringify(brokenMeta({
      provider, songId, hash, reason, failedAt: now(), retryable, previous,
    }))).catch(() => {});
    report({ event: 'media-asset-verify-failed', provider, songId, reason, phase: 'download' });
    return null;
  }

  async function acquire({ provider, songId, url = null, expectedDurationSeconds = 0 } = {}) {
    // 身份先归一化：后面所有报告、sidecar 与一致性核对都用同一组值。
    const name = normalizeMediaProvider(provider);
    const id = String(songId ?? '').trim();
    if (!id) throw new TypeError('mediaAssetHash requires songId');
    const hash = mediaAssetHash(name, id);
    if (inFlight.has(hash)) return inFlight.get(hash);
    const task = (async () => {
      const dir = await ensureDir();
      const finalPath = join(dir, `${hash}${MEDIA_FILE_EXTENSION}`);
      const metaPath = join(dir, `${hash}${SIDECAR_EXTENSION}`);
      const meta = await readSidecar(metaPath);
      const size = await statSize(finalPath);
      // 命中缓存前必须自证身份：字节可能来自另一个 (provider, songId)。
      // 缺失 sidecar 的历史文件不算「外来资产」，它没有可核对的声明。
      const foreignAsset = meta != null
        && (meta.provider !== name || String(meta.songId ?? '') !== id);

      if (size > 0 && !foreignAsset && meta?.status === 'ready' && meta.bytes === size) {
        // 命中缓存也是「资产就绪」：指纹队列自己会跳过已算过的，不必在这里判断。
        notifyReady(name, id, finalPath, meta);
        return {
          file: finalPath, url: mediaAssetUrl(hash), cached: true,
          format: meta.format ?? null, durationSeconds: meta.durationSeconds ?? null, verifiedBy: meta.verifiedBy ?? null,
        };
      }

      if (foreignAsset) {
        // 不是这批字节：不删除对方的资产，但也不能把它当成本歌。
        report({ event: 'media-asset-identity-mismatch', provider: name, songId: id });
      }

      // 播放失败是真实证据：不再相信同一份字节，直接换一份新的；校验器也判断不了"解码
      // 到一半才坏"的历史资产，重新验证只会把同一个坑再踩一次。
      if (size > 0 && !foreignAsset && meta?.status === 'broken' && meta.reason === 'playback-failed') {
        report({ event: 'media-asset-refresh-after-failure', provider: name, songId: id });
        if (!url) return null;
        return download({ provider: name, songId: id, hash, url, expectedDurationSeconds, dir });
      }

      if (size > 0 && !foreignAsset && meta?.status === 'broken') {
        // 已知坏资产：冷却期内 fail closed，避免解析循环里反复下载。
        if (meta.retryable !== true && now() - Number(meta.failedAt || 0) < brokenCooldownMs) {
          report({ event: 'media-asset-cooldown', provider: name, songId: id, reason: meta.reason || 'broken' });
          return null;
        }
        if (!url) return null;
        return download({ provider: name, songId: id, hash, url, expectedDurationSeconds, dir });
      }

      if (size > 0 && !foreignAsset) {
        // 历史资产（无 sidecar）或本身份的未就绪记录：先校验一次，通过才补写 ready。
        const verdict = await verify(finalPath, expectedDurationSeconds);
        if (verdict.ok) {
          const written = readyMeta({
            provider: name, songId: id, hash, bytes: size, sha256: await sha256Of(finalPath).catch(() => null),
            format: verdict.format, durationSeconds: verdict.durationSeconds, verifiedBy: verdict.verifiedBy,
            note: verdict.note, fetchedAt: now(),
          });
          await writeFile(metaPath, JSON.stringify(written));
          notifyReady(name, id, finalPath, written);
          return {
            file: finalPath, url: mediaAssetUrl(hash), cached: true,
            format: written.format, durationSeconds: written.durationSeconds, verifiedBy: written.verifiedBy,
          };
        }
        await writeFile(metaPath, JSON.stringify(brokenMeta({
          provider: name, songId: id, hash, reason: verdict.reason || 'verify-failed', bytes: size, failedAt: now(), previous: meta,
        })));
        report({ event: 'media-asset-verify-failed', provider: name, songId: id, reason: verdict.reason || 'verify-failed', phase: 'legacy', bytes: size });
        if (!url) return null;
        return download({ provider: name, songId: id, hash, url, expectedDurationSeconds, dir });
      }

      if (!foreignAsset && meta?.status === 'broken' && meta.retryable !== true
        && now() - Number(meta.failedAt || 0) < brokenCooldownMs) {
        report({ event: 'media-asset-cooldown', provider: name, songId: id, reason: meta.reason || 'broken' });
        return null;
      }

      if (!url) return null;
      return download({ provider: name, songId: id, hash, url, expectedDurationSeconds, dir });
    })().finally(() => inFlight.delete(hash));
    inFlight.set(hash, task);
    return task;
  }

  /**
   * 播放失败隔离：把对应资产标记为 broken，下一次解析重新下载。
   * 不立刻删除文件——当前队列项仍引用这个 URL，删掉只会让客户端重试变成 404。
   */
  async function quarantineByUrl(url, { reason = 'playback-failed' } = {}) {
    const hash = mediaHashFromUrl(url);
    if (!hash) return null;
    const dir = await ensureDir();
    const metaPath = join(dir, `${hash}${SIDECAR_EXTENSION}`);
    const previous = await readSidecar(metaPath);
    const size = await statSize(join(dir, `${hash}${MEDIA_FILE_EXTENSION}`));
    const meta = brokenMeta({ hash, reason, bytes: size, failedAt: now(), previous });
    await writeFile(metaPath, JSON.stringify(meta)).catch(() => null);
    return { hash, provider: meta.provider, songId: meta.songId, bytes: size };
  }

  async function inspect(songId, provider = 'qq') {
    const name = normalizeMediaProvider(provider);
    const id = String(songId ?? '').trim();
    const hash = mediaAssetHash(name, id);
    const dir = await ensureDir();
    const meta = await readSidecar(join(dir, `${hash}${SIDECAR_EXTENSION}`));
    if (!meta) return null;
    // 同 acquire：一个位置上的 sidecar 必须能自证是这条身份，否则不代表性。
    if (meta.provider !== name || String(meta.songId ?? '') !== id) return null;
    return { ...meta, hash };
  }

  return { acquire, quarantineByUrl, inspect, mediaAssetHash, mediaAssetUrl };
}
