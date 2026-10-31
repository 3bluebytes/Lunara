import { parseEvidence } from './memoryPolicy.js';

export function evidenceKeys(row) {
  const evidence = parseEvidence(row);
  return [...new Set([evidence.writeKey, evidence.sourceTurnId, ...(evidence.sourceTurnIds || []), ...(evidence.eventKeys || []),
    ...(evidence.originalEvidence || []).flatMap(item => [item.originalKey, item.data?.userTurnId])].filter(Boolean))];
}

export function initializeRevocations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_revocations (
    namespace TEXT NOT NULL, source_key TEXT NOT NULL, memory_id INTEGER, created_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, source_key)
  )`);
}

export function isMemoryRevoked(store, row) {
  if (!store?.db || !row?.namespace) return false;
  const check = store.db.prepare('SELECT 1 FROM memory_revocations WHERE namespace = ? AND source_key = ?');
  return evidenceKeys(row).some(key => check.get(row.namespace, key));
}

export function revokeMemory(store, id, now = Date.now()) {
  const row = store.getById(id);
  if (!row) return false;
  return store.db.transaction(() => {
    const write = store.db.prepare('INSERT OR IGNORE INTO memory_revocations VALUES (?, ?, ?, ?)');
    for (const key of evidenceKeys(row)) write.run(row.namespace, key, row.id, now);
    store.update(row.id, { tags: `${row.tags || ''},revoked`, expiresAt: now - 1 });
    return true;
  })();
}
