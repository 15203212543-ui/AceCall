# AceCall 桌面同步助手运行包

这是 AceCall 本地同步助手的运行包，不是已签名的 Mac `.app` 或 Windows `.exe` 安装程序。

- Mac：双击 `run-mac.command`
- Windows：在 PowerShell 中运行 `run-windows.ps1`
- 需要 Node.js 18+
- 首次运行会安装依赖
- 默认只读取用户主动使用的目录

在线 CloudBase 同步需要配置 `ACECALL_API_BASE` 和当前登录会话令牌；具体配置方式见项目中的 `local-sync-agent/README.md`。
