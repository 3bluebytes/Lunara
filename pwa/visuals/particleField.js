// 星点场：白核 + 光晕的星点，缓慢漂移、各自闪烁，并随音频幅度呼吸。
// 外观全部由主题 token 控制（见 pwa/themes/<id>/tokens.css），本文件只读不写颜色。
// 它是主题氛围层的引擎：各主题的 atmosphere.js 通过 mountParticleAtmosphere 挂载。
//
// motion：'drift' 随机漂移（默认）；'rise' 灯下浮尘——缓慢上浮、±8px 正弦横摆、
// 越往下越淡且亮度封顶 .5（方案 D「此刻」）。
//
// 绘制方式：主题变化时把"星核 + 光晕"预渲染成离屏精灵，逐帧只做 drawImage；
// 环境创建不了离屏 canvas（Node 测试、极老环境）时回退为 arc + fill。

const THEME_DEFAULTS = {
  hue: 230,
  saturation: 16,     // %
  lightness: 95,      // %
  glow: 3.6,          // 光晕半径 ÷ 星核半径
  radius: 0.9,        // 星核半径系数
  drift: 0.3,         // 漂移速度系数
  count: 56,          // 星点数量
  twinkle: 1.1,       // 闪烁速度
  jitter: 12,         // 单颗星的色相抖动
};

