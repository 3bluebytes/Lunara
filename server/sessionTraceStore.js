// sessionTraceStore.js — 会话执行记录的私有 JSONL 存储（add-session-jsonl-trace）。
//
// 布局（root 默认 <数据根>/sessions，见 runtimePaths.resolveSessionTraceDir）：
//   <root>/<ownerKind>-<ownerLabel>--<ownerHash>/<createdStamp>--<sessionHash>/<startStamp>--<instance>.jsonl
//
// 分段语义：每个应用实例为每个会话建立独占文件（O_EXCL 创建，只追加），重启不会改写历史
// 片段或崩溃留下的不完整尾行；同目录复用，改名/成员变化写 metadata 事件而不切目录。
//
// 隐私与稳定性边界：
//   - 事件写入前同步快照并脱敏：凭据键、URL、媒体字段、provider 原始载荷、异常 message/stack
//     不落盘；token 计数（maxTokens / *_tokens）保留。
//   - 单条有界（maxEventBytes，超长带 truncated/truncation/redactedPrefix）、队列有界
//     （maxPendingBytes，丢弃计数 + 事后 chained trace_gap）。
//   - 写入/解析/清理失败绝不向业务抛出：固定脱敏告警 + status() 计数，业务照常执行。
//   - 目录 0700 / 文件 0600；受管路径逐级 lstat，符号链接不回跟；根目录自身是符号链接直接拒绝。

import { createHash, randomUUID } from 'node:crypto';
import { close as closeCallback, open as openCallback, write as writeCallback } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { redactWebTrace } from './web-access/projections.js';

// 唯一的告警文本：不含任何载荷、路径或异常内容；所有失败共用同一字符串。
const WARNING = '会话执行记录写入失败，该事件已被跳过（计数见 status()）';
const SEGMENT_EXT = '.jsonl';
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

const IDENTITY_KEYS = ['executionId', 'roundId', 'requestId', 'virtualPersonId', 'traceId',
  'spanId', 'parentSpanId', 'toolCallId', 'modelCallId'];

// ============================================================
// 脱敏（写盘前的唯一出口）
// ============================================================

const MAX_SANITIZE_DEPTH = 14;
const MAX_SANITIZE_NODES = 4000;
const MAX_JSON_STRING_LENGTH = 20000;
const MAX_ARRAY_ITEMS = 1000;

// 用量计数字段必须保留（它们是诊断的核心，不是凭据）。
const SAFE_COUNT_KEYS = new Set(['maxtokens', 'completiontokens', 'reasoningtokens', 'prompttokens',
  'totaltokens', 'cachedtokens', 'inputtokens', 'outputtokens', 'tokencount']);
// 整棵子树都不记录：请求头、provider 原始载荷、异常栈。
const SENSITIVE_CONTAINER_KEYS = new Set(['headers', 'header', 'raw', 'providerpayload',
  'providerresponse', 'providerraw', 'stack']);
// 值本身是媒体/二进制，不落盘。
const MEDIA_KEYS = new Set(['media', 'audiodata', 'binary', 'base64', 'waveform', 'thumbnail']);
const SENSITIVE_KEY_PARTS = ['secret', 'password', 'passwd', 'credential', 'apikey', 'privatekey',
  'sessionkey', 'authorization', 'cookie', 'bearer', 'accesstoken', 'refreshtoken', 'idtoken',
  'sessiontoken', 'clientsecret', 'oauthtoken', 'sendkey'];
const SENSITIVE_EXACT_KEYS = new Set(['token', 'auth', 'authkey', 'signature', 'signedurl', 'pw', 'pwd']);

