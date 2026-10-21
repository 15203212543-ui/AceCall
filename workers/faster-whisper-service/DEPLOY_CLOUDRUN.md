# 云托管部署命令（faster-whisper 方案）

按顺序执行。每步都有验证方法，**上一步没验证通过不要进入下一步**。

目标架构：

```
前端 Pages ──→ 云函数 acecall-api-v2 ──→ acecall_transcription_tasks (queued)
                                              ↑ 轮询
                                     worker（云托管，常驻）──→ ASR 服务（云托管）
```

---

## 0. 前置：安装并登录 CLI

```bash
npm install -g @cloudbase/cli
tcb login                # 会打开浏览器授权
tcb env list             # 确认能看到 yuxiaomiaochongwu-d2dsk55ef4b392
```

环境 ID：`yuxiaomiaochongwu-d2dsk55ef4b392`

> 全程用命令行部署可以，但**环境变量和 CPU/内存规格需要在控制台设置**——`tcb cloudrun deploy`
> 没有提供这两项参数。所以后面会有控制台步骤。

---

## 1. 先决定模型规格（关键取舍）

云托管容器默认资源很小，Whisper 是吃 CPU 的。先按用途选：

| 场景 | 模型 | 资源 | 1 小时音频耗时（约） |
|---|---|---|---|
| 先跑通链路 / 短录音试听 | `small` + int8 + CPU | 2 核 4GB | 20~40 分钟 |
| 日常使用（可接受） | `medium` + int8 + CPU | 4 核 8GB | 40~80 分钟 |
| 正式生产 | `large-v3` + float16 + **GPU** | 需 GPU 实例 | 2~5 分钟 |

**首次部署建议 `small`**：先把「上传→转写→回填」整条链路验证通，再看要不要升级。
`large-v3` 在 CPU 上大约是实时的 0.2 倍速，两小时通话要跑十小时，不可接受。

> 如果云托管环境没有 GPU 实例可选，那生产环境就只能用 `small`/`medium`，
> 或者把 ASR 单独放到 GPU 服务器（此时第 2 步改成 `docker build -f Dockerfile.gpu`）。

---

## 2. 部署 ASR 服务

```bash
cd workers/faster-whisper-service

tcb cloudrun deploy \
  --env-id yuxiaomiaochongwu-d2dsk55ef4b392 \
  --service-name acecall-asr \
  --source . \
  --port 9001 \
  --min-num 1 \
  --max-num 1 \
  --wait
```

首次构建会预下载模型权重（`small` 约 500MB），需要几分钟。`Dockerfile` 里已把
`HF_ENDPOINT` 默认指向 `hf-mirror.com`，国内构建一般能通；若仍卡在下载，说明该镜像源也不可达，
可以先把权重下载到本地、改成把模型目录 COPY 进镜像，再构建。

> `tcb cloudrun deploy` **不支持** `--build-arg`，所以构建参数只能写死在 Dockerfile 里。

### 2.1 控制台补两项配置

云开发控制台 → 云托管 → `acecall-asr` → 服务设置：

**a) 资源规格**：至少 2 核 4GB（`small`）；`medium` 用 4 核 8GB。低于这个会非常慢或 OOM。

**b) 环境变量**：

```env
WHISPER_MODEL_SIZE=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_VAD_FILTER=1
ASR_API_KEY=<自己生成一串随机字符，记下来，worker 要用同一个>
ASR_EAGER_LOAD=1
ACECALL_ASR_HOTWORDS=CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,适当性,拆合股
```

改完保存会触发重新部署，等状态变成「运行中」。

### 2.2 验证

先拿到服务访问地址（控制台 → 服务详情 → 默认域名），然后：

```bash
# 健康检查（不需要 key）
curl https://<asr默认域名>/health
# 期望：{"ok":true,...,"detail":{"backend":"faster-whisper","model":"small","ready":true,...}}

# 鉴权是否生效（不带 key 应该 401）
curl -X POST https://<asr默认域名>/v1/audio/transcriptions \
  -F "file=@任意短音频.wav" -o /dev/null -w "%{http_code}\n"
# 期望 401

# 带 key 真实转写
curl -X POST https://<asr默认域名>/v1/audio/transcriptions \
  -H "Authorization: Bearer <你的ASR_API_KEY>" \
  -F "file=@说话录音.wav" \
  -F "language=zh" \
  -F "response_format=json"
# 期望返回 {"text":"..."}，人工核对中文是否合理、券商术语是否写对
```

**这一步必须人工听一遍转写结果**。模型选小 + 术语错得多，后面全部白搭。

---

## 3. 部署 worker

```bash
cd workers/transcription-worker

tcb cloudrun deploy \
  --env-id yuxiaomiaochongwu-d2dsk55ef4b392 \
  --service-name acecall-transcription-worker \
  --source . \
  --port 9000 \
  --min-num 1 \
  --max-num 1 \
  --wait
```

`--min-num 1` 很重要：worker 是常驻轮询进程，缩容到 0 就没人消费队列了。

