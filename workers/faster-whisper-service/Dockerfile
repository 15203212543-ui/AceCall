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

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY transcriber.py server.py ./

RUN useradd --create-home --uid 10001 asr \
  && mkdir -p /models \
  && chown -R asr:asr /models /app
USER asr

EXPOSE 9001
# CPU inference on large-v3 is slow; smaller models are the practical default
# here. Override WHISPER_MODEL_SIZE at deploy time.
ENV WHISPER_MODEL_SIZE=medium \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9001/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9001", "--timeout-keep-alive", "75"]
