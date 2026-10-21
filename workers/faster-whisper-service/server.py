"""OpenAI-compatible speech-to-text gateway backed by faster-whisper.

AceCall's Node transcription worker already speaks the OpenAI
``/v1/audio/transcriptions`` contract, so this service deliberately mirrors it.
Point ``WHISPER_API_URL`` at ``http://<host>:9001/v1/audio/transcriptions`` and
set ``TRANSCRIPTION_PROVIDER=whisper``; the worker needs no further change.

Two input shapes are accepted:

* ``file``      multipart upload, for curl and any OpenAI SDK.
* ``audio_url`` multipart string field, because Cloud Run caps request bodies
  at ~32 MB while a two-hour mono 16 kHz WAV is roughly 230 MB. The worker
  holds a time-limited CloudBase URL, so it hands us the URL instead of bytes.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from transcriber import (
    TranscriptionError,
    TranscriptionService,
    create_service_from_env,
)

logger = logging.getLogger("acecall.asr")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

MAX_AUDIO_BYTES = int(os.getenv("ASR_MAX_AUDIO_BYTES", str(600 * 1024 * 1024)))
DOWNLOAD_TIMEOUT_SECONDS = float(os.getenv("ASR_DOWNLOAD_TIMEOUT", "300"))
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
ALLOWED_AUDIO_HOSTS = {
    host.strip().lower()
    for host in os.getenv("ASR_ALLOWED_AUDIO_HOSTS", "").split(",")
    if host.strip()
}
SUPPORTED_FORMATS = {"json", "verbose_json", "text"}

service: Optional[TranscriptionService] = None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global service
    service = create_service_from_env()
    # Loading up front keeps the first real request from paying the model load
    # cost; ASR_EAGER_LOAD=0 defers it for environments that need fast startup.
    if os.getenv("ASR_EAGER_LOAD", "1") not in {"0", "false", "False"}:
        try:
            service.ensure_loaded()
        except TranscriptionError as error:
            logger.error("model preload failed: %s", error)
    yield


app = FastAPI(title="AceCall faster-whisper ASR", version="0.1.0", lifespan=lifespan)


def get_service() -> TranscriptionService:
    if service is None:
        raise HTTPException(status_code=503, detail="转写服务尚未初始化")
    return service


@app.get("/health")
async def health() -> dict:
    current = get_service()
    return {
        "ok": True,
        "service": "acecall-faster-whisper",
        "max_audio_bytes": MAX_AUDIO_BYTES,
        "detail": current.describe(),
    }


@app.get("/")
async def root() -> dict:
    return {
        "service": "acecall-faster-whisper",
        "endpoint": "POST /v1/audio/transcriptions",
        "accepted_fields": ["file", "audio_url"],
        "docs": "https://github.com/15203212543-ui/AceCall",
    }


def _guard_url(audio_url: str) -> None:
    parsed = urlparse(audio_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="audio_url 必须是 http 或 https 地址")
    if ALLOWED_AUDIO_HOSTS and parsed.hostname and parsed.hostname.lower() not in ALLOWED_AUDIO_HOSTS:
        raise HTTPException(status_code=400, detail="audio_url 域名不在 ASR_ALLOWED_AUDIO_HOSTS 白名单内")


async def _download_to(audio_url: str, target: str) -> int:
    """Stream a remote recording to disk, enforcing the size ceiling."""
    _guard_url(audio_url)
    written = 0
    try:
        async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_SECONDS, follow_redirects=True) as client:
            async with client.stream("GET", audio_url) as response:
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"下载录音失败（HTTP {response.status_code}）",
                    )
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="录音文件超过大小限制")
                with open(target, "wb") as sink:
                    async for chunk in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                        written += len(chunk)
                        if written > MAX_AUDIO_BYTES:
                            raise HTTPException(status_code=413, detail="录音文件超过大小限制")
                        sink.write(chunk)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"下载录音失败：{error}") from error
    if not written:
        raise HTTPException(status_code=422, detail="下载到的录音为空")
    return written


async def _spill_upload(upload: UploadFile, target: str) -> int:
    written = 0
    with open(target, "wb") as sink:
        while True:
            chunk = await upload.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_AUDIO_BYTES:
                raise HTTPException(status_code=413, detail="录音文件超过大小限制")
            sink.write(chunk)
    if not written:
        raise HTTPException(status_code=422, detail="上传的录音为空")
    return written


def _suffix_for(name: str, content_type: str) -> str:
    extension = os.path.splitext(name or "")[1].lower()
    if extension and len(extension) <= 6 and extension[1:].isalnum():
        return extension
    guessed = {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a",
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
    }.get((content_type or "").split(";")[0].strip().lower(), ".audio")
    return guessed


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: Optional[UploadFile] = File(default=None),
    audio_url: Optional[str] = Form(default=None),
    model: str = Form(default="whisper-1"),
    language: Optional[str] = Form(default=None),
    prompt: Optional[str] = Form(default=None),
    response_format: str = Form(default="json"),
    temperature: Optional[float] = Form(default=None),
):
    current = get_service()
    fmt = (response_format or "json").strip().lower()
    if fmt not in SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的 response_format：{response_format}",
        )
    if file is None and not (audio_url or "").strip():
        raise HTTPException(status_code=400, detail="请提供 file 或 audio_url")

    started = time.time()
    handle, audio_path = tempfile.mkstemp(prefix="acecall-asr-", suffix=_suffix_for(
        getattr(file, "filename", "") or os.path.basename(urlparse(audio_url or "").path),
        getattr(file, "content_type", "") or "",
    ))
    os.close(handle)
    try:
        if file is not None:
            size = await _spill_upload(file, audio_path)
            source = "upload"
        else:
            size = await _download_to(audio_url.strip(), audio_path)
            source = "audio_url"
        logger.info(
            "transcribing source=%s bytes=%s language=%s model=%s prompt=%s",
            source,
            size,
            language or "auto",
            model,
            "custom" if prompt else "hotwords",
        )
        transcript = current.transcribe(
            audio_path,
            language=(language or "").strip() or None,
            prompt=(prompt or "").strip() or None,
            timestamps=fmt == "verbose_json",
        )
        elapsed = round(time.time() - started, 3)
        logger.info(
            "transcribed characters=%s duration=%s elapsed=%ss",
            len(transcript.text),
            transcript.duration,
            elapsed,
        )
        if fmt == "text":
            return PlainTextResponse(transcript.text)
        if fmt == "verbose_json":
            payload = transcript.as_verbose_json()
            payload["elapsed_seconds"] = elapsed
            payload["audio_bytes"] = size
            return payload
        return {
            "text": transcript.text,
            "language": transcript.language,
            "duration": round(transcript.duration, 3),
            "model": transcript.model,
            "elapsed_seconds": elapsed,
            "audio_bytes": size,
        }
    except TranscriptionError as error:
        logger.error("transcription failed: %s", error)
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass
