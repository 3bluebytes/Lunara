import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { ConversationStore } = await import(`${ROOT}/virtual-person/ConversationStore.js`);
const { ReflectionObservationStore } = await import(`${ROOT}/station/ReflectionObservationStore.js`);

test('"今天只想听…"的回合晚导入反思：期限从用户说话时起算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r6a-until-'));
  const DAY = 86_400_000;
  let clock = Date.now() - 3 * DAY;
  const store = new ConversationStore({ dbPath: join(dir, 'state.db'), now: () => clock }).initialize();
  try {
    store.createRoom({ sessionId: 's1', memberIds: ['lunara'] });
    const said = clock;
    store.beginRequest({ sessionId: 's1', requestId: 'rq1', virtualPersonId: 'lunara', userText: '今天只想听爵士' });
    store.completeRequest({ requestId: 'rq1', virtualPersonId: 'lunara', message: { content: '好' } });
    clock = Date.now(); // app 关了三天，重启后 recoverCommittedTurns 补录
    const journal = new ReflectionObservationStore({ db: store.db, now: () => clock }).initialize();
    journal.recoverCommittedTurns();
    const row = store.db.prepare("SELECT data_json FROM reflection_observations WHERE kind = 'turn'").get();
    const policy = JSON.parse(row.data_json).policy;
    const observed = JSON.parse(store.db.prepare("SELECT policy_json FROM conversation_observations LIMIT 1").get().policy_json);
    assert.ok(policy.until <= said + DAY, '临时限定应从用户说话的时刻起算 24 小时，与聊天账本的观察策略一致');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
