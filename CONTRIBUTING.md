# 参与贡献 Lunara

欢迎为 **Lunara · Luna Radio** 提交 Issue、改进建议或 Pull Request！

## 行为准则

参与本项目讨论与协作前，请阅读并遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 反馈 Bug 与功能建议

- **遇到问题**：请使用 [Bug 反馈模板](https://github.com/3bluebytes/Lunara/issues/new?template=bug_report.yml)，注明操作系统、架构、安装方式（`.dmg` / 源码）与复现步骤。
- **隐私安全提醒**：贴日志或截图前，务必删除你的 API Key、QQ/网易云 Cookie、`.env`、`~/.lunara/config.json` 与 `~/.lunara/sessions/` 里的私人上下文。
- **安全漏洞**：涉及用户隐私或本地安全边界的漏洞请勿发公开 Issue，请查看 [SECURITY.md](SECURITY.md) 通过私密安全报告通道提交。
- **使用交流与想法**：欢迎前往 [GitHub Discussions](https://github.com/3bluebytes/Lunara/discussions) 或使用功能建议模板。

## 本地开发环境

### 前提

- Node.js 20 及以上（CI 与日常开发主要使用 **Node 22**）
- 克隆仓库并安装依赖：

```bash
git clone https://github.com/3bluebytes/Lunara.git
cd Lunara
npm ci
```

### 启动方式

```bash
npm start            # 启动 Electron 桌面端（prestart 会自动重编 better-sqlite3 到 Electron ABI）
npm run start:web    # 仅启动本地 Web 服务（默认监听 http://127.0.0.1:8080）
npm run dev          # 开发监听模式（node --watch server/index.js）
npm run doctor       # 环境诊断（ABI、LLM 连通性、端口与 QQ 内置 SDK 状态）
```

> **原生模块 ABI 提示**：`better-sqlite3` 需要区分 Node ABI 与 Electron ABI。`npm test`、`npm run start:web` 和 `npm run dev` 会自动切到 Node ABI；`npm start` 会自动切到 Electron ABI。手工直接运行单测 `node path/to/file.test.js` 前，若刚跑过 `npm start`，先运行 `npm run rebuild:node`，并自行指定隔离的 `LUNARA_DATA_DIR`，避免写入真实 `~/.lunara`。

## 代码与架构约定

提交代码前请了解以下核心边界，避免破坏已有契约测试：

1. **播放唯一真相源**：`server/playback/PlaybackRuntime.js` 是队列、当前曲目、phase 与续播状态的唯一权威写入者；前端只订阅 `runtime-state`，不要在界面或辅助服务里另建第二套播放状态机。
2. **HTTP 路由边界**：路由放在 `server/http/routes/`，只做参数解析、校验与服务委托。`server/http/routeBoundary.test.js` 对只读 `GET` 接口做了显式快照审计：新增或变更路由请同步更新契约测试，且绝不能在 `GET` 路由里触发状态变更。
3. **组合根精简**：`server/index.js` 只做模块装配；业务逻辑请放到 `server/services/`、`server/life/`、`server/virtual-person/` 等领域目录（`server/app/index.composition.test.js` 会检查入口行数上限）。
4. **本地边界**：Lunara 是本地单用户应用，不开放跨站 CORS，仅接受 loopback `Host`。不要修改这些安全限制，也不要把用户隐私数据写入默认日志或测试快照。
5. **跨平台换行**：仓库通过 `.gitattributes` 统一使用 `LF` 换行。

## 运行测试

```bash
npm test                 # 在隔离临时目录内逐文件运行全部测试
npm test playback        # 只运行路径包含关键词的测试文件
```

如果你需要本地构建桌面安装包：

```bash
npm run dist:mac         # Apple Silicon macOS 构建 .dmg 并运行打包冒烟（含 ffmpeg -L 检查）
npm run dist:win         # Windows x64 构建 NSIS .exe（含 ffmpeg -L 检查）
```

## 提交 Pull Request 前检查

- [ ] 新增或修改逻辑附带对应的单元测试，且 `npm test` 全部通过；
- [ ] `git diff --check` 无空白或冲突标记错误；
- [ ] 未包含任何真实 `.env`、`config.json`、`data/*.db`、Cookie、API Key 或个人数据；
- [ ] PR 说明中清楚写明改动原因、行为变化以及实际验证过的环境（例如单元测试 / Web / Electron 桌面端）。

向本仓库提交 Pull Request 即表示你同意你的贡献将按照本项目的 [MIT 协议](LICENSE) 发布。
