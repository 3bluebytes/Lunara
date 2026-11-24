import assert from 'node:assert/strict';
import test from 'node:test';

import { policyFromUserText } from './memoryPolicy.js';

const disclosure = text => policyFromUserText(text, 's').disclosure;

test('常见的保密说法都识别为只限这段关系', () => {
  for (const text of ['别告诉别人，我喜欢 City Pop', '我在准备辞职，别告诉别人', '别跟大家说', '这事别说出去', '不要告诉任何人',
    '别让别人知道', '别在群里提这个', '替我保密', '只告诉你一个人']) {
    assert.equal(disclosure(text), 'private', text);
  }
});

test('普通的话不会被误判为保密', () => {
  for (const text of ['告诉所有伙伴：我下个月结婚', '别放摇滚', '我不想说话', '别人都说这首好听', '你告诉我吧']) {
    assert.equal(disclosure(text), 'normal', text);
  }
});

test('「今天才知道…」不是临时限定；「今天只想听…」仍是', async () => {
  const temporary = text => Boolean(policyFromUserText(text, 's').until);
  assert.equal(temporary('我今天才知道我对花生过敏，记住哦'), false);
  assert.equal(temporary('今天只想听爵士'), true);
  assert.equal(temporary('只限这次，叫我船长'), true);
});

test('临时限定只看依据所在的那句与紧挨着的限定短句；私密看整句原话', async () => {
  const { policyForQuote } = await import('./memoryPolicy.js');
  const scoped = (text, quote) => policyForQuote(text, quote, 's');
  assert.equal(scoped('今天只想听爵士。另外记住，我叫小明', '我叫小明').until, undefined);
  assert.ok(scoped('今天只想听爵士。另外记住，我叫小明', '今天只想听爵士').until);
  assert.ok(scoped('这次就好。叫我船长', '叫我船长').until, '只有限定词的短句管到紧挨着的那句');
  assert.ok(scoped('叫我船长，只限这次', '叫我船长').until);
  assert.equal(scoped('别告诉别人。我在准备辞职', '我在准备辞职').disclosure, 'private');
});
