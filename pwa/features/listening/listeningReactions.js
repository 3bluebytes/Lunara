import { escapeHtml as esc } from '../chat/chatMarkup.js';

const STORAGE_KEY = 'lunara.songReactions';

function readStore(localStorageLike) {
  try {
    const raw = localStorageLike?.getItem?.(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store, localStorageLike) {
  try {
    localStorageLike?.setItem?.(STORAGE_KEY, JSON.stringify(store));
  } catch { /* 无存储环境时忽略：反应只保留在当前视图状态里 */ }
}

/** 反应键：供应商 + 歌曲 ID；缺失时回退标题+艺人（只影响本地展示，不做远端合并）。 */
export function songReactionKey(item = {}) {
  const songId = item.songId ?? item.song_id ?? '';
  const provider = item.source || item.provider || '';
  if (songId !== '' && provider) return `${provider}:${songId}`;
  if (songId !== '') return `id:${songId}`;
  return `t:${esc(String(item.title || ''))}|${esc(String(item.artist || ''))}`;
}

/** 曲目身份里的 provider（与 songReactionKey 同源，去掉 ':source' 后缀）。 */
function providerOf(item = {}) {
  const raw = String(item.source || item.provider || '');
  return raw.split(':')[0].trim().toLowerCase();
}

function songIdOf(item = {}) {
  const value = item.songId ?? item.song_id ?? '';
  return value === '' || value == null ? '' : String(value);
}

/**
 * 喜欢状态的四态文案。**只有 synced 允许出现「已同步」**：
 * 本地意图保存成功不等于远端已经跟上，界面不能替服务端保证它不知道的事。
 */
export const LIKE_STATE_COPY = Object.freeze({
  synced: '已同步到云端',
  local_only: '这条只记在本机',
  pending: '正在同步…',
  failed: '同步失败，可重试',
  // 这首歌本来就在云端歌单里（本地从没表达过，读了远端才采纳的）。
  // 单独一句是为了回答「我明明收藏过，为什么心形是空的」，并预先说明再点会取消。
  adopted: '云端歌单里已有这首，再点会取消收藏',
});

/**
 * 喜欢 / 取消喜欢写入之后给用户看的一句话。
 * **只有 remoteState=synced 才能说「已同步」**：本地意图落库成功不等于云端跟上了。
 * 取消收藏同样按 remoteState 说，不替服务端保证它没证实的事。
 */
export function likeNotice(like = null, desired = true) {
  const state = like?.remoteState || 'pending';
  if (desired) {
    if (state === 'synced') return { type: 'success', title: '已同步到云端', message: '已经写进该来源的「我喜欢的音乐」。' };
    if (state === 'local_only') return { type: 'info', title: '只记在本机', message: '这个音乐源不支持同步云端收藏，Lunara 之后仍会按它推荐。' };
    if (state === 'failed') return { type: 'error', title: '还没同步到云端', message: '喜欢已经记在本机，可以点「重试」。' };
    return { type: 'info', title: '正在同步到云端', message: '稍后自动重试；失败时可以点「重试」。' };
  }
  if (state === 'synced') return { type: 'success', title: '已取消云端收藏', message: '已经从该来源的「我喜欢的音乐」里移出。' };
  if (state === 'local_only') return { type: 'info', title: '已取消本机的喜欢', message: '这首歌只在 Lunara 里记过，云端歌单没有变化。' };
  if (state === 'failed') return { type: 'error', title: '云端还没跟上', message: '本机已经取消，云端可能还留着；可以点「重试」。' };
  return { type: 'info', title: '正在同步到云端', message: '稍后自动重试；失败时可以点「重试」。' };
}

/**
 * 听歌主视觉的 喜欢 / 不喜欢。
 *
 * 喜欢：意图存服务端（`/api/track-like`），按返回的 `remoteState` 如实呈现四态；
 * 没有远端同步能力的源（例如 QQ）只会是「仅记在本机」。
 * 取消喜欢：云端确实有这首时先确认一次（`confirmAction`），确认后才写。
 * 不喜欢：明确设置而不是 toggle，先确认再由 onDislike 原子移出并跳过，接受后才记本机反应。
 *
 * 浏览器 localStorage 里的旧记录只在服务端还没答复时用于防闪烁，**不作为真相**。
 */
export function createListeningReactions({
  documentLike = globalThis.document,
  localStorageLike = globalThis.localStorage,
  onDislike = async () => ({ accepted: false }),
  onLike = async () => ({ ok: false }),
  onRetryLike = async () => ({ ok: false }),
  fetchLike = async () => null,
  onError = () => {},
  // 需要提醒一次的动作（云端已收藏还点喜欢、不喜欢）：返回 true 才继续。
  // 默认放行只是给不自带弹层的调用方（如测试替身）留的退化路径。
  confirmAction = async () => true,
  // 写入成功后的 toast（{ type, title, message }），由壳层决定去哪里显示。
  onNotice = () => {},
} = {}) {
  if (!documentLike) throw new TypeError('documentLike is required');
  let currentKey = null;
  let currentTrack = null;
  let pending = false;
  let likePending = false;
  // { desired, remoteState } —— 当前曲目在服务端的喜欢状态。
  let likeState = null;
  let store = readStore(localStorageLike);

  const buttons = () => [...documentLike.querySelectorAll('[data-reactions] [data-reaction]')];
  const statusSlots = () => [...documentLike.querySelectorAll('[data-reactions] [data-reaction-status]')];
  const retryButtons = () => [...documentLike.querySelectorAll('[data-reactions] [data-reaction-retry]')];

  const canUseLike = () => Boolean(currentKey && providerOf(currentTrack) && songIdOf(currentTrack));

  function likeCopy() {
    if (!likeState?.desired) return '';
    if (likeState.adopted) return LIKE_STATE_COPY.adopted;
    return LIKE_STATE_COPY[likeState.remoteState] || '';
  }

  function syncPressed() {
    const disliked = currentKey ? store[currentKey] === 'dislike' : false;
    const liked = likeState?.desired === true;
    const browsingOtherSource = currentTrack?.browsingSessionId
      && currentTrack.browsingSessionId !== currentTrack.listeningSessionId;

    for (const button of buttons()) {
      const kind = button.dataset?.reaction;
      const inPanel = Boolean(button.closest?.('#listening-panel'));
      button.setAttribute('aria-pressed', String(kind === 'like' ? liked : disliked));
      button.disabled = !currentKey || pending || Boolean(browsingOtherSource && inPanel)
        || (kind === 'like' && (!canUseLike() || likePending))
        || (kind === 'dislike' && !currentTrack?.queueItemId);
      button.setAttribute('aria-busy', String(kind === 'like' ? likePending : pending));
      if (kind === 'like') {
        const copy = likeCopy();
        button.setAttribute('aria-label', copy ? `喜欢（${copy}）` : '喜欢');
        button.setAttribute('title', copy || '喜欢');
      } else {
        button.setAttribute('aria-label', '不喜欢，移出播放列表并跳过');
        button.setAttribute('title', '从当前播放列表移出并跳过，不修改远端歌单');
      }
    }

    const copy = likeCopy();
    for (const slot of statusSlots()) {
      slot.textContent = copy;
      // 只有「失败」需要显式重试入口；其余状态是陈述，不是操作。
      slot.classList?.toggle?.('is-error', likeState?.remoteState === 'failed');
    }
    for (const retry of retryButtons()) {
      retry.hidden = !(likeState?.desired && likeState?.remoteState === 'failed');
      retry.disabled = likePending;
    }
  }

  function applyLike(like, { adopted = false } = {}) {
    likeState = like
      ? { desired: like.desired === true, remoteState: like.remoteState || 'pending', adopted }
      : null;
  }

  async function loadLike(item) {
    if (!item || !canUseLike()) { likeState = null; syncPressed(); return; }
    const key = currentKey;
    try {
      const result = await fetchLike({ provider: providerOf(item), songId: songIdOf(item) });
      if (currentKey !== key) return; // 期间换歌了，丢弃过期答案
      applyLike(result?.like || null, {
        adopted: result?.adopted === true || result?.like?.origin === 'adopted',
      });
    } catch {
      if (currentKey !== key) return;
      // 读不到服务端状态时什么都不宣称，也不想把旧 localStorage 当真相。
      likeState = null;
    }
    syncPressed();
  }

  function setTrack(item) {
    currentTrack = item ? { ...item } : null;
    currentKey = item ? songReactionKey(item) : null;
    likeState = null;
    syncPressed();
    if (item) void loadLike(item);
  }

  async function toggleLike() {
    const target = { ...currentTrack };
    const provider = providerOf(target);
    const songId = songIdOf(target);
    const desired = !(likeState?.desired === true);
    const key = currentKey;
    // 取消喜欢且这首歌确实在云端：先问一次。云端已有的喜欢是读了远端才点亮的，
    // 直接一点就取消会让用户「只是想再点一下」就丢收藏。
    if (!desired && (likeState?.adopted === true || likeState?.remoteState === 'synced')) {
      likePending = true;
      syncPressed();
      let allowed = false;
      try {
        allowed = await confirmAction({
          kind: 'unlike',
          adopted: likeState?.adopted === true,
          remoteState: likeState?.remoteState || null,
          track: target,
        }) === true;
      } finally {
        likePending = false;
        syncPressed();
      }
      if (!allowed || currentKey !== key) return;
    }
    likePending = true;
    // 乐观表达意图：心形立刻响应，但状态先说「正在同步…」，不冒充已同步。
    likeState = { desired, remoteState: 'pending', adopted: false };
    syncPressed();
    try {
      const result = await onLike({ provider, songId, desired });
      if (currentKey !== key) return;
      applyLike(result?.like || { desired, remoteState: result?.ok ? 'pending' : 'failed' });
      onNotice(likeNotice(likeState, desired));
    } catch (error) {
      if (currentKey !== key) return;
      likeState = { desired, remoteState: 'failed' };
      onError(error ?? new Error('喜欢没有保存成功，请重试。'));
    } finally {
      likePending = false;
      syncPressed();
    }
  }

  async function retryLike() {
    const target = { ...currentTrack };
    const provider = providerOf(target);
    const songId = songIdOf(target);
    const key = currentKey;
    likePending = true;
    syncPressed();
    try {
      const result = await onRetryLike({ provider, songId });
      if (currentKey !== key) return;
      applyLike(result?.like || likeState);
      onNotice(likeNotice(likeState, likeState?.desired !== false));
    } catch (error) {
      if (currentKey !== key) return;
      likeState = likeState ? { ...likeState, remoteState: 'failed' } : null;
      onError(error ?? new Error('还是没能同步，请稍后再试。'));
    } finally {
      likePending = false;
      syncPressed();
    }
  }

  async function onClick(event) {
    const retry = event.target?.closest?.('[data-reaction-retry]');
    if (retry) {
      if (likePending) return;
      await retryLike();
      return;
    }
    const button = event.target?.closest?.('[data-reaction]');
    if (!button) return;
    const kind = button.dataset?.reaction;
    if (!currentKey || pending || likePending || button.disabled) return;
    if (kind === 'like') return toggleLike();
    if (kind !== 'dislike') return;

    const target = { ...currentTrack };
    const key = currentKey;
    // 不喜欢会当场移出并跳过，不能一键就到；先让用户确认这一次再动队列。
    const allowed = await confirmAction({ kind: 'dislike', track: target }) === true;
    if (!allowed) { syncPressed(); return; }
    if (currentKey !== key) return; // 弹层期间换歌了：不拿旧歌的决定去动新队列
    const restoreFocus = documentLike.activeElement === button;
    pending = true;
    syncPressed();
    try {
      const result = await onDislike(target);
      if (!(result?.ok === true || result?.accepted === true)) throw new Error('dismissal not accepted');
      store = { ...store, [key]: 'dislike' };
      writeStore(store, localStorageLike);
      onNotice({ type: 'success', title: '已移出播放列表', message: '这首歌已经跳过；云端歌单没有变化。' });
    } catch {
      onError(new Error('没能移出这首歌，请重试。'));
    } finally {
      pending = false;
      syncPressed();
      if (restoreFocus && documentLike.activeElement === documentLike.body && !button.disabled) {
        button.focus?.({ preventScroll: true });
      }
    }
  }

  function init() {
    documentLike.addEventListener?.('click', onClick);
    syncPressed();
    return api;
  }

  function destroy() {
    documentLike.removeEventListener?.('click', onClick);
  }

  const api = Object.freeze({ init, destroy, setTrack, syncPressed });
  return api;
}
