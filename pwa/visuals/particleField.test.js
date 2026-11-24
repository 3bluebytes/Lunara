import assert from 'node:assert/strict';
import test from 'node:test';
import { createParticleField } from './particleField.js';

test('particle field owns one resize listener and one cancellable animation frame', () => {
  const listeners = new Map();
  const frames = [];
  const cancelled = [];
  const windowLike = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  const context = {
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
    set fillStyle(_value) {},
  };
  const canvas = { style: {}, getContext: () => context };
  const field = createParticleField({
    canvas,
    windowLike,
    requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame: id => cancelled.push(id),
    getComputedStyle: () => ({ getPropertyValue: name => name.includes('hue') ? '180' : 'screen' }),
    random: () => 0.5,
    now: () => 1000,
    count: 2,
  });

  field.init();
  field.init();
  assert.equal(listeners.size, 1);
  assert.equal(frames.length, 1);
  assert.equal(canvas.width, 1600);
  field.setAmplitude(0.8);
  frames[0]();
  assert.equal(frames.length, 2);

  field.destroy();
  assert.equal(listeners.size, 0);
  assert.deepEqual(cancelled, [2]);
});

test('star field reads theme tokens, builds halo sprites, and honours reduced motion', () => {
  const frames = [];
  const calls = { drawImage: 0, createRadialGradient: 0, fillRect: 0, globalAlpha: [] };
  const themeValues = {
    '--particle-hue': '228',
    '--particle-saturation': '16%',
    '--particle-lightness': '95%',
    '--particle-glow': '3.6',
    '--particle-radius': '0.9',
    '--particle-drift': '0.3',
    '--particle-count': '40',
    '--particle-twinkle': '1.1',
    '--particle-hue-jitter': '12',
    '--particle-blend': 'screen',
  };
  const context = {
    setTransform() {},
    clearRect() {},
    drawImage() { calls.drawImage += 1; },
    set globalAlpha(value) { calls.globalAlpha.push(value); },
  };
  const spriteContext = {
    createRadialGradient() {
      calls.createRadialGradient += 1;
      return { addColorStop() {} };
    },
    fillRect() { calls.fillRect += 1; },
    set fillStyle(_value) {},
  };
  const spriteFactory = () => ({ width: 0, height: 0, getContext: () => spriteContext });
  const windowLike = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  };
  const canvas = { style: {}, getContext: () => context };
  const field = createParticleField({
    canvas,
    windowLike,
    root: {},
    getComputedStyle: () => ({ getPropertyValue: name => themeValues[name] ?? '' }),
    requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame: () => {},
    random: () => 0.5,
    now: () => 1000,
    spriteCanvasFactory: spriteFactory,
  });

  field.init();
  assert.equal(calls.createRadialGradient, 3, 'one halo sprite per hue offset');
  frames[0]();
  assert.equal(calls.drawImage, 40, 'sprite star per theme-driven particle count');
  assert.equal(canvas.style.mixBlendMode, 'screen');

  field.destroy();
});

test('star field falls back to plain arcs when no sprite canvas is available and stops rAF under reduced motion', () => {
  const frames = [];
  const calls = { drawImage: 0, arc: 0 };
  const positions = [];
  const context = {
    setTransform() {}, clearRect() {}, beginPath() {},
    arc(x, y) { calls.arc += 1; positions.push([x, y]); },
    fill() {},
    drawImage() { calls.drawImage += 1; },
    set fillStyle(_value) {},
  };
  const windowLike = {
    innerWidth: 1000,
    innerHeight: 700,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true }),
  };
  const canvas = { style: {}, getContext: () => context };
  const field = createParticleField({
    canvas,
    windowLike,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame: () => {},
    random: () => 0.25,
    now: () => 1000,
    spriteCanvasFactory: () => null,
    count: 4,
  });

  field.init();
  assert.equal(frames.length, 0, 'reduced motion paints static stars once and schedules zero rAF frames');
  assert.equal(calls.arc, 4, 'fallback draws one arc per particle');
  assert.equal(calls.drawImage, 0, 'fallback never uses sprites');
  const firstDraw = positions.slice(0, 4);
  field.setAmplitude(0.9);
  assert.equal(frames.length, 0, 'amplitude updates do not restart rAF under reduced motion');
  field.refreshTheme();
  const secondDraw = positions.slice(4, 8);
  assert.deepEqual(secondDraw, firstDraw, 'reduced motion freezes star drift');
  assert.equal(frames.length, 0);
  field.destroy();
});

