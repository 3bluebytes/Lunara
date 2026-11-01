import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getLLMConfig,
  getLLMConfigDir,
  getLLMConfigPath,
  getPublicLLMConfig,
  isConfigured,
  setLLMConfig,
} from './llmConfig.js';

async function withConfigDir(fn) {
  const previous = process.env.LUNARA_CONFIG_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'lunara-llm-config-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.LUNARA_CONFIG_DIR;
    else process.env.LUNARA_CONFIG_DIR = previous;
  }
}

test('自定义配置目录覆盖默认路径，写入 nested llm 配置且权限为 0600', { skip: process.platform === 'win32' ? 'POSIX 文件权限语义,Windows 不适用' : false }, async () => {
  await withConfigDir(async dir => {
    const saved = await setLLMConfig({
      baseUrl: 'https://example.test/v1/',
      apiKey: 'secret-key',
      model: 'model-a',
    });
    assert.equal(getLLMConfigPath(), join(dir, 'config.json'));
    assert.deepEqual(saved, {
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret-key',
      model: 'model-a',
    });

    const disk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(disk.llm, saved);
    assert.equal((await stat(join(dir, 'config.json'))).mode & 0o777, 0o600);
  });
});

test('空密钥保留旧 key，公开视图永不含明文', async () => {
  await withConfigDir(async () => {
    await setLLMConfig({ baseUrl: 'https://one.test/v1', apiKey: 'keep-me', model: 'm1' });
    await setLLMConfig({ baseUrl: 'https://two.test/v1', apiKey: '', model: 'm2' });

    assert.deepEqual(await getLLMConfig(), {
      baseUrl: 'https://two.test/v1',
      apiKey: 'keep-me',
      model: 'm2',
    });
    const publicConfig = await getPublicLLMConfig();
    assert.deepEqual(publicConfig, {
      baseUrl: 'https://two.test/v1',
      model: 'm2',
      apiKeySet: true,
      ready: true,
    });
    assert.equal(JSON.stringify(publicConfig).includes('keep-me'), false);
  });
});

test('isConfigured 反映"是否存在可解析的端点"（注册表 activeModel 或 legacy base+model）', async () => {
  await withConfigDir(async () => {
    assert.equal(await isConfigured(), false);
    // legacy 缺 model 不算可用
    await setLLMConfig({ baseUrl: 'https://example.test/v1', apiKey: '', model: '' });
    assert.equal(await isConfigured(), false);
    // legacy base+model（key 可空，本地网关场景）即视为可解析
    await setLLMConfig({ baseUrl: 'https://example.test/v1', apiKey: '', model: 'm' });
    assert.equal(await isConfigured(), true);
    // 注册表方式：清掉 legacy model，改由 provider 注册表提供
    await setLLMConfig({ baseUrl: '', apiKey: 'key', model: '' });
    const { saveModelProvider, setActiveModel } = await import('./llmProviders.js');
    const provider = await saveModelProvider({ name: 'a', baseUrl: 'http://a/v1', models: ['ma'] });
    await setActiveModel({ providerId: provider.id, model: 'ma' });
    assert.equal(await isConfigured(), true);
  });
});

test('LUNARA_CONFIG_DIR 优先于 legacy CLAUDIO_CONFIG_DIR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunara-config-priority-'));
  const current = join(root, 'current');
  const legacy = join(root, 'legacy');
  const prevCurrent = process.env.LUNARA_CONFIG_DIR;
  const prevLegacy = process.env.CLAUDIO_CONFIG_DIR;
  process.env.LUNARA_CONFIG_DIR = current;
  process.env.CLAUDIO_CONFIG_DIR = legacy;
  try {
    assert.equal(getLLMConfigPath(), join(current, 'config.json'));
    await setLLMConfig({ baseUrl: 'https://new.test/v1', apiKey: 'new-key', model: 'new-model' });
    assert.equal(JSON.parse(await readFile(join(current, 'config.json'), 'utf8')).llm.model, 'new-model');
  } finally {
    if (prevCurrent === undefined) delete process.env.LUNARA_CONFIG_DIR;
    else process.env.LUNARA_CONFIG_DIR = prevCurrent;
    if (prevLegacy === undefined) delete process.env.CLAUDIO_CONFIG_DIR;
    else process.env.CLAUDIO_CONFIG_DIR = prevLegacy;
  }
});

