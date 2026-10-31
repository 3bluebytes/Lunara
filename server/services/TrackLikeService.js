// TrackLikeService.js — 「喜欢」意图 → 远端镜像的唯一入口。
//
// 调用顺序（也是责任边界）：
//
//   POST /api/track-like
//     → TrackLikeService.setLike()
//        1. 幂等：requestId 回放过就直接返回上次结果
//        2. 落本地意图（song_likes 是真相源）
//        3. 能力门：源没有 like-write（例如 QQ）→ local_only，一个请求都不发
//        4. 按 (provider, songId) 串行地调用该源的 setSongLiked
//        5. 把结果写成 remote_state，失败保留意图、只记归类码
//
// 三个硬约束：
//   * 不进 AgentLoop，不产生聊天消息，不写角色记忆 —— 用户按按钮不是模型决策。
//   * 不跨源找替身：一首来自 A 源的歌，绝不在 B 源按标题收藏同名歌。
//   * 技术失败不改写意图，也不产生「不喜欢」。

import { randomUUID } from 'node:crypto';
import { providerRegistry } from '../music/providerRegistry.js';
import { MAX_AUTO_ATTEMPTS } from '../music/trackLikeStore.js';

/** 上游拒绝里属于「这首歌本身收不了」的，重试没有意义。 */
const TERMINAL_REASONS = new Set(['not_collectable', 'invalid_song', 'unresolved_song']);

function normalizeRequestId(value) {
  const id = String(value ?? '').trim();
  return id ? id.slice(0, 128) : randomUUID();
}

export class TrackLikeService {
  constructor({
    store,
    providers = {},
    registry = providerRegistry,
    now = () => Date.now(),
    newRequestId = randomUUID,
    // 远端只读结果的缓存时长：网易云一次 likelist 会返回全部 id，按秒级复用
    // 才不会变成「切一首歌打一次远端」。
    remoteReadTtlMs = 60_000,
  } = {}) {
    if (!store) throw new TypeError('TrackLikeService requires a store');
    this.store = store;
    this.providers = providers;
    this.registry = registry;
    this.now = now;
    this.newRequestId = newRequestId;
    this.remoteReadTtlMs = remoteReadTtlMs;
    this._queues = new Map();
    this._likeCache = new Map();   // `${provider}:${songId}` → { at, result }
    this._likedIdsCache = new Map(); // `${provider}:${uid}` → { at, ids:Set }
  }

  /** 该源此刻能不能写远端。能力门与模块实现缺一不可。 */
  canWriteRemote(provider) {
    const id = String(provider || '').trim().toLowerCase();
    if (!this.registry.supports(id, 'like-write')) return false;
    return typeof this.providers?.[id]?.setSongLiked === 'function';
  }

  /** 读一条意图。没有记录返回 null（没表达过 ≠ 不喜欢）。 */
  getLike(provider, songId) {
    return this.store.get(provider, songId);
  }

  /**
   * 界面展示用：本地有意图就返回它；本地**从没表达过**时读一次远端，
   * 若云端已经收藏了这首歌，就把这个事实采纳成初始状态。
   *
   * 为什么需要这一步：这首歌可能本来就在用户的「我喜欢的音乐」里。不做这一步，
   * 心形会显示成未喜欢 —— 用户点一下等于「又收藏一遍」，看起来毫无反应，
   * 而实际上他本来就已经喜欢它了。
   *
   * 边界：只在本地没有任何记录时发生一次；读不到远端就什么都不采纳（保持
   * 「没表达过」），绝不猜。
   */
  async resolveLike({ provider, songId } = {}) {
    const canWriteRemote = this.canWriteRemote(provider);
    const local = this.store.get(provider, songId);
    if (local) return { like: local, adopted: false, canWriteRemote, readError: null };
    if (!this.registry.supports(provider, 'like')) {
      return { like: null, adopted: false, canWriteRemote, readError: 'unsupported' };
    }
    const remote = await this._readRemote(provider, songId);
    if (!remote.ok) return { like: null, adopted: false, canWriteRemote, readError: remote.reason };
    if (remote.liked !== true) return { like: null, adopted: false, canWriteRemote, readError: null };

    // 远端确认为已收藏：把它记成本地意图，之后才谈得上「取消喜欢」。
    const adopted = this.store.setDesired(provider, songId, true, { remoteState: 'synced', origin: 'adopted' });
    return { like: adopted, adopted: true, canWriteRemote, readError: null };
  }

