import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUserDataFiles, USER_DATA_FILES } from './userData.js';

async function withRoot(run) {
  // 双锚点：templateRoot（包根语义）/ dataRoot（数据根语义）分开传。
  const templateRoot = await mkdtemp(join(tmpdir(), 'lunara-userdata-tpl-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'lunara-userdata-data-'));
  await mkdir(join(templateRoot, 'user'), { recursive: true });
  await mkdir(join(dataRoot, 'user'), { recursive: true });
  try {
    await run(templateRoot, dataRoot);
  } finally {
    await rm(templateRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('a missing user file is created from its template', async () => {
  await withRoot(async (templateRoot, dataRoot) => {
    await writeFile(join(templateRoot, 'user', 'taste.md.example'), '# seed taste\n', 'utf8');
    const created = await ensureUserDataFiles({ templateRoot, dataRoot, files: ['taste.md'], logger: { warn() {} } });
    assert.deepEqual(created, ['taste.md']);
    assert.equal(await readFile(join(dataRoot, 'user', 'taste.md'), 'utf8'), '# seed taste\n');
    assert.equal(existsSync(join(templateRoot, 'user', 'taste.md')), false, '模板目录不产生用户文件');
  });
});

test('an existing user file is never overwritten', async () => {
  await withRoot(async (templateRoot, dataRoot) => {
    await writeFile(join(templateRoot, 'user', 'taste.md.example'), '# seed taste\n', 'utf8');
    await writeFile(join(dataRoot, 'user', 'taste.md'), '# my own taste\n', 'utf8');
    const created = await ensureUserDataFiles({ templateRoot, dataRoot, files: ['taste.md'], logger: { warn() {} } });
    assert.deepEqual(created, []);
    assert.equal(await readFile(join(dataRoot, 'user', 'taste.md'), 'utf8'), '# my own taste\n');
  });
});

test('a missing template and a missing file are both tolerated', async () => {
  await withRoot(async (templateRoot, dataRoot) => {
    // no-go.md has no template: consolidation creates it on demand.
    const created = await ensureUserDataFiles({ templateRoot, dataRoot, files: ['no-go.md'], logger: { warn() {} } });
    assert.deepEqual(created, []);
    assert.equal(existsSync(join(dataRoot, 'user', 'no-go.md')), false);
  });
});

test('a seed failure is reported but does not throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunara-userdata-'));
  try {
    // A regular file where the user directory should be makes both the target
    // probe and the copy fail with something other than ENOENT.
    await writeFile(join(root, 'user'), 'not a directory', 'utf8');
    const warnings = [];
    const created = await ensureUserDataFiles({
      templateRoot: root, dataRoot: root, files: ['routines.md'], logger: { warn: message => warnings.push(message) },
    });
    assert.deepEqual(created, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /routines\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the tracked set is exactly the files consolidation rewrites', async () => {
  // Revision guard: these names must match the write targets in consolidator.js
  // (TASTE_PATH, NO_GO_PATH, MOOD_RULES_PATH) plus the read-only seeds.
  assert.deepEqual([...USER_DATA_FILES], [
    'taste.md', 'no-go.md', 'mood-rules.md', 'routines.md', 'playlists.json',
  ]);
});