// songTagTools.js — 让伙伴 agent 能「查 / 改 / 删」一首歌的结构化标签。
//
// 起因（见 trace rq_0cf91883）：用户纠正"这三首是粤语不是国语"，伙伴却没有任何工具
// 把纠正落回 song_tags，只能干瞪眼。这里补上三件套：
//   get_song_tags     —— 读一首歌当前标签（排障 / 让伙伴先看清再决定怎么改）
//   correct_song_tags —— 局部纠正（只改传入字段，其余沿用；高置信 + source_text 标记来源）
//   delete_song_tags  —— 删一行（彻底重打：删掉后下次解析会重新走打标管线）
//
// 设计：
//   - song 定位使用 (provider, song_id)；裸 ID 仅兼容唯一存量记录。
//     没有 ID 时使用当前歌曲或 resolveTrack(query) 的 canonical 来源；歧义拒绝修改。
//   - 纠正字段走白名单 + 复用打标管线同一套归一化（normLanguage/normTempo/SCENE_CHOICES），
//     保证用户改进来的值跟 LLM 打进来的值在「检索端」长一个样，不会出现新 token。
//   - 纠正即高置信（≥0.9）+ source_text='user-correction'，并 bump updated_at →
//     TTL 内的增量 backfill 不会再覆盖。force 全量重打仍会覆盖（已知取舍）。
//   - 返回显式 ToolOutcome；定位/字段失败保留失败状态，原始解析异常不进入模型。
//   - deps 注入（store / resolveTrack）方便离线单测。

import * as musicResolver from '../musicResolver.js';
import { providerRegistry } from '../music/providerRegistry.js';
import { getSongTagStore } from '../songtags/songTagStore.js';
import { SCENE_CHOICES, normLanguage, normTempo } from '../songtags/songTagGenerator.js';
import { toolSuccess, toolFailure } from './ToolOutcome.js';

// ---- 本地归一化小工具（与 generator 同义，避免过度导出内部实现）----
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
function asStr(v) {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}
function asArray(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return [String(v).trim()].filter(Boolean);
}
function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', '是', '有', '有人声', 'vocal'].includes(s)) return true;
  if (['false', '0', 'no', '否', '没有', '无', '纯音乐', 'instrumental'].includes(s)) return false;
  return null;
}
function toYear(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const y = Math.trunc(n);
  return y >= 1900 && y <= 2100 ? y : null;
}

// 可纠正字段白名单 → 归一化函数。不在表里的键一律忽略（防 agent 乱塞列）。
const FIELD_NORMALIZERS = {
  language: normLanguage,          // 认不出 → null（拒绝写）
  mood: asStr,
  genre: asStr,
  tempo: normTempo,                // 非 slow/mid/fast → null（拒绝写）
  energy: clamp01,
  valence: clamp01,
  has_vocal: toBool,
  vocal_softness: clamp01,
  scenes: v => asArray(v).filter(s => SCENE_CHOICES.includes(s)),
  themes: asArray,
  instruments: asArray,
  year: toYear,
};
const ARRAY_FIELDS = new Set(['scenes', 'themes', 'instruments']);

// ---- 定位 song：优先 song_id，其次 resolveTrack(query) ----
async function _resolveSong(args, resolveTrack, currentTrack = () => null, store, { mutation = false } = {}) {
  const songId = args?.song_id != null ? String(args.song_id).trim() : '';
  const query = String(args?.query || '').trim();
  const provider = args?.provider || null;
  if (provider && !providerRegistry.isPlayable(provider)) return { error: '请选择已接入的音乐源。', code: 'INVALID_TAG_PROVIDER' };
  if (songId) {
    if (provider) return { song_id: songId, title: query || null, artist: null, source: provider };
    const identities = store.identitiesForSong(songId);
    if (identities.length > 1) return { error: '多个音乐源有这个歌曲 ID，请指定 provider。', code: 'AMBIGUOUS_TAG_TARGET' };
    if (identities.length === 1) return { ...identities[0], source: identities[0].provider };
    if (mutation) return { error: '无法确认这个歌曲 ID 的音乐源，请指定 provider。', code: 'TAG_TARGET_UNAVAILABLE' };
    return { song_id: songId, source: null };
  }
  if (!query) {
    let current = null;
    try { current = currentTrack?.() || null; } catch { current = null; }
    if (current?.song_id != null) {
      const source = String(current.provider || current.source || '').split(/[:-]/)[0];
      if (!providerRegistry.isPlayable(source) || (provider && provider !== source)) {
        return { error: '当前歌曲的音乐源未能确认，请指定歌曲 ID 和音乐源。', code: 'TAG_TARGET_UNAVAILABLE' };
      }
      return {
        song_id: String(current.song_id),
        title: current.title || null,
        artist: current.artist || null,
        source,
      };
    }
    return { error: '现在没有正在播放的歌；请提供 song_id 或 query（歌名 / "艺人 歌名"）。', code: 'TAG_TARGET_UNAVAILABLE' };
  }
  let r;
  try {
    r = await resolveTrack(query);
  } catch {
    return { error: '暂时无法确认这首歌，请稍后重试。', code: 'TAG_RESOLUTION_FAILED' };
  }
  if (!r?.ok || r.song_id == null) return { error: `没找到这首歌："${query}"`, code: 'TAG_TARGET_UNAVAILABLE' };
  const source = String(r.provider || r.source || '').split(/[:-]/)[0];
  if (!providerRegistry.isPlayable(source) || (provider && source !== provider)) {
    return { error: '没有确认到指定音乐源的歌曲，请提供歌曲 ID 和音乐源。', code: 'TAG_TARGET_UNAVAILABLE' };
  }
  return {
    song_id: String(r.song_id),
    title: r.title || query,
    artist: r.artist || null,
    source,
  };
}

