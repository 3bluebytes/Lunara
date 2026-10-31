// ncmEmbedded.js — 进程内启动 NeteaseCloudMusicApi
//
// 目标：`npm start` / `npm run start:web` / `lunara` CLI 一步就能用网易云，
// 不需要另开终端跑 `npm run ncm`（QQ 一直是进程内 SDK，这里把网易云拉齐）。
//
// 边界：本模块只负责「把网易云 API 跑到某个 loopback 端口」，不碰登录态、
// cookie、曲库、候选或播放。所有失败都降级为「网易云源不可用」并返回 null，
// 绝不向调用方抛错 —— 网易云是可选音乐源，不能拖垮主程序启动。
//
// 契约见 openspec/changes/embed-netease-api-service。

import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE_ID = 'NeteaseCloudMusicApi';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);
// 包自带静态首页的标题：用它判定端口上「是不是网易云」，不需要访问上游。
const IDENTITY_MARKER = '网易云音乐 API';
const PROBE_TIMEOUT_MS = 1500;

// ---- 地址解析 ----
// 单一入口决定「内嵌 / 复用 / 外部 / 关闭」，避免同一判断散落在多处。
export function resolveNcmEmbedding({ env = process.env } = {}) {
  const toggle = String(env.LUNARA_EMBEDDED_NCM ?? '').trim().toLowerCase();
  if (DISABLED_VALUES.has(toggle)) return { mode: 'disabled', reason: 'LUNARA_EMBEDDED_NCM' };

  const raw = String(env.NCM_BASE_URL ?? '').trim();
  if (!raw) {
    return { mode: 'embed', host: DEFAULT_HOST, port: DEFAULT_PORT, baseUrl: DEFAULT_BASE_URL, configured: false };
  }

  let url = null;
  try {
    url = new URL(raw);
  } catch {
    return { mode: 'external', baseUrl: raw, reason: 'unparsable NCM_BASE_URL' };
  }
  // 远端地址与非 http 协议一律当作用户自管的外部服务：不该被本地实例抢走请求。
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    return { mode: 'external', baseUrl: raw, reason: 'not a local http NCM_BASE_URL' };
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { mode: 'external', baseUrl: raw, reason: 'invalid port' };
  }
  return {
    mode: 'embed',
    host: DEFAULT_HOST,
    port,
    baseUrl: `http://${DEFAULT_HOST}:${port}`,
    configured: true,
  };
}

// ---- 端口工具 ----
// 只靠「能不能 bind」不够：macOS 上另一个进程监听 `::`（双栈）时，
// 再 bind 127.0.0.1 仍然会成功，于是两个服务同端口共存、请求归属不确定。
// 先看「有人能接上连接吗」，再确认可绑定，两者都通过才算空闲。
function canConnect(port, host) {
  return new Promise(resolve => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = reachable => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', error => {
      // ECONNREFUSED / EADDRNOTAVAIL = 确实没人在听；其它错误保守当占用。
      finish(!(error?.code === 'ECONNREFUSED' || error?.code === 'EADDRNOTAVAIL'));
    });
  });
}

function canBind(port, host) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export function isPortFree(port, host = DEFAULT_HOST) {
  return (async () => {
    if (await canConnect(port, host)) return false;
    return canBind(port, host);
  })();
}

export function findFreePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---- 身份探针 ----
// 只读本地静态首页：离线或上游故障时也不会把「网易云就在这儿」误判成别的服务。
export async function probeNcmIdentity(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return false;
    const html = await response.text();
    return typeof html === 'string' && html.includes(IDENTITY_MARKER);
  } catch {
    return false;
  }
}

// ---- require 前置条件 ----
// util/request.js 在模块加载期就 readFileSync(anonymous_token)，文件缺失会直接抛错；
// server.js 处理 ::1 请求时读 global.cnIp。两者都必须早于 require 完成。
function ensureAnonymousTokenFile() {
  const file = join(tmpdir(), 'anonymous_token');
  if (!existsSync(file)) writeFileSync(file, '', 'utf-8');
  return file;
}

function ensureCnIp(requireFn) {
  if (globalThis.cnIp) return;
  const { generateRandomChineseIP } = requireFn(`${PACKAGE_ID}/util/index.js`);
  globalThis.cnIp = generateRandomChineseIP();
}