test('新配置缺失时迁移 legacy 文件，保持 0600 且不删除旧文件', { skip: process.platform === 'win32' ? 'POSIX 文件权限语义,Windows 不适用' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunara-config-migrate-'));
  const current = join(root, 'current');
  const legacy = join(root, 'legacy');
  await mkdir(legacy, { recursive: true });
  const legacyPath = join(legacy, 'config.json');
  await writeFile(legacyPath, JSON.stringify({ llm: {
    baseUrl: 'https://legacy.test/v1', apiKey: 'legacy-key', model: 'legacy-model',
  } }), { mode: 0o600 });

  const prevCurrent = process.env.LUNARA_CONFIG_DIR;
  const prevLegacy = process.env.CLAUDIO_CONFIG_DIR;
  process.env.LUNARA_CONFIG_DIR = current;
  process.env.CLAUDIO_CONFIG_DIR = legacy;
  try {
    const loaded = await getLLMConfig();
    assert.equal(loaded.model, 'legacy-model');
    const migratedPath = join(current, 'config.json');
    assert.equal(JSON.parse(await readFile(migratedPath, 'utf8')).llm.apiKey, 'legacy-key');
    assert.equal((await stat(migratedPath)).mode & 0o777, 0o600);
    await access(legacyPath);
  } finally {
    if (prevCurrent === undefined) delete process.env.LUNARA_CONFIG_DIR;
    else process.env.LUNARA_CONFIG_DIR = prevCurrent;
    if (prevLegacy === undefined) delete process.env.CLAUDIO_CONFIG_DIR;
    else process.env.CLAUDIO_CONFIG_DIR = prevLegacy;
  }
});

// ---- 密钥目录与数据根解耦（add-cli-launch-data-dir）----

test('设置 LUNARA_DATA_DIR 后密钥目录仍锚 ~/.lunara，不被数据根牵动', () => {
  const prevDataDir = process.env.LUNARA_DATA_DIR;
  const prevConfigDir = process.env.LUNARA_CONFIG_DIR;
  const prevLegacyConfigDir = process.env.CLAUDIO_CONFIG_DIR;
  delete process.env.LUNARA_CONFIG_DIR;
  delete process.env.CLAUDIO_CONFIG_DIR;
  process.env.LUNARA_DATA_DIR = '/tmp/lunara-home';
  try {
    assert.equal(getLLMConfigDir(), join(homedir(), '.lunara'));
    assert.equal(getLLMConfigPath(), join(homedir(), '.lunara', 'config.json'));
  } finally {
    if (prevDataDir === undefined) delete process.env.LUNARA_DATA_DIR;
    else process.env.LUNARA_DATA_DIR = prevDataDir;
    if (prevConfigDir === undefined) delete process.env.LUNARA_CONFIG_DIR;
    else process.env.LUNARA_CONFIG_DIR = prevConfigDir;
    if (prevLegacyConfigDir === undefined) delete process.env.CLAUDIO_CONFIG_DIR;
    else process.env.CLAUDIO_CONFIG_DIR = prevLegacyConfigDir;
  }
});

test('LUNARA_CONFIG_DIR 优先于数据根存在时的默认（密钥最高优先级固化）', () => {
  const prevDataDir = process.env.LUNARA_DATA_DIR;
  const prevConfigDir = process.env.LUNARA_CONFIG_DIR;
  process.env.LUNARA_DATA_DIR = '/tmp/lunara-home';
  process.env.LUNARA_CONFIG_DIR = '/tmp/explicit-config';
  try {
    assert.equal(getLLMConfigDir(), '/tmp/explicit-config');
  } finally {
    if (prevDataDir === undefined) delete process.env.LUNARA_DATA_DIR;
    else process.env.LUNARA_DATA_DIR = prevDataDir;
    if (prevConfigDir === undefined) delete process.env.LUNARA_CONFIG_DIR;
    else process.env.LUNARA_CONFIG_DIR = prevConfigDir;
  }
});

test('legacy setLLMConfig 保留注册表与未知顶层字段（不清空 provider）', async () => {
  await withConfigDir(async dir => {
    const { saveModelProvider, setActiveModel, getActiveModel, listModelProviders } = await import('./llmProviders.js');
    const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m'] });
    await setActiveModel({ providerId: provider.id, model: 'm' });

    await setLLMConfig({ baseUrl: 'http://legacy/v1', apiKey: 'sk-new', model: 'm-legacy' });
    assert.equal((await getLLMConfig()).model, 'm-legacy');
    const providers = await listModelProviders();
    assert.equal(providers.length, 1, 'legacy 保存不清空注册表');
    assert.equal(providers[0].id, provider.id);
    assert.deepEqual(await getActiveModel(), { providerId: provider.id, model: 'm' });
    // 未知顶层字段同样保留。
    const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(raw.llm.model, 'm-legacy');
    assert.ok(Array.isArray(raw.modelProviders) && raw.modelProviders.length === 1);
  });
});
