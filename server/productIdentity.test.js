import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 公开发布快照只含运行时源码与测试，docs/、openspec/、AGENTS.md 等开发材料可能不存在；
// 缺席的目录或文件跳过扫描，存在时照常检查。
async function filesUnder(path) {
  const out = [];
  if (!existsSync(path)) return out;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'archive') continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else out.push(absolute);
    }
  }
  await visit(path);
  return out;
}

test('当前产品元数据统一为 Lunara / Luna Radio', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(ROOT, 'pwa/manifest.json'), 'utf8'));
  assert.equal(pkg.name, '@3bluebytes/lunara');
  assert.equal(pkg.productName, 'Lunara');
  assert.match(manifest.name, /Lunara/);
  assert.match(manifest.name, /Luna Radio/);
});

test('当前源码与文档不再出现大写 Claudio 产品名', async () => {
  const roots = ['server', 'pwa', 'electron', 'scripts', 'prompts', 'user', 'docs', 'openspec/specs'];
  const files = (await Promise.all(roots.map(root => filesUnder(join(ROOT, root))))).flat();
  // The repository instruction files are deliberately not scanned: they quote
  // the retired product name in order to prohibit it, so scanning them would
  // only ever report the prohibition itself.
  files.push(...['README.md', 'PRODUCT.md', '.env.example', 'setup.sh'].map(name => join(ROOT, name)).filter(existsSync));
  const offenders = [];
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue;
    if (!/\.(?:js|mjs|html|css|json|md|sh)$/.test(file) && !file.endsWith('.env.example')) continue;
    const content = await readFile(file, 'utf8');
    if (content.includes('Claudio')) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test('可执行路径不再依赖 claude-cli', async () => {
  const roots = ['server', 'pwa', 'electron', 'scripts'];
  const files = (await Promise.all(roots.map(root => filesUnder(join(ROOT, root))))).flat();
  files.push(join(ROOT, 'setup.sh'), join(ROOT, 'package.json'));
  const offenders = [];
  for (const file of files) {
    if (file.endsWith('.test.js') || file.endsWith('/test.js')) continue;
    const content = await readFile(file, 'utf8');
    if (/claude-cli|CLAUDE_BIN|askClaudeCli|spawn\(['"]claude/.test(content)) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

// rename-radiohost-to-radiohost 的防回流防线：角色术语已收敛为 radiohost /「伙伴」，
// 活跃源码、当前文档与基线 specs 中不得再出现指称该角色的 dj/DJ 词形。
// 词形覆盖：\bdj（大小写任意、词边界，如 `radiohost:`、`/api/radiohost`、`DJHost`）
// 加 camelCase/下划线变体（`activeRadiohost`、`registerRadiohostRoutes`、`LUNARA_RADIOHOST_DIR`、`radiohost_` 前缀）。
// adjust/adjacent 等含小写 "dj" 的英文单词因大小写受限的变体规则而不会误报。
const DJ_TOKEN_RULES = [
  /\bdj/i,          // 词边界后的任意大小写 dj/DJ/Dj/dJ
  /[a-zA-Z_]DJ/,    // 词中/下划线后的大写 DJ（activeRadiohost、LUNARA_RADIOHOST_DIR）
  /[a-zA-Z_]Dj/,    // 词中的驼峰 Dj（registerRadiohostRoutes）
  /_dj/,            // 下划线后的小写 dj（radiohost_ 前缀变量、fixture）
];

// 历史档案与真实职业称谓不属于本扫描范围：
//  - archive 与本 change 自述必然含旧词，等同 rename-to-lunara 的「历史不改写」。
//  - docs/verification/ 是带日期的验收证据/删除墓碑记录（spec 允许 historical
//    tombstone references 不在扫描范围内），其中的旧路径是当时的事实。
//  - prompts/radio-examples.md 引用真实电台人（张有待、田龙等），"DJ" 指现实职业
//    而非 Lunara 角色命名，机械改写会篡改引文。
const DJ_SCAN_WHITELIST = [
  { test: rel => rel.startsWith('openspec/changes/archive/'), reason: '历史 change 不改写' },
  { test: rel => rel.startsWith('openspec/changes/rename-dj-to-radiohost/'), reason: '本 change 自述' },
  { test: rel => rel.startsWith('backup/'), reason: '运行时隔离备份目录' },
  { test: rel => rel.startsWith('docs/verification/'), reason: '带日期的验收证据与删除墓碑记录' },
  { test: rel => rel.startsWith('docs/legacy/'), reason: '已被取代的历史文档（等同历史档案，见 docs/README.md 的目录约定）' },
  { test: rel => rel === 'prompts/radio-examples.md', reason: '真实电台人史料引用，非角色命名' },
  { test: rel => rel === 'docs/brainstorm/2026-09-23-night-brainstorm.md',
    reason: '竞品 Spotify AI DJ 的产品名与广播职业泛称，非 Lunara 角色命名' },
  { test: rel => rel.startsWith('docs/research/companion-presence/'),
    reason: '陪伴研究材料引用并分析旧文案（"虚拟 DJ"、术语决策出处），引文不改写' },
  { test: rel => rel === 'server/legacyCutover.test.js', reason: '旧布局隔离切换的单测必须引用旧标识作为检测信号' },
  { test: rel => rel === 'server/legacyCutover.js', reason: '旧布局检测实现必须引用旧标识（user/dj、djhosts、kind=dj 是被检测的信号）' },
  { test: rel => rel === 'server/app/dataRootMigration.js', reason: '数据根迁移实现复用 legacyCutover 隔离与 user/dj 排除，必须引用旧标识作为检测信号' },
  { test: rel => rel === 'server/app/dataRootMigration.test.js', reason: '迁移对抗用例必须引用旧标识（user/dj、djhosts 表）验证隔离先于复制' },
  { test: rel => rel === 'server/runtimePaths.test.js', reason: 'radiohost-terminology spec 场景要求验证 CLAUDIO_DJ_DIR 已失效，必须引用该变量名' },
  { test: rel => rel === 'openspec/specs/radiohost-terminology/spec.md', reason: '术语契约原文必须写明 CLAUDIO_DJ_DIR fallback SHALL be removed，指名被移除的变量' },
  { test: rel => rel === 'pwa/core/frontend.contract.test.js', reason: '负向断言引用历史 localStorage 键名 lunara_active_dj（防旧键回流），必须保留旧键名' },
];

test('活跃源码与当前文档不再出现指称角色的 dj/DJ 术语', async () => {
  const roots = ['server', 'pwa', 'scripts', 'prompts', 'docs', 'openspec/specs'];
  const files = (await Promise.all(roots.map(root => filesUnder(join(ROOT, root))))).flat();
  files.push(...['README.md', 'AGENTS.md', '.env.example', 'package.json'].map(name => join(ROOT, name)).filter(existsSync));
  const offenders = [];
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue;
    if (!/\.(?:js|mjs|html|css|json|md)$/.test(file) && !file.endsWith('.env.example')) continue;
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (DJ_SCAN_WHITELIST.some(entry => entry.test(rel))) continue;
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DJ_TOKEN_RULES.some(rule => rule.test(lines[i]))) {
        offenders.push(`${rel}:${i + 1}`);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件仍包含 dj/DJ 角色术语（扫描防线；豁免清单见 DJ_SCAN_WHITELIST）:\n  ${offenders.join('\n  ')}`,
  );
});
