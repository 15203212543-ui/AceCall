$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "请先安装 Node.js 18 或更高版本：https://nodejs.org/"
  Read-Host "按回车退出"
  exit 1
}
npm install
$watchDir = Read-Host "请输入要监听的文件夹路径"
npm run sync-agent -- --dir $watchDir