  /**
   * 排歌后一次性对齐整批曲目的远端状态（尽力而为，不阻塞提交）。
   *
   * 为什么要在排歌时做：界面上「喜欢」只有一处真相，但它需要知道云端事实。
   * 逐首在渲染时读会变成「切一首打一次远端」，而且第一帧可能是空的。排歌是
   * 天然的批处理点：网易云一次 likelist 拿全量 id，QQ 一次 IsSongFanByMid 批量问。
   *
   * 冲突规则（谁说了算）：
   *   - 本地没有记录 + 云端已收藏 → 采纳（origin=adopted, synced）
   *   - 本地 origin=adopted → 跟随远端（用户没在 Lunara 里表过态，云端才是权威）
   *   - 本地 origin=user    → 以本地为准：一致就标 synced，不一致标 pending 交给重试
   *
   * 任何读取失败都不改动已有行，也不凭空造行。
   */
  async hydrate({ tracks = [], providers = null } = {}) {
    const wanted = (Array.isArray(tracks) ? tracks : [])
      .map(track => ({
        provider: String(track?.provider || track?.source || '').split(':')[0].trim().toLowerCase(),
        songId: String(track?.songId ?? track?.song_id ?? '').trim(),
      }))
      .filter(item => item.provider && item.songId && this.registry.supports(item.provider, 'like'));
    if (!wanted.length) return { ok: true, adopted: 0, followed: 0, pending: 0, unchanged: 0, readErrors: {} };

    const summary = { ok: true, adopted: 0, followed: 0, pending: 0, unchanged: 0, readErrors: {} };
    const byProvider = new Map();
    for (const item of wanted) {
      if (providers && !providers.includes(item.provider)) continue;
      if (!byProvider.has(item.provider)) byProvider.set(item.provider, new Set());
      byProvider.get(item.provider).add(item.songId);
    }

    for (const [provider, ids] of byProvider) {
      const remote = await this._readRemoteBatch(provider, [...ids]);
      if (!remote.ok) { summary.readErrors[provider] = remote.reason; continue; }
      for (const songId of ids) {
        const liked = remote.liked.has(songId);
        const local = this.store.get(provider, songId);
        if (!local) {
          if (liked) {
            this.store.setDesired(provider, songId, true, { remoteState: 'synced', origin: 'adopted' });
            summary.adopted += 1;
          } else {
            summary.unchanged += 1;
          }
          continue;
        }
        if (local.origin === 'adopted') {
          if (local.desired === liked) {
            if (local.remoteState !== 'synced') this.store.markState(provider, songId, 'synced', { error: null, attempts: 0 });
            summary.unchanged += 1;
          } else {
            this.store.setDesired(provider, songId, liked, { remoteState: 'synced', origin: 'adopted' });
            summary.followed += 1;
          }
          continue;
        }
        // 用户在 Lunara 里表达过：本地优先，只更新同步状态。
        if (local.desired === liked) {
          if (local.remoteState !== 'synced') this.store.markState(provider, songId, 'synced', { error: null, attempts: 0 });
          summary.unchanged += 1;
        } else if (local.remoteState !== 'pending') {
          this.store.markState(provider, songId, 'pending', { error: 'drift' });
          summary.pending += 1;
        } else {
          summary.unchanged += 1;
        }
      }
    }
    return summary;
  }

