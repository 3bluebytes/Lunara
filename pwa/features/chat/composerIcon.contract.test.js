import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const ruleFor = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  return css.slice(start, css.indexOf('}', start) + 1);
};

test('send and stop glyphs follow the button foreground instead of a fixed fill', async () => {
  const css = await read('features/conversations/conversations.css');
  for (const [selector, size] of [
    ['.conversation-main .compose #compose-send::after', '17px'],
    ['.conversation-main .compose #compose-send.stop::after', '13px'],
  ]) {
    const rule = ruleFor(css, selector);
    assert.match(rule, /background-color:\s*currentColor/, `${selector} paints with currentColor`);
    assert.match(rule, new RegExp(`-webkit-mask:\\s*center / ${size} no-repeat url\\(`), `${selector} keeps its shape mask size`);
    assert.match(rule, new RegExp(`(^|[^-])mask:\\s*center / ${size} no-repeat url\\(`), `${selector} keeps the standard mask`);
    assert.doesNotMatch(rule, /background:\s*center/, `${selector} no longer uses a fixed-fill background shorthand`);
  }
});

test('composer button states keep their existing colour contract', async () => {
  const css = await read('features/conversations/conversations.css');
  const button = ruleFor(css, '.conversation-main .compose #compose-send');
  assert.match(button, /color:\s*#24170a/, 'send keeps its dark foreground');
  assert.match(button, /background:\s*var\(--amber\)/, 'send keeps the amber surface');
  assert.match(css, /#compose-send:hover \{ background: color-mix\(in srgb, var\(--amber\) 86%, white\); \}/);
  assert.match(css, /#compose-send:active \{ transform: scale\(\.94\); \}/);
  assert.match(css, /#compose-send\.stop \{ background: var\(--t-mid\); \}/);
});
