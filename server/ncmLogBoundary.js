// NCM 依赖不支持 logger 注入；只对白名单异步上下文的输出做闭集投影。
// console 分发器常驻，以保护 response/stop 后的迟到任务；上下文外原样透传。
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
const protectedServers = new WeakSet();
const wrappers = new Map();

function diagnostics(args) {
  const result = { event: args[0] === '[ERR]' ? 'error' : args[0] === '[OK]' ? 'request-ok' : 'dependency-log' };
  for (const value of args) {
    if (!value || typeof value !== 'object') continue;
    // 不序列化上游对象/异常，也不转发 message、URL、Cookie 或堆栈。
    try {
      if (Number.isInteger(value.status) && value.status >= 100 && value.status < 600) result.status = value.status;
      const code = value.body?.code ?? value.code;
      if (typeof code === 'number' && Number.isFinite(code)) result.code = code;
    } catch { /* 不调用上游对象的序列化器，异常访问也不得突破日志边界 */ }
  }
  return result;
}

function installDispatchers() {
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    if (console[method] === wrappers.get(method)) continue;
    const sink = console[method];
    const wrapper = (...args) => context.getStore()
      ? sink.call(console, '[ncm]', diagnostics(args))
      : sink.apply(console, args);
    wrappers.set(method, wrapper);
    console[method] = wrapper;
  }
}

// 必须早于 QQ 等临时 console 包装器捕获 sink；模块加载时安装一次。
// 不在请求中重复安装，否则临时包装器恢复时可能覆盖保护入口。
installDispatchers();

export function runWithNcmLogBoundary(work) {
  return context.run(true, work);
}

export function protectNcmServerLogs(server) {
  if (protectedServers.has(server)) return;
  const listeners = server.rawListeners('request');
  if (!listeners.length) throw new Error('NCM request listener missing');
  protectedServers.add(server);
  // 显式绑定 request 回调，不依赖监听器注册时的隐式异步上下文传播。
  for (const listener of listeners) {
    server.removeListener('request', listener);
    server.on('request', function (...args) {
      return runWithNcmLogBoundary(() => listener.apply(this, args));
    });
  }
}
