// recommendationDecisions.js — 推荐决策账本（ground-music-selection-in-taste D9）。
//
// 调用顺序：
//   commit_music_selection 成功 → MusicSelectionService._commit → store.record(rows)
//   runtime 接受的状态转换 → RecommendationOutcomeBridge → classifyPlaybackTransition → store.applyOutcome
//
// Python 伪代码：
//   rows = [decision_row(index, track, occurrence) for index, track in adopted]
//   store.record(rows)                       # 提交失败不会走到这里
//   on_runtime_transition(next, event, prev):
//       r = classify(next, event, prev)
//       if r: store.apply_outcome(r.track.queue_item_id, r.outcome)   # 只按 occurrence 回填
//
// 账本只是离线诊断与后续打分的事实来源：写失败不影响提交，也不进入模型上下文。
// 快照只有白名单里的结构化字段，绝不存简报正文、记忆原文或用户原话。
import { classifyPlaybackTransition } from '../playback/playbackOutcome.js';

export const DECISION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const DECISION_PATHS = Object.freeze(['chat', 'auto_continue', 'manual_next', 'selection_task',
  'prepared', 'recommend_only', 'group_proposal']);
export const DECISION_OUTCOMES = Object.freeze(['completed', 'skipped', 'partial', 'technical_failure', 'superseded']);
// 只有听者主动产生的结果才是反馈；其余只说明「这一首没被完整评价」。
export const LISTENER_FEEDBACK_OUTCOMES = Object.freeze(['completed', 'skipped']);

// 特征快照白名单：值只能是数字、布尔、短枚举串、短字符串数组或数字分项。
const FEATURE_KEYS = new Set(['mode', 'delivery', 'reason', 'origin', 'tags', 'freshness', 'familiarity',
  'tasteMatches', 'probe', 'score', 'scoreParts']);
const SHORT_TEXT = 40;
const MAX_LIST = 12;

const shortText = value => {
  const text = String(value ?? '').trim();
  return text && text.length <= SHORT_TEXT ? text : null;
};

function sanitizeFeatureValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return shortText(value);
  if (Array.isArray(value)) {
    const list = value.map(item => (typeof item === 'number' && Number.isFinite(item) ? item : shortText(item)))
      .filter(item => item != null).slice(0, MAX_LIST);
    return list;
  }
  if (typeof value === 'object') {
    // 分项只收数字（打分分项、标签计数），不收嵌套文本。
    const parts = {};
    for (const [key, part] of Object.entries(value).slice(0, MAX_LIST)) {
      if (shortText(key) && typeof part === 'number' && Number.isFinite(part)) parts[key] = part;
    }
    return parts;
  }
  return null;
}

// offer 特征里的标签是结构化对象（D3）；账本只存短标签串，例如 ['zh', 'rnb', 'calm', 'slow', 'vocal']。
function flattenTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return tags;
  return [tags.language, ...(Array.isArray(tags.genres) ? tags.genres : []), tags.mood, tags.tempo,
    tags.hasVocal === true ? 'vocal' : tags.hasVocal === false ? 'instrumental' : null].filter(Boolean);
}

/** 只保留白名单字段；未知字段直接丢弃，避免把简报或记忆文本带进账本。 */
export function sanitizeDecisionFeatures(features = {}) {
  const clean = {};
  if (!features || typeof features !== 'object') return clean;
  for (const [key, value] of Object.entries(features)) {
    if (!FEATURE_KEYS.has(key)) continue;
    const sanitized = sanitizeFeatureValue(key === 'tags' ? flattenTags(value) : value);
    if (sanitized !== null) clean[key] = sanitized;
  }
  return clean;
}

/** 决策路径：群聊登记 > 只推荐 > 预热采用 > 续播 / 手动下一首 > 其他后台任务 > 聊天。 */
export function decisionPath({ proposal = false, delivery = null, prepared = false, reason = null, task = false } = {}) {
  if (proposal) return 'group_proposal';
  if (delivery === 'recommend_only') return 'recommend_only';
  if (prepared) return 'prepared';
  if (reason === 'auto_continue') return 'auto_continue';
  if (reason === 'manual_next') return 'manual_next';
  if (task) return 'selection_task';
  return 'chat';
}

/** runtime 快照里属于某个 program 的 occurrence（活动队列与挂起的听歌来源都找）。 */
export function occurrencesForProgram(snapshot, programId) {
  if (!snapshot || !programId) return [];
  const queues = [snapshot.queue || [], ...Object.values(snapshot.suspendedSessions || {}).map(session => session?.queue || [])];
  return queues.flat().filter(item => item?.programId === programId && item.queueItemId);
}

const providerOf = track => String(track?.source || track?.provider || '').split(/[:-]/)[0];
const songIdOf = track => String(track?.songId ?? track?.song_id ?? '');

/**
 * 把一次成功提交展开成账本行。被采纳的序号按 (provider, songId) 对上实际提交的曲目
 * （解析失败被跳过的序号不写），再按同一身份对上 runtime 的 occurrence。
 */
