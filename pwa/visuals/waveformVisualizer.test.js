import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaveformVisualizer } from './waveformVisualizer.js';

test('waveform init is idempotent and teardown releases frame, interval, and owned bars', () => {
  const children = [];
  const frames = [];
  const intervals = [];
  const cancelledFrames = [];
  const cancelledIntervals = [];
  const container = { appendChild: node => children.push(node) };
  const visualizer = createWaveformVisualizer({
    container,
    createElement: trackedElement,
    requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame: id => cancelledFrames.push(id),
    scheduleInterval: fn => { intervals.push(fn); return intervals.length; },
    cancelInterval: id => cancelledIntervals.push(id),
    isIdle: () => false,
    getVariant: () => 'dual',
    random: () => 0.5,
    dualBarCount: 4,
    dualMusicMaxBarHeight: 20,
    idleBarHeight: 4,
  });

  visualizer.init();
  visualizer.init();
  assert.equal(children.length, 2);
  assert.equal(children[0].children.length, 4);
  assert.equal(intervals.length, 1);

  const analyser = {
    frequencyBinCount: 8,
    getByteFrequencyData(data) { data.fill(128); },
  };
  visualizer.setAnalyser(analyser);
  visualizer.setAnalyser(analyser);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(frames.length, 2);
  assert.equal(children[0].children.every(node => Number.parseInt(node.style.height, 10) <= 22), true);

  visualizer.destroy();
  assert.deepEqual(cancelledFrames, [2]);
  assert.deepEqual(cancelledIntervals, [1]);
  assert.equal(children.every(node => node.removed), true);
});

function trackedElement() {
  const classes = new Set();
  const node = {
    className: '',
    style: {},
    children: [],
    classList: { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name) },
    appendChild(child) { node.children.push(child); },
    remove() { node.removed = true; },
  };
  return node;
}

test('dual variant builds a music row and a voice row; played bars follow progress', () => {
  const children = [];
  const intervals = [];
  let progress = 0.5;
  let speaking = false;
  const visualizer = createWaveformVisualizer({
    container: { appendChild: node => children.push(node) },
    createElement: trackedElement,
    windowLike: { matchMedia: () => ({ matches: false }) },
    scheduleInterval: fn => { intervals.push(fn); return 1; },
    cancelInterval() {},
    isIdle: () => false,
    getVariant: () => 'dual',
    getProgress: () => progress,
    isVoiceActive: () => speaking,
    dualBarCount: 8,
  });
  visualizer.init();
  assert.deepEqual(children.map(row => row.className), ['waveform-row waveform-music', 'waveform-row waveform-voice']);
  const [music, voice] = children.map(row => row.children);
  assert.equal(music.length, 8);
  assert.equal(voice.length, 8);

  intervals[0]();
  assert.deepEqual(music.map(bar => bar.classList.contains('played')), [true, true, true, true, false, false, false, false]);
  assert.equal(voice.every(bar => bar.style.height === '2px'), true, '旁白不播时下行静止');
  assert.equal(music.every(bar => bar.style.opacity === undefined), true, '双行的透明度交给样式');

  speaking = true;
  progress = 1;
  intervals[0]();
  assert.equal(music.every(bar => bar.classList.contains('played')), true);
  assert.ok(voice.some(bar => Number.parseInt(bar.style.height, 10) > 2), '旁白播放时下行起伏');
  visualizer.destroy();
});

test('the voice row stays still and schedules no timer under reduced motion', () => {
  const children = [];
  const intervals = [];
  const frames = [];
  const visualizer = createWaveformVisualizer({
    container: { appendChild: node => children.push(node) },
    createElement: trackedElement,
    windowLike: { matchMedia: () => ({ matches: true }) },
    requestFrame: fn => { frames.push(fn); return frames.length; },
    scheduleInterval: fn => { intervals.push(fn); return 1; },
    getVariant: () => 'dual',
    isIdle: () => false,
    isVoiceActive: () => true,
    dualBarCount: 4,
  }).init();
  visualizer.setAnalyser({ frequencyBinCount: 8, getByteFrequencyData(data) { data.fill(200); } });
  assert.equal(intervals.length, 0);
  assert.equal(frames.length, 0);
  assert.equal(children[1].children.every(bar => bar.style.height === '2px'), true);
  visualizer.destroy();
});

