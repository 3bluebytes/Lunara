// configLock.js — config.json 的按路径串行读改写（唯一写入纪律）。
//
// 背景（审查缺口 2026-10-16）：provider 注册表、能力档案与 legacy llm 三元组是同一份
// 文件的多个写入者；后台探测、运行时观测、设置保存与模型切换会自然并发。整文档读改写
// 必须**串行**，且必须保留不属于本次更新的字段——否则旧快照会覆盖新值（并发保存三份
// 能力档案只剩一份、保存能力时把使用中模型写回旧值，都是这个根因）。
//
// 语义：
//   - withConfigLock(path, task)：同一路径上的写入依次执行；任务在锁内读取最新文档。
//   - readConfigDocument(path)：读整份文档；缺失或坏 JSON → {}（不抛，调用方按空处理）。
//   - writeConfigDocument(path, doc)：0600 + 临时文件原子替换。
//   - updateConfigDocument(path, updater)：锁内 读 → updater(doc) → 写；updater 返回
//     null 表示放弃写入（例如“没有变化”）。
// 读取路径不加锁：写入是原子替换，读者要么看到旧版本要么看到新版本，不会读到半份文件。

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const locks = new Map();

/** 同一路径的写入排队执行；任务抛错不阻断后续写入（锁本身不吞错误，只隔离顺序）。 */
export function withConfigLock(path, task) {
  const key = String(path);
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

export async function readConfigDocument(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      console.warn(`[config] read failed: ${error?.message || error}`);
    }
    return {};
  }
}

export async function writeConfigDocument(path, document) {
  const dir = dirname(path);
  const tmpPath = join(dir, `.config-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(tmpPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function updateConfigDocument(path, updater) {
  return withConfigLock(path, async () => {
    const current = await readConfigDocument(path);
    const next = await updater(current);
    if (next == null) return null;
    await writeConfigDocument(path, next);
    return next;
  });
}

export default { withConfigLock, readConfigDocument, writeConfigDocument, updateConfigDocument };