function readNumber(style, name, fallback) {
  const value = style.getPropertyValue(name).trim();
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createParticleField({
  canvas,
  windowLike = globalThis.window,
  root = globalThis.document?.documentElement,
  getComputedStyle = globalThis.getComputedStyle,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  now = () => globalThis.performance?.now?.() || Date.now(),
  random = Math.random,
  count,
  motion = 'drift',
  spriteCanvasFactory = () => globalThis.document?.createElement?.('canvas'),
} = {}) {
  if (!canvas) throw new TypeError('particle canvas is required');
  const context = canvas.getContext?.('2d');
  if (!context) throw new TypeError('2d particle canvas context is required');

  const particles = [];
  const sprites = [];
  let spriteSize = 0;
  let initialized = false;
  let frameId = null;
  let amplitude = 0;
  let reducedMotion = false;
  let motionQuery = null;
  const rises = motion === 'rise';
  let theme = { ...THEME_DEFAULTS };
  // 这一层画的是缓慢漂移的光点：60fps 与 120Hz 屏幕上肉眼没有区别，但按帧画会白烧一半合成预算。
  // 所以按时间节流到 ~60fps，并把位移/闪烁/幅度衰减都折算成时间步长，降帧不会让运动变慢。
  const FRAME_MS = 1000 / 60;
  let lastDrawAt = 0;

  function readTheme() {
    if (typeof getComputedStyle !== 'function' || !root) return theme;
    const style = getComputedStyle(root);
    theme = {
      hue: readNumber(style, '--particle-hue', THEME_DEFAULTS.hue),
      saturation: readNumber(style, '--particle-saturation', THEME_DEFAULTS.saturation),
      lightness: readNumber(style, '--particle-lightness', THEME_DEFAULTS.lightness),
      glow: readNumber(style, '--particle-glow', THEME_DEFAULTS.glow),
      radius: readNumber(style, '--particle-radius', THEME_DEFAULTS.radius),
      drift: readNumber(style, '--particle-drift', THEME_DEFAULTS.drift),
      count: readNumber(style, '--particle-count', THEME_DEFAULTS.count),
      twinkle: readNumber(style, '--particle-twinkle', THEME_DEFAULTS.twinkle),
      jitter: readNumber(style, '--particle-hue-jitter', THEME_DEFAULTS.jitter),
    };
    const blend = style.getPropertyValue('--particle-blend').trim();
    if (blend) canvas.style.mixBlendMode = blend;
    return theme;
  }

  function readMotionPreference() {
    const query = windowLike.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedMotion = Boolean(query?.matches);
    return reducedMotion;
  }

  function desiredCount() {
    return Math.max(1, Math.round(Number(count ?? theme.count ?? THEME_DEFAULTS.count) || THEME_DEFAULTS.count));
  }

  function resize() {
    const dpr = Math.min(windowLike.devicePixelRatio || 1, 2);
    canvas.width = windowLike.innerWidth * dpr;
    canvas.height = windowLike.innerHeight * dpr;
    canvas.style.width = `${windowLike.innerWidth}px`;
    canvas.style.height = `${windowLike.innerHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 三档色相偏移的精灵（-jitter / 0 / +jitter），让星点有细微色差而不是完全同色。
  function buildSprites() {
    sprites.length = 0;
    spriteSize = 0;
    const dpr = Math.min(windowLike.devicePixelRatio || 1, 2);
    const maxCore = 1.7 * theme.radius;
    const halo = maxCore * theme.glow;
    spriteSize = Math.max(8, Math.ceil(halo * 2 * dpr));
    const canvasSize = spriteSize;
    const hueOffsets = [-theme.jitter, 0, theme.jitter];
    for (const offset of hueOffsets) {
      const sprite = spriteCanvasFactory?.();
      if (!sprite?.getContext) { sprites.length = 0; return false; }
      sprite.width = canvasSize;
      sprite.height = canvasSize;
      const g = sprite.getContext('2d');
      if (!g?.createRadialGradient) { sprites.length = 0; return false; }
      const center = canvasSize / 2;
      const hue = ((theme.hue + offset) % 360 + 360) % 360;
      const grad = g.createRadialGradient(center, center, 0, center, center, center);
      grad.addColorStop(0, `hsla(${hue}, ${theme.saturation}%, ${theme.lightness}%, 1)`);
      grad.addColorStop(0.14, `hsla(${hue}, ${theme.saturation}%, ${theme.lightness}%, .9)`);
      grad.addColorStop(0.34, `hsla(${hue}, ${theme.saturation}%, ${theme.lightness}%, .22)`);
      grad.addColorStop(1, `hsla(${hue}, ${theme.saturation}%, ${theme.lightness}%, 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, canvasSize, canvasSize);
      sprites.push(sprite);
    }
    return sprites.length === hueOffsets.length;
  }

  function populate() {
    particles.length = 0;
    const total = desiredCount();
    const drift = reducedMotion ? 0 : theme.drift;
    for (let index = 0; index < total; index += 1) {
      particles.push({
        x: random() * windowLike.innerWidth,
        y: random() * windowLike.innerHeight,
        r: (0.35 + random() * 1.25) * theme.radius,
        glow: 2.4 + random() * 2.4,
        vx: (random() - 0.5) * 0.18 * drift,
        vy: rises ? -(0.04 + random() * .1) : (random() - 0.5) * 0.18 * drift,
        originX: null,
        phase: random() * Math.PI * 2,
        twinkleSpeed: 0.6 + random() * 0.8,
        spriteIndex: Math.floor(random() * 3),
        base: 0.22 + random() * 0.4,
      });
    }
  }

  function draw() {
    if (!initialized) return;
    frameId = null;
    const time = now();
    const elapsed = lastDrawAt ? time - lastDrawAt : FRAME_MS;
    // 只有“明显快于 60fps 的真实帧”才跳过；同时调用（测试、事件回调）的 elapsed 不足 1ms，按一帧处理。
    if (elapsed >= 1 && elapsed < FRAME_MS - 1.5) {
      frameId = requestFrame?.(draw) ?? null;
      return;
    }
    const step = elapsed < 1 ? 1 : Math.min(4, elapsed / FRAME_MS);
    lastDrawAt = time;
    context.clearRect(0, 0, windowLike.innerWidth, windowLike.innerHeight);
    const seconds = time / 1000;
    for (const particle of particles) {
      if (!reducedMotion) {
        if (rises) {
          particle.originX ??= particle.x;
          particle.x = particle.originX + Math.sin(seconds * .2 + particle.phase) * 8;
        } else particle.x += particle.vx * step;
        particle.y += particle.vy * step;
        if (particle.x < -10) particle.x = windowLike.innerWidth + 10;
        if (particle.x > windowLike.innerWidth + 10) particle.x = -10;
        if (particle.y < -10) particle.y = windowLike.innerHeight + 10;
        if (particle.y > windowLike.innerHeight + 10) particle.y = -10;
      }
      const twinkle = reducedMotion
        ? 0
        : 0.5 + 0.5 * Math.sin(seconds * theme.twinkle * particle.twinkleSpeed + particle.phase);
      const falloff = rises ? Math.max(.25, 1 - particle.y / windowLike.innerHeight) : 1;
      const alpha = Math.min(rises ? .5 : 1, particle.base + twinkle * 0.38 + amplitude * 0.4) * falloff;
      const haloSize = particle.r * particle.glow * 2 * (1 + amplitude * 0.5);
      const sprite = sprites[particle.spriteIndex];
      if (sprite && context.drawImage) {
        context.globalAlpha = alpha;
        context.drawImage(sprite, particle.x - haloSize / 2, particle.y - haloSize / 2, haloSize, haloSize);
        context.globalAlpha = 1;
      } else {
        // 回退：无离屏 canvas 能力时的简单圆点
        context.beginPath();
        context.fillStyle = `hsla(${theme.hue}, ${theme.saturation}%, ${theme.lightness}%, ${alpha})`;
        context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        context.fill();
      }
    }
    amplitude *= Math.pow(0.92, step);
    frameId = requestFrame?.(draw) ?? null;
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    readMotionPreference();
    readTheme();
    buildSprites();
    resize();
    populate();
    windowLike.addEventListener?.('resize', resize);
    motionQuery = windowLike.matchMedia?.('(prefers-reduced-motion: reduce)');
    motionQuery?.addEventListener?.('change', refreshTheme);
    frameId = requestFrame?.(draw) ?? null;
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    windowLike.removeEventListener?.('resize', resize);
    motionQuery?.removeEventListener?.('change', refreshTheme);
    motionQuery = null;
    if (frameId != null) cancelFrame?.(frameId);
    frameId = null;
    particles.length = 0;
  }

  function setAmplitude(value) {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    amplitude = Math.max(amplitude, next);
  }

  function refreshTheme() {
    readMotionPreference();
    readTheme();
    buildSprites();
    if (initialized) populate();
  }

  const api = Object.freeze({ init, destroy, setAmplitude, refreshTheme });
  return api;
}

/**
 * 主题氛围层接口（THEME_PLUGINS.md）：在容器里建一张 #particle-canvas 并启动星点场。
 * 只读主题 token 与音频幅度，不改任何应用状态。reduced motion 由星点场自己监听。
 */
export function mountParticleAtmosphere(container, { motion = 'drift', documentLike = globalThis.document, reducedMotion: _reducedMotion, getState: _getState, ...options } = {}) {
  const canvas = documentLike.createElement('canvas');
  canvas.id = 'particle-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  const field = createParticleField({ canvas, motion, ...options });
  field.init();
  return {
    update(state = {}) {
      if (state.amplitude != null) field.setAmplitude(state.amplitude);
    },
    refresh() { field.refreshTheme(); },
    unmount() {
      field.destroy();
      canvas.remove();
    },
  };
}
