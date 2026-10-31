// dialogVisibility.test.js — 防止"对话框永久显示且关不掉"这类故障。
//
// 背景（真实发生过的故障）：给 `<dialog>` 无条件写 `display` 会覆盖浏览器内置的
// `dialog:not([open]) { display: none }`。后果是页面一加载对话框就永久可见，
// 且 `close()` 完全无效（display 优先级高于 open 属性），同时失去 modal 定位与遮罩——
// 整个应用被一个关不掉的面板挡住。
//
// 这类缺陷有两个特点，所以值得单独守：
//   1. 纯 CSS，任何单元测试与 DOM 夹具都测不到（我们的 144 个测试全部通过了）；
//   2. 只有"打开前"的状态才能暴露它——只看打开后的截图会漏掉。
//
// 因此这里直接对源码做检查：凡是给 `<dialog>` 用的类设了 display 的规则，
// 必须把 display 限定在 `[open]` 上。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const HTML = readFileSync(resolve(ROOT, 'pwa/index.html'), 'utf8');
const CSS_FILES = [
  'pwa/styles.css',
  'pwa/features/conversations/conversations.css',
  'pwa/features/radiohost/radiohost.css',
].filter(path => { try { readFileSync(resolve(ROOT, path)); return true; } catch { return false; } });

/** 从 index.html 取出所有 `<dialog>` 用到的类名。 */
export function dialogClassesFromHtml(html) {
  const classes = new Set();
  for (const match of html.matchAll(/<dialog\b[^>]*>/g)) {
    const classAttr = match[0].match(/class="([^"]*)"/);
    if (!classAttr) continue;
    for (const name of classAttr[1].split(/\s+/).filter(Boolean)) classes.add(name);
  }
  return classes;
}

/** 去掉注释，避免注释里的示例代码被当成规则。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 取选择器的主体（最后一个组合子之后的复合选择器），并剥掉伪类/属性/伪元素。
 *
 * 必须这样精确匹配：`.person-sheet-title` 里包含 `.person-sheet`，
 * 用子串匹配会把子元素正常设置 display 当成故障（第一版守卫就误报了这些）。
 */
export function selectorSubject(selector) {
  const last = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || '';
  return last
    .replace(/::?[a-zA-Z-]+(?:\([^)]*\))?/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

/**
 * 审查对话框的 display 规则。
 *
 * 只关心**主体就是对话框本身**且**把 display 设成可见值**的规则——
 * 那类规则会覆盖 `dialog:not([open]){display:none}`，使面板永久显示且 close() 失效。
 *
 * 特别注意：`.dialog { display: none }` + `.dialog[open] { display: flex }` 是
 * 仓库既有的**正确**写法（见 .mem-drawer），不属于违规。
 */
export function auditDialogDisplay(css, dialogClasses) {
  const violations = [];
  const scoped = [];
  const hidden = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1].trim();
    const body = match[2];
    const displayMatch = body.match(/(?:^|[;\s])display\s*:\s*([^;]+)/);
    if (!displayMatch) continue;
    const displayValue = displayMatch[1].trim();
    for (const selector of selectorList.split(',').map(part => part.trim()).filter(Boolean)) {
      const subject = selectorSubject(selector);
      const hit = [...dialogClasses].find(name => subject === `.${name}`);
      if (!hit) continue;
      const entry = { selector, displayValue, subject };
      // 必须先剥掉 `:not([open])`：那个字符串里也含 "[open]"，
      // 不区分就会把"关闭态"误判成"打开态"（守卫第一版就踩了这个坑）。
      const openScoped = selector.replace(/:not\(\[open\]\)/g, '').includes('[open]');
      if (openScoped) scoped.push(entry);
      else if (displayValue === 'none') hidden.push(entry);
      else violations.push(entry);
    }
  }
  return { violations, scoped, hidden };
}

test('index.html 里的对话框类可以被解析出来', () => {
  const classes = dialogClassesFromHtml(HTML);
  assert.ok(classes.size >= 3, `应识别出多个对话框类，实际 ${classes.size}`);
  assert.ok(classes.has('salon-dialog'), 'salon-dialog 是所有对话框的公共外壳');
});

test('检测器能认出"无条件 display"这种写法（自校验）', () => {
  // 先证明守卫本身有效：拿一段刻意写错的选择器喂进去，必须被标记。
  const buggy = '.my-dialog { display: flex; flex-direction: column; }';
  assert.equal(auditDialogDisplay(buggy, new Set(['my-dialog'])).violations.length, 1,
    '检测器必须能识出这个陷阱');
  // 正确写法：限定在 [open] 上，不应被标记。
  const ok = '.my-dialog:not([open]) { display: none; }\n.my-dialog[open] { display: flex; }';
  const okResult = auditDialogDisplay(ok, new Set(['my-dialog']));
  assert.deepEqual(okResult.violations, []);
  assert.equal(okResult.hidden.length, 1, ':not([open]) 应归为关闭态');
  assert.equal(okResult.scoped.length, 1, '[open] 应归为打开态');
  assert.equal(okResult.scoped[0].displayValue, 'flex');
  // 子元素设 display 不是故障（第一版守卫就是因为子串匹配误报了这些）。
  const child = '.my-dialog-title { display: flex; }\n.my-dialog-body { display: grid; }';
  assert.deepEqual(auditDialogDisplay(child, new Set(['my-dialog'])).violations, [],
    '子元素不应被误判为对话框本体');
});

test('没有任何规则给对话框无条件设 display（会导致关不掉）', () => {
  const dialogClasses = dialogClassesFromHtml(HTML);
  const all = [];
  for (const path of CSS_FILES) {
    const css = readFileSync(resolve(ROOT, path), 'utf8');
    for (const violation of auditDialogDisplay(css, dialogClasses).violations) {
      all.push({ path, ...violation });
    }
  }
  assert.deepEqual(all, [],
    '给 <dialog> 无条件设 display 会覆盖 dialog:not([open]){display:none}，'
    + '导致面板永久显示且 close() 无效。请把 display 限定在 [open] 上。');
});

test('person 面板的显示既被限定在 [open]，打开时也确实会显示', () => {
  const css = readFileSync(resolve(ROOT, 'pwa/features/conversations/conversations.css'), 'utf8');
  const clean = stripComments(css);
  // 关闭态必须显式为 none（而不是只依赖 UA 样式被别处覆盖）
  assert.match(clean, /\.person-sheet:not\(\[open\]\)\s*\{[^}]*display:\s*none/,
    '关闭态必须显式 display: none');
  assert.match(clean, /\.person-sheet\[open\]\s*\{[^}]*display:\s*flex/,
    '打开态必须显式 display: flex（面板靠 flex 布局分两列）');
});

test('每个设了 display 的对话框都有对应可见的 [open] 规则（否则打不开）', () => {
  const dialogClasses = dialogClassesFromHtml(HTML);
  for (const path of CSS_FILES) {
    const { scoped } = auditDialogDisplay(readFileSync(resolve(ROOT, path), 'utf8'), dialogClasses);
    // 只要求"有 [open] 且值不是 none"，不要求具体布局方式。
    for (const rule of scoped) {
      assert.notEqual(rule.displayValue, 'none',
        `${path}: ${rule.selector} 把打开态也设成 display: none，对话框将无法显示`);
    }
  }
});
