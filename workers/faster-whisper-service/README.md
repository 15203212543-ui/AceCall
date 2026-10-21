# AceCall faster-whisper ASR 网关

自托管的语音转写服务，把 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 包装成
OpenAI 兼容的 `/v1/audio/transcriptions` 接口，供 `workers/transcription-worker` 调用。

选它而不是原版 `openai/whisper` 的原因：同一套模型权重，但 faster-whisper 用 CTranslate2
重写推理，约为原版 4 倍速、支持 int8 量化、内置 Silero VAD，并且**从文件路径流式解码**——
两小时通话不会被整体读成一个大数组，这是我们能把长录音交给它的关键。

## 它在链路里的位置

```
浏览器录音 / 上传文件
   → CloudBase 存储（8MB 分片，上限 500MB）
   → acecall_transcription_tasks（status=queued）
   → transcription-worker 拉任务、流式合并分片、按需切段
   → 本服务 /v1/audio/transcriptions
   → 回写任务表（text + segments + duration）
   → 云函数调 DeepSeek 做 summarize / synthesize
```

DeepSeek 没有音频接口，所以转写与理解是两段：**faster-whisper 出文字，DeepSeek 做理解**。

## 快速开始

### 本地（CPU，验证链路）

```bash
cd workers/faster-whisper-service
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 没有 GPU 时用小模型先跑通
WHISPER_MODEL_SIZE=small WHISPER_DEVICE=cpu WHISPER_COMPUTE_TYPE=int8 \
  uvicorn server:app --host 0.0.0.0 --port 9001
```

### 完全不下载模型（只验证接口契约）

```bash
ASR_BACKEND=fake uvicorn server:app --port 9001
```

`ASR_BACKEND=fake` 返回固定文本，日志会打警告。它只用于联调，不能用于正式招聘判断。

### GPU（正式部署）

```bash
docker build -f Dockerfile.gpu -t acecall-asr:gpu .
docker run --gpus all -p 9001:9001 \
  -e ACECALL_ASR_HOTWORDS="CCASS,清结算,场外期权,拆合股,供股" \
  acecall-asr:gpu
```

首次启动会从 Hugging Face 下载 `large-v3` 权重（约 3GB）到 `HF_HOME`，建议挂载卷复用：

```bash
docker run --gpus all -p 9001:9001 -v acecall-models:/models acecall-asr:gpu
```

## 接口

### `POST /v1/audio/transcriptions`

multipart/form-data。输入二选一：

| 字段 | 类型 | 说明 |
|---|---|---|
| `file` | 文件 | 常规 OpenAI 用法，适合小文件、curl、官方 SDK |
| `audio_url` | 字符串 | **worker 的默认路径**。由服务端自己去下载 |

为什么有 `audio_url`：Cloud Run 的 HTTP 请求体上限约 32MB，而两小时 16kHz 单声道 WAV 约 230MB。
worker 手里有 CloudBase 的临时下载链接，交给服务端拉取可以彻底绕开这个限制。

其余字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | `whisper-1` | 仅为兼容 OpenAI SDK，实际模型由服务端 `WHISPER_MODEL_SIZE` 决定 |
| `language` | 自动检测 | 中文场景建议显式传 `zh`，可避免误判为粤语或日语 |
| `prompt` | 服务端热词 | 覆盖 `ACECALL_ASR_HOTWORDS`，用于注入术语表 |
| `response_format` | `json` | `json` / `verbose_json` / `text` |
| `temperature` | — | 兼容字段，当前忽略（faster-whisper 走 beam search） |

`verbose_json` 会额外返回 `segments`（含 `start`/`end`/`text`）和 `duration`，
worker 靠它把多段转写拼回一条完整时间轴。

```bash
# URL 方式
curl -X POST http://127.0.0.1:9001/v1/audio/transcriptions \
  -F "audio_url=https://your-bucket.example.com/call.wav" \
  -F "language=zh" \
  -F "response_format=verbose_json"

# 文件方式
curl -X POST http://127.0.0.1:9001/v1/audio/transcriptions \
  -F "file=@call.m4a" -F "language=zh"
```

### `GET /health`