test('refresh rebuilds bars only when the theme variant changes and skips bar/loop work on line variant', () => {
  const children = [];
  const frames = [];
  const intervals = [];
  const cancelledFrames = [];
  const cancelledIntervals = [];
  let variant = 'single';
  const visualizer = createWaveformVisualizer({
    container: { appendChild: node => children.push(node) },
    createElement: trackedElement,
    windowLike: { matchMedia: () => ({ matches: false }) },
    requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame: id => cancelledFrames.push(id),
    scheduleInterval: fn => { intervals.push(fn); return intervals.length; },
    cancelInterval: id => cancelledIntervals.push(id),
    isIdle: () => false,
    getVariant: () => variant,
    barCount: 3,
    dualBarCount: 5,
  });
  visualizer.init();
  visualizer.setAnalyser({ frequencyBinCount: 8, getByteFrequencyData(data) { data.fill(160); } });
  assert.equal(children.length, 3);
  assert.equal(frames.length, 1);
  visualizer.refresh();
  assert.equal(children.length, 3, '变体没变就不重建');

  variant = 'dual';
  visualizer.refresh();
  assert.equal(children.slice(0, 3).every(node => node.removed), true, '旧的单行条被移除');
  assert.deepEqual(children.slice(3).map(node => node.className), ['waveform-row waveform-music', 'waveform-row waveform-voice']);
  assert.equal(intervals.length, 1);

  variant = 'line';
  const framesBeforeLine = frames.length;
  const intervalsBeforeLine = intervals.length;
  visualizer.refresh();
  assert.equal(children.slice(3, 5).every(node => node.removed), true, '切到 line 时移除双行柱子');
  assert.equal(children.length, 5, 'line 变体不创建任何波形柱节点');
  assert.equal(frames.length, framesBeforeLine, 'line 变体不启动 rAF');
  assert.equal(intervals.length, intervalsBeforeLine, 'line 变体不启动定时器');
  assert.equal(cancelledFrames.length, 2, '切到 line 时取消先前活跃的 rAF');
  assert.equal(cancelledIntervals.length, 1, '切到 line 时取消先前活跃的 interval');

  variant = 'single';
  visualizer.refresh();
  assert.equal(children.slice(5).length, 3, '从 line 切回 single 时恢复波形柱');
  assert.equal(frames.length, framesBeforeLine + 1, '从 line 切回 single 且活跃时恢复 rAF');
  visualizer.destroy();
});

test('bands spread bars across the spectrum instead of piling onto high bins', async () => {
  const { logBandEdges, bandLevel, binLevel } = await import('./waveformVisualizer.js');
  const edges = logBandEdges(72, 128);
  assert.equal(edges.length, 73);
  assert.equal(edges[0], 1);
  assert.ok(Math.abs(edges.at(-1) - 96) < 1e-9);
  const low = edges.filter(edge => edge < 10).length;
  assert.ok(low > 20, `约三分之一的柱子落在前 10 个频点（线性只有 7 根），实际 ${low}`);
  assert.ok(edges.filter(edge => edge < 3).length < 12, '最低几个频点不会挤进一大片柱子');

  const levels = new Float32Array(128);
  levels[2] = 1; levels[3] = 1;
  assert.equal(bandLevel(levels, 2.4, 2.6), 1, '窄频段插值');
  levels[50] = 0.4;
  assert.ok(Math.abs(bandLevel(levels, 40, 60) - 0.4) < 1e-6, '宽频段取区间最大值');

  assert.equal(binLevel(-Infinity, 4), 0, '静音不显示');
  assert.equal(binLevel(-90, 1), 0, '低于下限不显示');
  assert.equal(binLevel(0, 1), 1, '超过上限封顶');
  // 实测（Apple Loops 混音，fftSize 256）：频点 1 约 -25dB、频点 48 约 -64dB、频点 96 约 -84dB。
  assert.ok(Math.abs(binLevel(-25, 1) - binLevel(-64, 48)) < 0.15, '补偿后低频和中高频高度相近');
  assert.ok(binLevel(-25, 1) < 0.6, '常态低频不顶格，留出峰值');
  assert.ok(binLevel(-84, 96) > 0, '最高频段仍可见');
});

test('music bars rise fast and fall slowly; reduced motion stops the frame loop at resting height', () => {
  function run(reduced) {
    const children = [];
    const frames = [];
    let level = 255;
    const visualizer = createWaveformVisualizer({
      container: { appendChild: node => children.push(node) },
      createElement: trackedElement,
      windowLike: { matchMedia: () => ({ matches: reduced }) },
      requestFrame: fn => { frames.push(fn); return frames.length; },
      cancelFrame() {},
      scheduleInterval: () => 1,
      cancelInterval() {},
      isIdle: () => false,
      getVariant: () => 'dual',
      dualBarCount: 4,
      dualMusicMaxBarHeight: 20,
    }).init();
    visualizer.setAnalyser({ frequencyBinCount: 16, getByteFrequencyData(data) { data.fill(level); } });
    if (reduced) {
      assert.equal(frames.length, 0);
      const resting = children[0].children.map(bar => Number.parseInt(bar.style.height, 10));
      visualizer.destroy();
      return resting;
    }
    const heights = [];
    const step = () => { frames.at(-1)(); heights.push(Number.parseInt(children[0].children[0].style.height, 10)); };
    step(); step(); step();
    level = 0;
    step();
    visualizer.destroy();
    return heights;
  }
  const [first, second, third, afterDrop] = run(false);
  assert.ok(first > 2 && first < 22, '第一帧只升到一部分');
  assert.ok(second > first && third >= second, '随后继续上升');
  assert.ok(afterDrop < third && afterDrop > 2, '静音后慢慢落下而不是瞬间归零');
  assert.deepEqual(run(true), [2, 2, 2, 2], '减少动态时不调度帧且保持静止高度');
});

