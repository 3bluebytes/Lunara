import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_FAILURE, SOURCE_FAILURE_CODES, SOURCE_FAILURE_NEXT_STEP,
  classifySourceFailure, isSourceFailureCode, sourceFailure,
  dominantSourceFailure, publicFailures, describeSourceFailure,
} from './sourceFailure.js';

const SECRET = 'https://provider.test/x?cookie=SID%3Dsecret&token=abc';

test('every code has a closed, known set and a user next step', () => {
  assert.equal(SOURCE_FAILURE_CODES.length, 8);
  assert.deepEqual([...SOURCE_FAILURE_CODES].sort(), [
    'internal', 'not-found', 'not-playable', 'rate-limited',
    'requires-auth', 'requires-member', 'timeout', 'unavailable',
  ]);
  for (const code of SOURCE_FAILURE_CODES) {
    assert.ok(SOURCE_FAILURE_NEXT_STEP[code], `missing next step for ${code}`);
    assert.equal(isSourceFailureCode(code), true);
  }
  assert.equal(isSourceFailureCode('no playable url (vip?)'), false);
});

test('closed Error.code values survive the provider to resolver boundary', () => {
  for (const code of SOURCE_FAILURE_CODES) {
    assert.equal(classifySourceFailure(Object.assign(new Error('safe provider failure'), { code })), code);
  }
});

test('raw provider errors are classified without echoing their text', () => {
  const cases = [
    ['no playable url (vip?)', SOURCE_FAILURE.REQUIRES_MEMBER],
    ['用户未登录', SOURCE_FAILURE.REQUIRES_AUTH],
    ['cookie invalid', SOURCE_FAILURE.REQUIRES_AUTH],
    ['HTTP 403 forbidden', SOURCE_FAILURE.REQUIRES_AUTH],
    ['429 too many requests', SOURCE_FAILURE.RATE_LIMITED],
    ['访问频繁，请稍后再试', SOURCE_FAILURE.RATE_LIMITED],
    ['connect ECONNREFUSED 127.0.0.1:3000', SOURCE_FAILURE.UNAVAILABLE],
    ['fetch failed', SOURCE_FAILURE.UNAVAILABLE],
    ['upstream 502', SOURCE_FAILURE.UNAVAILABLE],
    ['request timed out', SOURCE_FAILURE.TIMEOUT],
    ['something odd happened', SOURCE_FAILURE.INTERNAL],
    ['', SOURCE_FAILURE.INTERNAL],
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifySourceFailure(input), expected, `classify(${JSON.stringify(input)})`);
  }
});

test('classification never carries credentials or urls into its output', () => {
  const error = Object.assign(new Error(`login required: ${SECRET}`), { code: 'ERR_AUTH', name: 'Error', stack: `at ${SECRET}` });
  for (const input of [error, new Error(SECRET), SECRET, { message: SECRET }]) {
    const code = classifySourceFailure(input);
    assert.equal(code, SOURCE_FAILURE.REQUIRES_AUTH);
    assert.doesNotMatch(JSON.stringify({ code }), /cookie|token|https?:|secret/i);
  }
  const failure = sourceFailure(error, { source: 'qq', query: '晴天' });
  assert.deepEqual(failure, { ok: false, code: SOURCE_FAILURE.REQUIRES_AUTH, source: 'qq', query: '晴天' });
  assert.doesNotMatch(JSON.stringify(failure), /cookie|token|https?:|secret|stack/i);
});

test('rate limiting wins over auth because it is the actionable cause', () => {
  // 风控常以 403 表现；若先判 auth，用户会去反复重新登录而实际只会更糟。
  assert.equal(classifySourceFailure('403 rate limited'), SOURCE_FAILURE.RATE_LIMITED);
});

test('the top-level reason follows the resolution order, not a magic ranking', () => {
  assert.equal(dominantSourceFailure([]), SOURCE_FAILURE.INTERNAL);
  assert.equal(dominantSourceFailure([{ source: 'qq', code: 'not-found' }, { source: 'ncm', code: 'not-found' }]), SOURCE_FAILURE.NOT_FOUND);
  // 主源说需要会员、次源说没有 —— 这首歌其实存在，报「需要会员」才有用。
  assert.equal(dominantSourceFailure([{ source: 'qq', code: 'requires-member' }, { source: 'ncm', code: 'not-found' }]), SOURCE_FAILURE.REQUIRES_MEMBER);
  // 主源连不上、次源确实没有 —— 如实报主源连不上，不替它断言「没有这首歌」。
  assert.equal(dominantSourceFailure([{ source: 'qq', code: 'unavailable' }, { source: 'ncm', code: 'not-found' }]), SOURCE_FAILURE.UNAVAILABLE);
  // 顺序影响结果，这是刻意的：原因是「用户主源给出的那一个」。
  assert.equal(dominantSourceFailure([{ source: 'ncm', code: 'not-found' }, { source: 'qq', code: 'timeout' }]), SOURCE_FAILURE.TIMEOUT);
});

test('public failure lists drop unknown shapes and normalise codes', () => {
  assert.deepEqual(publicFailures([
    { source: 'qq', code: 'requires-auth' },
    { source: 'ncm', code: 'not-found' },
    { source: '', code: 'not-found' },
    null,
    'noise',
  ]), [{ source: 'qq', code: 'requires-auth' }, { source: 'ncm', code: 'not-found' }]);
  assert.deepEqual(publicFailures(undefined), []);
});

test('user copy names the source and never leaks technical detail', () => {
  assert.equal(describeSourceFailure('requires-member', { source: 'QQ 音乐' }), 'QQ 音乐需要会员才能听这首歌');
  assert.equal(describeSourceFailure('not-found', { source: 'QQ 音乐' }), '没有找到明确匹配的歌');
  assert.equal(describeSourceFailure('requires-auth'), '需要在这个音乐源登录');
  // 未知输入降级为通用文案，而不是把原始字符串当文案吐出去。
  assert.equal(describeSourceFailure('no playable url (vip?)', { source: 'QQ 音乐' }), 'QQ 音乐需要会员才能听这首歌');
  for (const code of SOURCE_FAILURE_CODES) {
    const copy = describeSourceFailure(code, { source: 'QQ 音乐' });
    assert.doesNotMatch(copy, /[A-Za-z]{3,}|\d{3}|https?:|cookie|token/, `copy for ${code} leaks technical detail: ${copy}`);
  }
});
