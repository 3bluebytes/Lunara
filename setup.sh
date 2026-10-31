#!/usr/bin/env bash
# Lunara setup — 一次性安装项目依赖
# 用法: bash setup.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }

green "▶ Lunara setup"

# 1) Node 版本检查
NODE_MAJ=$(node -v 2>/dev/null | sed -E 's/v([0-9]+)\..*/\1/')
if [ -z "$NODE_MAJ" ] || [ "$NODE_MAJ" -lt 20 ]; then
  red "需要 Node ≥ 20，当前: $(node -v 2>/dev/null || echo 'not found')"
  exit 1
fi
green "✓ Node $(node -v)"

# 2) .env（TTS / 音乐源；DJ LLM 在启动浮层单独配置）
if [ ! -f .env ]; then
  cp .env.example .env
  yellow "⚠ 已生成 .env；如需云端音色，请填写 MINIMAX_API_KEY，并按需设置经纬度"
else
  green "✓ .env 已存在"
fi

# 3) npm 依赖
green "▶ npm install"
npm install

# 4) 音乐源均由 package.json 安装；QQ SDK 直接嵌入 Lunara。
green "✓ NeteaseCloudMusicApi 已随 npm dependencies 安装"
green "✓ QQ Music SDK 已随 npm dependencies 安装（无需单独启动）"

# 5) 目录
mkdir -p cache/tts data
touch cache/tts/.gitkeep data/.gitkeep

green ""
green "✅ 安装完成。QQ 音乐已内置；按需启动网易云，再启动 Lunara："
green "   1)  npm run ncm        # 网易云 API（默认 :3000，可选）"
green "   2)  npm start          # Lunara 本体（默认 :8080，内置 QQ）"
green "       首次启动在设置浮层填写 LLM Base URL / API Key / Model"
green ""
green "   浏览器开 http://localhost:8080"
