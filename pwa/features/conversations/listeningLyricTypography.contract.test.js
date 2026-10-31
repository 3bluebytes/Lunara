import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('compact listening lyrics inherit theme emphasis without an internal divider or clamp', async () => {
  const css = await read('features/conversations/conversations.css');
  const rules = [...css.matchAll(/#app\.chat-focus \.listening-lyric\s*\{([^}]+)\}/g)];
  assert.ok(rules.length, 'compact lyric layout is defined');
  for (const [, body] of rules) {
    assert.doesNotMatch(body, /font(?:-size)?:/, 'do not override the theme current-line scale');
    assert.doesNotMatch(body, /border-top:|line-clamp:|-webkit-box/, 'no divider or text truncation between adjacent lyrics');
    assert.match(body, /padding: 0;/);
    assert.match(body, /border: 0;/);
    assert.match(body, /overflow-wrap: anywhere;/);
  }
});

test('stage retains secondary instrumental notice typography', async () => {
  const css = await read('features/shell/stage.css');
  assert.match(css, /\.listening-lyric\[data-kind="notice"\]\s*\{[^}]*font: 400 14px\/1\.7 var\(--font-ui\)/);
});
