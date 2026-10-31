import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createMoonlightSidebar } from './sidebar.js';

function harness(theme = 'moonlight') {
  const { document } = parseHTML(`<html data-theme="${theme}" data-layout="stage"><body><aside class="conversation-sidebar expanded"><button id="nav-conversations" class="shell-nav-item">聊天</button><button id="nav-today" class="shell-nav-item">帐本</button><button id="recording-review-open" class="shell-nav-item" aria-controls="recording-review-panel" aria-expanded="false">整理</button><button id="sidebar-close">收起</button><input id="room-search"></aside></body></html>`);
  let desktop = true, change;
  const viewport = { get matches() { return desktop; }, addEventListener(_, fn) { change = fn; }, removeEventListener(_, fn) { if (change === fn) change = null; } };
  const sidebar = createMoonlightSidebar({ documentLike: document, windowLike: { matchMedia: () => viewport } }).init();
  return { sidebar, document, panel: document.querySelector('aside'), resize(value) { desktop = value; change?.(); } };
}

test('moonlight starts collapsed; icons expand, switch, then repeat collapses without navigating', () => {
  const h = harness();
  assert.equal(h.panel.classList.contains('expanded'), false);
  assert.equal(h.sidebar.navigate('rooms'), true);
  assert.equal(h.panel.classList.contains('expanded'), true);
  assert.equal(h.sidebar.navigate('today'), true);
  assert.equal(h.sidebar.navigate('today'), false);
  assert.equal(h.panel.classList.contains('expanded'), false);
  assert.equal(h.sidebar.navigate('today'), true, 'same destination reopens from the rail');
  assert.equal(h.document.querySelector('#nav-today').getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.querySelector('#recording-review-open').getAttribute('aria-expanded'), 'false', 'review panel ARIA remains its own');
  h.sidebar.destroy();
});

test('automatic browsing does not undo icon expansion; explicit close returns hidden focus', () => {
  const h = harness();
  h.sidebar.navigate('today');
  assert.equal(h.sidebar.collapse(), true);
  assert.equal(h.panel.classList.contains('expanded'), true);
  const search = h.document.querySelector('input');
  Object.defineProperty(h.document, 'activeElement', { value: search, configurable: true });
  let focused = false;
  h.document.querySelector('#nav-today').focus = () => { focused = true; };
  h.sidebar.collapse({ explicit: true });
  assert.equal(h.panel.classList.contains('expanded'), false);
  assert.equal(focused, true);
  h.sidebar.destroy();
});

test('other themes restore their own expanded state; reentering moonlight defaults closed', () => {
  const h = harness('modernist');
  assert.equal(h.sidebar.navigate('rooms'), null);
  assert.equal(h.sidebar.collapse({ explicit: true }), false);
  assert.equal(h.panel.classList.contains('expanded'), true);
  h.sidebar.setTheme('moonlight');
  h.sidebar.navigate('rooms');
  h.sidebar.setTheme('modernist');
  assert.equal(h.panel.classList.contains('expanded'), true);
  assert.equal(h.document.documentElement.hasAttribute('data-moonlight-sidebar'), false);
  assert.equal(h.document.querySelector('#nav-today').hasAttribute('aria-expanded'), false);
  h.sidebar.setTheme('moonlight');
  assert.equal(h.panel.classList.contains('expanded'), false);
  h.sidebar.setTheme('nocturne');
  assert.equal(h.sidebar.navigate('people'), null);
  h.sidebar.destroy();
});

test('narrow drawer bypasses desktop toggling and restores the previous rail on widening', () => {
  const h = harness();
  h.resize(false);
  assert.equal(h.panel.classList.contains('expanded'), true, 'full drawer headings remain visible');
  assert.equal(h.sidebar.navigate('today'), null);
  assert.equal(h.sidebar.collapse({ explicit: true }), false);
  h.resize(true);
  assert.equal(h.panel.classList.contains('expanded'), false);
  h.sidebar.navigate('rooms');
  h.resize(false);
  h.resize(true);
  assert.equal(h.panel.classList.contains('expanded'), true);
  h.sidebar.destroy();
  assert.equal(h.document.documentElement.hasAttribute('data-moonlight-sidebar'), false);
});
