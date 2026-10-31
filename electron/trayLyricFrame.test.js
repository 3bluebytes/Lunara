import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LYRIC_EDGE_PADDING, computeLyricFrame, interpolateProgress, lyricPalette,
} from './trayLyricFrame.js';

test('the sung part grows from the left edge', () => {
  const window = 400;
  const textWidth = 320;
  assert.deepEqual(
    [0, 0.25, 0.5].map(progress => computeLyricFrame({ textWidth, windowWidth: window, progress })),
    [
      { shift: 0, clipRight: 0, sungRatio: 0 },
      { shift: 0, clipRight: 80, sungRatio: 0.25 },
      { shift: 0, clipRight: 160, sungRatio: 0.5 },
    ],
  );
});

test('once the progress point reaches the right edge the whole line shifts left', () => {
  const window = 400;
  const padding = LYRIC_EDGE_PADDING;
  const edge = window - padding;
  // 句子的字宽大于窗口：进度点一定会撞到右缘
  const textWidth = 520;
  // 撞到之前：字不动，只是染色变长
  assert.deepEqual(
    computeLyricFrame({ textWidth, windowWidth: window, progress: 0.6, edgePadding: padding }),
    { shift: 0, clipRight: Math.round(textWidth * 0.6), sungRatio: 0.6 },
  );
  // 撞到之后：整行左移，染色右边界固定在「窗口宽 - 余量」
  const late = computeLyricFrame({ textWidth, windowWidth: window, progress: 1, edgePadding: padding });
  assert.equal(late.shift, Math.round(textWidth - edge), '整行左移，让进度点停住');
  assert.equal(late.clipRight, edge, '进度点停在距右缘固定余量处');
  // 左移量必须是「平移到边缘」，不是每帧再叠加
  assert.equal(computeLyricFrame({ textWidth, windowWidth: window, progress: 0.8, edgePadding: padding }).clipRight, edge);
  // 句子比窗口短：整句都看得见，永不左移
  assert.equal(computeLyricFrame({ textWidth: 200, windowWidth: window, progress: 1, edgePadding: padding }).shift, 0);
});

test('a line longer than the window scrolls instead of overflowing', () => {
  const window = 400;
  const textWidth = 900; // 长句
  const mid = computeLyricFrame({ textWidth, windowWidth: window, progress: 0.5 });
  assert.ok(mid.shift > 0, '过半就要开始左移');
  assert.equal(mid.clipRight, window - LYRIC_EDGE_PADDING, '染色右边界固定在余量处');
  const start = computeLyricFrame({ textWidth, windowWidth: window, progress: 0.05 });
  assert.equal(start.shift, 0, '开头仍然从窗口左缘开始');
});

test('the frame never paints outside the window', () => {
  for (const progress of [-1, 0, 0.5, 1, 2]) {
    for (const textWidth of [0, 10, 400, 1200]) {
      const frame = computeLyricFrame({ textWidth, windowWidth: 400, progress });
      assert.ok(frame.clipRight >= 0 && frame.clipRight <= 400, `clip ${frame.clipRight}`);
      assert.ok(frame.shift >= 0, 'shift 不为负');
    }
  }
  // 未知进度（还没到第一句）按「全亮」处理，不闪成空白
  assert.equal(computeLyricFrame({ textWidth: 100, windowWidth: 400, progress: null }).sungRatio, 1);
});

test('progress is interpolated between reports and never rewinds', () => {
  assert.equal(interpolateProgress({ progress: 0.2, spanMs: 4000, anchorAt: 1000, now: 1000 }), 0.2);
  assert.equal(interpolateProgress({ progress: 0.2, spanMs: 4000, anchorAt: 1000, now: 3000 }), 0.7);
  assert.equal(interpolateProgress({ progress: 0.2, spanMs: 4000, anchorAt: 1000, now: 99_000 }), 1,
    '越过行尾停在 1，不回卷到下一句');
  assert.equal(interpolateProgress({ progress: 0.2, spanMs: 4000, anchorAt: 3000, now: 1000 }), 0.2,
    '时钟回拨也不倒退');
  assert.equal(interpolateProgress({ progress: 0.4, spanMs: null, anchorAt: 0, now: 5000 }), 0.4,
    '不知道跨度时停在已上报的进度');
  assert.equal(interpolateProgress({ progress: null }), null);
});

test('the palette follows the menu bar appearance', () => {
  assert.equal(lyricPalette(true).bright, '#ffffff');
  assert.match(lyricPalette(true).dim, /^rgba\(255,255,255,0\.4/);
  assert.equal(lyricPalette(false).bright, '#17171a');
  assert.match(lyricPalette(false).dim, /^rgba\(23,23,26,0\.3/);
});
