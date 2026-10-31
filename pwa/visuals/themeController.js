import { STORAGE_KEYS } from '../core/storageKeys.js';
import { THEME_MANIFESTS, VARIANT_OPTIONS, getThemeManifest } from '../themes/registry.js';

// 主题列表、名字与色点都来自主题插件注册表（pwa/themes/registry.js）。
export const THEMES = Object.freeze(THEME_MANIFESTS.map(manifest => manifest.id));
export const DEFAULT_THEME = 'nocturne';
const VARIANT_ATTRIBUTES = Object.freeze(Object.keys(VARIANT_OPTIONS));

export function isKnownTheme(value) {
  return THEMES.includes(String(value ?? ''));
}

/**
 * 主题只改根元素上的 data-theme 与显示变体属性（data-identity 等）：配色全部由
 * 各主题的 tokens.css / overrides.css 决定。这里不持有颜色，只负责选择、持久化，
 * 并通知外部（氛围层宿主等）主题已经变化。
 */
export function createThemeController({
  root,
  storage = globalThis.localStorage,
  container = null,
  modernistBaseContainer = null,
  onThemeChange = () => {},
  onError = () => {},
} = {}) {
  if (!root?.dataset) throw new TypeError('theme root with a dataset is required');
  let initialized = false;
  let current = DEFAULT_THEME;
  let notified = false;
  let base = 'paper';
  let baseLoaded = false;
  const cleanups = [];

  function baseOptions() {
    return modernistBaseContainer ? [...modernistBaseContainer.querySelectorAll('[data-modernist-base]')] : [];
  }

  function syncBaseChoices() {
    if (modernistBaseContainer) modernistBaseContainer.hidden = current !== 'modernist';
    for (const option of baseOptions()) {
      const selected = option.dataset.modernistBase === base;
      option.setAttribute('aria-checked', String(selected));
      option.tabIndex = selected ? 0 : -1;
    }
  }

  function applyBase(name, persist) {
    const next = name === 'indigo' ? 'indigo' : 'paper';
    base = next;
    baseLoaded = true;
    root.dataset.modernistBase = base;
    if (persist) {
      try { storage?.setItem?.(STORAGE_KEYS.modernistBase, base); } catch (error) { onError(error); }
    }
    syncBaseChoices();
    return base;
  }

  function setModernistBase(name) { return applyBase(name, true); }

  function renderBaseChoices() {
    for (const option of baseOptions()) {
      const activate = () => setModernistBase(option.dataset.modernistBase);
      const keydown = event => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const list = baseOptions();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
          : (list.indexOf(option) + step + list.length) % list.length;
        const next = list[index];
        if (next) { setModernistBase(next.dataset.modernistBase); next.focus?.(); }
      };
      option.addEventListener('click', activate);
      option.addEventListener('keydown', keydown);
      cleanups.push(() => {
        option.removeEventListener('click', activate);
        option.removeEventListener('keydown', keydown);
      });
    }
  }

  function options() {
    return container ? [...container.querySelectorAll('[data-theme-id]')] : [];
  }

  function syncChoices() {
    for (const option of options()) {
      const selected = option.dataset.themeId === current;
      option.setAttribute('aria-checked', selected ? 'true' : 'false');
      option.tabIndex = selected ? 0 : -1;
    }
  }

  function render() {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    container.innerHTML = THEMES.map(id => `<button type="button" class="theme-option" role="radio" data-theme-id="${id}" aria-checked="false" tabindex="-1"><span class="theme-swatch" aria-hidden="true"></span><span>${getThemeManifest(id)?.name || id}</span></button>`).join('');
    for (const option of options()) {
      // 色点背景走 CSSOM，不写内联 style 属性。
      const swatch = getThemeManifest(option.dataset.themeId)?.swatch;
      if (swatch) option.querySelector?.('.theme-swatch')?.style?.setProperty?.('--theme-swatch', swatch);
      const activate = () => set(option.dataset.themeId);
      const onKeyDown = event => {
        const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        const step = keys[event.key];
        if (!step) return;
        event.preventDefault();
        const list = options();
        const index = list.indexOf(option);
        const next = list[(index + step + list.length) % list.length];
        if (next) { set(next.dataset.themeId); next.focus?.(); }
      };
      option.addEventListener('click', activate);
      option.addEventListener('keydown', onKeyDown);
      cleanups.push(() => {
        option.removeEventListener('click', activate);
        option.removeEventListener('keydown', onKeyDown);
      });
    }
    syncChoices();
  }

  function set(name) {
    // 此刻并入月色；有机及其他已移除主题回到默认时间线。所有入口共用同一迁移。
    const candidate = name === 'cike' ? 'moonlight' : name;
    const next = isKnownTheme(candidate) ? String(candidate) : DEFAULT_THEME;
    const changed = next !== current;
    current = next;
    root.dataset.theme = next;
    if (next === 'modernist' && !baseLoaded) {
      let storedBase = null;
      try { storedBase = storage?.getItem?.(STORAGE_KEYS.modernistBase); } catch (error) { onError(error); }
      applyBase(storedBase, false);
    }
    syncBaseChoices();
    const variants = getThemeManifest(next)?.variants || {};
    for (const key of VARIANT_ATTRIBUTES) root.dataset[key] = variants[key];
    // 开发开关只能选登记过的 layout；未知值忽略，按主题声明走。
    let layoutOverride = null;
    try { layoutOverride = storage?.getItem?.(STORAGE_KEYS.layoutOverride) ?? null; } catch { /* 读不到开关就按主题声明走；存储错误已由主题读取报告过 */ }
    if (VARIANT_OPTIONS.layout.includes(layoutOverride)) root.dataset.layout = layoutOverride;
    try {
      storage?.setItem?.(STORAGE_KEYS.theme, next);
    } catch (error) {
      onError(error);
    }
    syncChoices();
    // 首次应用必须通知一次（即使存储值就是默认主题），否则氛围层不会挂载。
    if (changed || !notified) {
      notified = true;
      onThemeChange(next);
    }
    return next;
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    let stored = null;
    try {
      stored = storage?.getItem?.(STORAGE_KEYS.theme) ?? null;
    } catch (error) {
      onError(error);
    }
    render();
    renderBaseChoices();
    // 旧主题迁移、未知或缺失值回落，并顺手归一化存储。
    set(stored);
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    cleanups.splice(0).forEach(cleanup => cleanup());
  }

  const api = Object.freeze({
    init,
    destroy,
    set,
    setModernistBase,
    modernistBase: () => base,
    current: () => current,
    themes: () => [...THEMES],
    /** 给其他入口（顶栏「外观」）画选项用：名字与色点同样来自注册表。 */
    choices: () => THEMES.map(id => ({ id, name: getThemeManifest(id)?.name || id, swatch: getThemeManifest(id)?.swatch || '' })),
  });
  return api;
}