test('particle field stops rAF when document.hidden or reduced-motion activates and resumes when cleared', () => {
  const winListeners = new Map();
  const docListeners = new Map();
  const motionListeners = new Set();
  const documentLike = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener(type, fn) { docListeners.set(type, fn); },
    removeEventListener(type, fn) { if (docListeners.get(type) === fn) docListeners.delete(type); },
    emit(type) { docListeners.get(type)?.(); },
  };
  const motionQuery = {
    matches: false,
    addEventListener(type, fn) { if (type === 'change') motionListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') motionListeners.delete(fn); },
    emitChange() { for (const fn of motionListeners) fn(); },
  };
  const windowLike = {
    innerWidth: 900,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener(type, fn) { winListeners.set(type, fn); },
    removeEventListener(type, fn) { if (winListeners.get(type) === fn) winListeners.delete(type); },
    matchMedia: () => motionQuery,
  };
  const context = {
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
    set fillStyle(_value) {},
  };
  const canvas = { style: {}, getContext: () => context };
  let nextFrameId = 0;
  const activeFrames = new Map();

  const field = createParticleField({
    canvas,
    documentLike,
    windowLike,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestFrame: fn => { const id = ++nextFrameId; activeFrames.set(id, fn); return id; },
    cancelFrame: id => activeFrames.delete(id),
    spriteCanvasFactory: () => null,
    random: () => 0.5,
    now: () => 1000,
    count: 3,
  }).init();

  assert.equal(activeFrames.size, 1, '活跃且可见时启动 rAF');

  documentLike.hidden = true;
  documentLike.visibilityState = 'hidden';
  documentLike.emit('visibilitychange');
  assert.equal(activeFrames.size, 0, 'document.hidden 时取消 rAF');

  field.setAmplitude(0.75);
  assert.equal(activeFrames.size, 0, '后台隐藏时幅度更新不唤醒 rAF');

  documentLike.hidden = false;
  documentLike.visibilityState = 'visible';
  documentLike.emit('visibilitychange');
  assert.equal(activeFrames.size, 1, '页面重新可见时恢复 rAF');

  motionQuery.matches = true;
  motionQuery.emitChange();
  assert.equal(activeFrames.size, 0, '切到减少动态时取消 rAF');

  motionQuery.matches = false;
  motionQuery.emitChange();
  assert.equal(activeFrames.size, 1, '关闭减少动态时恢复 rAF');

  field.destroy();
  assert.equal(activeFrames.size, 0);
  assert.equal(winListeners.size, 0);
  assert.equal(docListeners.size, 0);
  assert.equal(motionListeners.size, 0);
});

test('particle field skips rAF loop when particle count is 0, opacity is 0, or container is hidden', () => {
  const tokens = { '--particle-count': '0', '--particle-opacity': '1' };
  const container = { hidden: false, style: {} };
  const canvas = {
    style: {},
    getContext: () => ({
      setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
      set fillStyle(_value) {},
    }),
  };
  let nextFrameId = 0;
  const activeFrames = new Map();
  const field = createParticleField({
    canvas,
    container,
    root: {},
    windowLike: {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false }),
    },
    getComputedStyle: () => ({ getPropertyValue: name => tokens[name] ?? '' }),
    requestFrame: fn => { const id = ++nextFrameId; activeFrames.set(id, fn); return id; },
    cancelFrame: id => activeFrames.delete(id),
    spriteCanvasFactory: () => null,
    random: () => 0.5,
  }).init();

  assert.equal(activeFrames.size, 0, '--particle-count: 0 时不启动 rAF');

  tokens['--particle-count'] = '12';
  tokens['--particle-opacity'] = '0';
  field.refreshTheme();
  assert.equal(activeFrames.size, 0, '--particle-opacity: 0 时不启动 rAF');

  tokens['--particle-opacity'] = '1';
  container.hidden = true;
  field.refreshTheme();
  assert.equal(activeFrames.size, 0, '容器 hidden 时不启动 rAF');

  container.hidden = false;
  field.start();
  assert.equal(activeFrames.size, 1, '容器变为可见且非空后按需启动 rAF');

  field.destroy();
  assert.equal(activeFrames.size, 0);
});
