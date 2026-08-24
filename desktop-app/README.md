# AceCall Sync Desktop

正式桌面应用工程，基于 Electron，提供窗口、托盘、目录选择和启动/暂停同步能力。核心监听逻辑复用 `local-sync-agent`。

## 本机开发

```bash
cd desktop-app
npm install
npm start
```

## 构建安装包

```bash
# 在 macOS 上构建 .dmg
npm run dist:mac

# 在 Windows 上构建 .exe 安装程序
npm run dist:win
```

Mac 和 Windows 安装包应在对应系统上构建并签名。首次正式发布前还需要配置 Apple Developer / Windows 代码签名证书、应用图标、自动更新地址以及安全的 CloudBase 登录授权流程。当前应用通过环境变量读取 `ACECALL_API_BASE` 和 `ACECALL_AUTH_TOKEN`，不会保存账号密码或管理密钥。
