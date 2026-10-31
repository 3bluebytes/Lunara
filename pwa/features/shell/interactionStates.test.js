import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const cssUrl = new URL('../../interactions.css', import.meta.url);

test('contextual interaction layer follows structural and theme styles', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.ok(css.length > 0);
  assert.ok(html.indexOf('href="/interactions.css') > html.indexOf('/themes/nocturne/overrides.css'));
});

test('interaction groups include tools, selectors, content disclosures and selectable rows', async () => {
  const css = await readFile(cssUrl, 'utf8');
  for (const selector of ['.top-bar-menu', '#room-settings', '#companion-mode', '.radio-toggle', '.llm-switch', '.history-button', '.recording-review__row', '.today-task-filter', '.settings-nav-item', '.source-warning-close']) {
    assert.ok(css.includes(selector), `missing audited role: ${selector}`);
  }
  assert.match(css, /@media\s*\(hover: hover\)\s*and\s*\(pointer: fine\)/);
  assert.match(css, /:active/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-reduced-motion: no-preference/);
  assert.match(css, /forced-colors: active/);
});

test('interaction enhancements do not target disabled or busy controls or change layout', async () => {
  const css = (await readFile(cssUrl, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  // Every added hover/press selector carries the same negative guard, including label wrappers.
  for (const head of css.split('{').slice(0, -1)) {
    const selector = head.slice(head.lastIndexOf('}') + 1).trim();
    if (!/:(hover|active)\b/.test(selector)) continue;
    assert.ok(selector.includes(':not(:disabled, [aria-disabled="true"], [aria-busy="true"])'), selector);
  }
  assert.doesNotMatch(css, /(?:^|[;{])\s*(?:transform|translate|scale|position|width|height|padding|margin|display|font-size|border-width)\s*:/m);
  assert.doesNotMatch(css, /transition:\s*all\b/);
  assert.doesNotMatch(css, /!important/);
  assert.match(css, /:not\(\.disabled\)/, 'legacy disabled choices are excluded too');
  assert.match(css, /:not\(:has\(input:disabled\)\)/, 'disabled choices do not highlight their label');
  assert.match(css, /background-image: linear-gradient\(var\(--control-row-hover\)/, 'hover overlays rather than replacing selected row color');
  assert.match(css, /:not\(\.danger-button, \.llm-icon-danger, \.song-tag-danger\)/, 'ID-specific quiet group cannot mask danger treatment');
});
