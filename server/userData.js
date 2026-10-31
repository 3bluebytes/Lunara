import { access, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveDataRoot, resolvePackageRoot } from './runtimePaths.js';

/**
 * Runtime-owned user files.
 *
 * The running server rewrites these as the user's own data (see
 * `consolidator.js`), so they are deliberately not tracked by git: otherwise
 * every downstream clone ends up with a tree that is permanently dirty and a
 * pull that always conflicts. Seed content ships as `<name>.example` instead.
 */
export const USER_DATA_FILES = Object.freeze([
  'taste.md',
  'no-go.md',
  'mood-rules.md',
  'routines.md',
  'playlists.json',
]);

/**
 * Create any missing user file from its tracked template.
 *
 * Dual anchors: templates ship inside the package (`templateRoot/user/*.example`),
 * while targets live in the data root (`dataRoot/user/`) — `--data-dir` must not
 * move the shipped templates, and installs without the repo tree still seed.
 *
 * Never overwrites: an existing file is the user's data, whatever it contains.
 * A missing template (for example `no-go.md`, which consolidation creates on
 * demand) is not an error. Any other failure is reported but must not stop the
 * server, because every reader already falls back to a documented default.
 */
export async function ensureUserDataFiles({
  templateRoot = resolvePackageRoot(),
  dataRoot = resolveDataRoot(),
  files = USER_DATA_FILES,
  logger = console,
} = {}) {
  const created = [];
  // 全新数据根没有 user/：首启动 mkdir 后才能播种（failures 不阻断启动）。
  await mkdir(resolve(dataRoot, 'user'), { recursive: true }).catch(() => {});
  for (const name of files) {
    const target = resolve(dataRoot, 'user', name);
    const template = resolve(templateRoot, 'user', `${name}.example`);
    try {
      await access(target);
      continue;
    } catch { /* absent: fall through and seed from the template */ }
    try {
      await copyFile(template, target);
      created.push(name);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`[user-data] could not create user/${name} from its template (${error?.code || 'error'})`);
      }
    }
  }
  return created;
}

export default { USER_DATA_FILES, ensureUserDataFiles };