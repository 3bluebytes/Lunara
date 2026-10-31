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
