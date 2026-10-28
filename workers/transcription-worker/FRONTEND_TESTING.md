# 前端实际操作测试指南

本文说明如何在浏览器里真实操作、测试「录音 → 转写 → 写入电话记录」这条链路。

---

## 先理解：前端录音的数据流

看 `public/app-v2.js` 的 `transcribeRecording()`（约 1476 行）可以确认，前端并不把音频发给后端，而是：

```
浏览器录音（MediaRecorder）
  → 8MB 分片
  → cloudbaseClient.uploadFile()  ← CloudBase Web SDK 直传对象存储
  → POST /api/recordings/{id}/parts/complete   登记分片
  → POST /api/transcription-tasks              入队
  → 每 3 秒 GET /api/transcription-tasks/{id}  轮询
  → status=completed 时，把 result.text 写进「电话记录」文本框
```

由此得出两个硬性前提：

1. **必须有 CloudBase 的 `env` 和 `publishableKey`**（`public/config.js`）。否则第 1483 行直接抛「CloudBase存储未初始化」。
2. **必须有 worker 在跑**，否则任务停在 `queued`，前端一直显示「排队等待转写服务」。

所以「纯本地 mock 后端」这条路走不通——录音上传那一步绕过了后端，直接连 CloudBase。这点和普通 CRUD 不同。

---

## 路径 A：现在就能测（走生产环境，验证前端交互）

**能验证**：录音权限、录音、分片上传、任务入队、状态轮询、转写文字回填、「完成电话并生成结果」后续流程。
**不能验证**：新的 faster-whisper 引擎（生产上跑的还是旧的百度引擎）。

### 步骤

1. 打开 https://15203212543-ui.github.io/AceCall/ ，用现有账号登录。
2. 进「候选人」→ 随便打开一个候选人 → 切到「**电话初筛**」页签。
3. 确认页面顶部有「开始录音」按钮。点击后浏览器会请求麦克风权限，允许。
4. 说 10~20 秒话（比如念一段简历内容），点「**停止录音**」。
5. 观察状态文字的变化：

   | 显示 | 含义 |
   |---|---|
   | 正在创建录音任务… | 调 `/api/recordings/init` |
   | 正在上传录音 45% | 分片直传 CloudBase |
   | 已上传，等待异步转写服务处理 | 已入队 |
   | 排队等待转写服务 | worker 还没取任务（正常，最多 15 秒） |
   | 转写处理中（transcribing） | worker 正在转 |
   | 已完成转写 N 字 | 成功，文字已写进下方文本框 |

6. 成功后「电话记录」文本框里会出现转写文字。勾选「已完成录音或转写告知」，点「完成电话并生成结果」，验证后续 AI 总结是否正常。

### 注意事项

- **必须用 HTTPS 或 localhost**。麦克风 API 只在安全上下文可用，`http://` 内网 IP 不行。Pages 是 https，满足。
- 如果卡在「排队等待转写服务」超过 2 分钟，说明生产 worker 没在跑或没配好，这不是你代码的问题。
- 录音文件会留在 CloudBase 存储和 `acecall_transcription_tasks` 里，测试完可以清理。

---

## 路径 B：验证新的 faster-whisper 引擎（需要部署）

要让前端走新的转写引擎，必须让**云端 worker 用上新代码并指向新的 ASR 服务**。前端代码完全不用改。

### 需要的资源

| 资源 | 用途 | 说明 |
|---|---|---|
| 一台能跑容器的服务器 | 部署 ASR 服务 | 有 GPU 最好；CPU 也能跑，但要小模型且慢 |
| CloudRun / 容器服务权限 | 重新部署 worker | 现在 worker 就跑在这类环境 |
| `TCB_ENV` + `CLOUDBASE_APIKEY` | worker 连 CloudBase | 管理端 API Key，**注意 2026-11-16 到期** |

### 部署步骤

**1. 部署 ASR 服务**

```bash
# 在 GPU 服务器上
git clone https://github.com/15203212543-ui/AceCall.git
cd AceCall/workers/faster-whisper-service

docker build -f Dockerfile.gpu -t acecall-asr:gpu .

docker run -d --gpus all --restart unless-stopped \
  -p 9001:9001 \
  -v acecall-models:/models \
  -e ACECALL_ASR_HOTWORDS="CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,适当性,拆合股" \
  acecall-asr:gpu
```

验证：

```bash
curl http://<服务器IP>:9001/health
# 期望 detail.ready = true，detail.backend = faster-whisper
```

> 没有 GPU 就用默认 `Dockerfile`，并把 `WHISPER_MODEL_SIZE` 降到 `small` 或 `medium`、`WHISPER_COMPUTE_TYPE=int8`。1 小时音频在 CPU 上可能要跑 1~3 小时，只适合验证功能。

