# 转写 worker 部署指南

## 为什么必须部署

云函数只负责「登记分片 → 标记任务为 `queued`」。真正的转写由 `workers/transcription-worker`
异步消费 `acecall_transcription_tasks` 里 `queued` 的任务。

**没有 worker 的结果**：前端一直显示「排队等待转写服务」，永远不出文字。

**worker 是旧版本的结果**：它的 `claimTask` / `updateTask` 会把 `_id` 写回数据库被 CloudBase
拒绝，任务连认领都失败，同样一直卡在 `queued`。所以**改了 worker 代码一定要重新部署**。

---

## 部署前先做一次 30 秒验证

云函数已部署新代码后，**先重试一次录音，不用等 worker**。这一步单独验证 `_id` 修复：

| 现象 | 说明 |
|---|---|
| 仍报 500「服务暂时不可用（INVALID_PARAM）」 | 云函数还是旧代码，重新部署 |
| 仍报 500 但没有 `code` | 云函数肯定没更新 |
| 变成「已上传，等待异步转写服务处理」然后停在「排队等待转写服务」 | ✅ **`_id` 修复已生效**，接下来只是缺 worker |

看到第三种就说明后端修好了，部署 worker 即可打通。

---

## 部署方式

worker 是一个常驻容器，要求：

- 监听 `PORT` 环境变量（默认 9000），提供 `GET /health`
- 内置 `ffmpeg` / `ffprobe`（`Dockerfile` 里已装）
- 能访问 CloudBase 数据库与存储（出网即可，走公网 API）
- 能访问所选 ASR 引擎

`workers/transcription-worker/Dockerfile` 已满足这些条件，直接构建即可：

```bash
cd workers/transcription-worker
docker build -t acecall-transcription-worker .
docker run -p 9000:9000 --env-file .env acecall-transcription-worker
```

### 推荐：CloudBase 云托管（CloudBase Run）

和现有云函数同一个环境，网络与权限模型最省事。控制台路径：

云开发控制台 → 云托管 → 新建服务 → 选择「本地代码 / 镜像」→ 上传 `workers/transcription-worker`
→ 端口填 `9000` → 配置下面的环境变量 → 部署。

CLI 方式（先 `tcb login`，具体参数以 `tcb run deploy --help` 为准）：

```bash
cd workers/transcription-worker
tcb run deploy --name acecall-transcription-worker --path .
```

**注意**：worker 是常驻轮询进程，要保证实例数至少 1 且不被缩容到 0，否则没人消费队列。
如果平台支持，配置最小实例数 = 1。

### 备选：任意容器平台

CloudRun、ECS + Docker、K8s 均可。只要满足上面四条要求。此时 ASR 服务如果用内网地址会更快。

---

## 环境变量

必填：

| 变量 | 值 |
|---|---|
| `TCB_ENV` | `yuxiaomiaochongwu-d2dsk55ef4b392` |
| `CLOUDBASE_SECRET_ID` | 腾讯云 API 密钥 ID（`AKID` 开头） |
| `CLOUDBASE_SECRET_KEY` | 腾讯云 API 密钥 Key |
| `TRANSCRIPTION_PROVIDER` | `baidu` 或 `whisper` |
| `WORKER_INTERVAL_MS` | `3000` |

