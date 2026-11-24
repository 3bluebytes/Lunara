// LifeContextService — 今日生活数据的校验、CRUD 编排与统一权限投影。
//
// 三个消费点（聊天 prompt、选歌软参考、串词）复用同一 buildLifeContextSnapshot：
// 先按 日期/伙伴授权/群聊全员/撤回 过滤，再生成有界、带来源与 planned 标记的
// LifeContextSnapshot。计划不是事实：confirmedScene 只来自用户显式操作或原话，
// 到点不自动确认任何活动。

import { repeatFrequency, isRecurringTask, entryOccursOn, occurrenceDone } from '../../pwa/core/lifeRecurrence.js';
import { createHash, randomUUID } from 'node:crypto';
import { isCompanionModeId } from '../playback/companionModes.js';
import { LIFE_SCHEMA_VERSION } from './LifeContextStore.js';

export const LIFE_SNAPSHOT_MAX_ENTRIES = 8;
export const LIFE_SNAPSHOT_MAX_CHARS = 2400;

export class LifeValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifeValidationError';
    this.code = code;
    this.userMessage = message;
  }
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const ENTRY_TYPES = new Set(['event', 'todo', 'important_date', 'note']);
const DAY_TYPES = new Set(['work', 'rest']);

function reject(code, message) {
  throw new LifeValidationError(code, message);
}

function isValidLocalDate(value) {
  if (!LOCAL_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(part => Number.parseInt(part, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function localDateParts(value) {
  const [year, month, day] = value.split('-').map(part => Number.parseInt(part, 10));
  return { year, month, day };
}

function cleanPersonIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(id => String(id || '').trim()).filter(Boolean))];
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanTags(value, sceneTag = null) {
  const list = Array.isArray(value) ? value : [];
  const normalized = list
    .map(tag => cleanText(tag, 24))
    .filter(Boolean);
  if (!normalized.length && sceneTag) normalized.push(cleanText(sceneTag, 24));
  return [...new Set(normalized)].slice(0, 8);
}

const LAYOUT_VARIANTS = new Set(['blank', 'dotgrid', 'playbill']);

function cleanAttachedTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const title = cleanText(track.title, 160);
  const artist = cleanText(track.artist, 120);
  const provider = cleanText(track.provider, 32);
  const songId = cleanText(track.songId, 120);
  if (!title) return null;
  const playedAt = cleanText(track.playedAt, 16);
  const attachedAt = cleanText(track.attachedAt, 32);
  return {
    provider: provider || 'unknown',
    songId: songId || '',
    title,
    artist: artist || '',
    album: cleanText(track.album, 160) || '',
    stampedAt: cleanText(track.stampedAt, 32) || null,
    introExcerpt: cleanText(track.introExcerpt, 160) || null,
    ...(playedAt ? { playedAt } : {}),
    ...(attachedAt ? { attachedAt } : {}),
    ...(track.liked === true ? { liked: true } : {}),
    ...(Number.isInteger(track.afterLine) && track.afterLine >= 0 ? { afterLine: track.afterLine } : {}),
    ...(Number.isFinite(track.order) ? { order: Number(track.order) } : {}),
  };
}

function cleanAttachedTracks(list) {
  const raw = Array.isArray(list) ? list : [];
  const seen = new Set();
  const tracks = [];
  for (const item of raw) {
    const cleaned = cleanAttachedTrack(item);
    if (!cleaned) continue;
    const identity = cleaned.songId ? `${cleaned.provider}:${cleaned.songId}` : `${cleaned.title}::${cleaned.artist}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    tracks.push(cleaned);
    if (tracks.length >= 12) break;
  }
  return tracks;
}

function cleanAttachedQuotes(list) {
  const raw = Array.isArray(list) ? list : [];
  const quotes = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = cleanText(item.text, 600);
    if (!text) continue;
    const turnId = cleanText(item.turnId, 128) || '';
    const speaker = cleanText(item.speaker, 64) || '伙伴';
    const time = cleanText(item.time, 16) || '';
    const key = turnId || `${speaker}::${time}::${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({
      ...(turnId ? { turnId } : {}),
      speaker,
      ...(item.personId ? { personId: cleanText(item.personId, 64) } : {}),
      time,
      text,
      ...(Number.isInteger(item.afterLine) && item.afterLine >= 0 ? { afterLine: item.afterLine } : {}),
      ...(Number.isFinite(item.order) ? { order: Number(item.order) } : {}),
    });
    if (quotes.length >= 12) break;
  }
  return quotes;
}

function cleanChecklist(list) {
  const raw = Array.isArray(list) ? list : [];
  const items = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanText(item.id, 64);
    const text = String(item.text ?? '').slice(0, 240);
    if (!id && !text.trim()) continue;
    items.push({
      id: id || `chk:${items.length + 1}`,
      text,
      done: item.done === true,
      ...(Number.isInteger(item.afterLine) && item.afterLine >= 0 ? { afterLine: item.afterLine } : {}),
      ...(Number.isFinite(item.order) ? { order: Number(item.order) } : {}),
    });
    if (items.length >= 50) break;
  }
  return items;
}

function cleanAnnotations(list) {
  const raw = Array.isArray(list) ? list : [];
  const annotations = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = cleanText(item.text, 400);
    if (!text) continue;
    const id = cleanText(item.id, 128) || `ann:${randomUUID()}`;
    const personId = cleanText(item.personId, 64) || 'lunara';
    const personName = cleanText(item.personName, 64) || '伙伴';
    const time = cleanText(item.time, 16) || '';
    const anchor = cleanText(item.anchor, 40) || '';
    const reply = cleanText(item.reply, 400) || '';
    const createdAt = Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now();
    const repliedAt = Number.isFinite(Number(item.repliedAt)) ? Number(item.repliedAt) : null;
    annotations.push({
      id,
      personId,
      personName,
      createdAt,
      time,
      anchor,
      text,
      reply,
      ...(repliedAt ? { repliedAt } : {}),
    });
    if (annotations.length >= 20) break;
  }
  return annotations;
}

