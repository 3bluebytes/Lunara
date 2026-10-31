import { STORAGE_KEYS } from '../core/storageKeys.js';

// 夜场的材质偏好：实底（默认）或玻璃。只写根元素 data-material，画法全在
// themes/nocturne/overrides.css；其他主题不读这个属性，选项也只在夜场显示（CSS 控制）。
export const NOCTURNE_MATERIALS = Object.freeze(['flat', 'glass']);

export function createNocturneMaterialController({
  root,
  storage = globalThis.localStorage,
  container = null,
  onError = () => {},
} = {}) {
  if (!root?.dataset) throw new TypeError('material root with a dataset is required');
  let current = 'flat';
  let initialized = false;
  const cleanups = [];

  const options = () => (container ? [...container.querySelectorAll('[data-material-option]')] : []);

  function sync() {
    for (const option of options()) {
      const selected = option.dataset.materialOption === current;
      option.setAttribute('aria-checked', String(selected));
      option.tabIndex = selected ? 0 : -1;
    }
  }

  function apply(name, persist) {
    current = NOCTURNE_MATERIALS.includes(name) ? name : 'flat';
    root.dataset.material = current;
    if (persist) {
      try { storage?.setItem?.(STORAGE_KEYS.nocturneMaterial, current); } catch (error) { onError(error); }
    }
    sync();
    return current;
  }

  function set(name) { return apply(name, true); }

  function init() {
    if (initialized) return api;
    initialized = true;
    let stored = null;
    try { stored = storage?.getItem?.(STORAGE_KEYS.nocturneMaterial) ?? null; } catch (error) { onError(error); }
    for (const option of options()) {
      const activate = () => set(option.dataset.materialOption);
      const keydown = event => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const list = options();
        const next = list[(list.indexOf(option) + step + list.length) % list.length];
        if (next) { set(next.dataset.materialOption); next.focus?.(); }
      };
      option.addEventListener('click', activate);
      option.addEventListener('keydown', keydown);
      cleanups.push(() => {
        option.removeEventListener('click', activate);
        option.removeEventListener('keydown', keydown);
      });
    }
    apply(stored, false);
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    cleanups.splice(0).forEach(cleanup => cleanup());
  }

  const api = Object.freeze({ init, destroy, set, material: () => current });
  return api;
}
