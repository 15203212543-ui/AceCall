# 录音转写功能怎么测试

这份文档说明改动后如何验证「录音 → 转写 → 文字」这条链路。按依赖从少到多分成三层，**建议按顺序走**。

---

## 先搞清楚一件事：GitHub Pages 测不到我的改动

`https://15203212543-ui.github.io/AceCall/` 部署的是仓库里的 `public/` 目录（纯前端静态文件），由 `main` 分支推送触发。

这次改动**全部在 `workers/` 和文档，没动任何前端代码**，所以：

| 你在 Pages 上能做什么 | 结果 |
|---|---|
| 打开页面、登录 | 正常，但连的是生产 CloudBase |
| 点「开始录音」 | **可以录**，前端录音代码我没改 |
| 录音上传、轮询转写状态 | 可以走通，但**转写由生产上旧的 worker 处理** |
| 看到我的改动效果 | ❌ 看不到 |

`public/config.js` 把 `apiBaseUrl` 硬编码指向生产 CloudBase 网关 `acecall-api-v2`，Pages 页面没有"切到本地后端"的开关。所以 Pages 只能用来**验证前端录音交互本身没坏**（本来也没改），验证不了新转写链路。

要在 Pages 上看到效果，需要满足两个条件：① 改动合并进 `main` 并自动部署；② ASR 服务 + worker 已部署到云上并配好环境变量。缺一个都看不到。

---

## 第 1 层：只验证 ASR 服务（不依赖任何云资源）

最小闭环。确认服务和模型本身能出中文文字。

### 1a. 不下载模型，先验证接口接通

```bash
cd workers/faster-whisper-service
python -m venv .venv && . .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt

ASR_BACKEND=fake uvicorn server:app --host 0.0.0.0 --port 9001
```

另开终端：

```bash
curl http://127.0.0.1:9001/health
# 期望 detail.fake = true

curl -X POST http://127.0.0.1:9001/v1/audio/transcriptions \
  -F "file=@你的录音.wav" -F "language=zh" -F "response_format=verbose_json"
```

`fake` 后端返回固定文本，只证明 HTTP 契约、上传、下载、时间戳都对，**不代表识别质量**。

### 1b. 用真实模型看中文准确率 ← 最有价值的一步

```bash
WHISPER_MODEL_SIZE=large-v3 WHISPER_DEVICE=cuda WHISPER_COMPUTE_TYPE=float16 \
ACECALL_ASR_HOTWORDS="CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,适当性" \
  uvicorn server:app --host 0.0.0.0 --port 9001
```

没有 GPU 就先在 CPU 上跑小模型验证流程（慢，但能出字）：

```bash
WHISPER_MODEL_SIZE=small WHISPER_DEVICE=cpu WHISPER_COMPUTE_TYPE=int8 uvicorn server:app --port 9001
```

**建议拿 3~5 段真实通话录音**（脱敏后），重点看这几项：

1. **券商术语**是否写错。`CCASS`、`清结算`、`拆合股`、`场外期权`、`Level 2` 这类最容易被写成同音字。如果错得多，往 `ACECALL_ASR_HOTWORDS` 里补词。
2. **数字**是否准。薪资、年限、金额，招聘场景里这些错了比错别字严重。
3. **中英混说**是否断裂。
4. 首尾有没有**幻听**（静音段被识别出内容）。有的话确认 `WHISPER_VAD_FILTER=1` 生效。

> 模型权重从 Hugging Face 下载。国内网络慢的话设 `HF_ENDPOINT=https://hf-mirror.com`，或提前把模型目录挂进 `WHISPER_DOWNLOAD_ROOT` 后直接把路径传给 `WHISPER_MODEL_SIZE`。

---

## 第 2 层：验证 worker 的完整转写链路（仍需第 1 层，不依赖 CloudBase）

这一步验证「分片合并 → 时长探测 → 切段 → 逐段转写 → 时间轴合并」整条流水线。我加了个离线工具，用本地临时目录冒充对象存储。

```bash
# 终端 1：ASR 服务（第 1 步起好的那个）

# 终端 2
cd workers/transcription-worker
WHISPER_API_URL=http://127.0.0.1:9001/v1/audio/transcriptions \
  node tools/offline-e2e.js /path/to/你的录音.wav
```

输出会打印：源文件大小、分片数、切段策略、状态、时长、字数、转写次数、时间轴段数、总耗时，以及转写文本和前 5 段时间轴。

### 重点验证长录音

两小时的会议录音是最容易出问题的地方。想快速构造长音频：

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=7500" -ac 1 -ar 16000 -c:a pcm_s16le long.wav
```

然后：

```bash
WHISPER_API_URL=http://127.0.0.1:9001/v1/audio/transcriptions \
  node tools/offline-e2e.js long.wav
