# 随包音频工具的许可证说明（FFmpeg）

Lunara 桌面安装包在构建时会将预编译的 `ffmpeg` 独立可执行文件放入
`app.asar.unpacked/node_modules/ffmpeg-static/`，用于下载音频的媒体校验（可解码性、容器格式与时长）和曲目音频指纹。

## 实际随包二进制核查记录

1. **macOS Apple Silicon (`darwin-arm64`)**
   - 说明：`ffmpeg-static@5.3.0` (`b6.1.1`) 默认下载的 `darwin-arm64` 二进制含 `--enable-nonfree`（不可再分发）。
   - 因此桌面打包脚本（`scripts/prepare-ffmpeg.mjs`）会在打包前校验 SHA-256，将其替换为来自 Martin Riedl 构建服务器的 GPL-3.0 静态构建：
     - FFmpeg 版本：`9.1`（`https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1/ffmpeg.zip`）
     - 归档 SHA-256：`1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1`
     - 许可：`GPL-3.0-or-later`（实测 `ffmpeg -L` 为 GPL-3.0，不含 `nonfree`）
     - 构建脚本与对应配置源码：<https://git.martin-riedl.de/ffmpeg/build-script>；FFmpeg 上游源码：<https://ffmpeg.org/download.html>

2. **Windows x64 (`win32-x64`)**
   - 来源：`ffmpeg-static@5.3.0`（release tag `b6.1.1`，上游构建来自 `www.gyan.dev` `6.1.1-essentials_build`）
   - 许可：`GPL-3.0`（`essentials` 构建不含 `nonfree`；打包前由 `scripts/prepare-ffmpeg.mjs` 强制核查 `ffmpeg -L`）
   - 上游 FFmpeg 源码基准：<https://github.com/FFmpeg/FFmpeg/commit/e38092ef93> 与 <https://ffmpeg.org/download.html>

## 打包门禁与许可边界

- `scripts/prepare-ffmpeg.mjs` 与 `scripts/smoke-packaged-app.mjs` 均在发布前执行 `ffmpeg -L` 检查：一旦输出包含 `nonfree` 或 `not legally redistributable`，立即中止打包或判冒烟失败。
- Lunara 应用本体以独立进程（`execFile`）方式调用 `ffmpeg`，二者不链接为同一程序；在这一聚合方式下，Lunara 应用本体仍按 MIT 发布，FFmpeg 二进制本身遵循 **GPL-3.0**（全文见本目录 `GPL-3.0.txt`）。
- 更换 FFmpeg 构建来源时，须同步更新本说明、SHA-256 校验值与随包许可文本。
