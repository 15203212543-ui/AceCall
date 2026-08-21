# AceCall 本地同步助手（第一版）

这是一个独立的 Node.js 本地守护进程。它只读取用户明确指定的目录，监听期间仅处理新出现的 PDF、DOC、DOCX、TXT、MD、RTF 文件，并在文件大小稳定后进行解析。启动时已存在的文件会建立为基线，不会自动导入。

## 启动

Node.js 18+：

```bash
npm run sync-agent -- --dir "/Users/你的用户名/Downloads"
```

Mac 默认目录是 `~/Downloads`；Windows 可以传入授权目录：

```powershell
npm run sync-agent -- --dir "C:\Users\你的用户名\Downloads"
```

默认每 5 分钟补偿扫描一次，文件系统事件会在页面之外尽快触发扫描。使用 `--once` 可执行一次扫描后退出，适合联调：

```bash
npm run sync-agent -- --once --dir "/tmp/acecall-resumes"
```

## 后端同步

不配置 `ACECALL_API_BASE` 时，助手只在本地解析文本并记录状态。接入本地 AceCall 服务时：

```bash
ACECALL_API_BASE="http://127.0.0.1:4173" npm run sync-agent -- --dir "/Users/你的用户名/Downloads"
```

接入 CloudBase 网关时，还需要提供当前用户会话令牌：

```bash
ACECALL_API_BASE="https://你的网关域名/acecall-api" \
ACECALL_AUTH_TOKEN="当前登录会话令牌" \
npm run sync-agent -- --dir "/Users/你的用户名/Downloads"
```

密码、DeepSeek Key 和 CloudBase 管理 API Key 不会被助手读取或保存。每个监听目录会生成权限为 `0600` 的 `.acecall-sync.json`，保存基线、去重记录和失败重试信息；不要将该文件提交到 Git。

网页关闭后，助手仍可继续运行；退出终端或发送 `Ctrl+C` 会停止监听。