const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>`]+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{4,}/gi;
const KEY_VALUE_PATTERN = /([A-Za-z0-9_.-]{2,40})\s*[:=]\s*([^\s,;"'}{[\]]{4,})/g;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 该键的值是否必须脱敏（用量计数字段显式豁免）。 */
function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SAFE_COUNT_KEYS.has(normalized)) return false;
  if (SENSITIVE_CONTAINER_KEYS.has(normalized)) return true;
  if (MEDIA_KEYS.has(normalized)) return true;
  if (normalized.endsWith('url') || normalized.endsWith('uri')) return true;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  if (normalized.startsWith('token') || normalized.endsWith('token')) {
    return !normalized.endsWith('tokens');
  }
  return SENSITIVE_KEY_PARTS.some(part => normalized.includes(part));
}

/** 文本级脱敏：URL、Bearer、sk-* 密钥与敏感 k=v 片段。 */
function redactText(value) {
  return String(value)
    .replace(URL_PATTERN, '[redacted:url]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(KEY_PATTERN, '[redacted:key]')
    .replace(KEY_VALUE_PATTERN, (match, key) => (isSensitiveKey(key) ? `${key}=[redacted]` : match));
}

/**
 * 字符串脱敏：JSON 嵌 JSON 的凭据也要清掉，且保持可解析（调用方会再 JSON.parse）。
 */
function sanitizeString(value, depth, state, ancestors) {
  const text = String(value);
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.length <= MAX_JSON_STRING_LENGTH) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const objectLike = first === '{' && last === '}';
    const arrayLike = first === '[' && last === ']';
    if (objectLike || arrayLike) {
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
      if (parsed && typeof parsed === 'object') {
        const sanitized = sanitizeWalk(parsed, depth + 1, state, ancestors);
        if (sanitized !== undefined) {
          try { return JSON.stringify(sanitized); } catch { /* 落回文本脱敏 */ }
        }
      }
    }
  }
  return redactText(text);
}

/** 沿原型链只读数据属性：绝不触发 getter。 */
function readDataProperty(object, key) {
  let current = object;
  for (let depth = 0; current && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** 异常只保留可诊断三元组：绝不带 message/stack/自定义字段。 */
function errorSummary(value) {
  let isError = false;
  try { isError = value instanceof Error; } catch { return null; }
  if (!isError) return null;
  const summary = { name: 'Error' };
  try {
    const name = readDataProperty(value, 'name');
    if (typeof name === 'string' && name) summary.name = name;
    const code = readDataProperty(value, 'code');
    if (typeof code === 'string' || typeof code === 'number') summary.code = code;
    const status = readDataProperty(value, 'status');
    if (typeof status === 'string' || typeof status === 'number') summary.status = status;
  } catch { /* 恶意/损坏的异常对象：只留 name */ }
  return summary;
}

function sanitizeWalk(value, depth, state, ancestors) {
  state.nodes += 1;
  if (state.nodes > MAX_SANITIZE_NODES) return '[truncated:size]';
  if (depth > MAX_SANITIZE_DEPTH) return '[truncated:depth]';
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return sanitizeString(value, depth, state, ancestors);
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type !== 'object') return undefined;
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(Number(value.length) || 0, MAX_ARRAY_ITEMS);
      const out = [];
      for (let index = 0; index < length; index++) {
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(value, index); } catch { descriptor = null; }
        if (!descriptor) { out.push(null); continue; }
        if (!('value' in descriptor)) { out.push('[unreadable]'); continue; }
        const item = sanitizeWalk(descriptor.value, depth + 1, state, ancestors);
        out.push(item === undefined ? null : item);
      }
      return out;
    }
    const summary = errorSummary(value);
    if (summary) return summary;
    let keys;
    try { keys = Reflect.ownKeys(value); } catch { return '[unserializable]'; }
    const out = {};
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { continue; }
      if (!descriptor || descriptor.enumerable === false) continue;
      if (!('value' in descriptor)) { out[key] = '[unreadable]'; continue; }
      if (typeof descriptor.value === 'function') continue;
      if (isSensitiveKey(key)) { out[key] = '[redacted]'; continue; }
      const item = sanitizeWalk(descriptor.value, depth + 1, state, ancestors);
      if (item !== undefined) out[key] = item;
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * 写盘前的脱敏/限界拷贝。不读 getter、不调 toJSON、可处理循环与恶意 Proxy；
 * 超深/超大结构以显式截断标记结束。
 */
export function sanitizeTraceValue(value) {
  // Run after the bounded descriptor-only walker: do not invoke getters or walk
  // unbounded caller objects when applying web-protocol-specific redaction.
  return redactWebTrace(sanitizeWalk(value, 0, { nodes: 0 }, new Set()));
}

// ============================================================
// 路径与命名
// ============================================================

function safeComponent(value, fallback = 'unknown', maxLength = 48) {
  let text = String(value ?? '');
  text = text.replace(/[\u0000-\u001f\u007f]/g, '');
  text = text.replace(/[/\\:*?"<>|]/g, '-');
  text = text.replace(/\s+/g, '-');
  text = text.replace(/-{2,}/g, '-');
  text = text.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  if (!text) text = fallback;
  const sliced = text.slice(0, maxLength).replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  return sliced || fallback;
}

/** ISO 时间戳转文件名安全的稳定串（2026-10-15T07-00-00-000Z）。 */
function stamp(value, fallback = 'unknown') {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return safeComponent(value, fallback);
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function hashOf(...parts) {
  return createHash('sha256').update(parts.map(part => String(part ?? '')).join('\u0000')).digest('hex').slice(0, 16);
}

function ownerDirectoryName(snapshot) {
  const owner = snapshot.owner || {};
  const rawKind = String(owner.kind ?? '').toLowerCase();
  const kind = /^[a-z][a-z0-9]{1,15}$/.test(rawKind) ? rawKind : 'owner';
  const label = safeComponent(owner.name || owner.id || 'unknown', 'unknown', 32);
  return `${kind}-${label}--${hashOf('owner', kind, owner.id)}`;
}

function snapshotMetadata(sessionId, metadata) {
  const owner = metadata.owner && typeof metadata.owner === 'object'
    ? { kind: String(metadata.owner.kind ?? ''), id: String(metadata.owner.id ?? ''), name: String(metadata.owner.name ?? '') }
    : null;
  const title = typeof metadata.title === 'string' ? metadata.title : String(metadata.title ?? '');
  return {
    sessionId,
    title,
    owner,
    createdAt: metadata.createdAt ?? null,
    identity: JSON.stringify([title, owner]),
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// 片段句柄用裸 fd（不是 FileHandle 对象）：进程期内长期持有，避免 GC 关闭句柄的
// 弃用告警，也避免在任何失败路径上被隐式回收。
function openFd(file, flags, mode) {
  return new Promise((resolve, reject) => {
    openCallback(file, flags, mode, (error, fd) => (error ? reject(error) : resolve(fd)));
  });
}

function writeFd(fd, text) {
  return new Promise((resolve, reject) => {
    writeCallback(fd, text, error => (error ? reject(error) : resolve()));
  });
}

function closeFd(fd) {
  return new Promise(resolve => closeCallback(fd, () => resolve()));
}

function ownedSegmentError() {
  const error = new Error('会话执行记录清理失败，未能确认删除全部私有片段');
  error.code = 'SESSION_TRACE_CLEANUP_FAILED';
  return error;
}

/** 超长记录：保留身份与可读前缀，显式记录原大小与上限。 */
function truncateRecord(record, fullText, limitBytes) {
  const originalBytes = Buffer.byteLength(fullText, 'utf8') + 1;
  const skeleton = {
    id: record.id,
    sequence: record.sequence,
    previousEventId: record.previousEventId,
    timestamp: record.timestamp,
  };
  if (record.sessionId) skeleton.sessionId = record.sessionId;
  if (record.taskType) skeleton.taskType = record.taskType;
  if (record.taskId) skeleton.taskId = record.taskId;
  if (typeof record.type === 'string') skeleton.type = record.type;
  for (const key of IDENTITY_KEYS) {
    if (typeof record[key] === 'string') skeleton[key] = record[key];
  }
  const truncation = { originalBytes, limitBytes };
  const empty = JSON.stringify({ ...skeleton, truncated: true, truncation, redactedPrefix: '' });
  let budget = Math.max(0, limitBytes - Buffer.byteLength(empty, 'utf8') - 16);
  const bytes = Buffer.from(fullText, 'utf8');
  while (budget > 0) {
    const prefix = bytes.subarray(0, budget).toString('utf8');
    const candidate = JSON.stringify({ ...skeleton, truncated: true, truncation, redactedPrefix: prefix });
    if (Buffer.byteLength(candidate, 'utf8') + 1 <= limitBytes) return candidate;
    budget = Math.floor(budget * 0.8);
  }
  return empty;
}

// ============================================================
// Store
// ============================================================

export class SessionTraceStore {
  /**
   * @param {{root: string, taskRoot?: string|null, resolveSession?: (sessionId: string) => object|null,
   *   now?: () => number, logger?: {warn: Function}|null, instanceId?: string|null,
   *   maxEventBytes?: number, maxPendingBytes?: number}} config
   */
  constructor({ root, taskRoot = null, resolveSession = null, now = null, logger = null, instanceId = null,
    maxEventBytes = DEFAULT_MAX_EVENT_BYTES, maxPendingBytes = DEFAULT_MAX_PENDING_BYTES } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('SessionTraceStore requires a root directory');
    this.root = path.resolve(root);
    this.taskRoot = taskRoot ? path.resolve(taskRoot) : path.resolve(path.dirname(this.root), 'tasks');
    this.resolveSession = typeof resolveSession === 'function' ? resolveSession : null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.logger = logger && typeof logger.warn === 'function' ? logger : null;
    this.instanceId = instanceId === null || instanceId === undefined ? randomUUID() : String(instanceId);
    this.maxEventBytes = positiveInteger(maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
    this.maxPendingBytes = positiveInteger(maxPendingBytes, DEFAULT_MAX_PENDING_BYTES);
    this.pendingBytes = 0;
    this.droppedEvents = 0;
    this.writeFailures = 0;
    this.pendingDropped = 0;
    this.states = new Map();
    this.deleted = new Set();
    this.tail = Promise.resolve();
  }

  /** 计数快照；写入失败与丢弃都会在这里可见。 */
  status() {
    return { pendingBytes: this.pendingBytes, droppedEvents: this.droppedEvents, writeFailures: this.writeFailures };
  }

  /**
   * 记录一个事件。同步快照 context/event/归属元数据并脱敏，异步落盘。
   * 绝不同步返回错误：未知会话、无身份、已删除会话直接丢弃；失败只计数与固定告警。
   */
  record(context, event) {
    try {
      const sessionId = context && typeof context === 'object' ? context.sessionId : null;
      if (typeof sessionId !== 'string' || !sessionId) return undefined;
      if (this.deleted.has(sessionId)) return undefined;
      let metadata = null;
      try { metadata = this.resolveSession ? this.resolveSession(sessionId) : null; } catch { this.#fail(); return undefined; }
      if (!metadata || typeof metadata !== 'object') return undefined;

      const snapshot = snapshotMetadata(sessionId, metadata);
      const state = this.#stateFor(sessionId, snapshot);
      if (state.broken) { this.#fail(); return undefined; }

      const backup = { sequence: state.sequence, lastId: state.lastId, header: state.header, identity: state.identity };
      const payloads = [];
      if (!state.header) {
        payloads.push(headerPayload(snapshot, this.instanceId));
        state.header = true;
      }
      if (state.identity !== null && state.identity !== snapshot.identity) {
        payloads.push(sanitizeTraceValue({ type: 'metadata', title: snapshot.title, owner: snapshot.owner }));
      }
      if (this.pendingDropped > 0) {
        payloads.push({ type: 'trace_gap', droppedEvents: this.pendingDropped });
      }
      payloads.push(cleanEvent(context, event, sessionId));

      const lines = payloads.map(payload => this.#line(state, payload));
      let bytes = 0;
      for (const line of lines) bytes += Buffer.byteLength(line, 'utf8');

      // 队列有界：满了就丢弃该事件（gap 计数保留，下次有空位时补 chained trace_gap）。
      if (this.pendingBytes > 0 && this.pendingBytes + bytes > this.maxPendingBytes) {
        state.sequence = backup.sequence;
        state.lastId = backup.lastId;
        state.header = backup.header;
        state.identity = backup.identity;
        this.droppedEvents += 1;
        this.pendingDropped += 1;
        return undefined;
      }
      if (this.pendingDropped > 0) this.pendingDropped = 0;
      state.identity = snapshot.identity;
      this.pendingBytes += bytes;
      this.#enqueue(state, lines, bytes);
    } catch {
      this.#fail();
    }
    return undefined;
  }

  /**
   * 记录一个程序类任务（如模型能力探测等无归属聊天）的执行事件。
   * 写入独立的 tasks/ 目录，不伪造 sessionId。
   */
  recordTask(context, event) {
    try {
      const taskType = context && typeof context === 'object' && typeof context.taskType === 'string'
        ? context.taskType.trim() : null;
      const taskId = context && typeof context === 'object' && context.taskId != null
        ? String(context.taskId).trim() : null;
      if (!taskType || !taskId) return undefined;

      const state = this.#taskStateFor(taskType, taskId, context);
      if (state.broken) { this.#fail(); return undefined; }

      const backup = { sequence: state.sequence, lastId: state.lastId, header: state.header };
      const payloads = [];
      if (!state.header) {
        payloads.push(taskHeaderPayload(context, this.instanceId, Number(this.now())));
        state.header = true;
      }
      if (this.pendingDropped > 0) {
        payloads.push({ type: 'trace_gap', droppedEvents: this.pendingDropped });
      }
      payloads.push(cleanTaskEvent(context, event, taskType, taskId));

      const lines = payloads.map(payload => this.#line(state, payload));
      let bytes = 0;
      for (const line of lines) bytes += Buffer.byteLength(line, 'utf8');

      if (this.pendingBytes > 0 && this.pendingBytes + bytes > this.maxPendingBytes) {
        state.sequence = backup.sequence;
        state.lastId = backup.lastId;
        state.header = backup.header;
        this.droppedEvents += 1;
        this.pendingDropped += 1;
        return undefined;
      }
      if (this.pendingDropped > 0) this.pendingDropped = 0;
      this.pendingBytes += bytes;
      this.#enqueue(state, lines, bytes);
    } catch {
      this.#fail();
    }
    return undefined;
  }

  /** 等待所有已接受的事件落盘（失败也已结算）。 */
  async flush() {
    let tail;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }

  /**
   * 删除一个会话的受管片段：立即挡住迟到记录，先排空已接受队列，再只删身份可核实的
   * 片段（非法/外来/用户文件与符号链接保留）。清理失败以 SESSION_TRACE_CLEANUP_FAILED 拒绝。
   */
  deleteSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : (sessionId == null ? '' : String(sessionId));
    if (!id) return Promise.resolve();
    this.deleted.add(id);
    const state = this.states.get(id) || null;
    const op = async () => {
      try {
        const directory = (state && state.directory) || await this.#findSessionDirectory(hashOf('session', id));
        if (!directory) return;
        await this.#assertRealDirectoryChain(directory);
        await this.#removeOwnedSegments(directory, id);
        try {
          await rmdir(directory);
        } catch (error) {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
        }
        if (state && state.segment) {
          await closeFd(state.segment.fd);
          state.segment = null;
          state.directory = null;
        }
      } catch {
        this.writeFailures += 1;
        this.#warn();
        throw ownedSegmentError();
      }
    };
    return this.#enqueueOperation(op);
  }

  // ---- 内部：队列 ----

  #enqueueOperation(op) {
    const run = this.tail.then(op, op);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #enqueue(state, lines, bytes) {
    const text = lines.join('');
    return this.#enqueueOperation(async () => {
      try {
        const segment = await this.#segment(state);
        await writeFd(segment.fd, text);
      } catch {
        state.broken = true;
        this.writeFailures += 1;
        this.#warn();
      } finally {
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
      }
    });
  }

  // ---- 内部：状态与序列 ----

  #taskStateFor(taskType, taskId, context = {}) {
    const key = `task:${taskType}:${taskId}`;
    let state = this.states.get(key);
    if (state) return state;
    const taskHash = hashOf('task', taskType, taskId);
    const targetStamp = context.targetDate
      ? safeComponent(context.targetDate, 'date', 24)
      : stamp(context.createdAt || this.now(), 'task');
    state = {
      isTask: true,
      taskType,
      taskId,
      broken: false,
      header: false,
      directory: null,
      segment: null,
      sequence: 0,
      lastId: null,
      taskHash,
      taskTypeDirName: safeComponent(taskType, 'task', 32),
      taskDirName: `${targetStamp}--${taskHash}`,
      startStamp: stamp(this.now(), 'start'),
      instanceComponent: safeComponent(this.instanceId, 'instance'),
    };
    this.states.set(key, state);
    return state;
  }

  #stateFor(sessionId, snapshot) {
    let state = this.states.get(sessionId);
    if (state) return state;
    const sessionHash = hashOf('session', sessionId);
    state = {
      sessionId,
      broken: false,
      header: false,
      identity: null,
      directory: null,
      segment: null,
      sequence: 0,
      lastId: null,
      sessionHash,
      ownerDirName: ownerDirectoryName(snapshot),
      sessionDirName: `${stamp(snapshot.createdAt, 'created')}--${sessionHash}`,
      startStamp: stamp(this.now(), 'start'),
      instanceComponent: safeComponent(this.instanceId, 'instance'),
    };
    this.states.set(sessionId, state);
    return state;
  }

  /** 组装完整记录（id/sequence/previousEventId/timestamp 由 store 独占，覆盖模型伪造字段）。 */
  #line(state, payload) {
    const record = {
      ...payload,
      id: randomUUID(),
      sequence: state.sequence,
      previousEventId: state.lastId,
      timestamp: this.#timestamp(),
    };
    if (state.isTask) {
      record.taskType = state.taskType;
      record.taskId = state.taskId;
    } else {
      record.sessionId = state.sessionId;
    }
    state.sequence += 1;
    state.lastId = record.id;
    let text = JSON.stringify(record);
    if (typeof text !== 'string') text = '{}';
    if (Buffer.byteLength(text, 'utf8') + 1 > this.maxEventBytes) {
      text = truncateRecord(record, text, this.maxEventBytes);
    }
    return `${text}\n`;
  }

  #timestamp() {
    const ms = Number(this.now());
    return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
  }

  // ---- 内部：路径 ----

  async #ensureRoot(targetRoot = this.root) {
    let info = null;
    try {
      info = await lstat(targetRoot);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!info) {
      await mkdir(targetRoot, { recursive: true, mode: 0o700 });
      info = await lstat(targetRoot);
    }
    // 根目录自身是符号链接直接拒绝；祖先里的符号链接由调用方（数据根）决定，允许。
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('trace root is not a real directory');
    if ((info.mode & 0o777) !== 0o700) await chmod(targetRoot, 0o700).catch(() => {});
  }

  async #ensureChain(targetRoot, directory) {
    const relative = path.relative(targetRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('trace directory escapes root');
    let current = targetRoot;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let info = null;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!info) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('trace directory is not a real directory');
      if ((info.mode & 0o777) !== 0o700) await chmod(current, 0o700).catch(() => {});
    }
  }

  async #findTaskDirectory(taskType, taskHash) {
    const parent = path.join(this.taskRoot, safeComponent(taskType, 'task', 32));
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    const suffix = `--${taskHash}`;
    const candidates = [];
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(suffix)) candidates.push(path.join(parent, entry.name));
    }
    if (!candidates.length) return null;
    candidates.sort();
    return candidates[0];
  }

  /** 复用同一会话的既有目录（重启/改名后仍写同一目录）。不跟随符号链接。 */
  async #findSessionDirectory(sessionHash) {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    const suffix = `--${sessionHash}`;
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parent = path.join(this.root, entry.name);
      let children;
      try {
        children = await readdir(parent, { withFileTypes: true });
      } catch { continue; }
      for (const child of children) {
        if (child.isDirectory() && child.name.endsWith(suffix)) candidates.push(path.join(parent, child.name));
      }
    }
    if (!candidates.length) return null;
    candidates.sort();
    return candidates[0];
  }

  async #assertRealDirectoryChain(directory) {
    const relative = path.relative(this.root, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('trace directory escapes root');
    let current = this.root;
    const parts = ['', ...relative.split(path.sep)];
    for (const part of parts) {
      if (part) current = path.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('trace path is not a real directory');
    }
  }

  /** 独占打开本实例的片段文件；同名（固定实例 ID/启动时刻）已存在时绝不追加、绝不清空。 */
  async #segment(state) {
    if (state.segment) return state.segment;
    if (state.isTask) {
      await this.#ensureRoot(this.taskRoot);
      const directory = state.directory
        || await this.#findTaskDirectory(state.taskType, state.taskHash)
        || path.join(this.taskRoot, state.taskTypeDirName, state.taskDirName);
      await this.#ensureChain(this.taskRoot, directory);
      const file = path.join(directory, `${state.startStamp}--${state.instanceComponent}${SEGMENT_EXT}`);
      const fd = await openFd(file, 'ax', 0o600);
      try { await chmod(file, 0o600); } catch { /* 个别文件系统不支持 */ }
      state.directory = directory;
      state.segment = { file, fd };
      return state.segment;
    }
    await this.#ensureRoot(this.root);
    const directory = state.directory
      || await this.#findSessionDirectory(state.sessionHash)
      || path.join(this.root, state.ownerDirName, state.sessionDirName);
    await this.#ensureChain(this.root, directory);
    const file = path.join(directory, `${state.startStamp}--${state.instanceComponent}${SEGMENT_EXT}`);
    const fd = await openFd(file, 'ax', 0o600);
    try { await chmod(file, 0o600); } catch { /* 个别文件系统不支持 */ }
    state.directory = directory;
    state.segment = { file, fd };
    return state.segment;
  }

  /** 受控关闭：flush 后释放所有片段句柄（进程退出前调用；不传参则关闭全部会话）。 */
  async close() {
    await this.flush();
    const closes = [];
    for (const state of this.states.values()) {
      if (!state.segment) continue;
      closes.push(closeFd(state.segment.fd));
      state.segment = null;
    }
    await Promise.all(closes);
  }

  // ---- 内部：删除 ----

  /** 只删首行 header 能核实归属（type/version/sessionId）的普通文件；其余一律保留。 */
  async #removeOwnedSegments(directory, sessionId) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(SEGMENT_EXT)) continue;
      const file = path.join(directory, entry.name);
      if (!(await this.#isOwnedSegment(file, sessionId))) continue;
      const info = await lstat(file).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) continue;
      await unlink(file);
    }
  }

  async #isOwnedSegment(file, sessionId) {
    let info;
    try { info = await lstat(file); } catch { return false; }
    if (!info.isFile() || info.isSymbolicLink()) return false;
    let text;
    try { text = await readFile(file, 'utf8'); } catch { return false; }
    const first = text.split('\n').find(line => line.trim());
    if (!first) return false;
    let record;
    try { record = JSON.parse(first); } catch { return false; }
    return Boolean(record) && record.type === 'session' && record.version === 1 && record.sessionId === sessionId;
  }

  // ---- 内部：失败与告警 ----

  #fail() {
    this.writeFailures += 1;
    this.#warn();
  }

  #warn() {
    if (!this.logger) return;
    try { this.logger.warn(WARNING); } catch { /* 固定告警失败也不影响业务 */ }
  }
}

function headerPayload(snapshot, instanceId) {
  return sanitizeTraceValue({
    type: 'session',
    version: 1,
    sessionId: snapshot.sessionId,
    title: snapshot.title,
    owner: snapshot.owner,
    createdAt: snapshot.createdAt,
    instanceId,
  });
}

function taskHeaderPayload(context, instanceId, nowMs) {
  return sanitizeTraceValue({
    type: 'task',
    version: 1,
    taskType: context.taskType,
    taskId: context.taskId,
    title: context.title || context.taskType,
    targetDate: context.targetDate || null,
    hostPersonId: context.hostPersonId || null,
    createdAt: context.createdAt || new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
    instanceId,
  });
}

/** 事件 + 执行身份合并后脱敏；context 的显式字段优先于事件自身字段。 */
function cleanEvent(context, event, sessionId) {
  const merged = {};
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === 'function') continue;
      merged[key] = value;
    }
  } else if (event !== undefined) {
    merged.event = event;
  }
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (key === 'emit' || typeof value === 'function') continue;
      merged[key] = value;
    }
  }
  merged.sessionId = sessionId;
  const cleaned = sanitizeTraceValue(merged);
  return cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : { type: 'event' };
}

function cleanTaskEvent(context, event, taskType, taskId) {
  const merged = {};
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === 'function') continue;
      merged[key] = value;
    }
  } else if (event !== undefined) {
    merged.event = event;
  }
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (key === 'emit' || typeof value === 'function') continue;
      merged[key] = value;
    }
  }
  merged.taskType = taskType;
  merged.taskId = taskId;
  const cleaned = sanitizeTraceValue(merged);
  return cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : { type: 'event' };
}