test('waveform halts rAF and interval while idle, hidden, or reduced-motion, and resumes on wakeup', () => {
  const docListeners = new Map();
  const motionListeners = new Set();
  const documentLike = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener(type, fn, options) {
      const key = `${type}:${Boolean(options)}`;
      if (!docListeners.has(key)) docListeners.set(key, new Set());
      docListeners.get(key).add(fn);
    },
    removeEventListener(type, fn, options) {
      docListeners.get(`${type}:${Boolean(options)}`)?.delete(fn);
    },
    emit(type, capture = false) {
      for (const fn of docListeners.get(`${type}:${capture}`) || []) fn();
    },
  };
  const motionQuery = {
    matches: false,
    addEventListener(type, fn) { if (type === 'change') motionListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') motionListeners.delete(fn); },
    emitChange() { for (const fn of motionListeners) fn(); },
  };

  let idle = true;
  let progress = 0.25;
  let nextFrameId = 0;
  let nextIntervalId = 0;
  const activeFrames = new Map();
  const activeIntervals = new Map();
  const amplitudes = [];
  const children = [];

  const visualizer = createWaveformVisualizer({
    container: { appendChild: node => children.push(node) },
    documentLike,
    windowLike: { matchMedia: () => motionQuery },
    createElement: trackedElement,
    requestFrame: fn => { const id = ++nextFrameId; activeFrames.set(id, fn); return id; },
    cancelFrame: id => activeFrames.delete(id),
    scheduleInterval: fn => { const id = ++nextIntervalId; activeIntervals.set(id, fn); return id; },
    cancelInterval: id => activeIntervals.delete(id),
    isIdle: () => idle,
    getVariant: () => 'dual',
    getProgress: () => progress,
    onAmplitude: value => amplitudes.push(value),
    dualBarCount: 4,
  }).init();
  visualizer.setAnalyser({ frequencyBinCount: 8, getByteFrequencyData(data) { data.fill(220); } });

  assert.equal(activeFrames.size, 0, '空闲时不启动 rAF');
  assert.equal(activeIntervals.size, 0, '空闲时不启动 interval');

  progress = 0.75;
  documentLike.emit('timeupdate', true);
  assert.deepEqual(
    children[0].children.map(bar => bar.classList.contains('played')),
    [true, true, true, false],
    '空闲拖动进度时仍通过被动事件同步已播柱，无需定时器',
  );

  idle = false;
  visualizer.start();
  assert.equal(activeFrames.size, 1, 'start() 在活跃时启动 rAF');
  assert.equal(activeIntervals.size, 1, 'start() 在活跃时启动 interval');
  const [firstFrameId, firstFrame] = [...activeFrames.entries()][0];
  activeFrames.delete(firstFrameId);
  firstFrame();
  assert.equal(activeFrames.size, 1, '渲染后继续挂下一帧');
  assert.ok(amplitudes.at(-1) > 0);

  idle = true;
  documentLike.emit('pause', true);
  assert.equal(activeFrames.size, 0, '暂停进入空闲后彻底停掉 rAF');
  assert.equal(activeIntervals.size, 0, '暂停进入空闲后彻底停掉 interval');
  assert.equal(amplitudes.at(-1), 0, '停帧归零幅度');

  idle = false;
  documentLike.emit('play', true);
  assert.equal(activeFrames.size, 1, '媒体 play 事件恢复 rAF');
  assert.equal(activeIntervals.size, 1, '媒体 play 事件恢复 interval');

  documentLike.hidden = true;
  documentLike.visibilityState = 'hidden';
  documentLike.emit('visibilitychange', false);
  assert.equal(activeFrames.size, 0, '页面隐藏时停掉 rAF');
  assert.equal(activeIntervals.size, 0, '页面隐藏时停掉 interval');

  documentLike.hidden = false;
  documentLike.visibilityState = 'visible';
  documentLike.emit('visibilitychange', false);
  assert.equal(activeFrames.size, 1, '页面重新可见时恢复 rAF');
  assert.equal(activeIntervals.size, 1, '页面重新可见时恢复 interval');

  motionQuery.matches = true;
  motionQuery.emitChange();
  assert.equal(activeFrames.size, 0, '开启减少动态时停掉 rAF');
  assert.equal(activeIntervals.size, 0, '开启减少动态时停掉 interval');

  motionQuery.matches = false;
  motionQuery.emitChange();
  assert.equal(activeFrames.size, 1, '关闭减少动态时恢复 rAF');
  assert.equal(activeIntervals.size, 1, '关闭减少动态时恢复 interval');

  visualizer.destroy();
  assert.equal(activeFrames.size, 0);
  assert.equal(activeIntervals.size, 0);
  assert.equal(motionListeners.size, 0);
  assert.equal([...docListeners.values()].every(set => set.size === 0), true, 'destroy 清理全部文档监听');
});
