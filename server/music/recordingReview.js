import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from '../services/ServiceError.js';
import { providerRegistry } from './providerRegistry.js';
import { isFingerprintMatch } from '../media/audioFingerprint.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = track => JSON.stringify([track.provider, track.songId]);
const normalized = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const MAX_TRACKS = 5000;
const MAX_BATCH = 50;
const problem = (status, message, code) => { throw new ServiceError(status, message, code); };

/**
 * 只提候选，永不写等价关系。
 *
 * 两条证据来源分开表达：
 * - **音频指纹**（已下载资产算出来的）：听起来是同一首，排前面并预选；
 * - **元数据**（歌名/歌手/专辑/时长）：值得看一眼。
 * 两者都只是提议。指纹没有权威性（design D3），所以它只影响排序与预选。
 */
export function proposeRecordings(tracks, recordings, { fingerprints = [] } = {}) {
  const buckets = new Map();
  for (const track of tracks) {
    if (!recordings.recordingOf(track.provider, track.songId).isSelf) continue;
    const title = normalized(track.title), artist = normalized(track.artist);
    if (!title || !artist) continue;
    const bucket = JSON.stringify([title, artist]);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(track);
  }
  const proposals = [];
  for (const members of buckets.values()) {
    // 一个源有两个同名候选时无法判定是哪一版：不把模糊分组交给「全部确认」。
    if (members.length < 2 || new Set(members.map(track => track.provider)).size !== members.length) continue;
    const albums = members.map(track => normalized(track.album));
    const durations = members.map(track => Number(track.duration));
    // 保留完整标题（含 Live/remix 等后缀），不去括号、不靠时长放宽版本条件。
    if (!albums[0] || !albums.every(album => album === albums[0])
      || !durations.every(duration => duration > 0 && Number.isFinite(duration))
      || Math.max(...durations) - Math.min(...durations) > 3) continue;
    members.sort((a, b) => key(a).localeCompare(key(b)));
    proposals.push({ id: digest(members), title: members[0].title, artist: members[0].artist,
      reason: '歌名、歌手和专辑相同，时长接近；仍需你确认。', members });
  }
  for (const proposal of fingerprintProposals(tracks, recordings, fingerprints)) {
    // 元数据已经提过同一组：补一条指纹证据，而不是列两行让用户看两遍。
    const same = proposals.find(item => membersKey(item.members) === membersKey(proposal.members));
    if (same) { same.evidence = 'fingerprint'; same.reason = proposal.reason; continue; }
    proposals.push(proposal);
  }
  return proposals.sort((a, b) => {
    const rank = item => (item.evidence === 'fingerprint' ? 0 : 1);
    return rank(a) - rank(b) || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

const membersKey = members => members.map(member => `${member.provider}:${member.songId}`).sort().join('|');

/** 指纹一致的跨源组合：每源恰好一条、都还没合并过。 */
function fingerprintProposals(tracks, recordings, fingerprints) {
  const byIdentity = new Map(tracks.map(track => [`${track.provider}:${track.songId}`, track]));
  const rows = (Array.isArray(fingerprints) ? fingerprints : [])
    .map(row => ({ row, track: byIdentity.get(`${row.provider}:${row.songId}`) }))
    .filter(item => item.track && item.row.fingerprint
      && recordings.recordingOf(item.row.provider, item.row.songId).isSelf);
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const left = rows[i];
      const right = rows[j];
      if (left.row.provider === right.row.provider) continue;
      if (!isFingerprintMatch(left.row.fingerprint, right.row.fingerprint)) continue;
      const members = [left.track, right.track].sort((a, b) => membersKey([a]).localeCompare(membersKey([b])));
      out.push({ id: digest(members), title: members[0].title, artist: members[0].artist,
        evidence: 'fingerprint',
        reason: '两段音频听起来是同一首；仍需你确认。', members });
    }
  }
  return out;
}

/**
 * 所有写入都在 recordings.db 的同一事务中完成。tagStore 必须共用该连接，
 * 否则「保存标签成功、拆分失败」会留下半笔操作。无网络、无模型、无播放动作。
 */
export class RecordingReviewService {
  constructor({ recordings, tagStore, readCatalog, getFingerprints = null, onChanged = () => {}, now = Date.now } = {}) {
    if (!recordings?.db || tagStore?.db !== recordings.db || typeof readCatalog !== 'function') {
      throw new TypeError('recording review requires one shared SQLite connection and a local catalog reader');
    }
    Object.assign(this, { recordings, tagStore, readCatalog, now });
    this.getFingerprints = typeof getFingerprints === 'function' ? getFingerprints : null;
    this.onChanged = () => { try { onChanged(); } catch { /* a committed write remains accepted even if presentation fails */ } };
    this.db = recordings.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recording_review_batches (
        request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, batch_id TEXT NOT NULL UNIQUE,
        groups_json TEXT NOT NULL, created_at INTEGER NOT NULL, undone_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS recording_review_preferences (
        id INTEGER PRIMARY KEY CHECK(id = 1), dismissals INTEGER NOT NULL, seen_json TEXT NOT NULL
      );
    `);
  }

  catalog() {
    const unique = new Map();
    for (const row of this.readCatalog({ limit: MAX_TRACKS + 1 })) {
      const provider = String(row.provider || '').trim();
      const songId = String(row.songId ?? row.song_id ?? '').trim();
      if (!providerRegistry.isPlayable(provider) || !songId) continue;
      const track = { provider, songId, sourceName: providerRegistry.displayName(provider),
        title: String(row.title || ''), artist: String(row.artist || ''), album: String(row.album || ''),
        duration: Number(row.duration) || 0 };
      unique.set(key(track), track);
    }
    const truncated = unique.size > MAX_TRACKS;
    return { tracks: [...unique.values()].slice(0, MAX_TRACKS).sort((a, b) => key(a).localeCompare(key(b))), truncated };
  }

  readFingerprints() {
    try { return this.getFingerprints?.()?.ready?.(300) || []; } catch { return []; }
  }

  groupSignature(group) {
    return digest({ ...group, decisions: this.recordings.decisions(group.recordingId) });
  }

  /** 只读：重复访问不会合并、打标、触发模型或改变提示次数。 */
  snapshot() {
    const { tracks, truncated } = this.catalog();
    const byKey = new Map(tracks.map(track => [key(track), track]));
    const groups = this.recordings.groups();
    const recordings = groups.map(group => ({ ...group, revision: this.groupSignature(group),
      members: group.members.map(member => byKey.get(key(member)) || {
        ...member, sourceName: providerRegistry.displayName(member.provider), title: '未在当前曲库中', artist: '', album: '', duration: 0,
      }) }));
    // 指纹只是提议证据：读不到（未接队列 / 表为空 / 打不开库）时照旧只按元数据提议。
    const fingerprints = this.readFingerprints();
    const proposals = proposeRecordings(tracks, this.recordings, { fingerprints });
    const prefs = this.db.prepare('SELECT * FROM recording_review_preferences WHERE id=1').get();
    const seen = new Set(prefs ? JSON.parse(prefs.seen_json) : []);
    const newCount = proposals.filter(proposal => !seen.has(proposal.id)).length;
    const identities = new Set(tracks.map(track => this.recordings.recordingOf(track.provider, track.songId).recordingId));
    const latest = this.db.prepare('SELECT batch_id, groups_json FROM recording_review_batches WHERE undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
    return {
      revision: digest([tracks, groups]),
      trackCount: identities.size, alignedCount: tracks.length - identities.size, truncated,
      showPrompt: proposals.length >= 5 && (!prefs || (prefs.dismissals === 1 && newCount >= 20)),
      proposals: proposals.slice(0, 200), proposalCount: proposals.length,
      recordings: recordings.slice(0, 200), recordingCount: recordings.length,
      latestBatchId: latest?.batch_id || null,
    };
  }

  dismiss() {
    const view = this.snapshot();
    const previous = this.db.prepare('SELECT * FROM recording_review_preferences WHERE id=1').get();
    const ids = view.proposals.map(proposal => proposal.id);
    // 重复点击/重试同一批不消耗第二次提醒预算。
    if (previous?.seen_json === JSON.stringify(ids)) return { ok: true };
    this.db.prepare(`INSERT INTO recording_review_preferences VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET dismissals=excluded.dismissals, seen_json=excluded.seen_json`)
      .run(Math.min(2, (previous?.dismissals || 0) + 1), JSON.stringify(ids));
    return { ok: true };
  }

  confirm({ requestId, revision, proposalIds } = {}) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 160
      || !Array.isArray(proposalIds) || !proposalIds.length || proposalIds.length > MAX_BATCH
      || new Set(proposalIds).size !== proposalIds.length || proposalIds.some(id => typeof id !== 'string')) {
      problem(400, '请选择要对齐的歌曲后重试。', 'invalid_recording_selection');
    }
    const requestHash = digest([revision, [...proposalIds].sort()]);
    const result = this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT * FROM recording_review_batches WHERE request_id=?').get(requestId);
      if (receipt) {
        if (receipt.request_hash !== requestHash) problem(409, '这次操作内容已变化，请刷新后重试。', 'recording_request_conflict');
        return { ok: true, batchId: receipt.batch_id, confirmed: JSON.parse(receipt.groups_json).length, replay: true };
      }
      const view = this.snapshot();
      if (revision !== view.revision) problem(409, '曲库已变化，请刷新后再确认。', 'stale_recording_review');
      const selected = proposalIds.map(id => view.proposals.find(proposal => proposal.id === id));
      if (selected.some(proposal => !proposal)) problem(409, '部分候选已变化，请刷新后再确认。', 'stale_recording_proposal');
      const batchId = randomUUID();
      const groups = [];
      for (const proposal of selected) {
        const [a, ...others] = proposal.members;
        let recordingId;
        for (const b of others) {
          ({ recordingId } = this.recordings.link({ a, b, kind: 'user-confirmed',
            decidedBy: 'listener', evidence: { batchId, proposalId: proposal.id } }));
        }
        const group = this.recordings.groups().find(item => item.recordingId === recordingId);
        groups.push({ ...group, signature: this.groupSignature(group) });
      }
      this.db.prepare('INSERT INTO recording_review_batches VALUES (?, ?, ?, ?, ?, NULL)')
        .run(requestId, requestHash, batchId, JSON.stringify(groups), this.now());
      return { ok: true, batchId, confirmed: groups.length };
    }).immediate();
    this.onChanged();
    return result;
  }

  /** 整批撤销或单组拆分：先校验整笔，再在同一连接中保留标签并撤回。 */
  split({ batchId, recordingId, revision } = {}) {
    if (Boolean(batchId) === Boolean(recordingId)
      || (batchId && (typeof batchId !== 'string' || batchId.length > 160))
      || (recordingId && (typeof recordingId !== 'string' || typeof revision !== 'string'))) {
      problem(400, '请选择要拆分的歌曲或要撤销的那次对齐。', 'invalid_recording_split');
    }
    const result = this.db.transaction(() => {
      let groups, batch;
      if (batchId) {
        batch = this.db.prepare('SELECT * FROM recording_review_batches WHERE batch_id=?').get(batchId);
        if (!batch) problem(404, '这次对齐记录不存在。', 'recording_batch_missing');
        if (batch.undone_at != null) return { ok: true, replay: true };
        groups = JSON.parse(batch.groups_json);
      } else {
        const group = this.recordings.groups().find(item => item.recordingId === recordingId);
        if (!group) problem(404, '这首歌已不在对齐列表中。', 'recording_missing');
        groups = [{ ...group, signature: revision }];
      }
      for (const before of groups) {
        const current = this.recordings.groups().find(group => group.recordingId === before.recordingId);
        if (!current || this.groupSignature(current) !== before.signature) {
          problem(409, '对齐关系已变化，请刷新后再拆分。', 'stale_recording_group');
        }
      }
      for (const group of groups) {
        // 如未读过合并后的标签，先提升一次；所有数据库写入仍属于本事务。
        const first = group.members[0];
        this.tagStore.getTags(first.songId, first.provider);
        this.tagStore.preserveTagsAcrossUnlink(group);
        this.recordings.dissolve({ recordingId: group.recordingId, evidence: { batchId: batchId || null } });
      }
      if (batch) this.db.prepare('UPDATE recording_review_batches SET undone_at=? WHERE batch_id=?').run(this.now(), batchId);
      // 用户拆开的那一批不立即又催一次合并。
      const ids = this.snapshot().proposals.map(proposal => proposal.id);
      this.db.prepare(`INSERT INTO recording_review_preferences VALUES (1, 1, ?)
        ON CONFLICT(id) DO UPDATE SET seen_json=excluded.seen_json, dismissals=MAX(1, dismissals)`).run(JSON.stringify(ids));
      return { ok: true, split: groups.length };
    }).immediate();
    this.onChanged();
    return result;
  }
}
