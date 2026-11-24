import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createClientPresence } from '../../core/clientPresence.js';
import { FREE_VOICE_DISCLOSURE } from '../settings/freeVoiceSettings.js';
import { activateOnboardingItem, createOnboardingCard, createOnSetupRequired, onboardingPrefersChatPane, onboardingView } from './onboardingCard.js';

const missing = { model: 'missing', music: 'missing', voice: 'missing' };

function page() {
  const { document } = parseHTML(`<div id="chat-scroll"><div id="chat-list"></div></div><textarea id="compose-input"></textarea>`);
  const calls = [];
  const card = createOnboardingCard({
    documentLike: document,
    mount: document.querySelector('#chat-scroll'),
    setPage: pageId => calls.push(['page', pageId]),
    openSettings: () => calls.push(['settings']),
    openSource: source => calls.push(['source', source]),
  });
  return { document, card, calls, input: document.querySelector('#compose-input') };
}

test('a new install shows the model, music account, and voice', () => {
  const { document, card } = page();
  card.render({ checklist: missing, source: 'qq' });
  const items = [...document.querySelectorAll('[data-onboarding-item]')].map(node => node.dataset.onboardingItem);
  assert.deepEqual(items, ['model', 'music', 'voice']);
  const cardEl = document.querySelector('[data-onboarding-card]');
  assert.equal(cardEl.hidden, false);
  assert.equal(cardEl.classList.contains('shell-page-head'), true);
  assert.equal(cardEl.querySelector('.shell-page-title')?.textContent, '开始之前');
  assert.equal(cardEl.querySelectorAll('[data-onboarding-item].shell-primary').length, 3);
  assert.equal(cardEl.querySelector('.free-voice-quick').hidden, true);
});

test('only the next step is the solid button; voice is marked optional', () => {
  const { document, card } = page();
  const emphasis = () => [...document.querySelectorAll('[data-onboarding-item]')].map(node => node.dataset.emphasis);
  card.render({ checklist: missing, source: 'qq' });
  assert.deepEqual(emphasis(), ['primary', 'secondary', 'secondary']);
  assert.match(document.querySelector('[data-onboarding-item="voice"]').textContent, /可选/);
  card.render({ checklist: { ...missing, model: 'complete' }, source: 'qq' });
  assert.deepEqual(emphasis(), ['secondary', 'primary', 'secondary']);
});

test('a committed greeting leaves the card at the top of the message list', () => {
  const { document, card } = page();
  card.render({ checklist: missing, source: 'qq' });
  document.querySelector('#chat-list').innerHTML = '<div class="chat-msg">回来了</div>';
  const scroller = document.querySelector('#chat-scroll');
  assert.equal(scroller.firstElementChild?.hasAttribute('data-onboarding-card'), true);
  assert.equal(document.querySelector('[data-onboarding-card]').hidden, false);
  assert.equal(document.querySelector('#chat-list').textContent, '回来了');
});

test('model and voice select their settings page before opening settings', () => {
  const { document, card, calls } = page();
  card.render({ checklist: missing, source: 'qq' });
  document.querySelector('[data-onboarding-item="model"]').click();
  document.querySelector('[data-onboarding-item="voice"]').click();
  assert.deepEqual(calls, [
    ['page', 'connection'], ['settings'],
    ['page', 'voice'], ['settings'],
  ]);
});

test('music account opens source login and does not type or fill the composer', () => {
  const { document, card, calls, input } = page();
  const sent = [];
  const presence = createClientPresence({
    getSocket: () => ({ readyState: 1, send: raw => sent.push(JSON.parse(raw)) }),
    documentLike: document,
    input,
  });
  presence.init();
  presence.connected();
  let inputEvents = 0;
  input.addEventListener('input', () => { inputEvents += 1; });
  card.render({ checklist: missing, source: 'qq' });
  document.querySelector('[data-onboarding-item="music"]').click();
  assert.deepEqual(calls, [['source', 'qq']]);
  assert.equal(input.value, '');
  assert.equal(inputEvents, 0);
  assert.deepEqual(sent, [{ type: 'client-presence', visible: true, typing: false }]);
  presence.destroy();
});

test('music account without a primary source opens connection settings', () => {
  const { document, card, calls } = page();
  card.render({ checklist: missing, source: null });
  document.querySelector('[data-onboarding-item="music"]').click();
  assert.deepEqual(calls, [['page', 'connection'], ['settings']]);
});