### 3.1 控制台设环境变量

云开发控制台 → 云托管 → `acecall-transcription-worker` → 服务设置 → 环境变量：

```env
TCB_ENV=yuxiaomiaochongwu-d2dsk55ef4b392
CLOUDBASE_APIKEY=<管理端 API Key>
TRANSCRIPTION_PROVIDER=whisper
WHISPER_API_URL=https://<asr默认域名>/v1/audio/transcriptions
WHISPER_API_KEY=<和第 2 步的 ASR_API_KEY 完全一致>
WHISPER_LANGUAGE=zh
WHISPER_TIMEOUT_MS=3600000
WORKER_INTERVAL_MS=15000
ACECALL_ASR_HOTWORDS=CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,适当性,拆合股
```

几个容易错的点：

- `CLOUDBASE_APIKEY` 是**管理端** API Key，不是前端 `public/config.js` 里那个 publishable key。
- `WHISPER_API_URL` 要带完整路径 `/v1/audio/transcriptions`，不是只填域名。
- `WHISPER_API_KEY` 必须和 ASR 的 `ASR_API_KEY` 一致，否则每次转写都 401。
- 资源给 1 核 2GB 起步即可（它只做 ffmpeg 切段和转发，转写在 ASR 那边）。

### 3.2 验证

```bash
curl https://<worker默认域名>/health
# 期望：{"ok":true,"service":"acecall-transcription-worker","provider":"whisper",...}
```

`provider` 必须是 `whisper`。如果不是，说明环境变量没生效，任务会走百度然后失败。

看日志确认启动正常（先拿部署记录里的 run-id，再查运行日志）：

```bash
tcb cloudrun record list --env-id yuxiaomiaochongwu-d2dsk55ef4b392 \
  --service-name acecall-transcription-worker

tcb cloudrun logs process --env-id yuxiaomiaochongwu-d2dsk55ef4b392 \
  --run-id <上面列出的 run-id>
```

应能看到 `started on port 9000; provider=whisper; autoSegment=900s`。

---

## 4. 端到端验证

打开 https://15203212543-ui.github.io/AceCall/ → 候选人 → 电话初筛 → 开始录音，说 15 秒 → 停止。

状态应依次变化：

1. `正在创建录音任务…`
2. `正在上传录音 xx%`
3. `已上传，等待异步转写服务处理`
4. `排队等待转写服务`（最多 15 秒，等 worker 轮询）
5. `转写处理中（transcribing）`
6. `已完成转写 N 字` ← 文字自动写进「电话记录」

### 任务卡住时的排查顺序

按这个顺序查，能快速定位是哪一环：

| 卡在哪 | 查什么 |
|---|---|
| 第 1 步就失败 | 云函数部署了吗？报错有没有 `code`？ |
| 第 2 步失败 | 浏览器 CloudBase 存储权限；看报错里的分片序号 |
| 停在第 4 步 | worker 没跑 / `provider` 不是 whisper / `/health` 不通 |
| 停在第 5 步 | 看 worker 日志：下载分片？调 ASR？超时？ |
| 失败，error 含 401 | `WHISPER_API_KEY` 与 `ASR_API_KEY` 不一致 |
| 失败，error 含「分片下载失败」 | `CLOUDBASE_APIKEY` 没有存储读权限 |
| 失败，error 含「不能更新_id的值」 | worker 还是旧镜像，重新部署不要只重启 |
| 转写成功但没说话人 | 已知限制：Whisper 不做 diarization |

也可以直接查数据库确认。最省事的是看云开发控制台的数据库面板，
打开 `acecall_transcription_tasks` 集合，找到刚那条记录，检查
`status` / `engine` / `error` / `result.text` 四个字段。

接口层面可以用云函数自带的诊断端点（需登录态）：

```bash
curl "https://yuxiaomiaochongwu-d2dsk55ef4b392-1382810550.ap-shanghai.app.tcloudbase.com/acecall-api-v2/api/debug/status"
```

---

## 5. 验收标准

- [ ] ASR `/health` 返回 `ready: true`，`backend` 为 `faster-whisper`
- [ ] ASR 不带 key 请求返回 401
- [ ] 用 curl 直接转一段中文录音，文字通顺、券商术语基本正确
- [ ] worker `/health` 的 `provider` 为 `whisper`
- [ ] 前端录音后能自动写出文字
- [ ] 数据库该任务 `status=completed`、`engine=whisper`
- [ ] 录一段 20 分钟以上的音频，确认自动切段生效（`result.segmentCount > 1`）、
      时间轴连续递增

最后一条最容易被忽略，但它是长录音能不能用的唯一证据。

---

## 回滚

如果新链路不通、又急着让人用，把 worker 的环境变量改回百度即可（云函数不用动）：

```env
TRANSCRIPTION_PROVIDER=baidu
BAIDU_API_KEY=...
BAIDU_SECRET_KEY=...
```

前端和云函数完全不需要改，两条引擎共用同一条任务链路。