// ---- 把标签渲染成一行紧凑文本（给 agent 转述用）----
function formatTags(t) {
  if (!t) return '(无)';
  const parts = [];
  const push = (k, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) parts.push(`${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`); };
  push('语言', t.language);
  push('情绪', t.mood);
  push('曲风', t.genre);
  push('节奏', t.tempo);
  if (t.energy != null) push('能量', Number(t.energy).toFixed(2));
  if (t.valence != null) push('愉悦', Number(t.valence).toFixed(2));
  if (t.has_vocal != null) push('人声', t.has_vocal ? '是' : '否');
  if (t.vocal_softness != null) push('柔和', Number(t.vocal_softness).toFixed(2));
  push('场景', t.scenes);
  push('主题', t.themes);
  push('乐器', t.instruments);
  push('年代', t.year);
  if (t.confidence != null) push('置信', Number(t.confidence).toFixed(2));
  return parts.length ? parts.join(' ') : '(空标签)';
}

/**
 * get_song_tags：读一首歌的当前标签。
 * @param {{provider?:string, song_id?:string, query?:string}} args
 * @param {{store?:object, resolveTrack?:function}} [deps]
 * @returns {Promise<object>} 显式 ToolOutcome，可转换为展示文本。
 */
export async function getSongTags(args, deps = {}) {
  const store = deps.store || getSongTagStore();
  const resolveTrack = deps.resolveTrack || musicResolver.resolveTrack;
  const loc = await _resolveSong(args, resolveTrack, deps.currentTrack, store);
  if (loc.error) return toolFailure(loc.error, { code: loc.code });

  const tags = store.getTags(loc.song_id, loc.source || undefined);
  if (!tags) return toolSuccess(`这首歌（song_id=${loc.song_id}）还没打标。`, { provider: loc.source, songId: loc.song_id, tags: null });
  const tip = Number(tags.confidence) > 0 ? '' : '（注：confidence=0，是占位行，尚未真正打上标）';
  return toolSuccess(`song_id=${loc.song_id} 当前标签：${formatTags(tags)}${tip ? ` ${tip}` : ''}`, { provider: loc.source, songId: loc.song_id, tags });
}

/**
 * correct_song_tags：局部纠正一首歌的标签（只改传入字段，其余沿用）。
 * @param {object} args - { song_id?|query?, language?, mood?, genre?, tempo?, energy?, valence?,
 *                          has_vocal?, vocal_softness?, scenes?, themes?, instruments?, year? }
 * @param {{store?:object, resolveTrack?:function}} [deps]
 * @returns {Promise<object>} 显式 ToolOutcome，可转换为展示文本。
 */
export async function correctSongTags(args, deps = {}) {
  const store = deps.store || getSongTagStore();
  const resolveTrack = deps.resolveTrack || musicResolver.resolveTrack;
  const loc = await _resolveSong(args, resolveTrack, deps.currentTrack, store, { mutation: true });
  if (loc.error) return toolFailure(loc.error, { code: loc.code });

  const patch = {};
  const applied = [];
  const rejected = [];
  for (const [field, normalize] of Object.entries(FIELD_NORMALIZERS)) {
    if (!(field in (args || {}))) continue; // 没传 → 不动
    const raw = args[field];
    const norm = normalize(raw);
    if (ARRAY_FIELDS.has(field)) {
      const wantsClear = Array.isArray(raw) && raw.length === 0;
      if (norm.length === 0 && !wantsClear) {
        rejected.push(`${field}=${JSON.stringify(raw)}`); // 给了值但全非法（如 scenes 不在白名单）
      } else {
        patch[field] = norm; applied.push(field);
      }
    } else if (norm == null) {
      rejected.push(`${field}=${JSON.stringify(raw)}`); // 标量归一化失败（如 language 认不出 / tempo 非法）
    } else {
      patch[field] = norm; applied.push(field);
    }
  }

  if (!applied.length) {
    const why = rejected.length ? `传入的字段都没法接受：${rejected.join('、')}。` : '没有可纠正的字段。';
    return toolFailure(`${why} 可改字段：language / mood / genre / tempo(slow|mid|fast) / energy / valence / has_vocal / vocal_softness / scenes(${SCENE_CHOICES.join('|')}) / themes / instruments / year。`, { code: 'INVALID_TAG_CORRECTION' });
  }

  // 起新行时补上身份字段（已有行不动其 title/artist）。
  const existing = store.getTags(loc.song_id, loc.source || undefined);
  if (!existing) {
    if (loc.title) patch.title = loc.title;
    if (loc.artist) patch.artist = loc.artist;
    if (loc.source) patch.source = loc.source;
  }
  // 用户纠正 = 高置信 + 标记来源；bump updated_at（TTL 内增量 backfill 不再覆盖）。
  patch.confidence = Math.max(Number(existing?.confidence) || 0, 0.9);
  patch.source_text = 'user-correction';

  const before = existing ? formatTags(existing) : '(原本未打标)';
  const after = store.patchTags(loc.song_id, patch, loc.source || undefined);
  const tail = rejected.length ? `（忽略非法字段：${rejected.join('、')}）` : '';
  return toolSuccess(`已纠正 song_id=${loc.song_id} 的 ${applied.join('、')}。${tail}\n改前：${before}\n改后：${formatTags(after)}`, { provider: loc.source, songId: loc.song_id, changed: true });
}

