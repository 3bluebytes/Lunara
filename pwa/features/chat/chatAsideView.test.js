import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createChatAsideView, readRecommendation } from './chatAsideView.js';

function node({ text = '', dataset = {}, attrs = {} } = {}) {
  const attributes = new Map(Object.entries(attrs));
  const listeners = new Map();
  return {
    textContent: text, hidden: false, dataset: { ...dataset }, clicks: 0,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch(type) { return listeners.get(type)?.(); },
    listeners,
    click() { this.clicks += 1; },
  };
}

function card({ state = 'pending', title = '《夜航星》', artist = '不才', turnId = 't1', note = '' } = {}) {
  const parts = {
    '.chat-recommendation-title': node({ text: title }),
    '.chat-recommendation-artist': artist ? node({ text: artist }) : null,
    '.chat-recommendation-note': node({ text: note }),
    '.chat-recommendation-accept': ['pending', 'not-source'].includes(state)
      ? node({ text: '放这首', dataset: { recommendationTurn: turnId }, attrs: { 'aria-label': `把${title}排到这首之后`, ...(state === 'not-source' ? { 'aria-disabled': 'true' } : {}) } })
      : null,
  };
  return { dataset: { state }, parts, querySelector: selector => parts[selector] || null };
}

function setup(cards) {
  const list = {
    cards,
    querySelectorAll(selector) {
      if (selector === '.chat-recommendation') return this.cards;
      if (selector === '[data-recommendation-turn]') return this.cards.map(c => c.parts['.chat-recommendation-accept']).filter(Boolean);
      return [];
    },
  };
  const parts = {
    '.chat-aside-title': node(), '.chat-aside-artist': node(), '.chat-aside-accept': node(), '.chat-aside-note': node(),
  };
  const aside = { hidden: true, dataset: {}, innerHTML: '', querySelector: selector => parts[selector] };
  let observed = null;
  class Observer {
    constructor(fn) { this.fn = fn; }
    observe(target, options) { observed = { target, options, fn: this.fn }; }
    disconnect() { observed = null; }
  }
  const nodes = { '#chat-aside': aside, '#chat-list': list };
  const view = createChatAsideView({ documentLike: { querySelector: s => nodes[s] || null, defaultView: { MutationObserver: Observer } } }).init();
  return { view, list, aside, parts, observed: () => observed };
}

test('右栏照最后一张推荐卡显示；没有推荐时整栏隐藏', () => {
  const f = setup([]);
  assert.equal(f.aside.hidden, true);
  assert.match(f.aside.innerHTML, /class="chat-aside-note" role="status" aria-live="polite"/);
  f.list.cards = [card({ title: '《旧歌》', turnId: 'old' }), card()];
  f.observed().fn();
  assert.equal(f.aside.hidden, false);
  assert.equal(f.aside.dataset.state, 'pending');
  assert.equal(f.parts['.chat-aside-title'].textContent, '《夜航星》');
  assert.equal(f.parts['.chat-aside-artist'].textContent, '不才');
  assert.equal(f.parts['.chat-aside-accept'].textContent, '放这首');
  assert.equal(f.parts['.chat-aside-accept'].getAttribute('aria-label'), '把《夜航星》排到这首之后');
  assert.equal(f.parts['.chat-aside-accept'].getAttribute('aria-disabled'), 'false');
});

test('「放这首」转给消息里的原按钮，不自己提交', () => {
  const f = setup([card({ turnId: 'a' }), card({ turnId: 'b' })]);
  f.parts['.chat-aside-accept'].dispatch('click');
  assert.equal(f.list.cards[1].parts['.chat-recommendation-accept'].clicks, 1);
  assert.equal(f.list.cards[0].parts['.chat-recommendation-accept'].clicks, 0);
});

test('原卡片的安排中、结果与过期都跟着变；播报节点不被替换', () => {
  const f = setup([card()]);
  const note = f.parts['.chat-aside-note'];
  const original = f.list.cards[0].parts['.chat-recommendation-accept'];
  original.textContent = '正在安排…';
  original.setAttribute('aria-busy', 'true');
  f.observed().fn();
  assert.equal(f.parts['.chat-aside-accept'].textContent, '正在安排…');
  assert.equal(f.parts['.chat-aside-accept'].getAttribute('aria-busy'), 'true');
  original.textContent = '放这首';
  original.setAttribute('aria-busy', 'false');
  original.setAttribute('aria-disabled', 'true');
  f.list.cards[0].parts['.chat-recommendation-note'].textContent = '已排到这首之后';
  f.observed().fn();
  assert.equal(f.parts['.chat-aside-note'], note);
  assert.equal(note.textContent, '已排到这首之后');
  assert.equal(f.parts['.chat-aside-accept'].getAttribute('aria-disabled'), 'true');
  f.list.cards = [card({ state: 'expired' })];
  f.observed().fn();
  assert.equal(f.aside.dataset.state, 'expired');
  assert.equal(f.parts['.chat-aside-accept'].hidden, true);
});

test('观察消息列表的子树与状态属性；销毁后解绑', () => {
  const f = setup([card()]);
  const { target, options } = f.observed();
  assert.equal(target, f.list);
  assert.equal(options.subtree, true);
  assert.equal(options.characterData, true);
  assert.deepEqual(options.attributeFilter, ['data-state', 'aria-disabled', 'aria-busy', 'aria-label']);
  f.view.destroy();
  assert.equal(f.observed(), null);
  assert.equal(f.parts['.chat-aside-accept'].listeners.size, 0);
});

test('readRecommendation：不可放的卡片没有按钮', () => {
  assert.equal(readRecommendation(null), null);
  const view = readRecommendation(card({ state: 'not-source', note: '到这个聊天一起听时才能放' }));
  assert.equal(view.action.disabled, true);
  assert.equal(view.note, '到这个聊天一起听时才能放');
  assert.equal(readRecommendation(card({ state: 'queued' })).action, null);
});

test('右栏默认隐藏，只在时间线「听」态宽屏显示；那时消息里的推荐卡收起', async () => {
  const shared = await readFile(new URL('../conversations/conversations.css', import.meta.url), 'utf8');
  assert.match(shared, /\.chat-aside \{ display: none; \}/);
  const timeline = await readFile(new URL('../shell/timeline.css', import.meta.url), 'utf8');
  const wide = timeline.slice(timeline.indexOf('/* ---- 聊天条（「听」态，961–1199px）'), timeline.indexOf('「聊」态（961–1199px）：时间线收成顶上一条'));
  assert.match(wide, /@media \(min-width: 961px\)/);
  assert.match(wide, /#app:not\(\.chat-focus\) \.chat-aside:not\(\[hidden\]\) \{[^}]*display: (grid|flex)/);
  assert.match(wide, /#app:not\(\.chat-focus\) \.chat-msg \.chat-recommendation \{ display: none; \}/);
  assert.match(wide, /grid-template-columns: minmax\(0, 1fr\) clamp\(/);
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<aside class="chat-aside" id="chat-aside" aria-label="推荐" hidden><\/aside>/);
});
