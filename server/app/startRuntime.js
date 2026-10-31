import { createServer } from 'node:http';

function lifecycleError(phase, name, error) {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(`runtime ${phase} failed in ${name}: ${cause.message}`, { cause });
}

async function startLifecycle(runtime) {
  for (const entry of runtime.lifecycle) {
    // Own the subsystem before starting it so a partially-initialized entry is
    // still asked to clean itself up when start() throws.
    runtime.startedLifecycle.push(entry);
    try {
      if (entry.start) await entry.start(runtime);
    } catch (error) {
      throw lifecycleError('start', entry.name, error);
    }
  }
}

// 单个组件的 stop 超时：一个子系统挂起不应吃掉整个停机预算，
// 超时后记录点名并继续停其余组件（entrypoint 的总死限是最后兜底）。
const COMPONENT_STOP_TIMEOUT_MS = 5000;

async function stopOneComponent(entry, runtime) {
  if (!entry.stop) return;
  let timer = null;
  try {
    return await Promise.race([
      entry.stop(runtime),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`stop 未在 ${COMPONENT_STOP_TIMEOUT_MS}ms 内完成（子系统疑似挂起）`)),
          COMPONENT_STOP_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopLifecycle(runtime) {
  const failures = [];
  while (runtime.startedLifecycle.length > 0) {
    const entry = runtime.startedLifecycle.pop();
    try {
      await stopOneComponent(entry, runtime);
    } catch (error) {
      console.warn(`[shutdown] ${entry.name}.stop 失败或超时，继续停其余组件: ${error.message}`);
      failures.push(lifecycleError('stop', entry.name, error));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'one or more runtime services failed to stop');
  }
}

function listen(server, { port, host }) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(lifecycleError('listen', 'http-server', error));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

export async function startRuntime(options = {}) {
  const runtime = options.runtime;
  const app = options.app;
  if (!runtime) throw new TypeError('startRuntime requires runtime');
  if (typeof app !== 'function') throw new TypeError('startRuntime requires an Express app');
  if (!['created', 'stopped'].includes(runtime.status)) {
    throw new Error(`runtime cannot start from status ${runtime.status}`);
  }

  const port = Number.isInteger(options.port)
    ? options.port
    : Number.parseInt(runtime.config.port ?? process.env.PORT ?? '8080', 10);
  const host = String(options.host || runtime.config.host || process.env.LUNARA_HOST || '127.0.0.1');
  const server = options.server || createServer(app);
  const handle = { runtime, app, server, address: null, stopped: false };

  runtime.status = 'starting';
  runtime.failure = null;
  try {
    await startLifecycle(runtime);
    handle.address = await listen(server, { port, host });
    runtime.status = 'running';
    runtime.startedAt = Date.now();
    return handle;
  } catch (error) {
    runtime.failure = error;
    runtime.status = 'failed';
    await closeServer(server).catch(() => {});
    await stopLifecycle(runtime).catch(() => {});
    throw error;
  }
}

export async function stopRuntime(handle) {
  if (!handle || handle.stopped) return;
  handle.stopped = true;
  const { runtime, server } = handle;
  const failures = [];
  runtime.status = 'stopping';
  // Stop accepting connections now; pending requests can finish after their work
  // is cancelled by the lifecycle, before waiting for HTTP to fully drain.
  const closingServer = closeServer(server).catch(error => {
    failures.push(lifecycleError('stop', 'http-server', error));
  });

  try {
    await stopLifecycle(runtime);
  } catch (error) {
    failures.push(error);
  }
  await closingServer;

  runtime.status = failures.length > 0 ? 'stop-failed' : 'stopped';
  runtime.stoppedAt = Date.now();
  if (failures.length > 0) {
    throw new AggregateError(failures, 'runtime failed to stop cleanly');
  }
}

export default { startRuntime, stopRuntime };