/**
 * delete_song_tags：删掉一首歌的标签行（下次解析会重新打标）。
 * @param {{provider?:string, song_id?:string, query?:string}} args
 * @param {{store?:object, resolveTrack?:function}} [deps]
 * @returns {Promise<object>} 显式 ToolOutcome，可转换为展示文本。
 */
export async function deleteSongTags(args, deps = {}) {
  const store = deps.store || getSongTagStore();
  const resolveTrack = deps.resolveTrack || musicResolver.resolveTrack;
  const loc = await _resolveSong(args, resolveTrack, deps.currentTrack, store, { mutation: true });
  if (loc.error) return toolFailure(loc.error, { code: loc.code });

  const n = store.deleteTags(loc.song_id, loc.source || undefined);
  return toolSuccess(n > 0
    ? `已删除 song_id=${loc.song_id} 的标签行。下次该歌被解析时会重新打标。`
    : `song_id=${loc.song_id} 本来就没有标签行，无需删除。`, { provider: loc.source, songId: loc.song_id, changed: n > 0 });
}

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_song_tags',
      description: '查一首歌当前的结构化标签（语言/情绪/曲风/场景等）。不传 song_id/query 时默认当前播放歌曲；指定其他歌曲时优先传 song_id，没有就传 query。',
      parameters: {
        type: 'object',
        properties: {
          song_id: { type: 'string', description: '歌曲 ID（最精确，优先用）' },
          query: { type: 'string', description: '没有 song_id 时的歌曲查询，如"陈奕迅 浮夸"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correct_song_tags',
      description: '纠正一首歌的标签（只改传入字段，其余保留）。不传 song_id/query 时默认当前播放歌曲；指定其他歌曲时再传定位信息。language 用 mandarin/cantonese/english/japanese/korean/instrumental；tempo 用 slow/mid/fast；energy/valence/vocal_softness 是 0~1。',
      parameters: {
        type: 'object',
        properties: {
          song_id: { type: 'string', description: '歌曲 ID（最精确，优先用）' },
          query: { type: 'string', description: '没有 song_id 时的歌曲查询' },
          language: { type: 'string', description: '演唱语言：mandarin/cantonese/english/japanese/korean/instrumental' },
          mood: { type: 'string', description: '情绪，一个词（如 治愈/激昂/忧郁）' },
          genre: { type: 'string', description: '曲风，一个词（如 流行/摇滚/民谣）' },
          tempo: { type: 'string', enum: ['slow', 'mid', 'fast'], description: '节奏体感' },
          energy: { type: 'number', description: '能量 0~1（0 极安静，1 极强烈）' },
          valence: { type: 'number', description: '情绪正负 0~1（0 悲伤，1 愉悦）' },
          has_vocal: { type: 'boolean', description: '是否有人声（纯音乐为 false）' },
          vocal_softness: { type: 'number', description: '人声柔和度 0~1（0 嘶吼，1 极轻柔）' },
          scenes: { type: 'array', items: { type: 'string' }, description: `适合场景，只能从 [${SCENE_CHOICES.join(', ')}] 里选` },
          themes: { type: 'array', items: { type: 'string' }, description: '主题数组（如 ["爱情","乡愁"]）' },
          instruments: { type: 'array', items: { type: 'string' }, description: '主要乐器数组（如 ["钢琴","弦乐"]）' },
          year: { type: 'number', description: '发行年份（1900~2100）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_song_tags',
      description: '删掉一首歌的全部标签。仅当标签整体明显错乱、改单个字段不划算时用。不传 song_id/query 时默认当前播放歌曲；指定其他歌曲时再传定位信息。',
      parameters: {
        type: 'object',
        properties: {
          song_id: { type: 'string', description: '歌曲 ID（最精确，优先用）' },
          query: { type: 'string', description: '没有 song_id 时的歌曲查询' },
        },
      },
    },
  },
];

for (const definition of TOOL_DEFS) {
  definition.function.parameters.properties.provider = { type: 'string', enum: providerRegistry.defaultSourceCandidates(),
    description: '歌曲音乐源；提供 song_id 时一并指定，避免不同源的同 ID 歌曲混淆。' };
}
