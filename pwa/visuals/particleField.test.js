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

test('star field falls back to plain arcs when no sprite canvas is available and freezes drift under reduced motion', () => {
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
  frames[0]();
  assert.equal(calls.arc, 4, 'fallback draws one arc per particle');
  assert.equal(calls.drawImage, 0, 'fallback never uses sprites');
  const firstDraw = positions.slice(0, 4);
  frames[1]();
  const secondDraw = positions.slice(4, 8);
  assert.deepEqual(secondDraw, firstDraw, 'reduced motion freezes star drift');
  field.destroy();
});
