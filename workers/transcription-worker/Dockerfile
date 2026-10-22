FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV PORT=9000

# 非敏感的运行配置写进镜像，减少部署时要在控制台手填的项。
# 密钥（CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY）必须由平台环境变量注入，
# 不能写进镜像，也不能提交 Git。
ENV TCB_ENV=yuxiaomiaochongwu-d2dsk55ef4b392 \
    TRANSCRIPTION_PROVIDER=whisper \
    WORKER_INTERVAL_MS=15000 \
    TRANSCRIPTION_AUTO_SEGMENT_SECONDS=900 \
    WHISPER_LANGUAGE=zh \
    WHISPER_TIMEOUT_MS=3600000

# 指向同一环境内的 ASR 服务。这个环境的内网访问没有开启（InternalAccess=close），
# 所以必须用公网默认域名，不能用 http://<服务名>:<端口> 的内网写法。
# ASR 部署在别处时用环境变量覆盖。
ENV WHISPER_API_URL=https://acecall-faster-whisper-329050-11-1382810550.sh.run.tcloudbase.com/v1/audio/transcriptions

# 热词对中文专业术语影响很大，尤其是 tiny 这类小模型。
ENV ACECALL_ASR_HOTWORDS=CCASS,港股交收,资金划拨,公司行动,期权清结算,场外期权,询报价,适当性,拆合股,猎头顾问,候选人

CMD ["node", "worker.js"]