  /** 批量读远端：网易云一次 likelist 全量，QQ 一次 IsSongFanByMid 批量。 */
  async _readRemoteBatch(provider, songIds) {
    const module = this.providers[provider];
    const now = this.now();
    if (provider === 'ncm') {
      const status = await module?.loginStatus?.();
      if (!status?.loggedIn) return { ok: false, reason: 'not_logged_in' };
      const key = `batch:ncm:${status.userId}`;
      const cached = this._likedIdsCache.get(key);
      let ids;
      if (cached && now - cached.at < this.remoteReadTtlMs) ids = cached.ids;
      else {
        const listed = await module.likedSongIds(status.userId);
        if (!listed?.ok) return { ok: false, reason: listed?.reason || 'request_failed' };
        ids = new Set(listed.ids.map(String));
        this._likedIdsCache.set(key, { at: now, ids });
        // 逐曲缓存也一起热掉，省掉随后 GET 的重复读取。
        this._likedIdsCache.set(`ncm:${status.userId}`, { at: now, ids });
      }
      return { ok: true, liked: new Set(songIds.filter(songId => ids.has(String(songId)))) };
    }
    if (provider === 'qq') {
      const asked = songIds.filter(songId => {
        const hit = this._likeCache.get(`qq:${songId}`);
        return !(hit && now - hit.at < this.remoteReadTtlMs);
      });
      if (asked.length) {
        if (typeof module?.isSongLikedBatch !== 'function') return { ok: false, reason: 'unsupported' };
        const outcome = await module.isSongLikedBatch(asked);
        if (!outcome?.ok) return { ok: false, reason: outcome?.reason || 'request_failed' };
        for (const songId of asked) {
          this._likeCache.set(`qq:${songId}`, { at: now, result: { ok: true, liked: outcome.liked.has(songId) } });
        }
      }
      const liked = new Set(songIds.filter(songId => this._likeCache.get(`qq:${songId}`)?.result?.liked === true));
      return { ok: true, liked };
    }
    return { ok: false, reason: 'unsupported' };
  }

  /** 清空远端只读缓存（测试与「用户刚在音乐源 App 里改过」时用）。 */
  invalidateRemoteCache() {
    this._likeCache.clear();
    this._likedIdsCache.clear();
  }

  /**
   * 设置喜欢意图并尝试镜像。返回：
   *   { ok, like, idempotent, reason? }
   * `ok` 表示**意图**已落库；远端是否跟上要看 `like.remoteState`。
   */
  async setLike({ provider, songId, desired, requestId } = {}) {
    const id = normalizeRequestId(requestId ?? this.newRequestId());
    const replayed = this.store.findByRequestId(id);
    if (replayed && replayed.provider === String(provider || '').trim().toLowerCase()
      && replayed.songId === String(songId ?? '').trim()
      && replayed.desired === Boolean(desired)) {
      return { ok: true, like: replayed, idempotent: true };
    }

    const writable = this.canWriteRemote(provider);
    const like = this.store.setDesired(provider, songId, desired, {
      remoteState: writable ? 'pending' : 'local_only',
      requestId: id,
      origin: 'user',
    });
    if (!writable) {
      return { ok: true, like, idempotent: false, reason: 'no_write_capability' };
    }
    const mirrored = await this._serialize(like.provider, like.songId,
      () => this._mirror(like, { requestId: id }));
    return { ...mirrored, idempotent: false };
  }

  /**
   * 用户显式重试：一定真的再试一次（用户要求了），但 `attempts` 继续累计 ——
   * 如果这个源一直坏，界面要能显示「试过 N 次都不行」，而不是无限回到初始态。
   */
  async retry({ provider, songId, requestId } = {}) {
    const like = this.store.get(provider, songId);
    if (!like) return { ok: false, reason: 'no_intent' };
    if (!this.canWriteRemote(like.provider)) {
      return { ok: true, like: this.store.markState(like.provider, like.songId, 'local_only', { error: 'no_write_capability' }) };
    }
    const id = normalizeRequestId(requestId ?? this.newRequestId());
    const pending = this.store.markState(like.provider, like.songId, 'pending');
    const mirrored = await this._serialize(like.provider, like.songId,
      () => this._mirror(pending || like, { requestId: id }));
    return mirrored;
  }

