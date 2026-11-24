# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-24

首个公开预览版本 **Lunara · Luna Radio**。

### 新增

- **多伙伴对话与在场陪伴**：内置 `VirtualPersonRuntime`、`AgentLoop`、结构化工具与分拍回复，支持创建多位拥有独立人格和声音的伙伴，支持单聊、群聊 `@` 分发及话题插话。
- **聊天点歌与播放状态机**：支持自然语言点歌、推荐不打断当前曲目、自动续播、单源 / 多源播放比例控制，以 `PlaybackRuntime` 作为队列与播放状态唯一真相源。
- **双音乐源接入**：进程内集成 QQ 音乐 SDK（支持应用内扫码登录）与内置 `NeteaseCloudMusicApi` 服务（自动端口避让与故障降级），导入歌单并与「喜欢」本地意图 / 云端红心按源能力联动。
- **歌间串词与多种语音接入**：支持「只听歌 / 偶尔介绍 / 多聊一点」陪伴模式；接入 OpenAI 兼容、ElevenLabs 兼容、MiniMax、千问 TTS、豆包语音预设、助手辅助接入配方，以及知情确认开启的免费 Edge 朗读与主/备音色代读。
- **多层级本地记忆与生活手帐**：支持明确记住、忘记与适用范围控制、共享记忆审查与后台异步反思；提供「手帐」随笔、重复待办与重要日子。
- **三套视觉主题与桌面体验**：内置「时间线（默认）」「月色」「素色」三套离线字体与主题，支持切换不中断播放、全屏聆听、空格/系统媒体键、macOS 菜单栏状态/双色歌词以及 Windows 自绘无边框窗控与托盘控制。
- **可选公开联网查询（默认关闭）**：支持显式开启匿名免费公开网页搜索与文章抓取，带 DNS 固定、内网/元数据 SSRF 阻断与低信任工具隔离。
- **CLI 与桌面打包流水线**：提供 `bin/lunara.js` CLI 启动器（支持 `--data-dir` 与 `migrate` 数据迁移），以及 Apple Silicon macOS `.dmg` 与 Windows x64 `.exe` 构建与打包前随包 FFmpeg GPL-3.0 许可核查门禁。

### 安全性与隐私

- 全部聊天、记忆、手帐与配置均保存在本机（默认 `~/.lunara`），模型配置目录权限限制为 `0600`，会话跟踪目录限制为 `0700`。
- HTTP 服务默认仅监听 `127.0.0.1:8080`，校验 loopback `Host` 且不下发 CORS 响应头，避免跨站页面或 DNS rebinding 访问本地数据。
- 随包 macOS arm64 FFmpeg 已从含 `--enable-nonfree` 的原始包替换并锁定为可合法再分发的 GPL-3.0 静态构建（附 SHA-256 校验与许可门禁）。

### 已知限制与平台说明

- **首发桌面安装包**：本次 Release 提供通过自动化打包冒烟与清单审计的 Apple Silicon macOS `.dmg`（未做 Apple 发行签名与公证，首次打开需按 README 指引在系统设置确认）。
- **Windows 支持现状**：Windows 源码运行（`npm start` / `npm run start:web`）与跨平台单元测试已验证，GitHub Actions 已产出 x64 `.exe` 候选包，但干净 Windows 真机的 `.exe` 安装/卸载/SmartScreen 实机验收尚待完成后再上架 Release；另 Windows 暂不提供系统级本地语音回退，无云端/免费语音配置时只显示文字。
- **Intel Mac**：本次不提供 Intel Mac 预编译安装包。
