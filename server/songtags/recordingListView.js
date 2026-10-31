// recordingListView.js — 标签库列表按「同一首歌」折行。
//
// 列表原本是 `song_tags` 的一行一首：同一首歌合并之后，另一个源的旧行还会继续
// 出现一次，用户看到的就是「同一首歌两行、标签可能还不一样」。这里把它们折成
// 一行：代表源 + 来源列表 + 「已合并」留痕，展开还能看到成员。
//
// 只在**展示层**折行：写入仍走既有 `patchTags` / `deleteTags`（它们已经按录音解析
// 身份），所以合并过的歌改一次标签就是整组生效，也不会因为列表折叠而多写一份。

const aliasKey = row => `${row.provider}:${row.song_id}`;

/**
 * @param {Array<object>} items `store.listTags()` 的行
 * @param {{recordings?: object, tagStore?: object}} deps
 * @returns {{items: Array<object>, folded: number}} folded = 被折掉的重复行数
 */
export function foldRecordingRows(items = [], { recordings = null, tagStore = null } = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (!recordings) return { items: rows, folded: 0 };
  const groups = new Map();
  const out = [];
  let folded = 0;
  for (const row of rows) {
    // 身份层不可用时退回「各自一行」：列表不能因为等价关系读不出来就变空。
    let identity = null;
    try { identity = recordings.recordingOf(row.provider, row.song_id); } catch { identity = null; }
    if (!identity || identity.isSelf) {
      out.push(row);
      continue;
    }
    const existing = groups.get(identity.recordingId);
    if (existing) {
      // 后出现的成员只是同一首歌的另一份供给身份：补进来源列表，不再占一行。
      existing.members.push({ provider: row.provider, songId: row.song_id, title: row.title, artist: row.artist });
      if (!existing.sources.includes(row.provider)) existing.sources.push(row.provider);
      folded += 1;
      continue;
    }
    const entry = {
      ...row,
      recordingId: identity.recordingId,
      merged: true,
      sources: [row.provider],
      members: [{ provider: row.provider, songId: row.song_id, title: row.title, artist: row.artist }],
      representativeProvider: row.provider,
    };
    groups.set(identity.recordingId, entry);
    out.push(entry);
  }
  // 标签属于录音：代表行显示共享值，而不是它自己那份可能过期的副本。
  for (const entry of groups.values()) {
    try {
      const shared = tagStore?.getTags?.(entry.members[0].songId, entry.members[0].provider);
      if (shared) Object.assign(entry, { ...shared, recordingId: entry.recordingId, merged: true,
        sources: entry.sources, members: entry.members, representativeProvider: entry.representativeProvider });
    } catch { /* 读共享标签失败时退回已展示的行，不让整个列表报错 */ }
  }
  const order = new Map(rows.map((row, index) => [aliasKey(row), index]));
  return {
    items: out.sort((a, b) => (order.get(aliasKey(a)) ?? 0) - (order.get(aliasKey(b)) ?? 0)),
    folded,
  };
}

/** 已被折进代表行的成员（用于修正 total：它们各自还占着一行 song_tags）。 */
export function duplicatesOf(items = [], store = null) {
  const pairs = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.merged || !Array.isArray(item.members)) continue;
    for (const member of item.members.slice(1)) {
      pairs.push({ provider: member.provider, songId: member.songId });
    }
  }
  return store?.countSongTagRows?.(pairs) ?? 0;
}
