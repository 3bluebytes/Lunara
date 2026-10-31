import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createRecordingReviewView } from './recordingReviewView.js';

test('presentation can intercept a repeat click and reopen the rail without closing the review', async () => {
  const { document } = parseHTML('<html><body><button id="recording-review-open"></button><section id="recording-review-panel"></section></body></html>');
  let action = 'open', reads = 0, opens = 0;
  const view = createRecordingReviewView({ documentLike: document,
    apiClient: { get: async () => { reads++; return { ok: true, proposals: [], recordings: [], trackCount: 0 }; } },
    beforeToggle: () => action, onOpen: () => { opens++; },
  });
  const launcher = document.querySelector('button');
  const host = document.querySelector('section');
  launcher.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.hidden, false);
  assert.equal(reads, 1);
  action = false;
  launcher.click();
  assert.equal(host.hidden, false, 'collapse of the sidebar does not close the workspace');
  action = 'open';
  launcher.click();
  assert.equal(host.hidden, false, 'opening the rail does not toggle the review closed');
  assert.equal(opens, 1);
  assert.equal(reads, 1, 'no repeated loading');
  action = true;
  launcher.click();
  assert.equal(host.hidden, true, 'other themes retain normal toggle behavior');
  view.destroy();
});
