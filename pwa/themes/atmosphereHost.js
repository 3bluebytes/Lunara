// 氛围层宿主：保证同一时刻只有当前主题的氛围层在跑。
//
// 切换主题时先卸载旧的、再加载并挂载新的；atmosphere.js 是动态 import，
// 快速连切时用代次令牌丢弃晚到的旧主题模块，不留下没停掉的动画循环。
// 氛围层只能读：宿主只往里送音频幅度与“主题 token 变了”这两种通知。
import { getThemeManifest, themeFileUrl } from './registry.js';

function defaultLoad(id, file) {
  return import(themeFileUrl(id, file).href);
}

export function createAtmosphereHost({
  container,
  getState = () => ({}),
  reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
  load = defaultLoad,
  onError = () => {},
} = {}) {
  if (!container) throw new TypeError('atmosphere container is required');
  let generation = 0;
  let activeId = null;
  let handle = null;

  function unmountCurrent() {
    const previous = handle;
    handle = null;
    if (!previous) return;
    try { previous.unmount?.(); } catch (error) { onError(error); }
  }

  async function activate(id) {
    const ticket = ++generation;
    activeId = id;
    unmountCurrent();
    const file = getThemeManifest(id)?.atmosphere;
    if (!file) return null;
    let module;
    try {
      module = await load(id, file);
    } catch (error) {
      if (ticket === generation) onError(error);
      return null;
    }
    // 加载期间又切了主题：这个模块已经过期，不挂载。
    if (ticket !== generation || typeof module?.mount !== 'function') return null;
    try {
      handle = module.mount(container, { reducedMotion: reducedMotion(), getState }) || null;
    } catch (error) {
      handle = null;
      onError(error);
    }
    return handle;
  }

  return Object.freeze({
    activate,
    update(state) { handle?.update?.(state); },
    refresh() { handle?.refresh?.(); },
    destroy() { generation += 1; activeId = null; unmountCurrent(); },
    activeTheme: () => activeId,
    isMounted: () => handle != null,
  });
}
