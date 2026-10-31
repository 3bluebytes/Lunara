// personaLoader.js — v2: 同步读取伙伴 persona markdown 文件
//
// memory-system-v2 change：persona 从 DB type=persona 迁出，每位伙伴一个 markdown 文件。
// 文件路径：`<数据根>/user/radiohost/<radiohostSlug>/persona.md`，经 runtimePaths.resolvePersonaRoot() 解析
// （默认 ~/.lunara/user/radiohost，LUNARA_RADIOHOST_DIR / LUNARA_DATA_DIR 可覆盖）。
//
// 接口契约（radiohost-persona-files spec）：
//   - 同步（不返 Promise），供 VirtualPersonRegistry 同步读取
//   - 5 分钟内存缓存，按 radiohostSlug 索引
//   - 文件不存在返 null（不抛）
//   - 文件 mtime 变化即穿透缓存重读

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePersonaRoot } from '../runtimePaths.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { content: string|null, loadedAt: number, mtime: number }>} */
const _cache = new Map();

/**
 * Resolve the absolute path for a radiohost's persona file.
 * @param {string} radiohostSlug
 * @returns {string}
 */
function personaPath(radiohostSlug) {
  return resolve(resolvePersonaRoot(), radiohostSlug, 'persona.md');
}

/**
 * Load radiohost persona markdown content (synchronous).
 *
 * @param {string} radiohostSlug - 通常等于 radiohostId（persona 文件约定：文件名 persona.md，位于人格根目录下）
 * @returns {string|null} markdown 全文，或 null（文件不存在 / 空文件）
 */
export function loadPersonaMarkdown(radiohostSlug) {
  if (!radiohostSlug) return null;
  const path = personaPath(radiohostSlug);

  // 检查缓存
  const cached = _cache.get(radiohostSlug);
  if (cached) {
    // 5 分钟内缓存命中且文件 mtime 没变
    const ageMs = Date.now() - cached.loadedAt;
    if (ageMs < CACHE_TTL_MS) {
      try {
        const currentMtime = existsSync(path) ? statSync(path).mtimeMs : 0;
        if (currentMtime === cached.mtime) {
          return cached.content;
        }
      } catch { /* fall through to re-read */ }
    }
  }

  // 读文件
  if (!existsSync(path)) {
    _cache.set(radiohostSlug, { content: null, loadedAt: Date.now(), mtime: 0 });
    return null;
  }

  try {
    const stat = statSync(path);
    const raw = readFileSync(path, 'utf8');
    const content = raw && raw.trim().length > 0 ? raw : null;
    _cache.set(radiohostSlug, { content, loadedAt: Date.now(), mtime: stat.mtimeMs });
    return content;
  } catch (e) {
    console.warn(`[persona] read failed for ${radiohostSlug}: ${e.message}`);
    return null;
  }
}

/**
 * Manually clear the cache (test/debug/force-reload endpoint).
 * @param {string} [radiohostSlug] - 不传则清全部
 */
export function clearPersonaCache(radiohostSlug) {
  if (radiohostSlug) _cache.delete(radiohostSlug);
  else _cache.clear();
}

/**
 * Delete a radiohost's persona file together with its cache entry.
 *
 * 删除伙伴时必须调用：不留这一步则文件系统会残留没有对应实体的人格文件（孤儿）。
 * 缓存必须先清，否则刚删掉的内容可能仍被读命。
 *
 * @param {string} radiohostSlug
 * @returns {boolean} 是否确实移除了文件
 */
export function deletePersonaMarkdown(radiohostSlug) {
  if (!radiohostSlug) return false;
  clearPersonaCache(radiohostSlug);
  const path = personaPath(radiohostSlug);
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch (e) {
    console.warn(`[persona] delete failed for ${radiohostSlug}: ${e.message}`);
    return false;
  }
}

export { personaPath };
export default { loadPersonaMarkdown, clearPersonaCache, deletePersonaMarkdown, personaPath };
