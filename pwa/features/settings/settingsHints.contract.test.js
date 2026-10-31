// settingsHints.contract.test.js — 设置页提示与喜欢/不喜欢弹层的标记契约。
//
// 这两件事都靠「属性 + 现有 DOM」串起来，单元测试用替身驗不到：
//   * `data-tip` 写在 index.html 里，气泡组件按属性查找，写错属性名就是静默失效；
//   * 弹层要引用真实存在的标题/正文/按钮 id，删了任何一个都会让确认无声地失效。
// 所以这里读真实的 pwa/index.html 与 linkedom 解析出的 DOM。

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseHTML } from 'linkedom';

import { createReactionConfirm } from '../listening/reactionConfirm.js';
import { createTooltipLayer } from '../../core/tooltip.js';

const PWA_ROOT = resolve(import.meta.dirname, '../..');

async function loadIndex() {
  const html = await readFile(resolve(PWA_ROOT, 'index.html'), 'utf8');
  return parseHTML(html);
}

test('every settings tooltip carries a real sentence instead of an empty attribute', async () => {
  const { document } = await loadIndex();
  const settings = document.querySelector('#settings-panel');
  assert.ok(settings, '设置面板必须在 index.html 里');
  const tipped = [...settings.querySelectorAll('[data-tip]')];
  assert.ok(tipped.length >= 12, `设置页应有多处解释，实际只有 ${tipped.length} 处`);
  for (const element of tipped) {
    const text = String(element.getAttribute('data-tip') || '').trim();
    assert.ok(text.length >= 8, `${element.tagName} 的 data-tip 太短，等于没解释：${text}`);
    assert.ok(text.length <= 120, `${element.tagName} 的 data-tip 太长，气泡会盖住内容：${text.length}`);
  }
});

test('the settings controls whose meaning is not obvious are all explained', async () => {
  const { document } = await loadIndex();
  // 解释可以挂在控件本身，也可以挂在包住勾选框的 label 上（悬停整行都能看到）。
  const expectTip = selector => {
    const element = document.querySelector(selector);
    assert.ok(element, `${selector} 必须存在`);
    const tip = element.getAttribute('data-tip') || element.closest('[data-tip]')?.getAttribute('data-tip') || '';
    assert.ok(String(tip).trim(), `${selector} 需要 data-tip（自身或祖先）`);
  };
  // 只列「改错了会影响真实行为」的项：来源模式、渠道比例、主动开口、联网、封面取色、保存入口。
  for (const selector of [
    '.settings-card[aria-label="位置设置"] .boot-h',
    '[data-settings-page="general"] .boot-opt[data-tip]',
    '#single-source-settings .source-choice-label',
    '#multi-source-settings .source-choice-label',
    '#presence-ambient-toggle',
    '#presence-greeting-toggle',
    '#web-access-toggle',
    '#web-access-fallback',
    '#artwork-theme-toggle',
    '#boot-go',
    '#song-tag-backfill',
    '#tts-custom-save',
  ]) expectTip(selector);
});

test('the tooltip layer works against the real stylesheet hooks', async () => {
  const styles = await readFile(resolve(PWA_ROOT, 'styles.css'), 'utf8');
  assert.match(styles, /\.ui-tip\s*\{/, '气泡样式必须存在，否则只会是页面角落的一行字');
  assert.match(styles, /\[data-tip\]\s*\{[^}]*cursor:\s*help/, '可解释的项要有可悬停的提示');
});

test('the like/dislike dialog markup can actually settle an answer', async () => {
  const { document } = await loadIndex();
  const dialog = document.querySelector('#reaction-confirm');
  assert.ok(dialog, '喜欢/不喜欢的确认弹层必须在 index.html 里');
  const titleId = dialog.getAttribute('aria-labelledby');
  const copyId = dialog.getAttribute('aria-describedby');
  assert.ok(document.querySelector(`#${titleId}`), 'aria-labelledby 必须指向真实标题');
  assert.ok(document.querySelector(`#${copyId}`), 'aria-describedby 必须指向真实正文');
  for (const id of ['#reaction-confirm-ok', '#reaction-confirm-cancel']) {
    assert.ok(document.querySelector(id), `${id} 必须存在`);
  }
  assert.ok(dialog.querySelector('[data-close-dialog]'), '弹层要有可键盘到达的关闭按钮');

  const confirm = createReactionConfirm({ documentLike: document }).init();
  const confirmed = confirm.confirm({ kind: 'unlike', adopted: true, track: { title: '晴天', artist: '周杰伦' } });
  assert.equal(document.querySelector('#reaction-confirm-title').textContent, '云端歌单里已有这首');
  assert.equal(document.querySelector('#reaction-confirm-track').textContent, '《晴天》 · 周杰伦');
  document.querySelector('#reaction-confirm-ok').dispatchEvent(new document.defaultView.Event('click'));
  assert.equal(await confirmed, true);

  const refused = confirm.confirm({ kind: 'dislike' });
  document.querySelector('#reaction-confirm-cancel').dispatchEvent(new document.defaultView.Event('click'));
  assert.equal(await refused, false);
  confirm.destroy();
});

test('the tooltip layer mounts into the real document without stealing focus', async () => {
  const { document } = await loadIndex();
  const layer = createTooltipLayer({ documentLike: document, delayMs: 0 }).init();
  const anchor = document.querySelector('#presence-ambient-toggle').closest('[data-tip]');
  assert.ok(anchor, '开关的解释挂在它的 label 上，聚焦里面的 input 也要能看到');
  const input = document.querySelector('#presence-ambient-toggle');
  input.dispatchEvent(new document.defaultView.Event('focusin', { bubbles: true }));
  const bubble = document.querySelector('#ui-tip-bubble');
  assert.ok(bubble, '气泡必须真的挂进文档');
  assert.equal(bubble.textContent, String(anchor.getAttribute('data-tip')));
  assert.equal(bubble.getAttribute('role'), 'tooltip');
  layer.destroy();
});