**2. 重新部署 worker**

在 CloudRun 上用 `workers/transcription-worker/` 构建镜像，环境变量加这几项：

```env
TCB_ENV=<环境ID>
CLOUDBASE_APIKEY=<管理端 Key>
TRANSCRIPTION_PROVIDER=whisper
WHISPER_API_URL=http://<ASR服务器IP>:9001/v1/audio/transcriptions
WHISPER_LANGUAGE=zh
WHISPER_TIMEOUT_MS=2700000
ACECALL_ASR_HOTWORDS=CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权
WORKER_INTERVAL_MS=3000
```

注意：

- worker 容器要能访问 ASR 服务器。如果都在腾讯云，优先走**内网地址**，别暴露公网。
- 若两者不通，而录音又比较短，可以设 `WHISPER_UPLOAD_MODE=file` 让 worker 直接把音频 multipart 发给 ASR（受 Cloud Run 32MB 请求体上限约束，长录音会失败）。
- `WHISPER_API_KEY` 只在 ASR 前面加了鉴权代理时才需要。

**3. 验证 worker 生效**

```bash
curl http://<worker地址>/health
# 期望 provider=whisper
```

**4. 回到前端测试**

和路径 A 的步骤完全一样。区别在于这次转写是由 faster-whisper 完成的。

### 怎么确认走的是新引擎

前端界面不显示引擎名，用这三种方式确认：

1. **查任务记录**：`acecall_transcription_tasks` 里该任务的 `engine` 字段应为 `whisper`。
2. **看 worker 日志**：每次转写会打印 `transcribing source=audio_url bytes=... language=zh`。
3. **看 ASR 服务日志**：`transcribed characters=... duration=... elapsed=...s`。

---

## 路径 C：不碰浏览器，本地验证引擎效果（已就绪）

如果只想确认识别质量，跳过整个前端：

```bash
# 终端 1：ASR 服务
cd workers/faster-whisper-service
ASR_BACKEND=fake uvicorn server:app --port 9001          # 验契约
# 或真实模型：
WHISPER_MODEL_SIZE=large-v3 WHISPER_DEVICE=cuda WHISPER_COMPUTE_TYPE=float16 \
  uvicorn server:app --port 9001

# 终端 2：跑完整链路
cd workers/transcription-worker
WHISPER_API_URL=http://127.0.0.1:9001/v1/audio/transcriptions \
  node tools/offline-e2e.js 你的通话录音.m4a
```

输出会打印切段策略、转写次数、时间轴、文本。详见 `TESTING.md`。

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 点录音没反应 | 非 HTTPS/localhost，或麦克风权限被拒 | 换 Pages 地址，检查浏览器地址栏权限图标 |
| 「CloudBase存储未初始化」 | `config.js` 缺 `publishableKey`，或未登录 | 重新登录 |
| 一直「排队等待转写服务」 | worker 没跑 / 没配环境变量 | 查 worker 的 `/health` 和日志 |
| 「转写失败：…」带 5xx | ASR 服务不可达或超时 | 查 ASR `/health`，查 worker 到 ASR 的网络 |
| 转写成功但没有说话人 | Whisper 不做 diarization | 已知限制，面试官分析仍走转写文件导入 |
| 长录音失败 | 没配切段，或 ASR 侧 32MB 限制 | 确认 `TRANSCRIPTION_AUTO_SEGMENT_SECONDS=900`，并走 `audio_url` 模式 |

### 分片登记返回 500「服务暂时不可用」

已在本次修复，但**必须重新部署云函数才会生效**（见下面「部署清单」）。

原因是 CloudBase 的 `document.set()` 拒绝含 `_id` 的写入（`INVALID_PARAM 不能更新_id的值`），
而 `set({ ...task })` 把从数据库读出来的 `_id` 又原样写了回去。该错误不带 `statusCode`，
被统一转成 500，所以界面上只看到「服务暂时不可用」，看不出真实原因。

受影响的不止分片登记：`createTranscriptionTask`、`analyzeTranscriptionTask`、
成员 / 工作区更新、Moka 岗位同步，以及 **worker 的 `claimTask` / `updateTask`**。
最后两处意味着即使分片上传成功，转写状态也永远写不回数据库。

### 接口返回 443「Unknown」，响应体为空

**这不是后端故障，是网关拒绝了请求携带的登录凭据。** 443 不是标准 HTTP 状态码，
Chrome 会显示成 `status of 443 (Unknown)`，很容易被误判成「服务挂了」。

实测特征（可用来确认是这一类问题）：

