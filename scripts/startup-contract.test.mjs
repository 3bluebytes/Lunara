import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('music-source scripts use the checked launcher and contain no personal account', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts.ncm, 'node scripts/start-music-source.mjs ncm');
  assert.equal(pkg.scripts.qq, 'node scripts/qq-sdk-ready.mjs');
  assert.equal(pkg.scripts['setup:qq'], undefined);
  assert.equal(pkg.scripts['music:qq'], undefined);
  assert.match(pkg.scripts.prestart, /ensure-electron\.mjs/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /QQ=\d{5,}/);
});

test('environment example documents QR-based QQ configuration without secrets', async () => {
  const example = await readFile(new URL('.env.example', root), 'utf8');
  assert.doesNotMatch(example, /^QQ_BASE_URL=/m);
  assert.doesNotMatch(example, /^QQ_USER_ID=/m);
  assert.doesNotMatch(example, /qm_keyst=|qqmusic_key=/);
  assert.doesNotMatch(example, /USER_DISPLAY_NAME=mmguo/);
});

test('runtime data and generated audio are ignored except placeholders', async () => {
  const ignore = await readFile(new URL('.gitignore', root), 'utf8');
  assert.match(ignore, /^data\/\*$/m);
  assert.match(ignore, /^!data\/\.gitkeep$/m);
  assert.match(ignore, /^cache\/audio\/\*$/m);
});

test('publishable package contract: bin, files whitelist, no private flag', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, '@3bluebytes/lunara');
  assert.equal(pkg.private, undefined, '发布形态不得保留 private');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.bin?.lunara, 'bin/lunara.js');
  for (const entry of ['bin/lunara.js', 'server', 'pwa', 'prompts', 'electron']) {
    assert.ok(pkg.files?.includes(entry), `files 白名单应含 ${entry}`);
  }
  // bin 脚本显式点名（而非目录条目）：跨 npm 版本 packlist 行为一致，且测试文件不入包。
  assert.ok(!pkg.files?.some(entry => entry === 'bin' || String(entry).includes('test')), 'files 不得整目录含 bin（避免测试文件入包）');
  assert.ok(pkg.files?.includes('user/*.example'), 'files 白名单应含模板（真实 user 数据不入包）');
  assert.ok(!pkg.files?.some(entry => String(entry).startsWith('data')), 'data/ 运行时自建不入包');
  assert.ok(!pkg.files?.some(entry => String(entry).includes('cache')), 'cache/ 运行时自建不入包');
});

test('repo-only npm scripts are documented as requiring a repository clone', async () => {
  // scripts/start-music-source.mjs、qq-sdk-ready.mjs、setup.sh、doctor.mjs 不入发布包：
  // 全局安装态 npm run ncm/qq/setup/doctor 不可用，README 必须标注「需在仓库克隆内运行」。
  const readme = await readFile(new URL('README.md', root), 'utf8');
  assert.match(readme, /仓库克隆内运行/);
  assert.match(readme, /doctor|ncm|qq|setup/);
});

test('desktop packaging contract: builder config whitelist excludes private runtime data', async () => {
  const builderConfig = await readFile(new URL('electron-builder.yml', root), 'utf8');
  for (const required of ['electron/**/*', 'server/**/*', 'pwa/**/*', 'prompts/**/*',
    'bin/lunara.js', 'user/*.example', 'build/licenses/**/*']) {
    assert.ok(builderConfig.includes(required), `electron-builder files 白名单应含 ${required}`);
  }
  for (const forbidden of ['^\\s*-\\s*\\.env', '^\\s*-\\s*data/', '^\\s*-\\s*backup/',
    '^\\s*-\\s*docs/', '^\\s*-\\s*openspec/', '^\\s*-\\s*dist-desktop']) {
    assert.ok(!new RegExp(forbidden, 'm').test(builderConfig), `打包 files 白名单不得含 ${forbidden}`);
  }
  // 真实 user/ 不得整目录入包（user/*.example 模板除外）。
  assert.ok(!/^\s*-\s*user\/?$/m.test(builderConfig), 'user/ 真实数据不得整目录入包');
  assert.ok(builderConfig.includes('icon.icns') && builderConfig.includes('icon.ico'), '打包配置应引用生成的图标');
});

test('desktop packaging contract: only a host-runnable ffmpeg ships as the audio tool', async () => {
  // ffprobe-static 的 darwin/arm64 实际是 x86_64，无 Rosetta 的 Apple Silicon 上跑不起来；
  // 格式与时长改由随包 ffmpeg 读出，安装包不再携带 ffprobe。
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.ok(pkg.dependencies['ffmpeg-static'], 'ffmpeg-static 是随包音频工具');
  assert.equal(pkg.dependencies['ffprobe-static'], undefined, '不再依赖 ffprobe-static');
  const builderConfig = await readFile(new URL('electron-builder.yml', root), 'utf8');
  assert.ok(builderConfig.includes('node_modules/ffmpeg-static/**/*'), 'ffmpeg 必须 asarUnpack 才能执行');
  assert.ok(!builderConfig.includes('ffprobe'), '打包配置不得再引用 ffprobe');
  const smoke = await readFile(new URL('scripts/smoke-packaged-app.mjs', root), 'utf8');
  assert.match(smoke, /ffmpeg-static/, '打包冒烟必须实际执行随包 ffmpeg，不能只查文件存在');
});

test('desktop packaging contract: publish metadata and LICENSE exist', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.ok(pkg.author, 'author 是打包与发布的必填元数据');
  assert.ok(pkg.license, 'license 字段是开源发布前提');
  assert.equal(pkg.scripts['dist:mac'], 'node scripts/dist-desktop.mjs --mac');
  assert.equal(pkg.scripts['dist:win'], 'node scripts/dist-desktop.mjs --win');
  assert.equal(pkg.scripts['smoke:packaged'], 'node scripts/smoke-packaged-app.mjs');
  await assert.doesNotReject(() => readFile(new URL('LICENSE', root), 'utf8'), 'LICENSE 文件必须存在');
  const ffmpegLicense = await readFile(new URL('build/licenses/README-ffmpeg.md', root), 'utf8');
  assert.match(ffmpegLicense, /GPL-3\.0/);
  assert.match(ffmpegLicense, /不传染|不链接/, '必须说明独立进程调用下的许可边界');
});

test('desktop shell contract: single-instance lock and visible boot failure', async () => {
  const main = await readFile(new URL('electron/main.js', root), 'utf8');
  assert.match(main, /acquireSingleInstance/);
  assert.match(main, /showErrorBox/, '启动失败必须用户可见，不能只写控制台');
  const smoke = await readFile(new URL('scripts/smoke-packaged-app.mjs', root), 'utf8');
  assert.match(smoke, /DOTENV_CONFIG_PATH/, '打包冒烟必须隔离真实 .env');
  assert.match(smoke, /LUNARA_DATA_DIR/, '打包冒烟必须隔离真实数据根');
});