test('a finished item is checked in place and the card hides only when all three are done', () => {
  const { document, card } = page();
  card.render({ checklist: missing, source: 'qq' });
  card.render({ checklist: { model: 'complete', music: 'missing', voice: 'missing' }, source: 'qq' });
  assert.equal(document.querySelector('[data-onboarding-item="model"]').dataset.complete, 'true');
  assert.equal(document.querySelector('[data-onboarding-item="music"]').dataset.complete, 'false');
  assert.equal(document.querySelector('[data-onboarding-item="voice"]').dataset.complete, 'false');
  assert.equal(document.querySelector('[data-onboarding-card]').hidden, false);
  const model = document.querySelector('[data-onboarding-item="model"]');
  card.render({ checklist: { model: 'complete', music: 'complete', voice: 'complete' }, source: 'qq' });
  assert.equal(document.querySelector('[data-onboarding-card]').hidden, true);
  assert.equal(document.querySelector('[data-onboarding-item="model"]') === model, true);
});

test('re-rendering keeps focus on the same item button', () => {
  const { document, card } = page();
  card.render({ checklist: missing, source: 'qq' });
  const music = document.querySelector('[data-onboarding-item="music"]');
  let focused = null;
  music.focus = () => { focused = music; };
  music.focus();
  card.render({ checklist: { model: 'complete', music: 'missing', voice: 'missing' }, source: 'qq' });
  assert.equal(document.querySelector('[data-onboarding-item="music"]') === focused, true);
  assert.equal(focused.isConnected, true);
  assert.equal(music.dataset.complete, 'false');
  assert.equal(document.querySelector('[data-onboarding-item="model"]').dataset.complete, 'true');
});

test('a completed music account does not open the scanner again', () => {
  const { document, card, calls } = page();
  card.render({ checklist: { model: 'missing', music: 'complete', voice: 'missing' }, source: 'qq' });
  document.querySelector('[data-onboarding-item="music"]').click();
  assert.deepEqual(calls, []);
});

test('activateOnboardingItem keeps source login on the music item', () => {
  const calls = [];
  const deps = {
    setPage: pageId => calls.push(['page', pageId]),
    openSettings: () => calls.push(['settings']),
    openSource: source => calls.push(['source', source]),
  };
  activateOnboardingItem('music', 'ncm', deps);
  activateOnboardingItem('music', '', deps);
  assert.deepEqual(calls, [
    ['source', 'ncm'],
    ['page', 'connection'], ['settings'],
  ]);
});

test('first source-login setup opens the scanner once and does not toast', () => {
  const sources = [];
  const toasts = [];
  const onSetupRequired = createOnSetupRequired({
    openSource: source => sources.push(source),
    showToast: () => toasts.push('toast'),
  });
  onSetupRequired({ missing: 'source-login', source: 'qq' });
  onSetupRequired({ missing: 'source-login', source: 'ncm' });
  const modelOnly = createOnSetupRequired({
    openSource: source => sources.push(source),
    showToast: () => toasts.push('toast'),
  });
  modelOnly({ missing: 'llm', source: null });
  assert.deepEqual(sources, ['qq']);
  assert.deepEqual(toasts, []);
});

const pendingXiaoxiao = {
  id: 'vp_cx_a0c168ef',
  displayName: '晓晓',
  sourceProvider: 'free-edge',
  unavailable: true,
};

