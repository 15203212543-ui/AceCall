# AceCall Sync Desktop

正式桌面应用工程，基于 Electron。安装后默认以后台服务运行，自动监听 Downloads 并提供本机录音接口；AceCall 网页负责控制录音、显示状态和提交转写任务。核心简历监听逻辑复用 `local-sync-agent`。

## 本机开发

```bash
cd desktop-app
npm install
npm start
```

后台模式：

```bash
npm start -- --background
```

后台服务默认监听 `127.0.0.1:17890`。网页通过 `/status`、`/recording/start` 和 `/recording/stop` 控制录音；首次使用仍需要操作系统麦克风授权。录音文件会先按 10 秒分片写入应用本地目录，停止后由 AceCall 网页提交到 CloudBase 转写任务。

## 构建安装包

```bash
# 在 macOS 上构建 .dmg
npm run dist:mac

# 在 Windows 上构建 .exe 安装程序
npm run dist:win
```

Mac 和 Windows 安装包应在对应系统上构建并签名。首次正式发布前还需要配置 Apple Developer / Windows 代码签名证书、应用图标、自动更新地址以及安全的 CloudBase 登录授权流程。当前应用通过环境变量读取 `ACECALL_API_BASE` 和 `ACECALL_AUTH_TOKEN`，不会保存账号密码或管理密钥。