// ---- 监听 ----
function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

async function listenEmbedded({ host, port, requireFn }) {
  const { serveNcmApi } = requireFn(`${PACKAGE_ID}/server.js`);
  // 包内部的端口计算是 `port || process.env.PORT || 3000`，传 0 会落到 Lunara 的
  // PORT(=8080) 上撞端口；所以必须给一个已经探好的具体端口。
  const app = await serveNcmApi({ port, host, checkVersion: false });
  const server = app.server;
  await waitForListening(server);
  return server;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function createLogger(log) {
  if (log && typeof log.info === 'function') return log;
  if (typeof log === 'function') return { info: log, warn: log };
  return {
    info: message => console.log(message),
    warn: message => console.warn(message),
  };
}

// ---- 启动 ----
// 返回 handle（embedded / reused）或 null（disabled / external / unavailable）。
// 不抛错：调用方把它当可选组件，失败只影响网易云源本身。
export async function startEmbeddedNcm(options = {}) {
  const env = options.env || process.env;
  const log = createLogger(options.log);
  const target = resolveNcmEmbedding({ env });

  if (target.mode === 'disabled') {
    log.info('  · 内置网易云服务已关闭（LUNARA_EMBEDDED_NCM），沿用外部地址');
    return null;
  }
  if (target.mode === 'external') {
    log.info(`  · 网易云使用外部服务 → ${target.baseUrl}`);
    return null;
  }

  const host = target.host;
  let port = target.port;
  let fallback = false;

  // 先认人，再判断端口：已有网易云服务就直接复用（独立进程 `npm run ncm` 仍可用）。
  if (await probeNcmIdentity(target.baseUrl, options.probeOptions)) {
    log.info(`  ♫ 复用已在运行的网易云 API → ${target.baseUrl}`);
    return { mode: 'reused', baseUrl: target.baseUrl, host, port, fallback: false, stop: async () => {} };
  }

  if (!(await isPortFree(port, host))) {
    try {
      port = await findFreePort(host);
    } catch (error) {
      log.warn(`  ⚠ ${target.baseUrl} 被占用且找不到空闲端口，网易云源不可用：${error?.message || error}`);
      return null;
    }
    fallback = true;
    log.warn(`  ⚠ ${target.baseUrl} 被其它程序占用，内置网易云 API 改听 → http://${host}:${port}`);
  }

  let requireFn = options.requireFn;
  let server = null;
  try {
    requireFn ||= createRequire(import.meta.url);
    ensureAnonymousTokenFile();
    ensureCnIp(requireFn);
  } catch (error) {
    log.warn(`  ⚠ 网易云服务初始化失败（${describeRequireFailure(error)}），本次不启用内置服务`);
    return null;
  }

  // 探测与 bind 之间存在竞态：允许换一个空闲端口再试一次，之后不再重试。
  for (let attempt = 0; attempt < 2 && !server; attempt += 1) {
    try {
      server = await listenEmbedded({ host, port, requireFn });
    } catch (error) {
      const missingPackage = error?.code === 'MODULE_NOT_FOUND';
      if (missingPackage || attempt > 0) {
        log.warn(`  ⚠ 内置网易云 API 启动失败（${describeRequireFailure(error)}），网易云源本次不可用`);
        return null;
      }
      try {
        port = await findFreePort(host);
        fallback = true;
      } catch (portError) {
        log.warn(`  ⚠ 内置网易云 API 启动失败（${error?.message || error}），网易云源本次不可用`);
        return null;
      }
    }
  }
  if (!server) return null;

  const baseUrl = `http://${host}:${port}`;
  log.info(`  ♫ 内置网易云 API → ${baseUrl}`);
  return {
    mode: 'embedded',
    baseUrl,
    host,
    port,
    fallback,
    stop: () => closeServer(server),
  };
}

function describeRequireFailure(error) {
  if (error?.code === 'MODULE_NOT_FOUND') return `缺少依赖 ${PACKAGE_ID}，请先 npm install`;
  return error?.message || String(error);
}

export default { resolveNcmEmbedding, probeNcmIdentity, isPortFree, findFreePort, startEmbeddedNcm };
