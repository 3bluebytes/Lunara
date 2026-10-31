// context.js — 提示词组装
// 第三层那个「组装盒子」：把 6 片粘成一个 prompt。

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as state from './state.js';
import * as envMod from './env.js';
import * as ncm from './ncm.js';
import * as candidates from './candidates.js';
import { appendAnnotation } from './songtags/songTagRetrieval.js';
import { resolveDataRoot, resolvePackageRoot } from './runtimePaths.js';

// 双锚点：prompts 随安装分发锚包根；user/* 是运行期状态锚数据根。
const PACKAGE_ROOT = resolvePackageRoot();
const DATA_ROOT = () => resolveDataRoot();

async function readSafe(path, fallback = '') {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
}

let _cache = { ts: 0, files: null };

async function loadFiles() {
  // 5 分钟内复用
  if (_cache.files && Date.now() - _cache.ts < 5 * 60 * 1000) return _cache.files;
  const dataRoot = DATA_ROOT();
  const [persona, taste, routines, mood, noGo, playlists] = await Promise.all([
    readSafe(resolve(PACKAGE_ROOT, 'prompts/radiohost-persona.md')),
    readSafe(resolve(dataRoot, 'user/taste.md')),
    readSafe(resolve(dataRoot, 'user/routines.md')),
    readSafe(resolve(dataRoot, 'user/mood-rules.md')),
    readSafe(resolve(dataRoot, 'user/no-go.md')),
    readSafe(resolve(dataRoot, 'user/playlists.json'), '{}'),
  ]);
  _cache = { ts: Date.now(), files: { persona, taste, routines, mood, noGo, playlists } };
  return _cache.files;
}

export function invalidateCache() { _cache = { ts: 0, files: null }; }

// 候选池序列化：超字符预算时按"当前小时 hash"做稳定抽样，
// liked/playlist/daily 三类按比例保留。
// banned 过滤：最近 14 天 outcome=banned 的 song_id 集合排除掉。
export function serializeCandidates(list, budget = 4000) {
  if (!list || !list.length) return '(无 —— 未登录或网易云不可用)';

  const banned = new Set();
  try {
    const since = Date.now() - 14 * 24 * 3600 * 1000;
    for (const row of state.bannedSongIdsSince(since)) banned.add(String(row.song_id));
  } catch {} // state 没装这函数也不至于挂

  const filtered = list.filter(t => !banned.has(t.song_id));
  if (!filtered.length) return '(无可用候选 —— 都被你拉黑过)';

  // 每行附带结构化标签注解 `[mood:.. energy:.. ...]`（无 tag 的歌为普通行）
  const fmt = t => appendAnnotation(`- ${t.title || '?'} — ${t.artist || '?'} [${t.source || '?'}]`, t);

  // 不超预算直接全量
  let all = filtered.map(fmt).join('\n');
  if (all.length <= budget) return all;

  // 超预算：按当前小时 hash 稳定抽样，三类按比例（不分 provider，同一 bucket 的 ncm+qq 做同一个池）
  const buckets = { liked: [], playlist: [], daily: [] };
  for (const t of filtered) {
    if (t.source?.endsWith(':liked')) buckets.liked.push(t);
    else if (t.source?.includes(':playlist:')) buckets.playlist.push(t);
    else buckets.daily.push(t);
  }
  const total = filtered.length;
  const lines = [];
  const hour = Math.floor(Date.now() / (3600 * 1000));
  const seed = hour;

  // 给每个 bucket 按比例分预算（按行数估算）
  const avgLine = Math.max(20, Math.floor(all.length / total)) + 1;
  const maxLines = Math.floor(budget / avgLine);
  const quota = {
    liked:    Math.max(1, Math.round(maxLines * (buckets.liked.length    / total))),
    playlist: Math.max(1, Math.round(maxLines * (buckets.playlist.length / total))),
    daily:    Math.max(1, Math.round(maxLines * (buckets.daily.length    / total))),
  };

  const sample = (arr, n, salt) => {
    if (arr.length <= n) return arr;
    const scored = arr.map((it, i) => ({
      it,
      // 稳定哈希：同一小时内同样的输入返回同样的样本
      h: parseInt(createHash('md5').update(`${seed}|${salt}|${it.song_id}|${i}`).digest('hex').slice(0, 8), 16),
    }));
    scored.sort((a, b) => a.h - b.h);
    return scored.slice(0, n).map(s => s.it);
  };

  for (const k of ['liked', 'playlist', 'daily']) {
    for (const t of sample(buckets[k], quota[k], k)) lines.push(fmt(t));
  }

  // 装一遍后还可能略超 —— 硬截
  let out = lines.join('\n');
  if (out.length > budget) out = out.slice(0, budget).replace(/\n[^\n]*$/, '');
  return out || '(候选池过大被压缩为空)';
}

/**
 * 组装一个 prompt 字符串。
 * @param {object} opts
 * @param {string} opts.userInput
 * @param {'chat'|'morning'|'mood-check'|'segue'} [opts.kind]
 * @returns {Promise<string>}
 */
export async function build(opts) {
  const { userInput = '', kind = 'chat' } = opts;
  const f = await loadFiles();
  // context.build 现在仅作 agent 的 fallback 用。正常聊天走 agent.run，不经过此处。

  const userName = process.env.USER_DISPLAY_NAME || 'friend';

  const prompt = f.persona
    .replaceAll('{{userName}}', userName)
    .replace('{{taste}}', f.taste || '(empty)')
    .replace('{{routines}}', f.routines || '(empty)')
    .replace('{{mood_rules}}', f.mood || '(empty)')
    .replace('{{no_go}}', f.noGo || '(empty)')
    .replace('{{playlists}}', f.playlists || '{}')
    .replace('{{candidates}}', '(agent mode)')
    .replace('{{environment}}', '(agent mode)')
    .replace('{{recent_plays}}', '(agent mode)')
    .replace('{{recent_messages}}', '(agent mode)')
    .replace('{{user_input}}', `kind=${kind}\n${userInput || '(none)'}`);

  return prompt;
}

export default { build, invalidateCache };