> **注意：不要用 `CLOUDBASE_APIKEY`。** `@cloudbase/node-sdk` 的配置类型里没有
> `accessKey` 字段，只认 `secretId` / `secretKey`。云函数写 `accessKey` 能用是因为
> 它跑在 CloudBase 内部、SDK 会自动读平台注入的临时凭证；worker 是外部进程，
> 只传 `CLOUDBASE_APIKEY` 会报
> `missing secretId or secretKey of tencent cloud`，且每条数据库请求都会失败。
>
> 密钥位置：腾讯云控制台 → 右上角头像 → 访问管理 → API 密钥管理。
> 也兼容腾讯云官方变量名 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`。

### 选 baidu 时

```env
TRANSCRIPTION_PROVIDER=baidu
BAIDU_API_KEY=...
BAIDU_SECRET_KEY=...
```

百度长音频识别需要公网可访问的音频 URL，worker 会自动把切片上传到 CloudBase 存储并取临时链接，
无需额外配置。**这是最少改动、最快能跑通的方式**，前提是已有百度语音的 Key。

### 选 whisper 时

```env
TRANSCRIPTION_PROVIDER=whisper
WHISPER_API_URL=http://<asr-host>:9001/v1/audio/transcriptions
WHISPER_LANGUAGE=zh
WHISPER_TIMEOUT_MS=2700000
ACECALL_ASR_HOTWORDS=CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,适当性
```

需要先按 `workers/faster-whisper-service/README.md` 把 ASR 服务部署起来。

如果 worker 和 ASR 不在同一内网、且录音都比较短，可以加 `WHISPER_UPLOAD_MODE=file`
（受 Cloud Run 32MB 请求体限制，长录音会失败，不建议）。

### 长录音相关（有默认值，通常不用改）

```env
TRANSCRIPTION_AUTO_SEGMENT_SECONDS=900        # 超过 15 分钟自动切段
TRANSCRIPTION_AUTO_SEGMENT_BYTES=33554432     # 时长探测失败时按 32MB 兜底切段
TRANSCRIPTION_MAX_SOURCE_BYTES=1073741824     # 合并上限 1GB
```

---

## 部署后怎么确认成功

1. **看 worker 日志**，启动应打印：
   ```
   [AceCall transcription worker] started on port 9000; provider=xxx; autoSegment=900s
   ```
2. **访问 `/health`**：
   ```bash
   curl http://<worker地址>/health
   # {"ok":true,"service":"acecall-transcription-worker","provider":"baidu","autoSegmentSeconds":900,"busy":false}
   ```
   期望 `provider` 和你配的一致。
3. **前端再录一次音**，状态应依次走完：
   `正在创建录音任务` → `正在上传录音 xx%` → `已上传，等待异步转写服务处理` →
   `排队等待转写服务`（最多 15 秒）→ `转写处理中（transcribing）` → `已完成转写 N 字`
4. **确认引擎**：`acecall_transcription_tasks` 里该任务的 `engine` 字段应为 `baidu` 或 `whisper`，
   `status` 为 `completed`，`result.text` 有内容。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `/health` 打不开 | 端口没配对，或实例未启动 | 确认容器监听 `PORT`，平台端口填 9000 |
| 日志报「缺少 CloudBase 密钥：请设置 CLOUDBASE_SECRET_ID 与 CLOUDBASE_SECRET_KEY」 | 环境变量没注入，或只注入了 `CLOUDBASE_APIKEY` | 补齐 SecretId / SecretKey 后重启 |
| 日志报「任务 engines=baidu，按本机配置改用 whisper」 | 正常提示，不是错误 | 说明 worker 用自身配置覆盖了任务里的旧 engine |
| 任务一直 `queued` | worker 没跑 / 实例被缩容到 0 / `status` 查询失败 | 看日志，确认常驻 |
| 任务变 `failed`，error 含「分片下载失败」 | CloudBase 临时链接获取失败 | 检查 API Key 是否有存储读权限 |
| 任务变 `failed`，error 含「ASR 服务未返回有效文字」类 | ASR 侧问题 | 直接请求 ASR `/health` 和 `/v1/audio/transcriptions` 单独验证 |
| 任务变 `failed`，error 含「不能更新_id的值」 | 跑的还是旧 worker 代码 | 重新构建镜像，别只重启 |
| 转写成功但没有说话人 | Whisper 不做 diarization | 已知限制，面试官分析仍走转写文件导入 |

## 关于密钥安全

- `CLOUDBASE_SECRET_ID`、`CLOUDBASE_SECRET_KEY`、`BAIDU_SECRET_KEY`、`WHISPER_API_KEY` 只放平台环境变量，不要写进镜像、不要提交 Git。
- 如果要把密钥交给别人代为部署，优先用平台自己的「密钥 / 凭据」管理，用完及时轮换。