```

**必须确认**：

- `切段` 显示自动生效，`分片转写` 次数 > 1（默认 900 秒一片，7500 秒应切成 9 段）。
- **时间轴连续递增**，最后一段的 `end` 接近音频总时长。这是拼接有没有错位的直接证据。
- 每个「上传切片」都明显小于 32MB。超过就有内存风险。

想验证「缺 ffprobe」的兜底，把 `FFPROBE_PATH` 指向一个不存在的路径：

```bash
FFPROBE_PATH=/nonexistent FFPROBE_PATH_X=1 \
WHISPER_API_URL=http://127.0.0.1:9001/v1/audio/transcriptions \
  node tools/offline-e2e.js long.wav
```

此时会走 ffmpeg 解析时长的兜底；如果连 ffmpeg 也解析不出来，还有按文件大小的兜底，两种都不应退化成"整块上传"。

### 跑自动化测试

```bash
# 仓库根目录
FFMPEG_PATH=$(which ffmpeg) node --test        # 50 项

# ASR 服务
cd workers/faster-whisper-service && pytest -q  # 15 项
```

不设 `FFMPEG_PATH` 时，切段相关的 7 个用例会跳过（不是失败）。

---

## 第 3 层：验证线上全链路（需要 CloudBase 权限）

只有这一层能验证「网页点录音 → 分片上传 → 入队 → worker 转写 → 前端显示文字」，因为中间要读写 CloudBase 数据库和存储。

### 需要的权限

- `TCB_ENV`：环境 ID，`yuxiaomiaochongwu-d2dsk55ef4b392`
- `CLOUDBASE_APIKEY`：**管理端 API Key**（不是 `public/config.js` 里那个浏览器用的 publishable key）
- 部署 CloudRun 或能连到 CloudBase 的机器

> 顺带提醒：README 写着这个 API Key **2026-11-16 到期**，已经不远了，部署前最好先确认轮换计划。

### 步骤

1. **部署 ASR 服务**到 CloudRun（有 GPU 的实例，或 CPU + 小模型），记下 URL。
2. **部署 worker**，环境变量：
   ```env
   TCB_ENV=...
   CLOUDBASE_APIKEY=...
   TRANSCRIPTION_PROVIDER=whisper
   WHISPER_API_URL=http://<asr-host>:9001/v1/audio/transcriptions
   WHISPER_LANGUAGE=zh
   ACECALL_ASR_HOTWORDS=CCASS,港股划拨,清结算,...
   ```
   若 ASR 和 worker 不在同一内网，且录音较短，可加 `WHISPER_UPLOAD_MODE=file`。
3. **打开 Pages 页面**，进候选人详情的「电话初筛」页签，点「开始录音」说几句话，停止后点「完成电话并生成结果」。
4. 观察三处：
   - `acecall_transcription_tasks` 里该任务的 `status` 是否从 `queued → transcribing → completed`；
   - `result.text` 是否有内容，`result.segments` 时间轴是否正常；
   - 页面「电话记录」文本框是否出现转写文字。
5. 失败时看 worker 日志里的 `error` 字段——我特意让 provider 把服务端 `detail` 带进错误信息，能直接看到是下载失败、鉴权失败还是解码失败。

### 也可以只验证「上传录音文件」这条

这条和录音走完全相同的后端路径，差别只是文件由 `<input type=file>` 提供。如果不想开麦克风，直接上传一个已有音频文件即可。

---

## 已知会失败 / 不符合预期的地方

| 现象 | 原因 | 处理 |
|---|---|---|
| 面试官分析、岗位归属识别不出来 | Whisper 不输出说话人标签，`transcript-match.js` 依赖「说话人 + 时间戳」格式 | 需要面试官分析时继续用腾讯会议/Moka 导出的转写走 `/api/transcript-imports` |
| 首次请求特别慢 | 模型冷启动（large-v3 约 3GB） | 保持 `ASR_EAGER_LOAD=1`，或用常驻实例 |
| 转写结果有明显错别字 | 领域术语未覆盖 | 往 `ACECALL_ASR_HOTWORDS` 补词后重启服务 |
| CPU 上 1 小时音频转很久 | large-v3 在 CPU 上约 0.2~0.5 倍速 | 用 GPU，或降到 small/medium |
| `MaxListenersExceededWarning` | 旧版分片下载用 `pipeline({end:false})`，每个分片累积监听器 | 已修（改为手动 write + drain），若仍出现说明跑的是旧代码 |

---

## 我的验证状态（如实说明）

| 项目 | 结果 |
|---|---|
| worker 全量单测 | ✅ 50/50 |
| ASR 服务单测 | ✅ 15/15 |
| Node ↔ Python 接口契约 | ✅ 9/9 |
| 25 分钟长音频：分片 → 切段 → 逐段转写 → 时间轴合并 | ✅ 切成 2 片，时间轴偏移到 900s 正确 |
| 12 个分片的监听器泄漏 | ✅ 已修复并回归 |
| 缺 ffprobe 的时长兜底 | ✅ 已修复并有测试 |
| **真实 faster-whisper 模型的中文识别质量** | ❌ **未验证**，本机下不了权重 |

最后一项必须由你在有模型的环境补测。这是唯一无法在这里替你完成的环节。
