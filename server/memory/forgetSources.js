// forgetSources.js — 聊天被删除或消息被编辑时，撤回从这些来源学到的东西（forget-memory-with-source）。
//
// 输入：被删除的聊天 id，或被编辑掉的 turn id 列表。
// 做什么（与调用方的聊天账本改动在同一个事务里）：
//   1. 证据指向这些来源的记忆（显式事实、共享事实、反思洞察、Station 晋升）→ 打 revoked 标签并过期；
//      它们取代过的旧事实恢复生效；
//      口味图式不单独处理：注入前会逐条重验贡献来源，来源洞察撤回后它自动不再注入。
//   2. 这些来源 turn 在相关 namespace 和 station 下写撤回墓碑，反思与晋升不会再把它们学回来；
//      只写被删的 turn，混合来源洞察里的其他聊天不受牵连。
//   3. 反思观察日志里来自这些来源的行删除，Station 晋升证据里引用它们的行删除。
// 不做什么：不碰播放统计与听歌记录（那是播放事实，不是从聊天里学到的）。
//
// Python 伪代码：
//   keys = set(turn_ids)
//   for row in memories where not revoked:
//       if evidence_keys(row) & keys or session_id in evidence_sessions(row): revoke(row)
//   tombstone(keys); delete observations / claim evidence from keys
import { evidenceKeys, restoreSuperseded } from './memoryProvenance.js';
import { parseEvidence } from './memoryPolicy.js';

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const REVOKED = /(?:^|,)revoked(?:,|$)/u;

function evidenceSessions(row) {
  const evidence = parseEvidence(row);
  return new Set([evidence.originSessionId, evidence.sessionId, ...(evidence.sessions || []),
    ...(evidence.originalEvidence || []).map(item => item.sessionId)].filter(Boolean));
}

/**
 * 撤回从指定来源学到的记忆。必须在调用方的事务里、聊天行还没删之前调用（需要读 turn 与 request）。
 * 记忆表不存在时什么也不做（单独测试聊天账本时没有记忆库）。
 * @returns {{ memoryIds: number[], sourceKeys: string[] }}
 */
export function forgetLearnedFromSources(db, { sessionId = null, turnIds = [], now = Date.now() } = {}) {
  const keys = new Set(turnIds.filter(Boolean).map(String));
  if (sessionId && tableExists(db, 'conversation_turns')) {
    for (const row of db.prepare('SELECT turn_id FROM conversation_turns WHERE session_id = ?').all(sessionId)) keys.add(row.turn_id);
  }
  if (tableExists(db, 'conversation_requests') && keys.size) {
    // 用户 turn 的回应、assistant turn 的提问都算同一来源：反思以 assistant turn 为事件键。
    const pair = db.prepare('SELECT user_turn_id, assistant_turn_id FROM conversation_requests WHERE user_turn_id = ? OR assistant_turn_id = ?');
    for (const key of [...keys]) {
      for (const row of pair.all(key, key)) {
        if (row.user_turn_id) keys.add(row.user_turn_id);
        if (row.assistant_turn_id) keys.add(row.assistant_turn_id);
      }
    }
  }
  const eventKeys = [...keys].map(key => `turn:${key}`);
  const sourceKeys = [...keys, ...eventKeys];
  if (!sourceKeys.length || !tableExists(db, 'memories')) return { memoryIds: [], sourceKeys };

  const matched = db.prepare('SELECT id, namespace, tags, evidence FROM memories').all()
    .filter(row => !REVOKED.test(row.tags || ''))
    .filter(row => evidenceKeys(row).some(key => keys.has(key) || eventKeys.includes(key))
      || (sessionId && evidenceSessions(row).has(sessionId)));
  // 墓碑写进命中记忆所在的 namespace 与 station；聊天账本本身已删除或标记改写，反思不会再导入这些 turn。
  const namespaces = new Set(['station', ...matched.map(row => row.namespace)]);
  const update = db.prepare("UPDATE memories SET tags = ?, expires_at = ?, updated_at = ? WHERE id = ?");
  for (const row of matched) update.run(`${row.tags || ''},revoked`, now - 1, now, row.id);
  // 被撤回的记忆取代过的旧事实恢复生效（例如删掉说"搬到杭州"的聊天，"住在上海"重新成为现状）。
  restoreSuperseded(db, matched.map(row => row.id), now);

  if (tableExists(db, 'memory_revocations')) {
    // 来源被删：墓碑不再归属某一条记忆（memory_id 置空），这个来源学到的全部记忆都算撤回。
    const tombstone = db.prepare(`INSERT INTO memory_revocations VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace, source_key) DO UPDATE SET memory_id = NULL`);
    for (const namespace of namespaces) for (const key of sourceKeys) tombstone.run(namespace, key, null, now);
  }
  if (tableExists(db, 'reflection_observations')) {
    const drop = db.prepare("DELETE FROM reflection_observations WHERE event_key = ? OR json_extract(data_json, '$.userTurnId') = ?");
    for (const key of keys) drop.run(`turn:${key}`, key);
    if (sessionId) db.prepare('DELETE FROM reflection_observations WHERE session_id = ?').run(sessionId);
  }
  if (tableExists(db, 'station_claim_evidence')) {
    const drop = db.prepare('DELETE FROM station_claim_evidence WHERE original_key = ?');
    for (const key of sourceKeys) drop.run(key);
  }
  return { memoryIds: matched.map(row => row.id), sourceKeys };
}
