// ttsFallbackConfig.js — 免费声音开关与「主声音失败时代读」的用户配置。
//
// 持久化到 `~/.lunara/tts-fallback.json`（0600，目录与 tts-custom.json 相同）：
//   { version:1, freeVoicesEnabled, consentAt, fallbackEnabled, fallbackTarget }
// freeVoicesEnabled 为 false 时不注册 free-edge，不向微软发送任何文字。从关到开必须带
// 本次的知情确认（consent:true），并记下确认时间；说明文字固定在设置页，不由模型生成。
// fallbackTarget 只有两种形状：
//   { providerId:'free-edge', voiceId:'zh-CN-…' }  一把 Edge 免费声音
//   { profileId:'vp_cx_…' }                        声音池里保留的任意一把
// 文件里不含 key 或文本，读接口可以原样返回。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLLMConfigDir } from './llmConfig.js';

const CONFIG_FILE = 'tts-fallback.json';
const FREE_EDGE_ID = 'free-edge';
const DEFAULT_TARGET = Object.freeze({ providerId: FREE_EDGE_ID, voiceId: 'zh-CN-XiaoxiaoNeural' });
const EDGE_VOICE_PATTERN = /^[a-z]{2,3}-[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8})?-[A-Za-z0-9]+Neural$/;
const PROFILE_ID_PATTERN = /^vp_cx_[0-9a-f]{8}$/;

const defaults = () => ({ version: 1, freeVoicesEnabled: false, consentAt: null, fallbackEnabled: false, fallbackTarget: null });
const configPath = () => join(getLLMConfigDir(), CONFIG_FILE);

/** 合法目标返回规范化副本，不合法返回 undefined（null 表示"未选"）。 */
function normalizeTarget(target) {
  if (target === null) return null;
  if (!target || typeof target !== 'object') return undefined;
  if (target.profileId !== undefined) {
    const profileId = String(target.profileId).trim();
    return PROFILE_ID_PATTERN.test(profileId) ? { profileId } : undefined;
  }
  const voiceId = String(target.voiceId || '').trim();
  return target.providerId === FREE_EDGE_ID && EDGE_VOICE_PATTERN.test(voiceId) ? { providerId: FREE_EDGE_ID, voiceId } : undefined;
}

function sanitize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const consentAt = typeof raw.consentAt === 'string' && !Number.isNaN(Date.parse(raw.consentAt)) ? raw.consentAt : null;
  return {
    ...base,
    // 没有确认时间的"已开启"按未开启处理：手改文件不能绕过知情确认。
    freeVoicesEnabled: raw.freeVoicesEnabled === true && Boolean(consentAt),
    consentAt,
    fallbackEnabled: raw.fallbackEnabled === true,
    fallbackTarget: normalizeTarget(raw.fallbackTarget) ?? null,
  };
}

let _cache = null;

export function readTtsFallbackConfig() {
  if (_cache) return _cache;
  try {
    _cache = sanitize(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    _cache = defaults();
  }
  return _cache;
}

/**
 * 部分更新。从关到开要求 consent:true；第一次开启且还没选目标时，代读默认开、目标默认晓晓。
 * 不合法的输入抛错，不写文件。
 */
export function saveTtsFallbackConfig(patch = {}, { now = Date.now } = {}) {
  const current = readTtsFallbackConfig();
  const next = { ...current };
  if (patch.freeVoicesEnabled !== undefined) {
    const enable = patch.freeVoicesEnabled === true;
    if (enable && !current.freeVoicesEnabled) {
      if (patch.consent !== true) throw new TypeError('开启免费声音前需要先阅读说明并确认。');
      next.consentAt = new Date(now()).toISOString();
      if (!current.fallbackTarget) {
        next.fallbackEnabled = true;
        next.fallbackTarget = { ...DEFAULT_TARGET };
      }
    }
    next.freeVoicesEnabled = enable;
  }
  if (patch.fallbackEnabled !== undefined) next.fallbackEnabled = patch.fallbackEnabled === true;
  if (patch.fallbackTarget !== undefined) {
    const target = normalizeTarget(patch.fallbackTarget);
    if (target === undefined) throw new TypeError('代读目标只能是一把免费声音或声音池里的声音。');
    next.fallbackTarget = target;
  }
  writeConfig(next);
  return next;
}

/** 此刻真正生效的代读目标：代读关闭、没选目标，或目标是 Edge 但免费声音没开时为 null。 */
export function effectiveFallbackTarget(config = readTtsFallbackConfig()) {
  if (!config.fallbackEnabled || !config.fallbackTarget) return null;
  if (config.fallbackTarget.providerId === FREE_EDGE_ID && !config.freeVoicesEnabled) return null;
  return { ...config.fallbackTarget };
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

/** 仅供测试：清空模块级缓存。 */
export function resetTtsFallbackConfigForTest() {
  _cache = null;
}
