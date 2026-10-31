// ambientRecommendations.js — 一起听时她偶尔推荐的一首歌（add-ambient-music-recommendation）。
//
// 职责边界（按调用顺序）：
//   1. gate：叫醒时算一次能不能推荐（封闭原因码）。只看事实：这一拍的场合与角色、是不是当前听歌来源、
//      有没有被要求安静、有没有未处理的推荐、离上次推荐多久、当地今天推荐了几次。不鼓励、不设配额。
//   2. resolve：交给 MusicSelectionService.recommendTrack（exact + recommend_only + 计划硬条件 + 排除），
//      只登记 music_selections 引用，不碰播放器。
//   3. record：和她说出口的那句话同一事务落一行 pending（调用方开事务）；同一聊天旧的 pending 随之过期。
//   4. accept：你点「放这首」或在聊天里说要听 → MusicSelectionService.acceptRecommendation
//      （after_current、负责人提交、推荐人另记）。runtime 接受才写 queued；解析失败写 unavailable，不替歌。
//   5. 过期：30 分钟或换了听歌来源。过期/忽略不产生任何口味、不喜欢或反思记录。
//
// 状态只在本表：pending → queued | unavailable | expired。turn 上的 musicRecommendation 是入账时的快照，
// 展示时用 view(turnId) 覆盖实时状态。
//
// Python 伪代码：
//   recs = AmbientRecommendations(db, get_music_service, playback_runtime, conversation_store)
//   if recs.gate(session_id, person_id, wake).open: tools.append('recommend_track')
//   with db.transaction(): store.record_presence_turn(...); recs.record(turn_id, session_id, person_id, item)
//   await recs.accept(session_id, turn_id)   # 幂等；并发双击共用同一个结果
export const RECOMMENDATION_LIMITS = Object.freeze({ minIntervalMs: 30 * 60_000, dailyCap: 3, ttlMs: 30 * 60_000 });
const NON_SPEAKER_ROLES = new Set(['follower', 'invited', 'returned']);
// 这些失败与「这首歌」无关（并发、版本过期、收据未确认）：保持 pending，可以再点。
const RETRYABLE_COMMIT_REASON = /^commit rejected/;

function localDay(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const viewOf = row => row && Object.freeze({ turnId: row.turn_id, sessionId: row.session_id, selectionId: row.selection_id,
  provider: row.provider, songId: row.song_id, title: row.title, artist: row.artist, recommendedBy: row.person_id,
  status: row.status, expiresAt: row.expires_at });

/**
 * 客户端看到的推荐卡片：歌名、歌手、推荐人与实时状态。内部 selectionId 不出服务端，确认只凭 turnId。
 * live 是 view(turnId) 的实时视图，覆盖入账时的快照状态。
 */
export function publicRecommendation(snapshot, live = null) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return { provider: String(snapshot.provider || ''), songId: String(snapshot.songId || ''), title: String(snapshot.title || ''),
    artist: String(snapshot.artist || ''), recommendedBy: String(snapshot.recommendedBy || ''),
    status: live?.status || snapshot.status || 'pending', expiresAt: live?.expiresAt ?? snapshot.expiresAt ?? null };
}

