# 随包音频工具的许可证说明（ffmpeg / ffprobe）

Lunara 桌面安装包（macOS `.dmg` / Windows `.exe`）通过 npm 包
[`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) 与
[`ffprobe-static`](https://github.com/SavageCore/ffprobe-static) 随包分发
预编译的 ffmpeg / ffprobe 可执行文件，用于下载音频的媒体校验（时长与可解码性）
和曲目音频指纹。

## 许可归属

- 这些二进制是 **FFmpeg 项目**的构建产物，按 **GPL-3.0**（含 `--enable-gpl --enable-version3` 构建选项）授权。
- FFmpeg 源码：<https://ffmpeg.org/download.html>；对应构建来源见上述两个 npm 包的仓库说明。
- GPL-3.0 许可证全文见本目录 `GPL-3.0.txt`，或 <https://www.gnu.org/licenses/gpl-3.0.txt>。

## 与 Lunara 许可的关系

Lunara 应用本体以独立进程（`execFile`）方式调用上述二进制，二者不链接为同一程序；
这一聚合方式下，GPL-3.0 义务随 ffmpeg/ffprobe 二进制本身履行（附带许可证与源获取途径），
**不传染 Lunara 应用本体的 MIT 许可**。变更构建来源（例如改用 LGPL 构建）时，
必须同步更新本说明与构建脚本。