function cleanLayoutVariant(value) {
  const v = String(value || '').trim();
  return LAYOUT_VARIANTS.has(v) ? v : 'blank';
}

function deriveNoteTitleFromContent(content, { checklist = [], attachedTracks = [], attachedQuotes = [] } = {}) {
  const firstLine = String(content || '')
    .split(/\r?\n/u)
    .map(line => line.replace(/^[-*#\s\[\]xX]+/u, '').trim())
    .find(Boolean);
  if (firstLine) return firstLine.slice(0, 36);
  const firstCheck = (checklist || []).map(item => String(item?.text || '').trim()).find(Boolean);
  if (firstCheck) return firstCheck.slice(0, 36);
  if (attachedTracks?.[0]?.title) return `听《${attachedTracks[0].title}》`.slice(0, 36);
  if (attachedQuotes?.[0]?.text) return String(attachedQuotes[0].text).trim().slice(0, 36);
  return '';
}

function shiftDateString(dateStr, deltaDays) {
  const [year, month, day] = dateStr.split('-').map(part => Number.parseInt(part, 10));
  const probe = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return probe.toISOString().slice(0, 10);
}

function daysBetweenDates(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function parseTimeString(value) {
  const [hours, minutes] = value.split(':').map(part => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

export class LifeContextService {
  constructor({ store, now = () => Date.now(), onRevisionChange = null } = {}) {
    if (!store) throw new TypeError('LifeContextService requires a store');
    this.store = store;
    this.now = now;
    this.onRevisionChange = typeof onRevisionChange === 'function' ? onRevisionChange : null;
    this.confirmedScenes = new Map();
  }

  _bump() {
    const revision = this.store.bumpContextRevision();
    return this._notifyRevision(revision);
  }

  _notifyRevision(revision, meta = { companionshipAffected: true }) {
    if (this.onRevisionChange) {
      try { this.onRevisionChange(revision, meta); } catch { /* 通知失败不阻断本地写入 */ }
    }
    return revision;
  }

  // ---- 读取 ----

  status() {
    return { schemaVersion: LIFE_SCHEMA_VERSION, contextRevision: this.store.contextRevision() };
  }

  getRoutine() {
    const row = this.store.getRoutine();
    if (!row) return { timeZone: null, workDays: [], workStartTime: null, workEndTime: null, revision: 0, configured: false };
    return {
      timeZone: row.time_zone,
      workDays: JSON.parse(row.work_days || '[]'),
      workStartTime: row.work_start_time || null,
      workEndTime: row.work_end_time || null,
      revision: row.revision,
      configured: true,
    };
  }

  getOverride(localDate) {
    const row = this.store.getOverride(String(localDate || ''));
    if (!row) return null;
    return { localDate: row.local_date, dayType: row.day_type, startTime: row.start_time || null,
      endTime: row.end_time || null, revision: row.revision };
  }

  listEntries() {
    return this.store.listEntries().map(LifeContextService.projectEntryRow);
  }

  getEntry(id) {
    const row = this.store.getEntry(String(id || ''));
    return row ? LifeContextService.projectEntryRow(row) : null;
  }

  static projectEntryRow(row) {
    const tags = parseJson(row.tags_json || '[]', []);
    const legacyTrack = row.attached_track_json ? parseJson(row.attached_track_json, null) : null;
    const rawTracks = row.attached_tracks_json ? parseJson(row.attached_tracks_json, []) : [];
    const attachedTracks = Array.isArray(rawTracks) && rawTracks.length
      ? rawTracks
      : (legacyTrack ? [legacyTrack] : []);
    const attachedTrack = legacyTrack || attachedTracks[0] || null;
    const attachedQuotes = parseJson(row.attached_quotes_json || '[]', []);
    const checklist = parseJson(row.checklist_json || '[]', []);
    const annotations = parseJson(row.annotations_json || '[]', []);
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content || null,
      localDate: row.local_date,
      endDate: row.end_date || null,
      startTime: row.start_time || null,
      endTime: row.end_time || null,
      done: row.done === 1,
      yearlyRepeat: row.yearly_repeat === 1,
      repeatFrequency: row.repeat_frequency || (row.yearly_repeat === 1 ? 'yearly' : 'none'),
      repeatWeekdays: JSON.parse(row.repeat_weekdays || '[]'),
      completedDates: row.completed_dates || [],
      useForCompanionship: row.use_for_companionship === 1,
      noteUsesTitle: row.note_uses_title === 1,
      companionNote: row.companion_note || null,
      allowedPersonIds: JSON.parse(row.allowed_person_ids || '[]'),
      sceneTag: row.scene_tag || null,
      mood: row.mood || null,
      tags: Array.isArray(tags) ? tags : [],
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      shareScope: row.share_scope === 'summary' ? 'summary' : 'note',
      attachedTrack,
      attachedTracks,
      attachedQuotes: Array.isArray(attachedQuotes) ? attachedQuotes : [],
      checklist: Array.isArray(checklist) ? checklist : [],
      annotations: Array.isArray(annotations) ? annotations : [],
      layoutVariant: cleanLayoutVariant(row.layout_variant),
      revision: row.revision,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  // ---- 写入（revision 防并发覆盖；成功持久化后才返回）----

  saveRoutine(input, { expectedRevision = null } = {}) {
    const timeZone = cleanText(input?.timeZone, 64) || null;
    if (timeZone == null && input?.workDays?.length) reject('routine-timezone-required', '设置了作息日期前需要先选择时区。');
    if (timeZone != null && !isValidTimeZone(timeZone)) reject('routine-invalid-timezone', '这个时区不可用，请检查拼写。');
    const workDays = Array.isArray(input?.workDays) ? input.workDays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [];
    const workStartTime = cleanText(input?.workStartTime, 5) || null;
    const workEndTime = cleanText(input?.workEndTime, 5) || null;
    for (const [label, value] of [['上班', workStartTime], ['下班', workEndTime]]) {
      if (value && !TIME_PATTERN.test(value)) reject('routine-invalid-time', `“${label}”时间格式应为 HH:MM。`);
    }
    // 上下班只作为本地墙钟时间保存，不换算成时刻，因此不存在夏令时映射问题。
    const existing = this.store.getRoutine();
    const nextRevision = LifeContextService.checkRevision(existing?.revision || 0, expectedRevision, 'routine');
    this.store.saveRoutine({ timeZone: timeZone || 'UTC', workDays: [...new Set(workDays)].sort(),
      workStartTime, workEndTime, revision: nextRevision });
    return this.getRoutine();
  }

  static checkRevision(current, expected, scope) {
    if (expected == null) return current + 1;
    if (!Number.isInteger(expected) || expected < 0 || expected !== current) {
      reject(`${scope}-revision-conflict`, '这份内容刚被修改过，请核对当前值后再保存。');
    }
    return current + 1;
  }

  saveOverride(input, { expectedRevision = null } = {}) {
    const localDate = cleanText(input?.localDate, 10);
    if (!isValidLocalDate(localDate)) reject('override-invalid-date', '日期无效，应为 YYYY-MM-DD。');
    if (!DAY_TYPES.has(input?.dayType)) reject('override-invalid-day-type', '需要标记为工作或休息。');
    const startTime = cleanText(input?.startTime, 5) || null;
    const endTime = cleanText(input?.endTime, 5) || null;
    for (const value of [startTime, endTime]) {
      if (value && !TIME_PATTERN.test(value)) reject('override-invalid-time', '时间格式应为 HH:MM。');
    }
    const existing = this.store.getOverride(localDate);
    const nextRevision = LifeContextService.checkRevision(existing?.revision || 0, expectedRevision, 'day-override');
    this.store.saveOverride({ localDate, dayType: input.dayType, startTime, endTime, revision: nextRevision });
    return this.getOverride(localDate);
  }

  deleteOverride(localDate, { expectedRevision = null } = {}) {
    const existing = this.store.getOverride(String(localDate || ''));
    if (existing) LifeContextService.checkRevision(existing.revision, expectedRevision, 'day-override');
    this.store.deleteOverride(String(localDate || ''));
    this._bump();
    return { deleted: true };
  }

  validateEntryInput(input) {
    const type = String(input?.type || '');
    if (!ENTRY_TYPES.has(type)) reject('entry-invalid-type', '条目类型不支持。');
    const rawContent = String(input?.content ?? '').trim();
    if (rawContent.length > 5000) reject('entry-content-too-long', '手帐正文最多 5000 字，请精简后再保存。');
    const content = rawContent || null;
    const hasExplicitTracks = Array.isArray(input?.attachedTracks);
    const singleTrack = cleanAttachedTrack(input?.attachedTrack);
    const attachedTracks = hasExplicitTracks
      ? cleanAttachedTracks(input.attachedTracks)
      : (singleTrack ? [singleTrack] : []);
    const attachedTrack = attachedTracks[0] || null;
    const attachedQuotes = cleanAttachedQuotes(input?.attachedQuotes);
    const checklist = cleanChecklist(input?.checklist);
    const annotations = cleanAnnotations(input?.annotations);
    const layoutVariant = cleanLayoutVariant(input?.layoutVariant);
    let title = cleanText(input?.title, 120);
    if (!title && type === 'note') {
      title = deriveNoteTitleFromContent(content, { checklist, attachedTracks, attachedQuotes });
    }
    if (!title) reject('entry-title-required', '需要填写标题。');
    const localDate = cleanText(input?.localDate, 10);
    if (!isValidLocalDate(localDate)) reject('entry-invalid-date', '日期无效，应为 YYYY-MM-DD。');
    const endDate = cleanText(input?.endDate, 10) || null;
    if (endDate && !isValidLocalDate(endDate)) reject('entry-invalid-end-date', '结束日期无效。');
    if (endDate && endDate < localDate) reject('entry-reversed-range', '结束日期不能早于开始日期。');
    const startTime = cleanText(input?.startTime, 5) || null;
    const endTime = cleanText(input?.endTime, 5) || null;
    for (const [label, value] of [['开始', startTime], ['结束', endTime]]) {
      if (value && !TIME_PATTERN.test(value)) reject('entry-invalid-time', `“${label}”时间格式应为 HH:MM。`);
    }
    if (startTime && endTime && !endDate && endTime <= startTime) {
      reject('entry-reversed-range', '跨夜安排需要明确的结束日期，或让结束时间晚于开始时间。');
    }
    const frequency = repeatFrequency(input || {});
    if (!['none', 'daily', 'weekly', 'yearly'].includes(frequency)) reject('entry-invalid-repeat', '重复频率无效。');
    if ((type === 'note' && frequency !== 'none') || (type === 'important_date' && !['none', 'yearly'].includes(frequency))) reject('entry-invalid-repeat', '此类型不支持这个重复频率。');
    const weekdays = frequency === 'weekly' ? input?.repeatWeekdays : [];
    if (frequency === 'weekly' && (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) reject('entry-invalid-weekdays', '每周重复至少选择一个有效星期。');
    if (['todo', 'event'].includes(type) && frequency !== 'none' && endDate && endDate !== localDate) reject('entry-repeat-range', '重复待办暂不支持跨日范围，请将结束日期设为开始日期。');
    const yearlyRepeat = frequency === 'yearly';
    const useForCompanionship = input?.useForCompanionship === true;
    const allowedPersonIds = cleanPersonIds(input?.allowedPersonIds);
    if (useForCompanionship && allowedPersonIds.length === 0) {
      reject('entry-persons-required', '开启“用于陪伴与选歌”至少要选择一位伙伴。');
    }
    const companionNote = cleanText(input?.companionNote, 300) || null;
    const rawScope = input?.shareScope;
    const noteUsesTitle = input?.noteUsesTitle === true || rawScope === 'summary';
    const shareScope = rawScope === 'note' || rawScope === 'summary'
      ? rawScope
      : (noteUsesTitle ? 'summary' : 'note');
    const sceneTag = cleanText(input?.sceneTag, 40) || null;
    const hasExplicitTags = Array.isArray(input?.tags);
    const tags = hasExplicitTags ? cleanTags(input.tags) : [];
    const mood = cleanText(input?.mood, 24) || null;
    const pinned = input?.pinned === true;
    const archived = input?.archived === true;
    const storedShareScope = input?.shareScope === 'summary' ? 'summary'
      : (input?.shareScope === 'note' ? 'note' : (noteUsesTitle ? 'summary' : 'note'));
    const entryDefaults = {
      type, title, content, localDate, endDate, startTime, endTime,
      done: input?.done === true,
      yearlyRepeat, repeatFrequency: frequency, repeatWeekdays: [...new Set(weekdays)].sort(),
      useForCompanionship,
      noteUsesTitle,
      companionNote,
      allowedPersonIds,
      sceneTag,
      ...(mood ? { mood } : {}),
      ...(tags.length ? { tags } : {}),
      ...(pinned ? { pinned } : {}),
      ...(archived ? { archived } : {}),
      ...(rawScope ? { shareScope: storedShareScope } : {}),
      ...(attachedTrack ? { attachedTrack } : {}),
      ...(hasExplicitTracks && attachedTracks.length ? { attachedTracks } : {}),
      ...(attachedQuotes.length ? { attachedQuotes } : {}),
      ...(checklist.length ? { checklist } : {}),
      ...(annotations.length ? { annotations } : {}),
      ...(layoutVariant !== 'blank' ? { layoutVariant } : {}),
    };
    return entryDefaults;
  }

  createEntry(input) {
    if (Object.hasOwn(input || {}, 'completedDates')) reject('entry-completion-readonly', '完成记录需要通过当次完成操作更新。');
    const entry = this.validateEntryInput(input);
    if (isRecurringTask(entry) && entry.done) reject('entry-completion-date-required', '重复待办请按具体日期标记完成。');
    const requestId = input?.clientRequestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128)) {
      reject('entry-invalid-request-id', '保存请求标识无效，请重新发起操作。');
    }
    // validateEntryInput 的固定字段顺序及无序授权集合形成稳定摘要，不保存第二份私密正文。
    const payloadHash = requestId === undefined ? null : createHash('sha256')
      .update(JSON.stringify({ ...entry, allowedPersonIds: [...entry.allowedPersonIds].sort() })).digest('hex');
    const { repeatFrequency: frequency, repeatWeekdays, ...legacyEntry } = entry;
    const legacyCompatible = frequency === 'none' || (frequency === 'yearly' && entry.type === 'important_date');
    const legacyPayloadHash = legacyCompatible && payloadHash ? createHash('sha256')
      .update(JSON.stringify({ ...legacyEntry, allowedPersonIds: [...entry.allowedPersonIds].sort() })).digest('hex') : null;
    const result = this.store.transaction(() => {
      const receipt = requestId === undefined ? null : this.store.getEntryCreateRequest(requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash && receipt.payload_hash !== legacyPayloadHash) {
          reject('entry-request-conflict', '这次保存请求对应的内容已变化，请核对后重新保存。');
        }
        const current = this.getEntry(receipt.entry_id);
        if (!current) reject('entry-request-deleted', '这条内容已经删除，无法重试原来的保存请求。');
        return { entry: current, revision: null };
      }
      const id = `life:${randomUUID()}`;
      const revision = this.store.insertEntry({
        ...entry,
        id,
        shareScope: entry.shareScope || (entry.noteUsesTitle ? 'summary' : 'note'),
      });
      if (requestId !== undefined) this.store.recordEntryCreateRequest(requestId, payloadHash, id);
      return { entry: this.getEntry(id), revision };
    });
    // 只有事务提交后才使消费者失效；请求重放不写入、不重复通知。
    if (result.revision !== null) {
      this._notifyRevision(result.revision, { companionshipAffected: Boolean(entry.useForCompanionship) });
    }
    return result.entry;
  }

  updateEntry(id, input, { expectedRevision = null } = {}) {
    const result = this.store.transaction(() => {
      const existing = this.getEntry(id);
      if (!existing) reject('entry-not-found', '这条内容已经不存在。');
      const nextRevision = LifeContextService.checkRevision(existing.revision, expectedRevision, 'entry');
      // PATCH 只合并显式值。undefined 与省略等价，null 才交给校验器清空可空字段。
      const patch = Object.fromEntries(Object.entries(input || {}).filter(([, value]) => value !== undefined));
      if (Object.hasOwn(patch, 'completedDates')) reject('entry-completion-readonly', '完成记录需要通过当次完成操作更新。');
      // Compatibility PATCH can still use yearlyRepeat if no explicit rule was sent.
      if (Object.hasOwn(patch, 'yearlyRepeat') && !Object.hasOwn(patch, 'repeatFrequency')) patch.repeatFrequency = patch.yearlyRepeat ? 'yearly' : 'none';
      const baseForPatch = {
        ...existing,
        // 未传 shareScope 时允许 noteUsesTitle / shareScope 沿旧口径演化
        ...(!Object.hasOwn(patch, 'shareScope') && Object.hasOwn(patch, 'noteUsesTitle') ? { shareScope: undefined } : {}),
        // 若调用方只改旧版单曲 attachedTrack 而未传 attachedTracks，清除旧 attachedTracks 避免回流。
        ...(Object.hasOwn(patch, 'attachedTrack') && !Object.hasOwn(patch, 'attachedTracks') ? { attachedTracks: undefined } : {}),
      };
      const entry = this.validateEntryInput({ ...baseForPatch, ...patch });
      if ((isRecurringTask(existing) || isRecurringTask(entry)) && Object.hasOwn(patch, 'done')) reject('entry-completion-date-required', '重复待办请按具体日期标记完成。');
      const revision = this.store.updateEntry(String(id), {
        ...entry,
        shareScope: entry.shareScope || (entry.noteUsesTitle ? 'summary' : 'note'),
        revision: nextRevision,
      });
      return {
        entry: this.getEntry(id),
        revision,
        companionshipAffected: Boolean(existing.useForCompanionship || entry.useForCompanionship),
      };
    });
    this._notifyRevision(result.revision, { companionshipAffected: result.companionshipAffected });
    return result.entry;
  }

  /** 用户明确勾选完成；不自动推进任何现实状态。 */
  setEntryDone(id, done, { expectedRevision = null, occurrenceDate = null } = {}) {
    const result = this.store.transaction(() => {
      const existing = this.getEntry(String(id || ''));
      if (!existing) reject('entry-not-found', '这条内容已经不存在。');
      const restoringHistory = done !== true && occurrenceDate != null && existing.completedDates.includes(occurrenceDate);
      const occurrenceOperation = isRecurringTask(existing) || occurrenceDate != null;
      if (occurrenceOperation && expectedRevision == null) reject('entry-revision-required', '请刷新条目后再标记本次完成。');
      const nextRevision = LifeContextService.checkRevision(existing.revision, expectedRevision, 'entry');
      if (occurrenceOperation) {
        if (!restoringHistory && (!isRecurringTask(existing) || !entryOccursOn(existing, occurrenceDate))) reject('entry-invalid-occurrence', '需要选择此重复待办实际发生的日期。');
        this.store.setOccurrenceDone(existing.id, occurrenceDate, done === true);
        // Legacy global done describes the original occurrence only; restoring it clears that legacy flag.
        if (occurrenceDate === existing.localDate && !done) existing.done = false;
      } else existing.done = done === true;
      const revision = this.store.updateEntry(existing.id, { ...existing, revision: nextRevision });
      return {
        entry: this.getEntry(existing.id),
        revision,
        companionshipAffected: Boolean(existing.useForCompanionship),
      };
    });
    this._notifyRevision(result.revision, { companionshipAffected: result.companionshipAffected });
    return result.entry;
  }

  deleteEntry(id, { expectedRevision = null } = {}) {
    const result = this.store.transaction(() => {
      const existing = this.store.getEntry(String(id || ''));
      if (!existing) return null;
      LifeContextService.checkRevision(existing.revision, expectedRevision, 'entry');
      const wasShared = existing.use_for_companionship === 1;
      return { revision: this.store.deleteEntry(String(id)), companionshipAffected: wasShared };
    });
    if (result === null) return { deleted: false };
    this._notifyRevision(result.revision, { companionshipAffected: result.companionshipAffected });
    return { deleted: true };
  }

  /** 撤回陪伴授权：正文保留为本地私有，模型上下文不再出现。 */
  revokeEntryCompanionship(id) {
    const revision = this.store.revokeEntryCompanionship(String(id || ''));
    if (this.onRevisionChange) {
      try { this.onRevisionChange(revision, { companionshipAffected: true }); } catch { /* 同 _bump */ }
    }
    return this.getEntry(id);
  }

  /** 为手帐页追加一条伙伴页边批注，并自动授予该伙伴当日同页可见权限。 */
  appendAnnotation(id, annotationInput, { expectedRevision = null } = {}) {
    const cleanedList = cleanAnnotations([annotationInput]);
    if (!cleanedList.length) reject('entry-annotation-invalid', '批注内容不能为空。');
    const annotation = cleanedList[0];
    const result = this.store.transaction(() => {
      const existing = this.getEntry(String(id || ''));
      if (!existing) reject('entry-not-found', '这条内容已经不存在。');
      const nextRevision = LifeContextService.checkRevision(existing.revision, expectedRevision, 'entry');
      const allowedPersonIds = cleanPersonIds([...(existing.allowedPersonIds || []), annotation.personId]);
      const annotations = [...(existing.annotations || []).slice(-19), annotation];
      const revision = this.store.updateEntry(String(existing.id), {
        ...existing,
        useForCompanionship: true,
        allowedPersonIds,
        annotations,
        revision: nextRevision,
      });
      return { entry: this.getEntry(existing.id), revision };
    });
    this._notifyRevision(result.revision, { companionshipAffected: true });
    return { entry: result.entry, annotation };
  }

  // ---- 场景默认 ----

  listSceneDefaults() {
    return this.store.listSceneDefaults().map(row => ({ sceneTag: row.scene_tag, modeId: row.mode_id, revision: row.revision }));
  }

  getSceneDefault(sceneTag) {
    const row = this.store.getSceneDefault(cleanText(sceneTag, 40));
    return row ? { sceneTag: row.scene_tag, modeId: row.mode_id, revision: row.revision } : null;
  }

  saveSceneDefault(sceneTag, modeId, { expectedRevision = null } = {}) {
    const tag = cleanText(sceneTag, 40);
    if (!tag) reject('scene-tag-required', '需要场景名称。');
    if (!isCompanionModeId(modeId)) reject('scene-invalid-mode', '需要选择三个陪伴模式之一。');
    const existing = this.store.getSceneDefault(tag);
    const nextRevision = LifeContextService.checkRevision(existing?.revision || 0, expectedRevision, 'scene-default');
    this.store.saveSceneDefault(tag, modeId, nextRevision);
    this._bump();
    return { sceneTag: tag, modeId, revision: nextRevision };
  }

  deleteSceneDefault(sceneTag) {
    this.store.deleteSceneDefault(cleanText(sceneTag, 40));
    this._bump();
    return { deleted: true };
  }

  // ---- confirmedScene（显式使用，限本会话，本地日结束失效）----

  confirmScene({ listeningSessionId, sceneTag, source = 'user_action', targetDate }) {
    const tag = cleanText(sceneTag, 40);
    if (!tag) reject('scene-tag-required', '需要场景名称。');
    if (!['user_action', 'user_statement'].includes(source)) reject('scene-invalid-source', '场景来源无效。');
    this.confirmedScenes.set(String(listeningSessionId), {
      sceneTag: tag, source, setAt: this.now(), localDate: String(targetDate || ''),
    });
    return this.confirmedScenes.get(String(listeningSessionId));
  }

  clearConfirmedScene(listeningSessionId) {
    this.confirmedScenes.delete(String(listeningSessionId || ''));
    return { cleared: true };
  }

  getConfirmedScene(listeningSessionId, targetDate) {
    const confirmed = this.confirmedScenes.get(String(listeningSessionId || ''));
    if (!confirmed) return null;
    // 本地日结束失效；到点不清除会话中的其他状态。
    if (targetDate && confirmed.localDate && confirmed.localDate !== targetDate) {
      this.confirmedScenes.delete(String(listeningSessionId));
      return null;
    }
    return confirmed;
  }

  // ---- 日期投影 ----

  /** 单日覆盖 > 周模板 > unknown；未设置不猜。 */
  resolveDayType(localDate, weekday) {
    const override = this.store.getOverride(localDate);
    if (override) return { dayType: override.day_type, startTime: override.start_time || null, endTime: override.end_time || null, source: 'override' };
    const routine = this.getRoutine();
    if (!routine.configured || !routine.workDays.length) return { dayType: 'unknown', startTime: null, endTime: null, source: 'unknown' };
    const day = Number.isInteger(weekday) ? weekday : LifeContextService.weekdayOf(localDate);
    const isWork = routine.workDays.includes(day);
    return { dayType: isWork ? 'work' : 'rest', startTime: isWork ? routine.workStartTime : null,
      endTime: isWork ? routine.workEndTime : null, source: 'routine' };
  }

  static weekdayOf(localDate) {
    const { year, month, day } = localDateParts(localDate);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  /** 条目在某目标日是否发生：一次性按区间；每年重复按月日匹配（2/29 仅闰年）。 */
  static entryOccursOn(entry, targetDate) { return entryOccursOn(entry, targetDate); }

  /** 一次性已完成待办（含历史"安排"）不再进入未来投影；过期未完成单独标记。 */
  static entryStatusForDate(entry, targetDate) {
    const todoLike = entry.type === 'todo' || entry.type === 'event';
    if (todoLike && occurrenceDone(entry, targetDate)) return 'excluded-done';
    if (isRecurringTask(entry)) return 'planned';
    if (todoLike && !entry.done && entry.localDate < targetDate) return 'planned-overdue';
    return 'planned';
  }

  /**
   * 唯一权限投影：先过滤（发生日、授权、群聊全员、撤回），再有界化。
   * 标题/备注是不可信资料，只作为数据传递，绝不成为指令。
   * confirmedScene 按听歌会话取：只有用户显式操作/原话才存在，本地日结束失效。
   */
  static projectCompanionNote(entry) {
    if (!entry || entry.useForCompanionship !== true) return null;
    const shareSummary = entry.noteUsesTitle === true || entry.shareScope === 'summary';
    const shareNoteOnly = entry.shareScope === 'note';
    const titleSummary = (!shareNoteOnly && shareSummary)
      ? (entry.content ? `${entry.title}: ${cleanText(entry.content, 160)}` : entry.title)
      : null;
    const extraNote = cleanText(entry.companionNote, 300) || null;
    if (shareNoteOnly) return extraNote;
    if (titleSummary && extraNote) return `${titleSummary}（选歌备注：${extraNote}）`;
    return titleSummary || extraNote || null;
  }

  previewCompanionshipText(input = {}, { partnerNames = [] } = {}) {
    const names = Array.isArray(partnerNames) && partnerNames.length ? partnerNames.join('、') : '所选伙伴';
    if (input.useForCompanionship !== true) {
      return '仅自己可见，不会进入任何伙伴对话或选歌参考。';
    }
    const scope = input.shareScope === 'note' ? 'note' : (input.shareScope === 'summary' ? 'summary' : (input.noteUsesTitle ? 'summary' : 'note'));
    if (scope === 'note') {
      const noteText = cleanText(input.companionNote, 300);
      return noteText
        ? `${names} 在聊天与选歌时会看到选歌备注：「${noteText}」`
        : `${names} 仅知道你有一个授权条目，尚未收到文字备注。`;
    }
    const rawTitle = cleanText(input.title, 120) || (input.type === 'note' ? deriveNoteTitleFromContent(input.content) : '');
    const title = rawTitle || '未命名手帐';
    const contentSnippet = cleanText(input.content, 160);
    const summaryText = contentSnippet ? `${title}: ${contentSnippet}` : title;
    const extra = cleanText(input.companionNote, 300);
    const full = extra ? `${summaryText}（选歌备注：${extra}）` : summaryText;
    return `${names} 在聊天与选歌时会看到：「${full}」`;
  }

  buildLifeContextSnapshot({ personId, participants = null, targetDate, nowMs = null, listeningSessionId = null }) {
    const date = String(targetDate || '');
    const routine = this.getRoutine();
    const timeZone = routine.configured ? routine.timeZone : null;
    const dayInfo = this.resolveDayType(date);
    const memberIds = Array.isArray(participants) && participants.length
      ? participants.map(String) : [String(personId || '')];
    const scope = memberIds.length > 1 ? 'group' : 'single';
    const now = Number.isFinite(nowMs) ? nowMs : this.now();
    const recentFloor = isValidLocalDate(date) ? shiftDateString(date, -3) : null;
    const upcomingCeil = isValidLocalDate(date) ? shiftDateString(date, 7) : null;

    const candidates = [];
    for (const entry of this.listEntries()) {
      if (!entry.useForCompanionship || entry.archived) continue;
      if (scope === 'single') {
        if (!entry.allowedPersonIds.includes(memberIds[0])) continue;
      } else if (!memberIds.every(id => entry.allowedPersonIds.includes(id))) continue;

      if (LifeContextService.entryOccursOn(entry, date)) {
        const status = LifeContextService.entryStatusForDate(entry, date);
        if (status === 'excluded-done') continue;
        candidates.push({ entry, status, windowRelation: 'today', daysUntil: 0 });
        continue;
      }

      if (recentFloor && entry.type === 'note' && entry.localDate >= recentFloor && entry.localDate < date) {
        candidates.push({ entry, status: 'recent-note', windowRelation: 'recent', daysUntil: daysBetweenDates(date, entry.localDate) });
        continue;
      }

      if (upcomingCeil && entry.type === 'important_date' && !entry.done) {
        // 查未来 1..7 天内命中的纪念日
        for (let offset = 1; offset <= 7; offset += 1) {
          const checkDate = shiftDateString(date, offset);
          if (LifeContextService.entryOccursOn(entry, checkDate)) {
            candidates.push({ entry, status: 'upcoming', windowRelation: 'upcoming', daysUntil: offset, occurrenceDate: checkDate });
            break;
          }
        }
      }
    }

    // 确定性排序：当日重要日子 > 当日待办/随笔（按开始时间）> 近期随笔与未来纪念日。
    const rank = item => {
      if (item.windowRelation === 'today') return item.entry.type === 'important_date' ? 0 : 1;
      if (item.windowRelation === 'upcoming') return 2;
      return 3;
    };
    candidates.sort((a, b) => (rank(a) - rank(b))
      || (a.daysUntil - b.daysUntil)
      || String(a.entry.startTime || '99:99').localeCompare(String(b.entry.startTime || '99:99'))
      || a.entry.id.localeCompare(b.entry.id));

    const items = [];
    let usedChars = 0;
    for (const { entry, status, windowRelation, daysUntil, occurrenceDate } of candidates) {
      if (items.length >= LIFE_SNAPSHOT_MAX_ENTRIES) break;
      const note = LifeContextService.projectCompanionNote(entry);
      const trackList = Array.isArray(entry.attachedTracks) && entry.attachedTracks.length
        ? entry.attachedTracks
        : (entry.attachedTrack?.title ? [entry.attachedTrack] : []);
      const trackSummary = trackList.length
        ? trackList.slice(0, 3).map(t => `${t.title}${t.artist ? ` - ${t.artist}` : ''}`).join('；')
        : null;
      const item = {
        sourceId: entry.id,
        sourceRevision: entry.revision,
        ...(isRecurringTask(entry) ? { occurrenceDate: occurrenceDate || date } : {}),
        ...(windowRelation !== 'today' ? { windowRelation, localDate: occurrenceDate || entry.localDate, daysUntil } : {}),
        type: entry.type,
        status,
        time: entry.startTime || entry.endTime ? { start: entry.startTime, end: entry.endTime, endDate: entry.endDate } : null,
        sceneTag: entry.sceneTag,
        ...(entry.mood ? { mood: entry.mood } : {}),
        ...(trackSummary ? { track: trackSummary } : {}),
        note,
      };
      const cost = JSON.stringify(item).length;
      if (usedChars + cost > LIFE_SNAPSHOT_MAX_CHARS && items.length > 0) break;
      usedChars += cost;
      items.push(item);
    }

    // plannedScene：计划里覆盖“现在”的场景标签，仅作线索；到点不确认任何现实活动。
    const wallMinutes = LifeContextService.wallMinutesNow(timeZone, now);
    let plannedScene = null;
    for (const { entry } of candidates.filter(({ entry, windowRelation }) => windowRelation === 'today' && items.some(item => item.sourceId === entry.id))) {
      if (!entry.sceneTag || !entry.startTime || !entry.endTime) continue;
      const start = parseTimeString(entry.startTime);
      const end = parseTimeString(entry.endTime);
      if (end > start ? (wallMinutes >= start && wallMinutes < end) : (wallMinutes >= start || wallMinutes < end)) {
        plannedScene = entry.sceneTag;
        break;
      }
    }
    if (plannedScene == null && dayInfo.source === 'routine' && dayInfo.dayType === 'work'
      && dayInfo.startTime && dayInfo.endTime && routine.configured) {
      const start = parseTimeString(dayInfo.startTime);
      const end = parseTimeString(dayInfo.endTime);
      if (wallMinutes >= start && wallMinutes < end) plannedScene = 'work';
    }

    const confirmed = listeningSessionId ? this.getConfirmedScene(listeningSessionId, date) : null;
    return Object.freeze({
      schema: 'life-context-snapshot',
      targetDate: date,
      timeZone,
      scope,
      revision: this.store.contextRevision(),
      computedAt: now,
      dayType: dayInfo.dayType,
      daySource: dayInfo.source,
      plannedScene,
      confirmedScene: confirmed ? { sceneTag: confirmed.sceneTag, source: confirmed.source } : null,
      entries: Object.freeze(items),
      sourceRefs: Object.freeze(items.map(item => ({ id: item.sourceId, revision: item.sourceRevision }))),
      bounded: Object.freeze({ maxEntries: LIFE_SNAPSHOT_MAX_ENTRIES, maxChars: LIFE_SNAPSHOT_MAX_CHARS,
        truncated: candidates.length > items.length }),
    });
  }

  /** 展示/开口前重验：来源仍在且 revision 未变，才允许使用旧结果。 */
  snapshotStillCurrent(snapshot) {
    if (!snapshot || snapshot.schema !== 'life-context-snapshot') return false;
    if (snapshot.revision !== this.store.contextRevision()) return false;
    for (const ref of snapshot.sourceRefs || []) {
      if (this.store.getRevocation(ref.id, 'entry') || this.store.getRevocation(ref.id, 'entry-authorization')) return false;
      const entry = this.store.getEntry(ref.id);
      if (!entry || entry.revision !== ref.revision) return false;
    }
    return true;
  }

  listQuotedTurnIds() {
    return this.store.listQuotedTurnIds();
  }

  static wallMinutesNow(timeZone, nowMs) {
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
      const [hours, minutes] = formatter.format(new Date(nowMs)).split(':').map(part => Number.parseInt(part, 10));
      return (hours % 24) * 60 + minutes;
    } catch {
      return -1;
    }
  }
}

export { isValidLocalDate, isValidTimeZone, isLeapYear };
export default LifeContextService;
