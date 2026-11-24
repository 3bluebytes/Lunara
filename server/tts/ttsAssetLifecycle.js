// ttsAssetLifecycle.js — 语音缓存三级生命周期治理。
//
// 分层策略：
//   1. pinned   ：至少被一条未删除手账条目的 attachedQuotes 引用的对话 turnId -> 永久豁免。
//   2. dialogue ：仍被未撤回/未改写的对话回合引用的语音文件 -> 仅受 500 MiB 总预算与 30 天最小保护期约束，按 mtime LRU 淘汰。
//   3. ephemeral：自动串词、未归属试听与孤立片段 -> 默认保留 7 天 TTL，超时清理。
//
// 所有定时清理均为异步分批执行，让出事件循环，不阻塞请求或播放。

import { existsSync, mkdirSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_EPHEMERAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_DIALOGUE_MAX_BYTES = 500 * 1024 * 1024;
export const DEFAULT_DIALOGUE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_SWEEP_BATCH_SIZE = 200;
const STARTUP_SWEEP_DELAY_MS = 15_000;

export function resolveDefaultDialogueMaxBytes() {
  const envMb = Number(process.env.LUNARA_TTS_CACHE_MAX_MB);
  if (Number.isFinite(envMb) && envMb > 0) return Math.round(envMb * 1024 * 1024);
  return DEFAULT_DIALOGUE_MAX_BYTES;
}

const AUDIO_FILE_RE = /^([a-zA-Z0-9_-]+)\.(wav|mp3)$/i;
const TTS_URL_RE = /^\/tts\/([a-zA-Z0-9_-]+\.(?:wav|mp3))$/i;

function yieldEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

export function extractTtsAssetFilename(url) {
  const clean = String(url || '').trim().split(/[?#]/)[0];
  const match = TTS_URL_RE.exec(clean);
  return match ? match[1] : null;
}

export function createTtsAssetLifecycle({
  cacheDir,
  conversationStore = null,
  listPinnedTurnIds = () => new Set(),
  logger = console,
  now = () => Date.now(),
  ephemeralTtlMs = DEFAULT_EPHEMERAL_TTL_MS,
  dialogueMaxBytes = resolveDefaultDialogueMaxBytes(),
  dialogueMinAgeMs = DEFAULT_DIALOGUE_MIN_AGE_MS,
  batchSize = DEFAULT_SWEEP_BATCH_SIZE,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
} = {}) {
  let activeSweep = null;
  let startupTimer = null;
  let periodicTimer = null;

  function resolveAssetPath(url) {
    if (!cacheDir) return null;
    const filename = extractTtsAssetFilename(url);
    if (!filename) return null;
    const fullPath = join(cacheDir, filename);
    try {
      const st = statSync(fullPath);
      if (st.isFile() && st.size > 0) return fullPath;
    } catch {
      return null;
    }
    return null;
  }

  function existsByUrl(url) {
    return resolveAssetPath(url) !== null;
  }

  function touchByUrl(url) {
    const fullPath = resolveAssetPath(url);
    if (!fullPath) return false;
    try {
      const ts = new Date(now());
      utimesSync(fullPath, ts, ts);
      return true;
    } catch {
      return false;
    }
  }

  function readPinnedHashes() {
    if (!conversationStore?.voiceHashesForTurnIds) return new Set();
    const rawIds = typeof listPinnedTurnIds === 'function' ? listPinnedTurnIds() : [];
    const turnIds = rawIds instanceof Set ? [...rawIds] : (Array.isArray(rawIds) ? rawIds : []);
    if (!turnIds.length) return new Set();
    return conversationStore.voiceHashesForTurnIds(turnIds);
  }

  function purgeUnreferencedHashes(candidateHashes = [], { preserveHashes = null } = {}) {
    if (!cacheDir || !existsSync(cacheDir)) return { deleted: 0, bytesFreed: 0 };
    const candidates = new Set(
      (Array.isArray(candidateHashes) || candidateHashes instanceof Set ? [...candidateHashes] : [])
        .map(item => String(item || '').trim())
        .filter(Boolean),
    );
    if (!candidates.size) return { deleted: 0, bytesFreed: 0 };

    const referenced = conversationStore?.referencedVoiceHashes?.() || new Set();
    const pinned = readPinnedHashes();
    const extraPreserve = preserveHashes instanceof Set ? preserveHashes : new Set(preserveHashes || []);
    let deleted = 0;
    let bytesFreed = 0;

    for (const hash of candidates) {
      if (!/^[a-zA-Z0-9_-]+$/.test(hash)) continue;
      if (referenced.has(hash) || pinned.has(hash) || extraPreserve.has(hash)) continue;
      for (const ext of ['wav', 'mp3']) {
        const filePath = join(cacheDir, `${hash}.${ext}`);
        try {
          const st = statSync(filePath);
          if (!st.isFile()) continue;
          unlinkSync(filePath);
          deleted += 1;
          bytesFreed += st.size;
        } catch {
          // 文件已不存在或无权时跳过
        }
      }
    }
    return { deleted, bytesFreed };
  }

  async function runSweep() {
    if (!cacheDir || !existsSync(cacheDir)) {
      return { scanned: 0, pinnedCount: 0, dialogueCount: 0, ephemeralDeleted: 0, dialogueDeleted: 0, bytesFreed: 0 };
    }
    mkdirSync(cacheDir, { recursive: true });

    let entries;
    try {
      entries = await readdir(cacheDir, { withFileTypes: true });
    } catch {
      return { scanned: 0, pinnedCount: 0, dialogueCount: 0, ephemeralDeleted: 0, dialogueDeleted: 0, bytesFreed: 0 };
    }

    const referenced = conversationStore?.referencedVoiceHashes?.() || new Set();
    const pinned = readPinnedHashes();
    const cutoff = now();
    const dialogueFiles = [];
    let scanned = 0;
    let pinnedCount = 0;
    let ephemeralDeleted = 0;
    let dialogueDeleted = 0;
    let bytesFreed = 0;
    let dialogueTotalBytes = 0;
    let processedInBatch = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = AUDIO_FILE_RE.exec(entry.name);
      if (!match) continue;
      scanned += 1;
      const hash = match[1];
      const filePath = join(cacheDir, entry.name);

      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue;
      }

      if (pinned.has(hash)) {
        pinnedCount += 1;
      } else if (referenced.has(hash)) {
        dialogueTotalBytes += st.size;
        dialogueFiles.push({ path: filePath, size: st.size, mtimeMs: st.mtimeMs });
      } else if (cutoff - st.mtimeMs > ephemeralTtlMs) {
        try {
          await unlink(filePath);
          ephemeralDeleted += 1;
          bytesFreed += st.size;
        } catch {
          // ignore race
        }
      }

      processedInBatch += 1;
      if (processedInBatch >= batchSize) {
        processedInBatch = 0;
        await yieldEventLoop();
      }
    }

    if (dialogueTotalBytes > dialogueMaxBytes && dialogueFiles.length > 0) {
      const evictable = dialogueFiles
        .filter(item => cutoff - item.mtimeMs > dialogueMinAgeMs)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

      for (const item of evictable) {
        if (dialogueTotalBytes <= dialogueMaxBytes) break;
        try {
          await unlink(item.path);
          dialogueDeleted += 1;
          bytesFreed += item.size;
          dialogueTotalBytes -= item.size;
        } catch {
          // ignore race
        }
        processedInBatch += 1;
        if (processedInBatch >= batchSize) {
          processedInBatch = 0;
          await yieldEventLoop();
        }
      }
    }

    return {
      scanned,
      pinnedCount,
      dialogueCount: dialogueFiles.length - dialogueDeleted,
      ephemeralDeleted,
      dialogueDeleted,
      bytesFreed,
    };
  }

  function sweep() {
    if (activeSweep) return activeSweep;
    activeSweep = runSweep()
      .catch(error => {
        logger?.warn?.(`[tts-lifecycle] sweep failed: ${error?.message || error}`);
        return null;
      })
      .finally(() => {
        activeSweep = null;
      });
    return activeSweep;
  }

  function scheduleSweep() {
    stop();
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void sweep();
    }, STARTUP_SWEEP_DELAY_MS);
    startupTimer.unref?.();

    periodicTimer = setInterval(() => {
      void sweep();
    }, sweepIntervalMs);
    periodicTimer.unref?.();
    return stop;
  }

  function stop() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  return {
    existsByUrl,
    touchByUrl,
    readPinnedHashes,
    purgeUnreferencedHashes,
    sweep,
    scheduleSweep,
    stop,
  };
}