返回模型、设备、量化方式、是否就绪、热词数量。Docker HEALTHCHECK 用的就是它。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WHISPER_MODEL_SIZE` | `large-v3`（镜像里 CPU 版默认 `medium`） | `tiny`/`base`/`small`/`medium`/`large-v3` |
| `WHISPER_DEVICE` | `auto` | `cuda` / `cpu` / `auto` |
| `WHISPER_COMPUTE_TYPE` | `default` | GPU 用 `float16`，CPU 用 `int8` |
| `WHISPER_BEAM_SIZE` | `5` | 降低可提速，代价是准确率 |
| `WHISPER_VAD_FILTER` | `1` | 用 Silero VAD 跳过静音，能显著减少「静音被识别成幻听文本」 |
| `WHISPER_MAX_CONCURRENCY` | `1` | 单卡同时转写数，GPU 上不建议超过 1 |
| `WHISPER_CPU_THREADS` | `0`（自动） | CPU 部署可显式指定 |
| `ACECALL_ASR_HOTWORDS` | 空 | 逗号/顿号/换行分隔的术语表，会拼成 `initial_prompt` |
| `ASR_MAX_AUDIO_BYTES` | `629145600`（600MB） | 单次请求音频上限 |
| `ASR_ALLOWED_AUDIO_HOSTS` | 空（不限制） | 填了则 `audio_url` 域名必须在白名单内，防 SSRF |
| `ASR_DOWNLOAD_TIMEOUT` | `300` | 拉取远端音频超时（秒） |
| `ASR_EAGER_LOAD` | `1` | 启动即加载模型；设 `0` 可加快冷启动但首个请求变慢 |
| `ASR_BACKEND` | `faster-whisper` | 设 `fake` 用模拟后端 |

### 热词怎么配

Whisper 训练语料以英文为主，对「CCASS」「拆合股」「场外期权」这类券商术语容易写错同音字。
`initial_prompt` 能显著改善，建议直接把项目里的岗位关键词铺进去：

```env
ACECALL_ASR_HOTWORDS=CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,PRD,Level 2,复权,适当性,投资者适当性管理
```

超过 60 个会被截断（Whisper 的上下文窗口有限，塞太多反而挤掉音频语境）。

## 与 worker 对接

worker 侧只需要三个变量：

```env
TRANSCRIPTION_PROVIDER=whisper
WHISPER_API_URL=http://<asr-host>:9001/v1/audio/transcriptions
WHISPER_LANGUAGE=zh
ACECALL_ASR_HOTWORDS=CCASS,清结算,场外期权
```

如果 ASR 与 worker 不在同一网络、无法互访，把 `WHISPER_UPLOAD_MODE=file` 打开可以强制
走 multipart 文件上传（受 32MB 限制，只适合短录音）。

## 长音频是怎么处理的

| 环节 | 做法 |
|---|---|
| 分片合并 | worker **流式**写盘，不再 `Buffer.concat` 全部内容（旧实现在两小时录音下会 OOM） |
| 时长探测 | `ffprobe` 拿 `format=duration` |
| 自动切段 | 超过 `TRANSCRIPTION_AUTO_SEGMENT_SECONDS`（默认 900 秒）自动切成 15 分钟一片 |
| 切段原因 | CloudBase `uploadFile` 只接受 Buffer，单文件必须控制在内存预算内。15 分钟 16k 单声道约 28MB |
| 时间轴 | 每片转写结果按 `index × segmentSeconds` 偏移后合并，`segments` 保持全局绝对时间 |
| 短音频 | 不切段；Whisper 兼容网关能直接解码原始容器，不做多余转码 |

## 已知限制

- **没有说话人分离（diarization）**。Whisper 只输出文字。`cloudfunctions/acecall-api/transcript-match.js`
  里的 `speakerTurns()` 依赖「说话人 + 时间戳」格式来推断面试官，纯 ASR 结果无法提供，
  因此**录音转写路径的面试官识别会失效**。需要该能力时：继续用腾讯会议/Moka 导出的转写文件
  走 `/api/transcript-imports`，或后续接入 WhisperX（pyannote）补充 diarization。
- `temperature` 字段被忽略。
- 未做音频内容合规检测；正式使用前需完成录音告知与数据保存期限评审。
- CPU 上跑 `large-v3` 极慢（约为实时的 0.2–0.5 倍速），仅适合验证。

## 测试

```bash
pip install pytest
pytest -q          # 15 个用例，使用 fake 后端，不需要模型和 GPU
```
