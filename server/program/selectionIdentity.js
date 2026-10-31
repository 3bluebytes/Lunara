// selectionIdentity.js — 选曲路径上的「同一首歌」判定。
//
// 只做三件事，全部是纯函数式、可单独测试的：
//   1. 把一条候选/排除引用归一成 (provider, songId)；
//   2. 用它查录音身份（没有身份层时退回供给身份，行为与今天一致）；
//   3. 按已确认录音去重 —— 优先收藏来源，其次保留代表源。
//
// 为什么单独成模块：`MusicSelectionService` 依赖很多、构造很重，把这段逻辑放进去
// 就只能靠大型集成测试覆盖。而这里恰好是最容易出错的地方（同一首歌出现两遍、
// 或把不同版本误并成一条），值得有直接的断言。

import { getRecordingStore as getSharedRecordingStore } from '../music/recordingStore.js';
import { collectionPriority } from '../library/collectionSourceAffinity.js';

function providerOfTrack(track) {
  // `candidateOrigin` 可能带子来源前缀（`ncm:liked`），供给身份只取供应商那一段。
  return String(track?.candidateOrigin || track?.provider || track?.source || '')
    .trim()
    .toLowerCase()
    .split(/[:-]/)[0];
}

function songIdOfTrack(track) {
  return String(track?.songId ?? track?.song_id ?? '').trim();
}

function supplyKey(provider, songId) {
  return `${provider}:${songId}`;
}

/**
 * @param {object} options
 * @param {() => {recordingOf: Function} | null} options.getRecordingStore 惰性取身份层
 */
// 默认用进程内共享的录音身份层。默认而不是注入的理由很实际：组合根有行数预算，
// 每加一个接线点都要挤掉别的东西；而这一层是纯读取、失败即退回供给身份。
// 测试可以显式传 `{ getRecordingStore: () => null }` 或替身。
export function createSelectionIdentity({ getRecordingStore = getSharedRecordingStore } = {}) {
  function store() {
    try {
      return getRecordingStore?.() || null;
    } catch {
      return null; // 身份层不可用不能拖垮选曲：退回供给身份即可。
    }
  }

  /**
   * 一条候选的身份键。没有身份层、没有 songId、或身份层报错时都退回供给键，
   * 这保证「未合并时行为与之前逐字一致」。
   */
  function keyOfTrack(track) {
    const provider = providerOfTrack(track);
    const songId = songIdOfTrack(track);
    if (!provider || !songId) return `${provider}:${track?.artist || ''}:${track?.title || ''}`;
    const recording = store();
    if (!recording) return supplyKey(provider, songId);
    try {
      return recording.recordingOf(provider, songId).recordingId;
    } catch {
      return supplyKey(provider, songId);
    }
  }

  /** 一条排除引用的身份键（形如 `{provider, songId}`）。 */
  function keyOfRef(ref) {
    const provider = String(ref?.provider ?? '').trim().toLowerCase().split(/[:-]/)[0];
    const songId = String(ref?.songId ?? ref?.song_id ?? '').trim();
    if (!provider || !songId) return '';
    const recording = store();
    if (!recording) return supplyKey(provider, songId);
    try {
      return recording.recordingOf(provider, songId).recordingId;
    } catch {
      return supplyKey(provider, songId);
    }
  }

  /** 一组排除引用 → 身份键集合。空键被丢掉，不制造「排除一切」的意外。 */
  function keySetOfRefs(refs) {
    const set = new Set();
    for (const ref of Array.isArray(refs) ? refs : []) {
      const key = keyOfRef(ref);
      if (key) set.add(key);
    }
    return set;
  }

  /**
   * 按身份去重：先优先收藏来源，同级再留代表源那一条 —— 展示与点播要落在
   * 同一个源上，否则「我的歌」会随展示时机变来变去。
   * 保留首次出现的位置，避免打乱已有的排序语义。
   */
  function dedupeByRecording(tracks) {
    const rows = Array.isArray(tracks) ? tracks : [];
    const chosen = new Map();
    const order = [];
    for (const track of rows) {
      const key = keyOfTrack(track);
      const existing = chosen.get(key);
      if (!existing) {
        chosen.set(key, track);
        order.push(key);
        continue;
      }
      // 只在已确认的同组内比较：喜欢歌单 > 普通歌单 > 在线；同级保留代表源。
      const collected = collectionPriority(track), previousCollected = collectionPriority(existing);
      if ((collected > previousCollected)
        || (collected === previousCollected && isFromRepresentative(track) && !isFromRepresentative(existing))) {
        chosen.set(key, track);
      }
    }
    return order.map(key => chosen.get(key));
  }

  function representativeKey(track) {
    const provider = providerOfTrack(track);
    const songId = songIdOfTrack(track);
    const recording = store();
    if (!recording || !provider || !songId) return null;
    try {
      return recording.recordingOf(provider, songId).representative || null;
    } catch {
      return null;
    }
  }

  function isFromRepresentative(track) {
    const representative = representativeKey(track);
    if (!representative) return false;
    return providerOfTrack(track) === String(representative.provider).toLowerCase()
      && songIdOfTrack(track) === String(representative.songId);
  }

  return { providerOfTrack, songIdOfTrack, keyOfTrack, keyOfRef, keySetOfRefs, dedupeByRecording };
}
