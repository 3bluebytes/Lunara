#!/usr/bin/env node
// lunara — Lunara GUI 启动器（无 REPL；add-cli-launch-data-dir）。
//
// 契约：
//   lunara [--profile web|desktop] [--data-dir <dir>] [--port <p>] [--host <h>]
//          [--help] [--version]
//   lunara migrate [--source <dir>] [--data-dir <dir>] [--dry-run] [--include-cache]
//
// - 服务端只认 env：--data-dir/--port/--host 在任何服务端 import 之前分别写入
//   LUNARA_DATA_DIR / PORT / LUNARA_HOST。
// - 每路径 env（LUNARA_DB_PATH/LUNARA_RADIOHOST_DIR，含 cwd .env 经 dotenv 注入者）
//   恒为更高优先级且会跳过自动迁移：显式 --data-dir 时只告警不拒绝（既有契约）。
// - ABI 是运行态（npm start 的 prestart 随时把 better-sqlite3 切回 Electron ABI）：
//   web 档动态 import 与 migrate 分支统一 catch ERR_DLOPEN_FAILED/NODE_MODULE_VERSION，
//   打印 rebuild:node 指引并 exit 1。require 探针是假阴性（dlopen 只在 new Database
//   时发生），因此提示判定基于捕获的 error，不做预探测。
// - desktop 档探测包内 Electron（全局安装必缺，electron 在 devDependencies）：
//   缺失打印指引并回退 web；存在则 spawn（继承 env 传导 LUNARA_DATA_DIR 与 stdio）。

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(BIN_DIR, '..');

const USAGE = `lunara — Lunara (Luna Radio) 启动器

用法：
  lunara [--profile web|desktop] [--data-dir <dir>] [--port <p>] [--host <h>]
  lunara migrate [--source <dir>] [--data-dir <dir>] [--dry-run] [--include-cache]

选项：
  --profile web|desktop   启动档位（默认 web；desktop 复用 Electron 桌面壳）
  --data-dir <dir>        数据根目录（写入 LUNARA_DATA_DIR；默认 ~/.lunara）
  --port <p>              服务端口（写入 PORT）
  --host <h>              绑定地址（写入 LUNARA_HOST）
  migrate                 把旧仓库布局数据迁移到数据根（一致性备份 + 表级校验）
  --dry-run               只检测不写入（含源侧）
  --include-cache         迁移时附带 cache/（默认不迁）
  --help / --version

说明：LUNARA_DB_PATH / LUNARA_RADIOHOST_DIR 等每路径变量优先于 --data-dir 推导，
且会跳过自动迁移。原生模块 ABI 不匹配时按提示运行 npm run rebuild:node（web 档）
或 npm run rebuild:electron（桌面档）。

注意：npm run doctor / ncm / qq / setup 需在仓库克隆内运行，全局安装态不可用。`;

export function parseCliArgs(argv = []) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      profile: { type: 'string', default: 'web' },
      'data-dir': { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      source: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'include-cache': { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  return {
    migrate: positionals[0] === 'migrate',
    profile: values.profile,
    dataDir: values['data-dir'],
    port: values.port,
    host: values.host,
    source: values.source,
    dryRun: values['dry-run'],
    includeCache: values['include-cache'],
    version: values.version,
    help: values.help,
  };
}

/** 服务端只认 env：在任何服务端 import 之前写入。 */
export function applyCliEnv(args, env = process.env) {
  if (args.dataDir) env.LUNARA_DATA_DIR = resolve(args.dataDir);
  if (args.port) env.PORT = String(args.port);
  if (args.host) env.LUNARA_HOST = String(args.host);
}

function effectiveDataRoot(env) {
  return resolve(env.LUNARA_DATA_DIR || join(homedir(), '.lunara'));
}

/**
 * 显式 --data-dir 与残留每路径 env 的语义冲突告警：两者恒为更高优先级且会
 * 跳过自动迁移。只告警不拒绝（优先级链是既有契约）。
 */
export function warnDataDirConflicts({ env = process.env, log = console } = {}) {
  const overrides = [
    ['LUNARA_DB_PATH', '数据库'],
    ['LUNARA_RADIOHOST_DIR', '角色目录'],
  ].filter(([name]) => env[name]);
  if (!overrides.length) return;
  const dataRoot = effectiveDataRoot(env);
  const lines = overrides.map(([name, label]) => {
    const value = env[name];
    const actual = isAbsolute(value) ? resolve(value) : resolve(dataRoot, value);
    return `  ${name}（${label}）→ ${actual}`;
  });
  log.warn(
    `[lunara] 已显式指定 --data-dir，但环境中仍设置了每路径覆盖变量；`
    + `以下变量以更高优先级生效且会跳过自动迁移：\n${lines.join('\n')}\n  数据根: ${dataRoot}`,
  );
}

/**
 * 原生模块 ABI 失败提示。判定基于捕获的 error（ERR_DLOPEN_FAILED 或
 * NODE_MODULE_VERSION 文本）；require 探针是假阴性，绝不用作触发器。
 */
export function nativeModuleHint(error) {
  const message = String(error?.message || '');
  if (error?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(message)) {
    return '[lunara] 原生模块 ABI 不匹配：better-sqlite3 与当前 Node 运行时编译目标不一致。\n'
      + '  请先在安装目录运行 `npm run rebuild:node`（桌面档为 `npm run rebuild:electron`），再重新启动。';
  }
  return null;
}

/** migrate 报告 status → 进程退出码。 */
export function statusExitCode(status) {
  return ['source-busy', 'refused-target-not-empty', 'refused-source-equals-target'].includes(status) ? 1 : 0;
}

/**
 * 探测包内 Electron 运行时（electron 在 devDependencies，全局安装必缺）。
 */
export function inspectElectronInstall({ root = PACKAGE_ROOT } = {}) {
  try {
    const rel = readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
    const binaryPath = join(root, 'node_modules', 'electron', 'dist', rel);
    if (!existsSync(binaryPath)) return { ready: false, binaryPath: null, root };
    return { ready: true, binaryPath, root };
  } catch {
    return { ready: false, binaryPath: null, root };
  }
}

/** desktop 档分流：缺失 → 指引 + web 回退；就绪 → electron。 */
export function resolveDesktopLaunch({ inspect = inspectElectronInstall, root = PACKAGE_ROOT, log = console } = {}) {
  const electron = inspect({ root });
  if (!electron.ready) {
    log.warn('[lunara] 未找到 Electron 运行时（全局安装不含 devDependencies）。');
    log.warn('[lunara] 可在仓库克隆内运行 `npm install` 后重试，或直接使用 `lunara --profile web`。');
    log.warn('[lunara] 现在回退为 web 档启动。');
    return { mode: 'web-fallback' };
  }
  return { mode: 'electron', binaryPath: electron.binaryPath };
}

/** 尽力打开浏览器；打开失败仅提示 URL，不使进程失败。 */
export function openBrowser(url, log = console) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => log.log(`[lunara] 未能自动打开浏览器，请手动访问: ${url}`));
    child.unref();
  } catch {
    log.log(`[lunara] 未能自动打开浏览器，请手动访问: ${url}`);
  }
}

