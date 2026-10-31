import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DESKTOP_WINDOW_BOUNDS } from './windowBounds.js';

test('desktop window keeps every primary control inside a usable minimum envelope', async () => {
  assert.deepEqual(DESKTOP_WINDOW_BOUNDS, {
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
  });
  const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /new BrowserWindow\(\{[\s\S]*\.\.\.DESKTOP_WINDOW_BOUNDS/);
  assert.doesNotMatch(main, /minWidth:\s*360|minHeight:\s*600/);
});
