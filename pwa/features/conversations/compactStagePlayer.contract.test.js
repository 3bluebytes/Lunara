import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the native mixer disclosure wraps the original inputs without duplicating player authority', async () => {
  const html = await read('index.html');
  assert.match(html, /<details[^>]*id="player-mixer-details"[\s\S]*?<summary[^>]*id="mixer-summary"[^>]*aria-label="声音混合"/);
  for (const id of ['episode-mixer', 'mixer-bed', 'mixer-voice', 'audioMusic', 'big-play']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} remains unique`);
  }
});

test('stage narrow player does not expand the mixer and waveform into mandatory full-width rows', async () => {
  const css = await read('features/shell/stage.css');
  assert.doesNotMatch(css, /\.persistent-player \.episode-mixer:not\(\[hidden\]\) \{ display: flex !important; flex-basis: 100%/);
  const shared = await read('features/conversations/conversations.css');
  assert.match(shared, /\.player-details:not\(\[open\]\) > \.episode-mixer \{ display: none !important; \}/);
  assert.match(css, /\.mixer-summary \{[^}]*min-height: 44px/);
  assert.match(css, /#compose-send \{[^}]*width: 44px; height: 44px; min-height: 44px/);
});
