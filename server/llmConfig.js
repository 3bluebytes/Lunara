// llmConfig.js — Lunara 的单一 LLM endpoint 配置入口。
//
// 密钥不属于工程数据：默认写到 ~/.lunara/config.json。LUNARA_CONFIG_DIR
// 可覆盖目录；CLAUDIO_CONFIG_DIR 仅作为一版 legacy fallback。所有调用均即时
// 读文件，因而设置保存后无需重启即可生效。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveModelEndpoint } from './llmProviders.js';
import { readConfigDocument, withConfigLock, writeConfigDocument } from './configLock.js';

const EMPTY_CONFIG = Object.freeze({ baseUrl: '', apiKey: '', model: '' });

export function getLLMConfigDir() {
  return process.env.LUNARA_CONFIG_DIR
    || process.env.CLAUDIO_CONFIG_DIR
    || join(homedir(), '.lunara');
}

export function getLLMConfigPath() {
  return join(getLLMConfigDir(), 'config.json');
}

function normalizeConfig(value = {}) {
  return {
    baseUrl: String(value.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(value.apiKey || '').trim(),
    model: String(value.model || '').trim(),
  };
}

function getLegacyLLMConfigPath() {
  return join(process.env.CLAUDIO_CONFIG_DIR || join(homedir(), '.claudio'), 'config.json');
}

async function readConfigAt(path) {
  const document = await readConfigDocument(path);
  const llm = document?.llm;
  if (!llm || typeof llm !== 'object') return null;
  return normalizeConfig(llm);
}

export async function getLLMConfig() {
  const currentPath = getLLMConfigPath();
  const current = await readConfigAt(currentPath);
  if (current) return current;

  // 新路径为空时，读取旧配置并复制到新路径。旧文件不删除，便于回滚。
  const legacyPath = getLegacyLLMConfigPath();
  if (legacyPath !== currentPath) {
    const legacy = await readConfigAt(legacyPath);
    if (legacy) {
      // 锁内重查：并发的注册表写入可能刚好补上了 llm，不能把它的新值盖回旧值。
      await withConfigLock(currentPath, async () => {
        const raw = await readConfigDocument(currentPath);
        if (raw.llm) return;
        await writeConfigDocument(currentPath, { ...raw, llm: legacy });
      });
      return legacy;
    }
  }
  return { ...EMPTY_CONFIG };
}

export async function isConfigured() {
  return Boolean(await resolveModelEndpoint({}));
}

/** 公共视图：使用中模型的 baseUrl/model（注册表派生）；ready = 有可解析的使用中模型。 */
export async function getPublicLLMConfig() {
  const [endpoint, config] = await Promise.all([resolveModelEndpoint({}), getLLMConfig()]);
  return {
    baseUrl: endpoint?.baseUrl || '',
    model: endpoint?.model || '',
    apiKeySet: Boolean(endpoint?.apiKey || (!endpoint && config.apiKey)),
    ready: Boolean(endpoint),
  };
}

export async function setLLMConfig(update = {}) {
  const path = getLLMConfigPath();
  return withConfigLock(path, async () => {
    const raw = await readConfigDocument(path);
    // 同一个键里有 legacy 三元组；apiKey 留空时保留现值（含只在旧路径里的值）。
    const previous = raw.llm && typeof raw.llm === 'object'
      ? normalizeConfig(raw.llm)
      : (await readConfigAt(getLegacyLLMConfigPath()) || { ...EMPTY_CONFIG });
    const next = normalizeConfig({
      baseUrl: update.baseUrl,
      apiKey: String(update.apiKey || '').trim() || previous.apiKey,
      model: update.model,
    });
    // 保留 modelProviders/activeModel 等不属于本次更新的字段：legacy 保存不能清空注册表。
    await writeConfigDocument(path, { ...raw, llm: next });
    return next;
  });
}
