import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const bodyScale = /var\(--chat-body-size\)\/var\(--chat-body-line\)/;

test('chat uses a compact local scale without focus-mode enlargement', async () => {
  const css = await read('features/conversations/conversations.css');
  assert.match(css, /--chat-body-size: 14px;/);
  assert.match(css, /--chat-body-line: 1\.7;/);
  assert.doesNotMatch(css, /#app\.chat-focus \.conversation-main \{[^}]*--chat-body-size:/);
});

test('stage and themes consume the chat scale rather than larger reading sizes', async () => {
  const stage = await read('features/shell/stage.css');
  for (const role of ['assistant', 'user']) {
    const rule = stage.split('\n').find(line => line.includes(`.chat-msg.${role} `) && line.includes('font:'));
    assert.match(rule || '', bodyScale, `${role} follows the local chat scale`);
  }
  for (const theme of ['moonlight', 'modernist']) {
    const css = await read(`themes/${theme}/overrides.css`);
    const rules = css.split('\n').filter(line => line.includes('.chat-msg.') && line.includes('font:'));
    assert.ok(rules.length);
    for (const rule of rules) assert.match(rule, bodyScale, `${theme} preserves chat density`);
  }
});

test('latest assistant reply and page titles consume existing theme font roles', async () => {
  const styles = await read('styles.css');
  const emptyStrong = styles.slice(styles.indexOf('.chat-empty strong {'), styles.indexOf('}', styles.indexOf('.chat-empty strong {')) + 1);
  assert.match(emptyStrong, /font-family:\s*var\(--font-display\)/, 'empty-state title uses the display role');
  const pageTitle = styles.slice(styles.indexOf('.settings-page-title {'), styles.indexOf('}', styles.indexOf('.settings-page-title {')) + 1);
  assert.match(pageTitle, /font:\s*500 18px\/1\.35 var\(--font-display\)/, 'settings title keeps its scale but uses the display role');
});

test('moonlight keeps the shared 14px reading scale for the latest reply', async () => {
  const partner = await read('themes/moonlight/partner.css');
  assert.doesNotMatch(partner, /chat-msg\.assistant:not\(:has\(~ \.chat-msg\.assistant\)\)[^{]*\{[^}]*font-size:/, 'no latest-reply size override');
  assert.doesNotMatch(partner, /最新一条她的话放大/, 'no stale enlargement comment');
});
