import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSourceFailureWarning } from './sourceFailureWarning.js';

function fixture() {
  const { document } = parseHTML('<html><body><input id="compose-input"><div id="source-failure-warnings" role="status" aria-live="polite" hidden></div></body></html>');
  const input = document.querySelector('input');
  let focused = input;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  input.focus = () => { focused = input; };
  const actions = [];
  const warning = createSourceFailureWarning({ documentLike: document, onAction: action => actions.push(action) });
  const region = document.querySelector('#source-failure-warnings');
  return { warning, document, region, actions,
    fact: (source = 'future-source', code = 'requires-auth', displayName = '未来播放源') => warning.consume({ type: 'music-source-status', source, displayName, code }),
    click(selector) { region.querySelector(selector).dispatchEvent(new document.defaultView.Event('click', { bubbles: true })); },
    get focus() { return focused; }, input,
  };
}

test('any valid provider uses backend registry metadata without a modal or focus capture', () => {
  const h = fixture();
  assert.equal(h.fact(), true);
  assert.equal(h.region.hidden, false);
  assert.match(h.region.textContent, /未来播放源需要重新登录/);
  assert.equal(h.document.querySelector('dialog'), null);
  assert.equal(h.focus, h.input);
  assert.deepEqual(h.actions, []);
  h.warning.destroy();
});

test('a warning persists until explicit acknowledgement and deduplicates repeated failures', () => {
  const h = fixture();
  h.fact(); h.fact();
  assert.equal(h.region.children.length, 1);
  h.click('[data-source-warning-dismiss]');
  assert.equal(h.region.hidden, true);
  h.fact();
  assert.equal(h.region.hidden, true, 'same incident stays acknowledged');
  h.fact('future-source', null);
  h.fact();
  assert.equal(h.region.hidden, false, 'a later incident can be shown');
  h.warning.destroy();
});

test('automatic recovery updates but never silently dismisses an unacknowledged warning', () => {
  const h = fixture();
  h.fact();
  h.fact('future-source', null);
  assert.equal(h.region.hidden, false);
  assert.match(h.region.textContent, /连接已恢复/);
  assert.equal(h.region.querySelector('[data-source-warning-action]'), null);
  h.click('[data-source-warning-dismiss]');
  assert.equal(h.region.hidden, true);
  h.warning.destroy();
});

test('QQ, Netease and future providers share one generic warning path', () => {
  const h = fixture();
  h.fact('qq', 'requires-auth', 'QQ 音乐');
  h.fact('ncm', 'timeout', '网易云音乐');
  h.fact('future-source', 'rate-limited', '新音源');
  assert.equal(h.region.children.length, 3);
  assert.match(h.region.textContent, /QQ 音乐需要重新登录/);
  assert.match(h.region.textContent, /网易云音乐响应超时/);
  assert.match(h.region.textContent, /新音源请求暂时受限/);
  assert.equal(h.focus, h.input);
  h.warning.destroy();
});

test('recovery actions require a user click and preserve the originating source and code', () => {
  const h = fixture();
  h.fact();
  h.click('[data-source-warning-action]');
  assert.deepEqual(h.actions, [{ source: 'future-source', code: 'requires-auth', displayName: '未来播放源' }]);
  assert.equal(h.region.hidden, true);
  h.warning.destroy();
});

test('network failures are actionable warnings, never labelled as login expiry', () => {
  const h = fixture();
  for (const code of ['timeout', 'unavailable', 'rate-limited', 'requires-member']) {
    h.fact('future-source', code);
    assert.doesNotMatch(h.region.textContent, /登录状态已失效/);
    assert.equal(h.region.querySelector('[data-source-warning-action]').textContent, '检查音乐源');
  }
  h.warning.destroy();
});

test('unknown codes, malformed identities and untrusted markup cannot become raw error content', () => {
  const h = fixture();
  h.fact('future-source', 'not-playable');
  h.fact('future-source', 'RAW upstream private error');
  h.fact('<script>', 'requires-auth');
  assert.equal(h.region.hidden, true);
  h.fact('future-source', 'requires-auth', '<img src=x onerror=alert(1)>');
  assert.equal(h.region.querySelector('img'), null);
  assert.ok(h.region.textContent.includes('<img'));
  h.warning.destroy();
});

test('destroy removes all warnings and listeners', () => {
  const h = fixture();
  h.fact(); h.warning.destroy();
  assert.equal(h.region.hidden, true);
  assert.equal(h.fact('other'), false);
  assert.deepEqual(h.actions, []);
});

test('voice endpoint failures share the region, use voice copy and open voice settings', () => {
  const h = fixture();
  assert.equal(h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'credit-exhausted' }), true);
  assert.match(h.region.textContent, /Breeze额度已用尽/);
  assert.match(h.region.textContent, /串词和语音回复暂时没有声音/);
  h.fact('custom', 'requires-auth', '同名音乐源');
  assert.equal(h.region.children.length, 2, 'voice and music keys do not collide');
  h.click('[data-source-warning-action="voice:custom"]');
  assert.deepEqual(h.actions, [{ kind: 'voice', source: 'custom', code: 'credit-exhausted', displayName: 'Breeze' }]);
  assert.equal(h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'sk-secret' }), false);
  h.warning.destroy();
});

test('voice recovery updates without dismissing', () => {
  const h = fixture();
  h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'rate-limited' });
  h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: null });
  assert.match(h.region.textContent, /Breeze声音已恢复/);
  assert.equal(h.region.hidden, false);
  h.warning.destroy();
});

test('voice failure covered by substitute narration says who is reading instead of claiming silence', () => {
  const h = fixture();
  const fallback = { endpoint: 'free-edge', displayName: '免费声音（Edge）' };
  assert.equal(h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'timeout', fallback }), true);
  assert.match(h.region.textContent, /Breeze合成超时/);
  assert.match(h.region.textContent, /由「免费声音（Edge）」代读/);
  assert.doesNotMatch(h.region.textContent, /没有出声/);
  assert.equal(h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'timeout', fallback }), false, 'same incident deduplicates');
  assert.equal(h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'timeout' }), true, 'losing the substitute updates the copy');
  assert.match(h.region.textContent, /没有出声/);
  assert.equal(h.warning.consume({ type: 'voice-endpoint-status', endpoint: 'custom', displayName: 'Breeze', code: 'failed', fallback: { endpoint: 'bad id!', displayName: 'x' } }), true);
  assert.doesNotMatch(h.region.textContent, /代读/, 'an invalid substitute id is ignored');
  h.warning.destroy();
});
