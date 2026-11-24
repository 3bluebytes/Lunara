// 在场性格：角色默认 → 模式上限 → 用户显式档位，取更严格者。Run: node --test server/presence/presenceTemperament.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePresenceSetting, presenceTemperamentOf, resolvePresencePolicy } from './presenceTemperament.js';

test('persona metadata declares temperament and style; missing or invalid falls back to balanced', () => {
  assert.deepEqual(presenceTemperamentOf({ metadata: {} }), { temperament: 'balanced', style: '' });
  assert.deepEqual(presenceTemperamentOf({ metadata: { presence: { temperament: 'quiet', style: '  话少，偶尔冷幽默  ' } } }),
    { temperament: 'quiet', style: '话少，偶尔冷幽默' });
  assert.equal(presenceTemperamentOf({ metadata: { presence: { temperament: 'shouty' } } }).temperament, 'balanced');
  assert.equal(presenceTemperamentOf(null).temperament, 'balanced');
  assert.equal(presenceTemperamentOf({ metadata: { presence: { style: 'x'.repeat(300) } } }).style.length, 200);
});

test('writes are validated: unknown temperament is rejected, style is bounded', () => {
  assert.deepEqual(normalizePresenceSetting({ temperament: 'lively', style: ' 爱接话 ' }), { temperament: 'lively', style: '爱接话' });
  assert.throws(() => normalizePresenceSetting({ temperament: 'loud' }), TypeError);
  assert.throws(() => normalizePresenceSetting({ temperament: 'quiet', style: 'x'.repeat(201) }), TypeError);
});

test('temperament maps to cadence parameters; the stricter of mode ceiling and level wins', () => {
  const quiet = resolvePresencePolicy({ modeId: 'conversational', temperament: 'quiet' });
  assert.equal(quiet.id, 'quiet');
  assert.equal(quiet.perWindow, 1);
  assert.equal(quiet.perSession, 4);
  assert.equal(quiet.moments.has('track_completed'), false);
  assert.equal(quiet.hooks, 'strong');
  const lively = resolvePresencePolicy({ modeId: 'conversational', temperament: 'lively' });
  assert.deepEqual([lively.perWindow, lively.perSession, lively.every.track_completed], [3, 12, 3]);
  assert.equal(resolvePresencePolicy({ modeId: 'occasional', temperament: 'lively' }).id, 'balanced', '模式上限');
  assert.equal(resolvePresencePolicy({ modeId: null, temperament: 'lively' }).id, 'lively', 'legacy 会话不额外收紧');
  assert.equal(resolvePresencePolicy({ modeId: 'music_only', temperament: 'lively' }), null);
  assert.equal(resolvePresencePolicy({ modeId: 'conversational', temperament: 'lively', userLevel: 'quiet' }).id, 'quiet',
    '用户显式档位优先于角色默认');
  assert.equal(resolvePresencePolicy({ modeId: 'occasional', temperament: 'quiet', userLevel: 'lively' }).id, 'balanced',
    '用户档位也不能越过模式上限');
  assert.equal(resolvePresencePolicy({ modeId: 'conversational' }).id, 'balanced');
});

test('生效话量：原因按 停用 > 全局关闭 > 只听歌 > 安静点 > 在场性格 的顺序给出', async () => {
  const { describeEffectivePresence } = await import('./presenceTemperament.js');
  const base = { available: true, ambientEnabled: true, listenerQuiet: false, modeId: 'conversational', temperament: 'lively' };
  assert.deepEqual(describeEffectivePresence(base), { level: 'lively', limitedBy: null });
  assert.deepEqual(describeEffectivePresence({ ...base, available: false, ambientEnabled: false, listenerQuiet: true }),
    { level: 'silent', limitedBy: 'unavailable' });
  assert.deepEqual(describeEffectivePresence({ ...base, ambientEnabled: false, listenerQuiet: true, temperament: 'quiet' }),
    { level: 'silent', limitedBy: 'ambient-off' });
  assert.deepEqual(describeEffectivePresence({ ...base, modeId: 'music_only', listenerQuiet: true }),
    { level: 'silent', limitedBy: 'mode' });
  assert.deepEqual(describeEffectivePresence({ ...base, listenerQuiet: true, temperament: 'quiet' }),
    { level: 'silent', limitedBy: 'listener-quiet' });
  assert.deepEqual(describeEffectivePresence({ ...base, temperament: 'quiet' }), { level: 'quiet', limitedBy: 'temperament' });
  // 偶尔介绍的上限就是「自然」：自然的伙伴没被压低；健谈的伙伴是被模式自己压的，不必另外解释。
  assert.deepEqual(describeEffectivePresence({ ...base, modeId: 'occasional', temperament: 'balanced' }), { level: 'balanced', limitedBy: null });
  assert.deepEqual(describeEffectivePresence({ ...base, modeId: 'occasional' }), { level: 'balanced', limitedBy: 'mode' });
  assert.deepEqual(describeEffectivePresence({ ...base, modeId: 'occasional', temperament: 'quiet' }), { level: 'quiet', limitedBy: 'temperament' });
  // 「自然」是角色默认：配多聊一点也不算被压低，不打扰用户。
  assert.deepEqual(describeEffectivePresence({ ...base, temperament: 'balanced' }), { level: 'balanced', limitedBy: null });
  assert.deepEqual(describeEffectivePresence({ ...base, temperament: 'nonsense' }), { level: 'balanced', limitedBy: null });
});