export function buildDecisionRows({ offer, indexes, committedTracks, snapshot = null, programId = null,
  path, sessionId, personId, outputGeneration = null, selectionId = null, features = null, baseFeatures = {} } = {}) {
  if (!offer || !Array.isArray(indexes) || !Array.isArray(committedTracks)) return [];
  const windowSize = Array.isArray(offer.candidates) ? offer.candidates.length : 0;
  const occurrences = path === 'recommend_only' || path === 'group_proposal' ? [] : occurrencesForProgram(snapshot, programId);
  const usedTracks = new Set();
  const usedOccurrences = new Set();
  const rows = [];
  for (const index of indexes) {
    const candidate = offer.candidates?.[index - 1];
    if (!candidate) continue;
    const provider = providerOf(candidate);
    const songId = songIdOf(candidate);
    const trackIndex = committedTracks.findIndex((track, position) => !usedTracks.has(position)
      && providerOf(track) === provider && songIdOf(track) === songId);
    if (trackIndex < 0) continue;
    usedTracks.add(trackIndex);
    const occurrence = occurrences.find(item => !usedOccurrences.has(item.queueItemId)
      && providerOf(item) === provider && songIdOf(item) === songId) || null;
    if (occurrence) usedOccurrences.add(occurrence.queueItemId);
    const candidateFeatures = Array.isArray(features) ? features[index - 1] : features;
    rows.push({ sessionId, personId, path, offerId: offer.offerId, candidateIndex: index, windowRank: index,
      windowSize, provider, songId, features: sanitizeDecisionFeatures({ ...baseFeatures, ...(candidateFeatures || {}) }),
      queueItemId: occurrence?.queueItemId || null, outputGeneration: occurrence ? outputGeneration : null,
      programId: occurrence ? programId : null, selectionId });
  }
  return rows;
}

export class RecommendationDecisionStore {
  constructor({ db, now = Date.now, retentionMs = DECISION_RETENTION_MS } = {}) {
    this.db = db;
    this.now = now;
    this.retentionMs = retentionMs;
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS music_recommendation_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decided_at INTEGER NOT NULL,
      session_id TEXT NOT NULL, person_id TEXT NOT NULL, path TEXT NOT NULL,
      offer_id TEXT, candidate_index INTEGER NOT NULL, window_rank INTEGER NOT NULL, window_size INTEGER NOT NULL,
      provider TEXT NOT NULL, song_id TEXT NOT NULL, features_json TEXT NOT NULL,
      queue_item_id TEXT, output_generation INTEGER, program_id TEXT, selection_id TEXT,
      outcome TEXT, outcome_at INTEGER, played_seconds REAL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS music_recommendation_decisions_occurrence
      ON music_recommendation_decisions(queue_item_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS music_recommendation_decisions_decided
      ON music_recommendation_decisions(decided_at)`);
    this.initialized = true;
    this.prune();
  }

  prune() {
    this.initialize();
    return this.db.prepare('DELETE FROM music_recommendation_decisions WHERE decided_at < ?')
      .run(this.now() - this.retentionMs).changes;
  }

  record(rows = []) {
    this.initialize();
    if (!rows.length) return 0;
    const insert = this.db.prepare(`INSERT INTO music_recommendation_decisions
      (decided_at, session_id, person_id, path, offer_id, candidate_index, window_rank, window_size,
       provider, song_id, features_json, queue_item_id, output_generation, program_id, selection_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const decidedAt = this.now();
    const write = this.db.transaction(items => {
      for (const row of items) {
        if (!DECISION_PATHS.includes(row.path)) throw new TypeError(`unknown decision path: ${row.path}`);
        insert.run(decidedAt, String(row.sessionId), String(row.personId), row.path, row.offerId || null,
          row.candidateIndex, row.windowRank, row.windowSize, row.provider, row.songId,
          JSON.stringify(sanitizeDecisionFeatures(row.features)), row.queueItemId || null,
          Number.isFinite(Number(row.outputGeneration)) && row.outputGeneration != null ? Number(row.outputGeneration) : null,
          row.programId || null, row.selectionId || null);
      }
    });
    write(rows);
    return rows.length;
  }

  /**
   * 只按 queue occurrence 回填。已有最终结果的行不覆盖；superseded 可被之后的最终结果覆盖，
   * 而 superseded 本身只写给还没有结果的行。
   */
  applyOutcome({ queueItemId, outcome, playedSeconds = null } = {}) {
    this.initialize();
    if (!queueItemId || !DECISION_OUTCOMES.includes(outcome)) return 0;
    const played = Number.isFinite(Number(playedSeconds)) && playedSeconds != null ? Math.max(0, Number(playedSeconds)) : null;
    const replaceable = outcome === 'superseded' ? 'outcome IS NULL' : `(outcome IS NULL OR outcome = 'superseded')`;
    return this.db.prepare(`UPDATE music_recommendation_decisions
      SET outcome = ?, outcome_at = ?, played_seconds = COALESCE(?, played_seconds)
      WHERE queue_item_id = ? AND ${replaceable}`).run(outcome, this.now(), played, String(queueItemId)).changes;
  }
}

/** 订阅 runtime 已接受的转换，把结果回填到账本；浏览器分析上报不进入这里。 */
export class RecommendationOutcomeBridge {
  constructor({ getStore, logger = console } = {}) {
    this.getStore = getStore;
    this.logger = logger;
  }

  attach(runtime) {
    return runtime.subscribe((next, event, previous) => {
      try { this.observe(next, event, previous); }
      catch { this.logger.warn('[recommendation-ledger] outcome capture failed'); }
    });
  }

  observe(next, event, previous) {
    const classified = classifyPlaybackTransition(next, event, previous);
    if (!classified?.track?.queueItemId) return 0;
    const store = this.getStore?.();
    if (!store) return 0;
    return store.applyOutcome({ queueItemId: classified.track.queueItemId, outcome: classified.outcome,
      playedSeconds: event.playedSeconds ?? event.deliveredDuration ?? null });
  }
}
