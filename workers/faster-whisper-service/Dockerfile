FROM python:3.11-slim

# PyAV (pulled in by faster-whisper) ships its own libav, so system ffmpeg is
# not required. libgomp is needed by ctranslate2 on slim images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models \
    WHISPER_DOWNLOAD_ROOT=/models

# 国内部署时 Hugging Face 直连经常超时，默认走镜像；如需官方源：
#   docker build --build-arg HF_ENDPOINT=https://huggingface.co ...
ARG HF_ENDPOINT=https://hf-mirror.com
ENV HF_ENDPOINT=${HF_ENDPOINT}

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY transcriber.py server.py ./

RUN useradd --create-home --uid 10001 asr && mkdir -p /models

# 构建期预下载权重。云托管的容器文件系统是临时的，若留到启动时再下载，
# 每次冷启动都要重新拉 1~3GB，既慢又容易失败，还可能导致健康检查超时。
# 需要在离线环境构建时可加 --build-arg PRELOAD_MODEL=0 跳过。
ARG PRELOAD_MODEL=1
ARG WHISPER_MODEL_SIZE=medium
RUN if [ "$PRELOAD_MODEL" = "1" ]; then \
      python -c "from faster_whisper.utils import download_model; download_model('${WHISPER_MODEL_SIZE}', cache_dir='/models')"; \
    fi \
  && chown -R asr:asr /models /app
USER asr

EXPOSE 9001
# CPU 上 large-v3 很慢，small/medium 才是 CPU 的实际选择；GPU 请用 Dockerfile.gpu。
ENV WHISPER_MODEL_SIZE=medium \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9001/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9001", "--timeout-keep-alive", "75"]
