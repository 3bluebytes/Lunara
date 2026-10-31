import { isSongTagAutoEnabled } from '../songtags/songTagConfig.js';
import { getActiveModel } from '../llmProviders.js';
import { ServiceError } from './ServiceError.js';
import { providerOf } from '../songtags/songTagStore.js';
import { duplicatesOf, foldRecordingRows } from '../songtags/recordingListView.js';

// ---- 手动修正：字段白名单与校验（song-tag-inspection）----
const KNOWN_PROVIDERS = new Set(['ncm', 'qq', 'legacy']);
const TEMPOS = new Set(['slow', 'mid', 'fast']);
const TEXT_FIELDS = new Set(['language', 'genre', 'mood']);
const UNIT_FIELDS = new Set(['energy', 'valence', 'vocal_softness']);
const ARRAY_FIELDS = new Set(['themes', 'instruments', 'scenes']);
const MAX_LIST_ITEMS = 12;
const MAX_LIST_ITEM_CHARS = 40;

function invalid(message) {
  return new ServiceError(400, message, 'invalid_song_tag_patch');
}

/** 字符串字段：trim、限长；空串 → null（清除）。 */
function sanitizeText(value, label) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 60) throw invalid(`${label} 过长（最多 60 字）`);
  return text;
}

/** 0–1 数值字段：空值 → null；非数字或超范围 → 400。 */
function sanitizeUnit(value, label) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw invalid(`${label} 必须是 0 到 1 之间的数值`);
  return n;
}

/** 字符串数组字段：逗号/顿号分隔或数组；每项 trim 限长；空列表 → null（清除）。 */
function sanitizeList(value, label) {
  if (value == null || value === '') return null;
  const raw = Array.isArray(value) ? value : String(value).split(/[,，、;]/u);
  const items = raw.map(item => String(item ?? '').trim()).filter(Boolean);
  if (items.length > MAX_LIST_ITEMS) throw invalid(`${label} 最多 ${MAX_LIST_ITEMS} 项`);
  for (const item of items) {
    if (item.length > MAX_LIST_ITEM_CHARS) throw invalid(`${label} 单项过长（最多 ${MAX_LIST_ITEM_CHARS} 字）`);
  }
  return items.length ? items : null;
}

/**
 * 校验并收敛手动修改补丁：只保留白名单字段，非法值抛 400，白名单外字段忽略。
 * @returns {object} 收敛后的补丁（只含实际出现的可编辑字段）
 */
export function sanitizeTagPatch(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalid('补丁必须是对象');
  }
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (TEXT_FIELDS.has(key)) clean[key] = sanitizeText(value, key);
    else if (key === 'tempo') {
      if (value == null || value === '') { clean[key] = null; continue; }
      const tempo = String(value).trim().toLowerCase();
      if (!TEMPOS.has(tempo)) throw invalid('tempo 只能是 slow / mid / fast');
      clean[key] = tempo;
    }
    else if (UNIT_FIELDS.has(key)) clean[key] = sanitizeUnit(value, key);
    else if (key === 'has_vocal') {
      if (value == null || value === '') clean[key] = null;
      else if (typeof value === 'boolean') clean[key] = value;
      else if (value === 'true' || value === 1 || value === '1') clean[key] = true;
      else if (value === 'false' || value === 0 || value === '0') clean[key] = false;
      else throw invalid('has_vocal 只能是 true / false');
    }
    else if (key === 'year') {
      if (value == null || value === '') { clean[key] = null; continue; }
      const year = Number(value);
      if (!Number.isInteger(year) || year < 1000 || year > 3000) throw invalid('year 必须是合理范围内的整数');
      clean[key] = year;
    }
    else if (ARRAY_FIELDS.has(key)) clean[key] = sanitizeList(value, key);
    // 白名单外字段（title/artist/provider/song_id/confidence/source…）静默忽略。
  }
  if (Object.keys(clean).length === 0) throw invalid('没有可修改的标签字段');
  return clean;
}

/** 手动修改的身份校验：显式 (provider, songId)，不从 title/artist 猜。 */
function requireIdentity({ provider, songId } = {}) {
  const resolvedProvider = String(provider ?? '').trim().toLowerCase();
  if (!KNOWN_PROVIDERS.has(resolvedProvider)) throw invalid('provider 必须是 ncm / qq / legacy');
  const id = String(songId ?? '').trim();
  if (!id || id.length > 128) throw invalid('songId 不能为空');
  return { provider: resolvedProvider, songId: id };
}

