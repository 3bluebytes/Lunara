# 第三方声明与开源许可汇总

**Lunara · Luna Radio** 本体源码基于 [MIT 协议](LICENSE) 开源发布。本仓库源码、桌面安装包及发行资产中还包含或引用了以下第三方开源组件、字体、媒体工具与公共领域素材，特此一并说明并保留其版权与许可声明。

---

## 1. 随桌面安装包分发的独立可执行程序

### FFmpeg（GPL-3.0-or-later）

Lunara 桌面安装包在构建时将预编译的 `ffmpeg` 独立二进制放入 `app.asar.unpacked/node_modules/ffmpeg-static/`，仅通过子进程（`execFile`）用于音频文件完整性解码校验与轻量指纹计算，不与 Lunara 主程序链接。在此聚合调用方式下，Lunara 主程序保持 MIT 许可，FFmpeg 二进制本身受 GNU General Public License v3.0 或更高版本保护。

- 详细来源、固定版本、SHA-256 校验及对应源码获取方式见 [build/licenses/README-ffmpeg.md](build/licenses/README-ffmpeg.md)。
- GPL-3.0 许可证全文见 [build/licenses/GPL-3.0.txt](build/licenses/GPL-3.0.txt)。

---

## 2. 内置视觉与字体资产

### 离线字体（SIL Open Font License 1.1）

界面多主题离线打包了以下字体及子集（来自 Google Fonts，遵循 SIL OFL 1.1）：

- **Figtree**（[LICENSE-figtree.txt](pwa/assets/fonts/LICENSE-figtree.txt)）
- **Geist Mono**（[LICENSE-geistmono.txt](pwa/assets/fonts/LICENSE-geistmono.txt)）
- **Instrument Serif**（[LICENSE-instrumentserif.txt](pwa/assets/fonts/LICENSE-instrumentserif.txt)）
- **Noto Serif SC**（[LICENSE-notoserifsc.txt](pwa/assets/fonts/LICENSE-notoserifsc.txt)）
- **Noto Sans SC**（[LICENSE-notosanssc.txt](pwa/assets/fonts/LICENSE-notosanssc.txt)）
- **Newsreader**（[LICENSE-newsreader.txt](pwa/assets/fonts/LICENSE-newsreader.txt)）
- **Bodoni Moda**（[LICENSE-bodonimoda.txt](pwa/assets/fonts/LICENSE-bodonimoda.txt)）

字体处理说明详见 [pwa/assets/fonts/README.md](pwa/assets/fonts/README.md)。

### 公共领域图像资产

- `pwa/assets/starry-night.jpg`：Vincent van Gogh *The Starry Night* (1889) 的公共领域数字复制品（来源 Wikimedia Commons，详见 [pwa/assets/README.md](pwa/assets/README.md)）。

---

## 3. 协议参考与主要开源依赖

### 公开联网查询参考（MIT）

- `server/web-access/` 参考了 `pi-web-access@0.44.0`（Copyright (c) 2025 Nico Bailon, MIT）的 Exa / degoog 与 SSRF 防护协议约定。完整版权声明见 [server/web-access/THIRD_PARTY_NOTICES.md](server/web-access/THIRD_PARTY_NOTICES.md)。

### 主要直接 npm 依赖

| 包名 | 许可证 | 用途 |
|---|---|---|
| `express` | MIT | 本地 HTTP 服务与路由 |
| `ws` | MIT | 本地实时状态同步 WebSocket |
| `better-sqlite3` | MIT | 本地 SQLite 状态、记忆与手帐存储 |
| `dotenv` | BSD-2-Clause | `.env` 环境变量加载 |
| `node-cron` | ISC | 本地作息与定时维护任务 |
| `@sansenjian/qq-music-api` | MIT | QQ 音乐非官方接口适配 |
| `@jixun/qmweb-sign` | MIT | QQ 音乐请求签名辅助 |
| `NeteaseCloudMusicApi` | MIT | 网易云音乐非官方接口服务 |
| `@mozilla/readability` | Apache-2.0 | 联网开启时的离线正文提取 |
| `linkedom` | ISC | 联网正文提取的惰性 DOM 解析 |
| `ipaddr.js` | MIT | 联网 SSRF 私网/保留地址段拦截 |
| `ffmpeg-static` | GPL-3.0-or-later | 随包 FFmpeg 路径入口（macOS arm64 已在打包前替换为合规 GPL-3.0 构建） |
| `@huggingface/transformers`（可选） | Apache-2.0 | 可选本地语义记忆召回 |
| `electron`（开发/桌面壳） | MIT | 桌面窗口与系统托盘运行时 |

所有直接与传递依赖的完整许可与来源版本均记录于 `package-lock.json` 及 `node_modules` 对应包内。
