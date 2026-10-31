// runtimePaths.js — 产品级运行路径的唯一解析入口。
// LUNARA_* 为当前契约；CLAUDIO_* 仅保留一版只读 fallback，禁止新调用方主动写入。
// 例外：旧人格目录的 CLAUDIO fallback 已随术语硬切换移除，不再有任何只读兼容。
//
// 双锚点（add-cli-launch-data-dir）：包根 = 代码（pwa/prompts/electron），
// 数据根 = 状态（data/user/cache）。默认数据根是 ~/.lunara；
// LUNARA_DATA_DIR 可整体覆盖（CLI 的 --data-dir 写入同一变量）。
// 每路径 env（LUNARA_DB_PATH 等）优先于 LUNARA_DATA_DIR 推导；
// 相对 env 值相对数据根解析（历史行为曾锚 cwd，属静默破坏性变更，故告警）。

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveOverride(primaryName, legacyName, fallback) {
  const value = process.env[primaryName] || process.env[legacyName] || fallback;
  if (isAbsolute(value)) return resolve(value);
  const resolved = resolve(resolveDataRoot(), value);
  // 相对值从锚 cwd 改锚数据根是静默破坏性变更：存量 .env 开发者会被指向新空库
  // 且显式覆盖会跳过自动迁移，warn 实际解析路径是最低限度保护。
  console.warn(`[runtime-paths] ${primaryName || legacyName} 为相对路径，已相对数据根解析: ${resolved}（数据根: ${resolveDataRoot()}）`);
  return resolved;
}

/** 数据根：所有运行期状态（data/user/cache/backup）的根。 */
export function resolveDataRoot() {
  return resolve(process.env.LUNARA_DATA_DIR || join(homedir(), '.lunara'));
}

/** 包根：随安装分发的代码资产（pwa/prompts/electron）根。 */
export function resolvePackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function resolveDatabasePath(fallback = resolve(resolveDataRoot(), 'data/state.db')) {
  return resolveOverride('LUNARA_DB_PATH', 'CLAUDIO_DB_PATH', fallback);
}

export function resolvePersonaRoot(fallback = resolve(resolveDataRoot(), 'user/radiohost')) {
  const value = process.env.LUNARA_RADIOHOST_DIR || fallback;
  if (isAbsolute(value)) return resolve(value);
  // 与 resolveOverride 同语义：相对值相对数据根解析，并告警实际路径。
  const resolved = resolve(resolveDataRoot(), value);
  console.warn(`[runtime-paths] LUNARA_RADIOHOST_DIR 为相对路径，已相对数据根解析: ${resolved}（数据根: ${resolveDataRoot()}）`);
  return resolved;
}

/**
 * 合成音频缓存目录。
 *
 * 可覆盖是必需的：测试需要隔离产物，否则会把合成结果写进仓库的 cache/。
 * 静态服务把该目录挂到 /tts，因此返回值必须与 server/index.js 的挂载点一致。
 */
export function resolveTtsCacheDir(fallback = resolve(resolveDataRoot(), 'cache/tts')) {
  return resolveOverride('LUNARA_TTS_CACHE_DIR', 'CLAUDIO_TTS_CACHE_DIR', fallback);
}

/**
 * 历史模型目录的兼容解析（用于旧数据根/迁移/回滚；当前无模型加载消费者）。
 * 保留旧环境变量和路径，不代表仍提供本地模型适配，也不自动删除用户文件。
 */
export function resolveTtsModelDir(fallback = resolve(resolveDataRoot(), 'cache/tts-models')) {
  return resolveOverride('LUNARA_TTS_MODEL_DIR', 'CLAUDIO_TTS_MODEL_DIR', fallback);
}

/** 下载音频缓存（ncm/qq cacheAudio 共用），锚数据根。 */
export function resolveAudioCacheDir() {
  return resolve(resolveDataRoot(), 'cache/audio');
}

/**
 * 会话执行记录目录（私有 JSONL）。
 *
 * 与合成缓存同理可覆盖：测试必须写进隔离目录，否则会把真实会话记录污染进仓库或 home。
 */
export function resolveSessionTraceDir(fallback = resolve(resolveDataRoot(), 'sessions')) {
  return resolveOverride('LUNARA_SESSION_TRACE_DIR', null, fallback);
}

/**
 * 任务执行记录目录（私有 JSONL，如模型能力探测等无会话任务）。
 * 锚数据根 tasks/，可通过 LUNARA_TASK_TRACE_DIR 覆盖。
 */
export function resolveTaskTraceDir(fallback = resolve(resolveDataRoot(), 'tasks')) {
  return resolveOverride('LUNARA_TASK_TRACE_DIR', null, fallback);
}

/** 提供商图片缓存（/img 静态挂载），锚数据根。 */
export function resolveImageCacheDir() {
  return resolve(resolveDataRoot(), 'cache/img');
}

export default {
  resolveDatabasePath,
  resolveDataRoot,
  resolvePackageRoot,
  resolveAudioCacheDir,
  resolveImageCacheDir,
  resolvePersonaRoot,
  resolveSessionTraceDir,
  resolveTaskTraceDir,
  resolveTtsCacheDir,
  resolveTtsModelDir,
};
