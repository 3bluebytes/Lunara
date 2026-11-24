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

# 2) .env（可选；LLM、语音、音乐账号均可在应用内设置）
if [ ! -f .env ]; then
  cp .env.example .env
  yellow "⚠ 已生成 .env（可保持默认；高级环境变量覆盖可按需编辑）"
else
  green "✓ .env 已存在"
fi

# 3) npm 依赖
green "▶ npm install"
npm install

# 4) 音乐源均随应用启动。
green "✓ QQ 音乐 SDK 与网易云 API 已随依赖安装（无需单独启动）"

# 5) 目录
mkdir -p cache/tts data
touch cache/tts/.gitkeep data/.gitkeep

green ""
green "✅ 安装完成。直接启动 Lunara："
green "   npm start"
green "   首次启动在设置中填写 LLM Base URL / API Key / Model"