function pageWithFreeVoice(fail = null) {
  const { document } = parseHTML('<div id="chat-scroll"><div id="chat-list"></div></div>');
  const patches = [];
  const card = createOnboardingCard({
    documentLike: document,
    mount: document.querySelector('#chat-scroll'),
    setPage() {},
    openSettings() {},
    openSource() {},
    saveTtsFallback: async patch => {
      patches.push(patch);
      if (fail) throw new Error(fail);
      return { fallback: { freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z' } };
    },
  });
  return { document, card, patches };
}

test('没有可用声音时引导卡先展示微软说明，同意后才开启', async () => {
  const { document, card, patches } = pageWithFreeVoice();
  card.render({
    checklist: missing,
    source: 'qq',
    voices: [pendingXiaoxiao],
    fallback: { freeVoicesEnabled: false, consentAt: null },
  });
  const button = document.querySelector('[data-free-voice-enable]');
  assert.equal(button?.textContent, '使用免费声音');
  assert.equal(document.querySelector('[data-free-voice-prompt]').hidden, true);
  button.click();
  assert.equal(document.querySelector('[data-free-voice-disclosure]').textContent, FREE_VOICE_DISCLOSURE);
  assert.deepEqual(patches, []);
  document.querySelector('[data-free-voice-agree]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(patches, [{ freeVoicesEnabled: true, consent: true }]);
});

test('引导卡取消免费声音时不开启', () => {
  const { document, card, patches } = pageWithFreeVoice();
  card.render({
    checklist: missing,
    source: null,
    voices: [],
    fallback: null,
  });
  document.querySelector('[data-free-voice-enable]').click();
  document.querySelector('[data-free-voice-cancel]').click();
  assert.equal(document.querySelector('[data-free-voice-prompt]').hidden, true);
  assert.deepEqual(patches, []);
});

test('已有可用声音时引导卡不显示使用免费声音', () => {
  const { document, card } = pageWithFreeVoice();
  card.render({
    checklist: { model: 'missing', music: 'missing', voice: 'missing' },
    source: 'qq',
    voices: [{ id: 'vp_custom', sourceProvider: 'custom', unavailable: false }],
    fallback: null,
  });
  const entry = document.querySelector('.free-voice-quick');
  assert.equal(entry.hidden, true);
  assert.equal(document.querySelector('[data-onboarding-card]').hidden, false);
});

test('引导卡刷新不重建免费声音入口，已展开的说明还在', () => {
  const { document, card } = pageWithFreeVoice();
  const state = {
    checklist: missing,
    source: 'qq',
    voices: [pendingXiaoxiao],
    fallback: { freeVoicesEnabled: false, consentAt: null },
  };
  card.render(state);
  const button = document.querySelector('[data-free-voice-enable]');
  const prompt = document.querySelector('[data-free-voice-prompt]');
  button.click();
  card.render(state);
  assert.equal(document.querySelector('[data-free-voice-enable]'), button);
  assert.equal(document.querySelector('[data-free-voice-prompt]'), prompt);
  assert.equal(prompt.hidden, false);
  card.render({
    ...state,
    voices: [{ id: 'vp_custom', sourceProvider: 'custom', unavailable: false }],
  });
  assert.equal(button.parentElement.hidden, true);
  card.render(state);
  assert.equal(document.querySelector('[data-free-voice-enable]'), button);
  assert.equal(prompt.hidden, false);
});

test('引导卡开启失败时展示具体原因', async () => {
  const { document, card } = pageWithFreeVoice('微软接口暂时拒绝');
  card.render({
    checklist: missing,
    source: 'qq',
    voices: [pendingXiaoxiao],
    fallback: null,
  });
  document.querySelector('[data-free-voice-enable]').click();
  document.querySelector('[data-free-voice-agree]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.querySelector('[data-free-voice-status]').textContent, /微软接口暂时拒绝/);
  assert.equal(document.documentElement.textContent.includes('操作没有完成'), false);
});

test('a consented /api/tts/custom payload marks the root voice complete', () => {
  const rootVoiceId = 'vp_cx_a0c168ef';
  const view = onboardingView({
    settings: { current: { llm: { ready: true }, primarySource: 'qq' }, options: { source: [{ id: 'qq', ready: true }] } },
    auth: { qq: { loggedIn: true } },
    voicesBody: { ok: true, voices: [{ id: rootVoiceId, unavailable: false, sourceProvider: 'free-edge', resolvedProviderId: 'free-edge' }] },
    customBody: {
      ok: true,
      config: {
        endpoints: [],
        voices: [],
        fallback: { version: 1, freeVoicesEnabled: true, consentAt: '2026-11-03T00:00:00.000Z', fallbackEnabled: false, fallbackTarget: null },
      },
    },
    rootVoiceId,
  });
  assert.equal(view.checklist.voice, 'complete');
  assert.equal(view.checklist.model, 'complete');
  assert.equal(view.checklist.music, 'complete');
});

test('an incomplete checklist opens the chat pane once', () => {
  assert.equal(onboardingPrefersChatPane({ incomplete: true, alreadyDefaulted: false }), true);
  assert.equal(onboardingPrefersChatPane({ incomplete: true, alreadyDefaulted: true }), false);
  assert.equal(onboardingPrefersChatPane({ incomplete: false, alreadyDefaulted: false }), false);
});
