// 为系统 Node 重编 better-sqlite3。
// npm 11.17 会把用户 .npmrc 里的 allow-scripts 以 npm_config_allow_scripts 环境变量传给子脚本，
// 嵌套的 `npm rebuild` 再读到它时会当成 --allow-scripts 命令行参数，在项目内安装里直接报 EALLOWSCRIPTS。
// 去掉这个环境变量后，嵌套 npm 仍会从 .npmrc 读取同一份设置。
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
}
const result = spawnSync('npm', ['rebuild', 'better-sqlite3'], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
