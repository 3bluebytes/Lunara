// songTagConfig.js — 歌曲打标的用户级开关（unified-model-providers 后端点统一到注册表）。
//
// 持久化在 `~/.lunara/song-tag.json`（0600，LUNARA_CONFIG_DIR 约定）。
// unified-model-providers 之后这里只剩 `auto` 开关：打标模型跟随应用的"使用中"模型
// （见 llmProviders.js），本文件不再保存任何端点信息（旧文件里的 baseUrl/model 字段
// 读取时被忽略）。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLLMConfigDir } from '../llmConfig.js';

const CONFIG_FILE = 'song-tag.json';

function configPath() {
  return join(getLLMConfigDir(), CONFIG_FILE);
}

function sanitize(config) {
  return { auto: Boolean(config?.auto) };
}

let _cache = null;

export function readSongTagConfig() {
  if (_cache) return _cache;
  try {
    _cache = sanitize(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    _cache = { auto: false };
  }
  return _cache;
}

export function saveSongTagConfig(patch = {}) {
  const current = readSongTagConfig();
  const next = sanitize({ ...current, auto: patch?.auto != null ? Boolean(patch.auto) : current.auto });
  writeConfig(next);
  return next;
}

function writeConfig(config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  rmSync(path, { force: true });
  renameSync(temp, path);
  _cache = config;
}

/** 自动打标开关：显式 env 双向覆盖；env 未设置时以持久化 auto 为准。 */
export function isSongTagAutoEnabled({ env = process.env } = {}) {
  const raw = env?.SONG_TAG_AUTO;
  if (raw === '1') return true;
  if (raw != null && raw !== '') return false;
  return readSongTagConfig().auto;
}

export function resetSongTagConfigForTest() {
  _cache = null;
}
