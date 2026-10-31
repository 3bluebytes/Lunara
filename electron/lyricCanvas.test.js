import assert from 'node:assert/strict';
import test from 'node:test';
import { createLyricCanvas, lyricCanvasHtml } from './lyricCanvas.js';

test('without a renderer or image factory the canvas fails closed', () => {
  // 渲染器拿不到 nativeImage 时不能半可用：tray 会据此回落单色文本。
  assert.equal(createLyricCanvas({}), null);
  assert.equal(createLyricCanvas({ BrowserWindow: class {} }), null, '缺 nativeImage 时不可用');
  const canvas = createLyricCanvas({ BrowserWindow: class {}, nativeImage: { createFromBuffer() {} } });
  assert.equal(canvas.textWidthPx, canvas.widthPx - canvas.textX, '扫色窗口 = 整窗扣除左侧图标位');
  assert.ok(canvas.textX > 0, '图标位留有宽度');
});

test('the page separates device-pixel size from point display size', () => {
  // 曾经踩过：只写在样式表里的 CSS 缩放没生效，画布 400×44 塞进 200×22pt 窗口，
  // 只露出左上角 → 菜单栏里的字被放大并裁掉。这里锁死两条尺寸都在模板里。
  const html = lyricCanvasHtml({ widthPx: 400, heightPx: 44, widthPt: 200, heightPt: 22,
    icon: { cx: 14, cy: 22, r: 12 } });
  assert.match(html, /width="400"\s+height="44"/, '画布像素尺寸 = 点 × dpr');
  assert.match(html, /style="display:block;width:200px;height:22px"/, '显示尺寸必须是点');
  assert.match(html, /baseline = 22/, '基线用设备像素的一半，不能是 undefined');
  assert.doesNotMatch(html, /undefined/, '模板里不能有未定义的插值');
});