  /**
   * 远端校准（只读）。远端与意图不一致时标记漂移并最多重试一次；
   * 校准本身失败则什么都不改 —— 不能因为读不到就说「已同步」。
   */
  async reconcile({ provider, songId } = {}) {
    const like = this.store.get(provider, songId);
    if (!like) return { ok: false, reason: 'no_intent' };
    const remote = await this._readRemote(like.provider, like.songId, { fresh: true });
    if (!remote.ok) return { ok: false, reason: remote.reason, like };

    if (remote.liked === like.desired) {
      const synced = like.remoteState === 'synced'
        ? like
        : this.store.recordSuccess(like.provider, like.songId);
      return { ok: true, like: synced, drifted: false };
    }

    // 漂移：远端被外部改掉了。意图不动，重新同步一次。
    const pending = this.store.markState(like.provider, like.songId, 'pending', { error: 'drift' });
    if (!this.canWriteRemote(like.provider) || like.attempts >= MAX_AUTO_ATTEMPTS) {
      const failed = this.store.markState(like.provider, like.songId, 'failed', { error: 'drift' });
      return { ok: false, reason: 'drift', like: failed, drifted: true };
    }
    const mirrored = await this._serialize(like.provider, like.songId,
      () => this._mirror(pending || like, { requestId: this.newRequestId() }));
    return { ...mirrored, drifted: true };
  }

  // ---- 内部 ----

  async _mirror(like, { requestId }) {
    const module = this.providers[like.provider];
    let outcome;
    try {
      outcome = await module.setSongLiked(like.songId, like.desired);
    } catch {
      // provider 契约是不抛错；真抛了也只当作可重试失败，不把异常原文带出去。
      outcome = { ok: false, reason: 'request_failed' };
    }

    if (outcome?.ok) {
      return { ok: true, like: this.store.recordSuccess(like.provider, like.songId, { requestId }) };
    }

    const reason = String(outcome?.reason || 'request_failed');
    if (reason === 'not_logged_in' || reason === 'no_write_capability') {
      // 没登录不是「同步失败」，是「这条现在只能待在本机」。
      const local = this.store.markState(like.provider, like.songId, 'local_only', { error: reason });
      return { ok: false, reason, like: local, retryable: false };
    }
    if (TERMINAL_REASONS.has(reason)) {
      const failed = this.store.markState(like.provider, like.songId, 'failed', { error: reason });
      return { ok: false, reason, like: failed, retryable: false };
    }
    const failed = this.store.recordFailure(like.provider, like.songId, reason);
    return {
      ok: false,
      reason: 'retryable',
      detail: reason,
      like: failed,
      retryable: (failed?.attempts ?? MAX_AUTO_ATTEMPTS) < MAX_AUTO_ATTEMPTS,
    };
  }

  async _readRemote(provider, songId, { fresh = false } = {}) {
    const module = this.providers[provider];
    const now = this.now();
    const cacheKey = `${provider}:${songId}`;
    const cached = fresh ? null : this._likeCache.get(cacheKey);
    if (cached && now - cached.at < this.remoteReadTtlMs) return cached.result;

    let result;
    if (provider === 'qq') {
      if (typeof module?.isSongLiked !== 'function') return { ok: false, reason: 'unsupported' };
      const outcome = await module.isSongLiked(songId);
      result = outcome?.ok
        ? { ok: true, liked: outcome.liked === true }
        : { ok: false, reason: outcome?.reason || 'request_failed' };
    } else if (provider === 'ncm') {
      const status = await module?.loginStatus?.();
      if (!status?.loggedIn) return { ok: false, reason: 'not_logged_in' };
      const idsKey = `ncm:${status.userId}`;
      const idsCached = fresh ? null : this._likedIdsCache.get(idsKey);
      let ids = idsCached && now - idsCached.at < this.remoteReadTtlMs ? idsCached.ids : null;
      if (!ids) {
        const listed = await module.likedSongIds(status.userId);
        // 「读到空列表」和「没读到」必须分开：后者绝不能当成「用户没收藏」，
        // 否则校准失败会被说成「已同步」。
        if (!listed?.ok) return { ok: false, reason: listed?.reason || 'liked_list_unavailable' };
        ids = new Set(listed.ids.map(String));
        this._likedIdsCache.set(idsKey, { at: now, ids });
      }
      result = { ok: true, liked: ids.has(String(songId)) };
    } else {
      return { ok: false, reason: 'unsupported' };
    }

    if (result.ok) this._likeCache.set(cacheKey, { at: now, result });
    return result;
  }

  /** 同一首歌的写请求串行执行：远端是单值，两个并发写只会互相覆盖。 */
  _serialize(provider, songId, operation) {
    const key = `${provider}:${songId}`;
    const previous = this._queues.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    this._queues.set(key, next.catch(() => undefined));
    return next;
  }
}