async function importServerModule(modulePath, log) {
  try {
    // Windows 下绝对路径必须转 file:// URL，否则 `D:\...` 被当成 `d:` 协议（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
    return await import(pathToFileURL(resolve(PACKAGE_ROOT, modulePath)).href);
  } catch (error) {
    const hint = nativeModuleHint(error);
    if (hint) {
      log.error(hint);
      process.exit(1);
    }
    throw error;
  }
}

async function runWeb({ log = console } = {}) {
  const { resolveDataRoot } = await import('../server/runtimePaths.js');
  log.log(`数据目录: ${resolveDataRoot()}`);

  const server = await importServerModule('server/index.js', log);
  const { runServerEntrypoint } = await importServerModule('server/app/runServerEntrypoint.js', log);
  const port = parseInt(process.env.PORT || '8080', 10);
  const host = String(process.env.LUNARA_HOST || '127.0.0.1');
  const { starting } = runServerEntrypoint({ start: server.start, stop: server.stop, port });
  // 只有服务真正开始监听才打开浏览器：启动失败时打开的只是缓存的旧壳，
  // 用户会以为 Lunara 坏了（按钮全部无响应）。失败已由 entrypoint 记录并置 exitCode。
  let listening = false;
  await starting.then(() => { listening = true; }, () => {});
  if (listening) openBrowser(`http://${host}:${port}`, log);
  else log.error(`[lunara] 服务未能启动，已跳过打开浏览器。请查看上方启动日志；数据目录: ${effectiveDataRoot(process.env)}`);
}

async function runDesktop({ log = console } = {}) {
  const launch = resolveDesktopLaunch({ log });
  if (launch.mode === 'web-fallback') return runWeb({ log });

  const child = spawn(launch.binaryPath, [PACKAGE_ROOT], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    if (code) {
      log.error(`[lunara] Electron 桌面档异常退出（code ${code}）。`);
      log.error('[lunara] 若为原生模块 ABI 问题，请在安装目录运行 `npm run rebuild:electron`。');
    }
    process.exitCode = code || (signal ? 1 : 0);
  });
  return child;
}

async function runMigrate(args, { log = console, now = () => new Date() } = {}) {
  // 只 import runtimePaths + dataRootMigration，不拉起服务端；套同一 ABI catch。
  const { resolveDataRoot } = await import('../server/runtimePaths.js');
  const migration = await importServerModule('server/app/dataRootMigration.js', log);

  const targetRoot = resolveDataRoot();
  const sourceRoot = args.source || migration.detectLegacySourceRoot({ env: process.env, cwd: process.cwd() });
  if (!sourceRoot) {
    log.error('[lunara] 未发现旧布局数据源（cwd 下无 data/state.db）。请传 --source <目录> 或在旧仓库目录内运行。');
    process.exit(1);
  }

  let report;
  try {
    report = migration.runMigration({
      sourceRoot,
      targetRoot,
      dryRun: !!args.dryRun,
      includeCache: !!args.includeCache,
      now,
      log,
    });
  } catch (error) {
    const hint = nativeModuleHint(error);
    if (hint) log.error(hint);
    else log.error(`[lunara] 迁移失败（fail-closed，未产出部分状态）: ${error?.message || error}`);
    process.exit(1);
  }
  log.log(JSON.stringify(report, null, 2));
  process.exitCode = statusExitCode(report.status);
  return report;
}

export async function main({ argv = process.argv.slice(2), env = process.env, inspect = inspectElectronInstall, log = console } = {}) {
  const args = parseCliArgs(argv);
  if (args.help) {
    log.log(USAGE);
    return;
  }
  if (args.version) {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    log.log(String(pkg.version));
    return;
  }
  // env 注入在任何服务端 import 之前；dotenv 已在模块顶部加载，cwd 的 .env
  // 变量已入 env，冲突检测因此能看到「经 dotenv 注入」的残留覆盖。
  applyCliEnv(args, env);
  if (args.dataDir) warnDataDirConflicts({ env, log });
  if (args.migrate) return runMigrate(args, { log });
  if (args.profile === 'desktop') return runDesktop({ log });
  return runWeb({ log });
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
