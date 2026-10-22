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
COPY transcriber.py server.py download_model.py ./

RUN useradd --create-home --uid 10001 asr && mkdir -p /models

# 构建期预下载权重。云托管的容器文件系统是临时的，若留到启动时再下载，
# 每次冷启动都要重新拉 1~3GB，既慢又容易失败，还可能导致健康检查超时。
# 需要在离线环境构建时可加 --build-arg PRELOAD_MODEL=0 跳过。
ARG PRELOAD_MODEL=1
# CPU 部署的默认模型只能是 tiny：实测 16 核上 small 仅 0.38 倍实时、
# medium 更低，云托管常见 1~2 核实例上跑 medium 等于不可用。tiny 配合
# ACECALL_ASR_HOTWORDS 能让专业术语基本正确，是纯 CPU 场景的唯一折中。
# 有 GPU 或高配实例时用 Dockerfile.gpu，或构建时覆盖：
#   --build-arg WHISPER_MODEL_SIZE=small
ARG WHISPER_MODEL_SIZE=tiny

# 构建期预下载权重。云托管的容器文件系统是临时的，若留到启动时再下载，
# 每次冷启动都要重新拉，既慢又容易失败，还可能导致健康检查超时。
#
# 这里不用 huggingface_hub 的 download_model：新版 hf_hub 会把大文件重定向到
# xet 存储（cas-server.xethub.hf.co），在 CI/容器里常因缺少授权返回
#   401 Unauthorized → File reconstruction error
# 直接走 HTTP 拉 resolve/main 下的几个文件，行为稳定且可预期。
# 需要在离线环境构建时可加 --build-arg PRELOAD_MODEL=0 跳过。
ARG HF_ENDPOINT_FOR_DOWNLOAD=https://hf-mirror.com
RUN if [ "$PRELOAD_MODEL" = "1" ]; then \
      python download_model.py "${WHISPER_MODEL_SIZE}" "/models/${WHISPER_MODEL_SIZE}"; \
    fi \
  && chown -R asr:asr /models /app
USER asr

EXPOSE 9001
# 与上面的 ARG 保持一致，否则构建期下载的模型和运行期加载的模型不是同一个，
# 运行时会去重新下载（云托管容器文件系统是临时的，冷启动会被健康检查判死）。
# 指向本地目录而不是模型名，避免运行时再去访问 HuggingFace。
ENV WHISPER_MODEL_SIZE=/models/tiny \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9001/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9001", "--timeout-keep-alive", "75"]