export function createAmbientRecommendations({ db, getMusicService = () => null, playbackRuntime = null,
  conversationStore = null, now = () => Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  trace = null, listenerQuiet = () => false, limits = {}, logger = console } = {}) {
  // 会话库在 runtime initialize 时才打开：没直接给 db 就现读 conversationStore.db。
  const database = () => db || conversationStore?.db;
  if (!db && !conversationStore) throw new TypeError('createAmbientRecommendations requires db or conversationStore');
  const bounds = { ...RECOMMENDATION_LIMITS, ...limits };
  let isQuiet = typeof listenerQuiet === 'function' ? listenerQuiet : () => false;
  const inflight = new Map();
  let ready = false;
  const record = (sessionId, event) => {
    try { trace?.(sessionId, event); } catch { /* trace 不影响推荐 */ }
  };
  const isSource = sessionId => {
    try { return playbackRuntime?.snapshot?.()?.activeListeningSessionId === sessionId; } catch { return false; }
  };

  function initialize() {
    if (ready) return;
    database().exec(`CREATE TABLE IF NOT EXISTS ambient_music_recommendations (
      turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, person_id TEXT NOT NULL, selection_id TEXT NOT NULL,
      provider TEXT NOT NULL, song_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
      status TEXT NOT NULL, local_day TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
    database().exec('CREATE INDEX IF NOT EXISTS ambient_music_recommendations_session ON ambient_music_recommendations(session_id, created_at)');
    ready = true;
  }

  const setStatus = (turnId, status, from = 'pending') => {
    initialize();
    return database().prepare('UPDATE ambient_music_recommendations SET status = ?, updated_at = ? WHERE turn_id = ? AND status = ?')
      .run(status, now(), turnId, from).changes > 0;
  };

  /** 惰性过期：读到已过期的 pending 时顺手写成 expired。 */
  function view(turnId) {
    initialize();
    const row = database().prepare('SELECT * FROM ambient_music_recommendations WHERE turn_id = ?').get(String(turnId || ''));
    if (row?.status === 'pending' && row.expires_at <= now()) {
      setStatus(row.turn_id, 'expired');
      return viewOf({ ...row, status: 'expired' });
    }
    return viewOf(row);
  }

  function pending(sessionId) {
    initialize();
    const row = database().prepare(`SELECT turn_id FROM ambient_music_recommendations WHERE session_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`).get(String(sessionId || ''));
    const current = row ? view(row.turn_id) : null;
    return current?.status === 'pending' ? current : null;
  }

  function gate({ sessionId, personId, wake } = {}) {
    initialize();
    const closed = reason => ({ open: false, reason });
    if (!getMusicService?.() || !sessionId || !personId) return closed('unavailable');
    if (wake?.reason === 'app_open') return closed('occasion');
    if (NON_SPEAKER_ROLES.has(wake?.role)) return closed('role');
    if (!isSource(sessionId)) return closed('not-listening-source');
    let quiet = false;
    try { quiet = isQuiet(sessionId) === true; } catch { quiet = true; }
    if (quiet) return closed('quiet');
    if (pending(sessionId)) return closed('pending');
    const nowMs = now();
    const last = database().prepare('SELECT MAX(created_at) AS at FROM ambient_music_recommendations WHERE session_id = ?').get(sessionId)?.at;
    if (Number.isFinite(last) && nowMs - last < bounds.minIntervalMs) return closed('interval');
    const today = database().prepare('SELECT COUNT(*) AS count FROM ambient_music_recommendations WHERE session_id = ? AND local_day = ?')
      .get(sessionId, localDay(nowMs, timeZone)).count;
    if (today >= bounds.dailyCap) return closed('daily-cap');
    return { open: true, reason: null };
  }

  /** 调用方负责事务（与 presence turn 同一事务）。返回入账后的视图。 */
  function recordRecommendation({ turnId, sessionId, personId, item } = {}) {
    initialize();
    const nowMs = now();
    database().prepare(`UPDATE ambient_music_recommendations SET status = 'expired', updated_at = ?
      WHERE session_id = ? AND status = 'pending'`).run(nowMs, sessionId);
    database().prepare(`INSERT INTO ambient_music_recommendations VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(turnId, sessionId, personId, item.selectionId, String(item.provider || ''), String(item.songId || ''),
        String(item.title || ''), String(item.artist || ''), localDay(nowMs, timeZone), nowMs, nowMs + bounds.ttlMs, nowMs);
    record(sessionId, { type: 'ambient_recommendation_recorded', turnId, personId,
      provider: String(item.provider || ''), songId: String(item.songId || '') });
    return view(turnId);
  }

  /** 换了听歌来源：这个聊天的 pending 推荐作废（不是不喜欢，不留任何口味记录）。 */
  function expireSession(sessionId) {
    initialize();
    return database().prepare(`UPDATE ambient_music_recommendations SET status = 'expired', updated_at = ?
      WHERE session_id = ? AND status = 'pending'`).run(now(), String(sessionId || '')).changes;
  }

  const markQueued = turnId => setStatus(turnId, 'queued');

  async function settle(recommendation) {
    const { sessionId, turnId } = recommendation;
    const room = conversationStore?.getSession?.(sessionId);
    const committerId = room?.memberIds?.includes(room.activeVirtualPersonId) ? room.activeVirtualPersonId
      : recommendation.recommendedBy;
    let result;
    try {
      result = await getMusicService().acceptRecommendation({ sessionId, turnId, selectionId: recommendation.selectionId,
        recommenderId: recommendation.recommendedBy, committerId });
    } catch {
      logger?.warn?.('[presence] recommendation accept failed');
      result = { ok: false, code: 'RECOMMENDATION_ACCEPT_FAILED' };
    }
    let outcome = 'retryable';
    if (result?.ok === true) {
      markQueued(turnId);
      outcome = 'queued';
    } else if (result?.code === 'RECOMMENDATION_UNRESOLVED'
      || (result?.code === 'MUSIC_NOT_COMMITTED' && !RETRYABLE_COMMIT_REASON.test(String(result.reason || '')))) {
      setStatus(turnId, 'unavailable');
      outcome = 'unavailable';
    }
    record(sessionId, { type: 'recommendation_accept', turnId, outcome, code: String(result?.code || '') });
    const latest = view(turnId);
    if (outcome === 'queued') return { ok: true, code: 'RECOMMENDATION_QUEUED', recommendation: latest };
    if (outcome === 'unavailable') return { ok: false, code: 'RECOMMENDATION_UNAVAILABLE', recommendation: latest };
    return { ok: false, code: 'RECOMMENDATION_ACCEPT_RETRY', retryable: true, recommendation: latest };
  }

  /** 你确认要听：只在 pending、未过期、这个聊天正是当前听歌来源时提交；绝不切换来源。 */
  async function accept({ sessionId, turnId } = {}) {
    const recommendation = view(turnId);
    if (!recommendation || recommendation.sessionId !== String(sessionId || '')) return { ok: false, code: 'RECOMMENDATION_NOT_FOUND' };
    if (inflight.has(recommendation.turnId)) return inflight.get(recommendation.turnId);
    if (recommendation.status === 'queued') return { ok: true, code: 'RECOMMENDATION_QUEUED', recommendation };
    if (recommendation.status !== 'pending') return { ok: false, code: 'RECOMMENDATION_NOT_PENDING', recommendation };
    if (!isSource(recommendation.sessionId)) {
      setStatus(recommendation.turnId, 'expired');
      return { ok: false, code: 'RECOMMENDATION_NOT_LISTENING_SOURCE', recommendation: view(turnId) };
    }
    const task = settle(recommendation).finally(() => inflight.delete(recommendation.turnId));
    inflight.set(recommendation.turnId, task);
    return task;
  }

  return Object.freeze({
    initialize, gate, view, pending, expireSession, accept, markQueued,
    record: recordRecommendation,
    resolve: (target, input) => getMusicService().recommendTrack(target, input),
    /** presence 装配晚于 runtime：在那里接上「安静点」判断。 */
    setListenerQuiet(fn) { if (typeof fn === 'function') isQuiet = fn; },
  });
}

export default createAmbientRecommendations;
