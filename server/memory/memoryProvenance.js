import { memoryApplies, parseEvidence } from './memoryPolicy.js';

export function evidenceKeys(row) {
  return keysOf(parseEvidence(row));
}

function keysOf(evidence) {
  return [...new Set([evidence.writeKey, evidence.sourceTurnId, ...(evidence.sourceTurnIds || []), ...(evidence.eventKeys || []),
    ...(evidence.originalEvidence || []).flatMap(item => [item.originalKey, item.data?.userTurnId])].filter(Boolean))];
}

export function initializeRevocations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_revocations (
    namespace TEXT NOT NULL, source_key TEXT NOT NULL, memory_id INTEGER, created_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, source_key)
  )`);
}

/**
 * 证据里任一来源有墓碑即视为撤回。例外：用户撤回某一条显式事实时，墓碑也写在它的来源回合上
 * （memory_id 记着被撤回的那条）；同一句话里另行记下、带自己 writeKey 的其他显式事实不跟着消失，
 * 从那句话反思出来的近况与洞察则一起撤回。
 * 删除聊天、编辑消息写的墓碑 memory_id 为空，照旧作用于这个来源的全部记忆。
 */
// 每轮注入要对几百条记忆逐条判断：同一个库只编译一次查询。
const revocationChecks = new WeakMap();
const EXPLICIT_SOURCES = new Set(['user_explicit_feedback', 'manual_seed']);

export function isMemoryRevoked(store, row) {
  if (!store?.db || !row?.namespace) return false;
  let check = revocationChecks.get(store.db);
  if (!check) {
    // 一行记忆的全部来源键一次查完（json_each 展开），合并过的洞察带几十个来源也只查一次库。
    check = store.db.prepare(`SELECT source_key, memory_id FROM memory_revocations
      WHERE namespace = ? AND source_key IN (SELECT value FROM json_each(?))`);
    revocationChecks.set(store.db, check);
  }
  const evidence = parseEvidence(row);
  const keys = keysOf(evidence);
  if (!keys.length) return false;
  const { writeKey } = evidence;
  return check.all(row.namespace, JSON.stringify(keys)).some(tombstone => {
    const key = tombstone.source_key;
    // 豁免只给用户亲口记下的显式事实；反思派生的行（近况、洞察）同样自带 writeKey，但来源被撤回就该一起消失。
    const siblingFactRevoked = EXPLICIT_SOURCES.has(row.source) && writeKey && key !== writeKey
      && tombstone.memory_id != null && tombstone.memory_id !== row.id;
    return !siblingFactRevoked;
  });
}

/**
 * 与逐行 isMemoryRevoked 相同的判断，批量版：同一 namespace 的全部来源键一次查完，
 * 每轮几千条关系事实不再各查一次库。返回未被撤回的行，顺序不变。
 */
export function filterUnrevoked(store, rows) {
  if (!store?.db || !rows?.length) return rows || [];
  const parsed = rows.map(row => {
    const evidence = row?.namespace ? parseEvidence(row) : {};
    return { row, evidence, keys: row?.namespace ? keysOf(evidence) : [] };
  });
  const tombstones = new Map();
  const byNamespace = new Map();
  for (const item of parsed) {
    if (!item.keys.length) continue;
    if (!byNamespace.has(item.row.namespace)) byNamespace.set(item.row.namespace, new Set());
    for (const key of item.keys) byNamespace.get(item.row.namespace).add(key);
  }
  const lookup = store.db.prepare(`SELECT source_key, memory_id FROM memory_revocations
    WHERE namespace = ? AND source_key IN (SELECT value FROM json_each(?))`);
  for (const [namespace, keys] of byNamespace) {
    for (const tombstone of lookup.all(namespace, JSON.stringify([...keys]))) tombstones.set(`${namespace}\u0000${tombstone.source_key}`, tombstone);
  }
  return parsed.filter(({ row, evidence, keys }) => !keys.some(key => {
    const tombstone = tombstones.get(`${row.namespace}\u0000${key}`);
    if (!tombstone) return false;
    const siblingFactRevoked = EXPLICIT_SOURCES.has(row.source) && evidence.writeKey && key !== evidence.writeKey
      && tombstone.memory_id != null && tombstone.memory_id !== row.id;
    return !siblingFactRevoked;
  })).map(item => item.row);
}

export function revokeMemory(store, id, now = Date.now(), { restore = true } = {}) {
  const row = store.getById(id);
  if (!row) return false;
  return store.db.transaction(() => {
    const write = store.db.prepare('INSERT OR IGNORE INTO memory_revocations VALUES (?, ?, ?, ?)');
    for (const key of evidenceKeys(row)) write.run(row.namespace, key, row.id, now);
    store.update(row.id, { tags: `${row.tags || ''},revoked`, expiresAt: now - 1 });
    if (restore) restoreSuperseded(store.db, [row.id], now);
    return true;
  })();
}

/** 还有被这些记忆取代、仍处于失效状态的旧事实的条数。 */
export function supersededByAny(db, replacingIds) {
  const ids = new Set(replacingIds.map(Number));
  return db.prepare("SELECT evidence FROM memories WHERE (',' || tags || ',') LIKE '%,superseded,%'").all()
    .filter(row => ids.has(Number(parseEvidence(row).supersededBy))).length;
}

/** 修正（不是忘掉）一条记忆时：被旧行取代的事实改为被修正后的新行取代，不会复活。 */
export function transferSuperseded(db, fromId, toId, now = Date.now()) {
  const rows = db.prepare("SELECT id, evidence FROM memories WHERE (',' || tags || ',') LIKE '%,superseded,%'").all()
    .filter(row => Number(parseEvidence(row).supersededBy) === Number(fromId));
  const update = db.prepare('UPDATE memories SET evidence = ?, updated_at = ? WHERE id = ?');
  for (const row of rows) update.run(JSON.stringify({ ...parseEvidence(row), supersededBy: toId }), now, row.id);
  return rows.map(row => row.id);
}

/**
 * 取代旧事实的新记忆被撤回后，旧事实恢复生效（remember_person_fact 的 replacesMemoryIds）。
 * 撤回新事实是"这件事不算了"，旧状态重新成为现状；被撤回的旧行不受影响。
 * 取代链 A←B←C 里撤回中间的 B：现状仍是 C，A 改为被 C 取代，而不是复活与 C 并存。
 */
export function restoreSuperseded(db, replacingIds, now = Date.now()) {
  const ids = new Set(replacingIds.map(Number));
  if (!ids.size) return [];
  const byId = db.prepare('SELECT id, tags, evidence FROM memories WHERE id = ?');
  const hasTag = (row, tag) => String(row?.tags || '').split(',').includes(tag);
  // 沿取代链往后找仍然生效的那一条；链上全被撤回则没有。
  const liveSuccessor = id => {
    const visited = new Set();
    let row = byId.get(id);
    while (row && hasTag(row, 'superseded') && !visited.has(row.id)) {
      visited.add(row.id);
      const next = byId.get(Number(parseEvidence(row).supersededBy));
      if (!next) return null;
      if (!hasTag(next, 'revoked') && !ids.has(Number(next.id))) return next.id;
      row = next;
    }
    return null;
  };
  const rows = db.prepare("SELECT id, tags, evidence FROM memories WHERE (',' || tags || ',') LIKE '%,superseded,%'").all()
    .filter(row => ids.has(Number(parseEvidence(row).supersededBy)));
  const update = db.prepare('UPDATE memories SET tags = ?, evidence = ?, updated_at = ? WHERE id = ?');
  const restored = [];
  for (const row of rows) {
    const { supersededBy, ...evidence } = parseEvidence(row);
    const successor = liveSuccessor(Number(supersededBy));
    if (successor != null) {
      update.run(row.tags, JSON.stringify({ ...evidence, supersededBy: successor }), now, row.id);
      continue;
    }
    const tags = String(row.tags || '').split(',').filter(tag => tag && tag !== 'superseded').join(',');
    update.run(tags, JSON.stringify(evidence), now, row.id);
    restored.push(row.id);
  }
  return restored;
}

/**
 * 图式是否仍可注入（fix-release-blocking-defects）。
 *
 * 图式是 namespace 级、无条件注入的：它是派生副本，因此它的来源被撤回、收窄、过期或删除
 * 之后，副本也不能继续携带那份内容。这里在注入前逐条重验贡献来源；无法证明适用面的旧图式
 * 也不再注入（下一次蒸馏会写回带来源的图式）。
 */
export function schemaContributorsStillApply(service, row) {
  const evidence = parseEvidence(row);
  if (evidence.scope !== 'widest-audience') return false;
  const ids = Array.isArray(evidence.contributorIds) ? evidence.contributorIds : [];
  if (!ids.length) return false;
  return ids.every(id => {
    // 只读校验：不走 getMemory，免得每轮把每个来源的 access_count 加一。
    const contributor = service.store?.getById(id) ?? service.getMemory?.(id);
    return Boolean(contributor)
      && !isMemoryRevoked(service.store, contributor)
      && memoryApplies(contributor, { shared: true, sessionId: null });
  });
}
