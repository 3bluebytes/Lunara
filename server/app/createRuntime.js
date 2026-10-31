function normalizeLifecycleEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError(`runtime lifecycle[${index}] must be an object`);
  }
  const name = String(entry.name || `lifecycle-${index + 1}`);
  if (entry.start != null && typeof entry.start !== 'function') {
    throw new TypeError(`runtime lifecycle "${name}" start must be a function`);
  }
  if (entry.stop != null && typeof entry.stop !== 'function') {
    throw new TypeError(`runtime lifecycle "${name}" stop must be a function`);
  }
  return { ...entry, name };
}

/**
 * Build a side-effect-free runtime context.
 *
 * Services are deliberately injected instead of imported here. Production may
 * compose concrete adapters while tests can provide fakes without opening a DB,
 * starting a scheduler, or touching an external provider.
 */
export async function createRuntime(options = {}) {
  const lifecycle = Array.isArray(options.lifecycle)
    ? options.lifecycle.map(normalizeLifecycleEntry)
    : [];

  return {
    config: { ...(options.config || {}) },
    services: { ...(options.services || {}) },
    lifecycle,
    status: 'created',
    startedLifecycle: [],
    startedAt: null,
    stoppedAt: null,
    failure: null,
  };
}