export class SongTagAdminService {
  constructor({
    getStore,
    getRecordings = null,
    getCandidates,
    getQueueStats,
    providers = {},
    runBackfill,
    env = process.env,
    activeModel = getActiveModel,
    autoEnabled = isSongTagAutoEnabled,
    configStore = { save: () => {} },
  } = {}) {
    this.getStore = getStore;
    this.getRecordings = typeof getRecordings === 'function' ? getRecordings : null;
    this.getCandidates = getCandidates;
    this.getQueueStats = getQueueStats;
    this.providers = providers;
    this.runBackfill = runBackfill;
    this.env = env;
    this.activeModel = activeModel;
    this.autoEnabled = autoEnabled;
    this.configStore = configStore;
  }

  async status() {
    const store = this.getStore();
    const candidates = this.getCandidates();
    let tagged = 0;
    let placeholders = 0;
    let untagged = 0;
    for (const candidate of candidates) {
      const songId = candidate?.song_id != null ? String(candidate.song_id) : '';
      if (!songId) continue;
      const tags = store.getTags(songId, candidate?.provider ?? candidate?.source);
      if (!tags) untagged += 1;
      else if (Number(tags.confidence) > 0) tagged += 1;
      else placeholders += 1;
    }
    const poolSize = candidates.length;
    // 打标跟随应用的"使用中"模型（unified-model-providers），不暴露任何端点信息。
    const active = await this.activeModel();
    return {
      ok: true,
      auto: this.autoEnabled({ env: this.env }),
      activeModel: active ? { providerId: active.providerId, model: active.model } : null,
      model: active?.model || null,
      ttlDays: Number(this.env.SONG_TAG_TTL_DAYS) || 30,
      store: store.stats(),
      candidatePool: poolSize,
      coverageSource: 'candidates',
      coverage: {
        tagged,
        placeholders,
        untagged,
        pct: poolSize > 0 ? Math.round(tagged / poolSize * 100) : null,
      },
      queue: this.getQueueStats(),
    };
  }

  /** 打标配置（现在只有 auto 开关；端点统一到注册表）。 */
  async config() {
    return { ok: true, auto: this.autoEnabled({ env: this.env }) };
  }

  /** 保存配置补丁（只有 auto）；返回保存后的配置。 */
  async saveConfig(patch = {}) {
    this.configStore.save(patch || {});
    return this.config();
  }

  async backfill({ force = false, limit = 50 } = {}) {
    let ncmStatus = null;
    let qqStatus = null;
    [ncmStatus, qqStatus] = await Promise.all([
      this.providers.ncm.loginStatus().catch(() => ({ loggedIn: false })),
      this.providers.qq.loginStatus().catch(() => ({ loggedIn: false })),
    ]);
    const result = await this.runBackfill({
      force: Boolean(force),
      limit,
      ncmUid: ncmStatus?.loggedIn ? ncmStatus.userId : null,
      qqUid: qqStatus?.loggedIn ? qqStatus.userId : null,
    });
    return { ok: true, ...result, queue: this.getQueueStats() };
  }

  /** 标签库分页浏览（只读）：透传 store 的搜索/分页结果。 */
  list({ search, limit, offset } = {}) {
    const store = this.getStore();
    const result = store.listTags({ search, limit, offset });
    // 合并过的歌折成一行：同一首歌不该因为来自两个源就在列表里出现两次。
    const folded = foldRecordingRows(result.items, { recordings: this.getRecordings?.(), tagStore: store });
    const duplicates = folded.folded ? duplicatesOf(folded.items, store) : 0;
    return { ok: true, ...result, items: folded.items, total: Math.max(folded.items.length, result.total - duplicates), folded: folded.folded };
  }

  /** 手动修正一首歌的标签：白名单校验 → 合并现值 → 以 source='user'/confidence=1 落库。 */
  update({ provider, songId, patch } = {}) {
    const store = this.getStore();
    const identity = requireIdentity({ provider, songId });
    const clean = sanitizeTagPatch(patch);
    const tags = store.patchTags(identity.songId, {
      ...clean,
      source: 'user',
      confidence: 1,
      source_text: '手动修改',
    }, identity.provider);
    return { ok: true, tags };
  }

  /** 删除一首歌的标签行（缺行返 deleted=0，不报错）；删后可重新自动打标。 */
  remove({ provider, songId } = {}) {
    const store = this.getStore();
    const identity = requireIdentity({ provider, songId });
    const deleted = store.deleteTags(identity.songId, identity.provider);
    return { ok: true, deleted };
  }
}
