const ORDER = Object.freeze([
  // 本地音乐源服务没有依赖，且越早可用越好（首个搜索请求不必等）。
  'musicSource',
  'realtime',
  'lifeContext',
  'station',
  'virtualPerson',
  'dreaming',
  'scheduler',
  'playback',
  'maintenance',
]);

function asLifecycleEntry(name, component) {
  if (!component) return null;
  if (component.start != null && typeof component.start !== 'function') {
    throw new TypeError(`${name}.start must be a function`);
  }
  if (component.stop != null && typeof component.stop !== 'function') {
    throw new TypeError(`${name}.stop must be a function`);
  }
  return {
    name,
    start: component.start ? runtime => component.start(runtime) : undefined,
    stop: component.stop ? runtime => component.stop(runtime) : undefined,
  };
}

export function createProductionLifecycle(components = {}) {
  return ORDER
    .map(name => asLifecycleEntry(name, components[name]))
    .filter(Boolean);
}
