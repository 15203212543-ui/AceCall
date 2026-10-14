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

Mac 首次录音授权：打开“系统设置 → 隐私与安全性 → 麦克风”，打开 `AceCall Sync` 的权限；如果是通过终端运行 Electron，则允许实际显示在列表中的终端应用。修改权限后完全退出并重新启动 AceCall Sync，再点击“开始录音”。

## 构建安装包

```bash
# 在 macOS 上构建 .dmg
npm run dist:mac

# 在 Windows 上构建 .exe 安装程序
npm run dist:win
```

Mac 和 Windows 安装包应在对应系统上构建并签名。首次正式发布前还需要配置 Apple Developer / Windows 代码签名证书、应用图标和自动更新地址。AceCall 网页登录成功后会把短期会话令牌交给本机助手，助手只保存在内存中，不保存账号密码、长期密钥或 CloudBase 管理凭证。

## Mac 用户安装

从 AceCall 简历中心下载 `AceCall-Sync-Mac.dmg`，打开后将 `AceCall Sync` 拖入“应用程序”，再从“应用程序”启动。当前发布包未使用 Apple Developer 证书签名，首次打开若出现安全提示，请在“系统设置 → 隐私与安全性”中选择“仍要打开”。

首次点击网页中的“开始录音”时，macOS 会请求麦克风权限。若没有弹窗，前往“系统设置 → 隐私与安全性 → 麦克风”，打开 `AceCall Sync`，然后完全退出并重新启动桌面助手。
