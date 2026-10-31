import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaveformVisualizer } from './waveformVisualizer.js';

function createElement() {
  return {
    className: '',
    style: {},
    classList: { toggle() {}, remove() {} },
    remove() { this.removed = true; },
  };
}

test('waveform init is idempotent and teardown releases frame, interval, and owned bars', () => {
  const children = [];
  const frames = [];
  const intervals = [];
  const cancelledFrames = [];
  const cancelledIntervals = [];
  const container = { appendChild: node => children.push(node) };
  const visualizer = createWaveformVisualizer({
    container,
    createElement,
    requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame: id => cancelledFrames.push(id),
    scheduleInterval: fn => { intervals.push(fn); return intervals.length; },
    cancelInterval: id => cancelledIntervals.push(id),
    isIdle: () => true,
    random: () => 0.5,
    barCount: 4,
    maxBarHeight: 20,
    idleBarHeight: 4,
  });

  visualizer.init();
  visualizer.init();
  assert.equal(children.length, 4);
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
  assert.equal(children.every(node => Number.parseInt(node.style.height, 10) <= 22), true);

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
});

test('the voice row stays still under reduced motion', () => {
  const children = [];
  const intervals = [];
  createWaveformVisualizer({
    container: { appendChild: node => children.push(node) },
    createElement: trackedElement,
    windowLike: { matchMedia: () => ({ matches: true }) },
    scheduleInterval: fn => { intervals.push(fn); return 1; },
    getVariant: () => 'dual',
    isVoiceActive: () => true,
    dualBarCount: 4,
  }).init();
  intervals[0]();
  assert.equal(children[1].children.every(bar => bar.style.height === '2px'), true);
});

test('refresh rebuilds bars only when the theme variant changes', () => {
  const children = [];
  let variant = 'single';
  const visualizer = createWaveformVisualizer({
    container: { appendChild: node => children.push(node) },
    createElement: trackedElement,
    scheduleInterval: () => 1,
    getVariant: () => variant,
    barCount: 3,
    dualBarCount: 5,
  });
  visualizer.init();
  assert.equal(children.length, 3);
  visualizer.refresh();
  assert.equal(children.length, 3, '变体没变就不重建');

  variant = 'dual';
  visualizer.refresh();
  assert.equal(children.slice(0, 3).every(node => node.removed), true, '旧的单行条被移除');
  assert.deepEqual(children.slice(3).map(node => node.className), ['waveform-row waveform-music', 'waveform-row waveform-voice']);

  variant = 'single';
  visualizer.refresh();
  assert.equal(children.slice(3, 5).every(node => node.removed), true);
  assert.equal(children.slice(5).length, 3);
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

test('music bars rise fast and fall slowly; reduced motion snaps', () => {
  function run(reduced) {
    const children = [];
    const frames = [];
    let level = 255;
    const visualizer = createWaveformVisualizer({
      container: { appendChild: node => children.push(node) },
      createElement: trackedElement,
      windowLike: { matchMedia: () => ({ matches: reduced }) },
      requestFrame: fn => { frames.push(fn); return frames.length; },
      scheduleInterval: () => 1,
      isIdle: () => false,
      getVariant: () => 'dual',
      dualBarCount: 4,
      dualMusicMaxBarHeight: 20,
    }).init();
    visualizer.setAnalyser({ frequencyBinCount: 16, getByteFrequencyData(data) { data.fill(level); } });
    const heights = [];
    const step = () => { frames.at(-1)(); heights.push(Number.parseInt(children[0].children[0].style.height, 10)); };
    step(); step(); step();
    level = 0;
    step();
    return heights;
  }
  const [first, second, third, afterDrop] = run(false);
  assert.ok(first > 2 && first < 22, '第一帧只升到一部分');
  assert.ok(second > first && third >= second, '随后继续上升');
  assert.ok(afterDrop < third && afterDrop > 2, '静音后慢慢落下而不是瞬间归零');
  assert.deepEqual(run(true), [2, 2, 2, 2], '减少动态时不动');
});
