// CLI owns process signals; imports and Electron retain explicit lifecycle control.
export function runServerEntrypoint({ start, stop, port, process: host = process, report = console.error, shutdownTimeoutMs = 10000 }) {
  const starting = Promise.resolve().then(() => start(port));
  let stopping = null;
  let shutdownDone = false;
  let deadline = null;

  const forceExit = (code, reason) => {
    report(`[shutdown] ${reason}`);
    host.exit(code);
  };

  // 停机句柄：启动优雅停机并返回可 await 的 promise；重复调用幂等，不触发强杀。
  const shutdown = (signal = 'SIGTERM') => {
    if (shutdownDone) return Promise.resolve();
    if (!stopping) {
      stopping = (async () => {
        await starting.catch(() => {});
        if (shutdownTimeoutMs > 0) {
          deadline = setTimeout(() => {
            forceExit(1, `优雅停机未在 ${Math.round(shutdownTimeoutMs / 1000)}s 内完成，强制退出（有子系统疑似挂起，[shutdown] 日志会点名）。`);
          }, shutdownTimeoutMs);
          deadline.unref?.();
        }
        try {
          await stop();
        } catch {
          report('[shutdown] Lunara could not stop cleanly.');
          host.exitCode = 1;
        } finally {
          if (deadline) clearTimeout(deadline);
          shutdownDone = true;
        }
      })();
    }
    return stopping;
  };

  // 信号入口：优雅停机可能被某个子系统挂住（在途 agent 回合、音频缓存、网络重试……）。
  // Ctrl-C 必须永远能赢：停机进行中再收到信号，立即强制退出，不再返回挂起的 promise。
  const onSignal = (signal) => {
    if (stopping && !shutdownDone) {
      forceExit(130, `再次收到 ${signal}，放弃等待优雅停机并强制退出。`);
      return;
    }
    void shutdown(signal);
  };

  host.on('SIGINT', () => onSignal('SIGINT'));
  host.on('SIGTERM', () => onSignal('SIGTERM'));
  void starting.catch(() => {
    report('[startup] Lunara failed to start.');
    host.exitCode = 1;
    void shutdown();
  });
  return { starting, shutdown };
}