```
HTTP/1.1 443 Unknown
content-length: 0                     ← 响应体完全为空
server: tcbgw
x-cloudbase-upstream-status-code: 443
```

判别方法（一条命令即可复现）：

```bash
KEY=$(curl -s https://15203212543-ui.github.io/AceCall/config.js | grep -o "publishableKey: '[^']*'" | sed "s/publishableKey: '//;s/'$//")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" \
  "https://yuxiaomiaochongwu-d2dsk55ef4b392-1382810550.ap-shanghai.app.tcloudbase.com/acecall-api-v2/api/health"
# 输出 443 即证实：匿名凭据被网关拒绝
```

原因：`publishableKey` 是**匿名凭据**（JWT 里 `scope: anonymous`），而 `acecall-api-v2`
这条路由开启了网关「身份认证」，匿名 token 过不去。

常见触发场景：**登录会话过期后，前端拿到的是 CloudBase 自动生成的匿名会话**，
于是所有接口一起 443。此时重新登录即可恢复。

注意区分两种网关拒绝：

| 状态码 | 响应体 | 含义 |
|---|---|---|
| 401 | `{"code":"INVALID_CREDENTIALS"}` | token 格式非法 |
| **443** | **空** | token 合法但**身份不被接受**（典型是匿名身份） |

前端已做的防护：`initializeAuth` 会识别匿名会话并直接要求登录；
`authenticatedFetch` 遇到 443 会先尝试刷新会话，失败则提示「登录凭据已失效，请退出后重新登录」。

### 所有接口一起 404「Not found」

**先检查 `public/config.js` 的 `apiBaseUrl` 用的是哪条路由。**

同一个环境里有两个 HTTP 函数，代码完全相同（`cloudbaserc.json` 里 `dir` 都指向
`acecall-api`），但**网关的路由配置不一样**：

| 路由 | 行为 |
|---|---|
| `.../acecall-api-v2` | 透传子路径，`/api/state` 能正确到达函数 ✅ |
| `.../acecall-api` | **不透传子路径**，函数收到的路径是 `/`，所有接口一律 404 ❌ |

判断方法：如果响应体是函数自己的 `{"error":"Not found","route":"unmatched"}`，
说明请求到了函数、只是路径没匹配（而非网关 404）。此时看响应里的 `path` 字段，
若是 `/` 就证实了网关没透传。

修复只需把 `apiBaseUrl` 指回 `acecall-api-v2`。**注意这只影响路由，与部署代码无关**，
重新部署 `acecall-api` 也改变不了这个行为。

修复方式是统一用 `persistable()` 剥掉 `_id` / `_openid`，并加了静态检查防止回退。
部署后如果仍报 500，把响应里的 `code` 字段发出来——现在错误提示和云函数日志都会带上它。

---

## 部署清单（改完代码必须做，否则前端仍会失败）

代码推到 `main` **不等于**线上生效。这条链路上有两个独立部署物：

| 部署物 | 什么时候要重新部署 | 怎么部署 |
|---|---|---|
| 前端静态文件 | 改了 `public/` 下任何文件 | 推 `main` 后 GitHub Actions 自动部署（约 1 分钟） |
| **云函数 `acecall-api` / `acecall-api-v2`** | **改了 `cloudfunctions/acecall-api/` 任何文件** | 需手动部署，见下 |
| **worker 容器** | 改了 `workers/transcription-worker/` 任何文件 | 需手动重新构建部署 |
| ASR 服务 | 改了 `workers/faster-whisper-service/` | 需手动重新构建部署 |

云函数部署（需已安装并登录 CloudBase CLI）：

```bash
# 在仓库根目录执行；cloudbaserc.json 已声明 envId 和两个函数，无需重复指定
tcb login
tcb fn deploy acecall-api --force
tcb fn deploy acecall-api-v2 --force
```

两个函数用的是同一份代码（`dir` 都指向 `acecall-api`），`acecall-api-v2` 是前端 `config.js` 实际调用的那个，**不要只部署其中一个**。

判断云函数是否已更新：调用一个会写库的接口，如果还返回 500 且 `code` 为空，说明跑的还是旧代码。

---

## 建议的测试顺序

1. **路径 C**（5 分钟）：先确认引擎本身能出中文文字、术语对不对。
2. **路径 A**（10 分钟）：在 Pages 上点一次录音，确认前端交互没坏、生产链路正常。
3. **路径 B**（需要部署）：让云端 worker 指向新 ASR，再按路径 A 重测一遍，这次走的是新引擎。

先做 1 和 2，能立刻排除「引擎不行」和「前端坏了」两种可能，再决定要不要投入第 3 步的部署。
