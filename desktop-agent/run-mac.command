#!/bin/zsh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 18 或更高版本：https://nodejs.org/"
  read -r "?按回车退出..."
  exit 1
fi
npm install
npm run sync-agent -- --dir "$HOME/Downloads"
