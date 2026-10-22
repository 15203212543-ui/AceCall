"""faster-whisper transcription backend.

Keeps every model-specific concern behind ``TranscriptionService`` so the HTTP
layer stays testable without a GPU, torch, or downloaded weights. The fake
backend is what the test suite and local wiring use.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, List, Optional

logger = logging.getLogger(__name__)


def _patch_av_open() -> bool:
    """让 faster-whisper 能在不支持 metadata_errors 的 PyAV 上工作。

    faster-whisper 的 audio.py 调用 av.open(..., metadata_errors="ignore")，
    但 PyAV 19.0.2（当前最新发布版）不接受这个关键字，真正转写时会直接报
    TypeError: open() got an unexpected keyword argument 'metadata_errors'。
    模型加载阶段不会触发，所以问题要到第一次转写才暴露。

    探测一次，不支持就把该参数丢掉再调用。返回是否打了补丁，便于日志记录。
    """
    try:
        import av
    except Exception:  # pragma: no cover - av 缺失时交给 faster-whisper 自己报错
        return False
    if getattr(av.open, "_acecall_metadata_errors_patched", False):
        return False
    original = av.open
    try:
        # 不支持的 PyAV 会在参数校验阶段抛 TypeError；支持则抛文件/格式相关错误
        original("/nonexistent-acecall-probe", metadata_errors="ignore")
        return False
    except TypeError as error:
        if "metadata_errors" not in str(error):
            return False
    except Exception:
        return False

    def open_compat(*args, **kwargs):
        kwargs.pop("metadata_errors", None)
        return original(*args, **kwargs)

    open_compat._acecall_metadata_errors_patched = True
    av.open = open_compat
    logger.info("PyAV 不支持 metadata_errors，已启用兼容补丁")
    return True


AV_COMPAT_PATCHED = _patch_av_open()


class TranscriptionError(RuntimeError):
    """Raised when the backend cannot produce a usable transcript."""


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: Optional[str] = None

    def as_dict(self, index: int) -> dict:
        item = {
            "id": index,
            "seek": 0,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
        }
        if self.speaker:
            item["speaker"] = self.speaker
        return item


@dataclass
class Transcript:
    text: str
    language: str = ""
    duration: float = 0.0
    segments: List[Segment] = field(default_factory=list)
    speakers: List[str] = field(default_factory=list)
    model: str = ""

    def as_verbose_json(self) -> dict:
        return {
            "task": "transcribe",
            "language": self.language,
            "duration": round(self.duration, 3),
            "text": self.text,
            "segments": [segment.as_dict(index) for index, segment in enumerate(self.segments)],
            "speakers": list(self.speakers),
            "model": self.model,
        }


def _split_hotwords(value: str) -> List[str]:
    """Accept comma/newline/semicolon separated hotwords and de-duplicate."""
    seen: set[str] = set()
    words: List[str] = []
    for chunk in str(value or "").replace("\n", ",").replace(";", ",").replace("、", ",").split(","):
        word = chunk.strip()
        if word and word not in seen:
            seen.add(word)
            words.append(word)
    return words


def build_initial_prompt(hotwords: Iterable[str], limit: int = 60) -> str:
    """Whisper biases decoding on ``initial_prompt``; feed domain vocabulary.

    Whisper only sees a bounded window, so we cap the term count instead of
    letting a large job keyword list crowd out the actual audio context.
    """
    words = [word for word in hotwords if word][:limit]
    if not words:
        return ""
    return "本次通话涉及以下术语，请按原词输出：" + "、".join(words) + "。"


class TranscriptionService:
    """Lazily loaded faster-whisper model with serialized inference."""

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "auto",
        compute_type: str = "default",
        download_root: Optional[str] = None,
        hotwords: Optional[Iterable[str]] = None,
        beam_size: int = 5,
        vad_filter: bool = True,
        cpu_threads: int = 0,
        max_concurrency: int = 1,
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.download_root = download_root
        self.hotwords = list(hotwords or [])
        self.beam_size = beam_size
        self.vad_filter = vad_filter
        self.cpu_threads = cpu_threads
        self._model: Any = None
        self._load_lock = threading.Lock()
        # A single GPU cannot usefully run two large-v3 decodes at once, so the
        # default is serialized inference with a queue in front of it.
        self._inference_slots = threading.BoundedSemaphore(max(1, max_concurrency))
        self.loaded_at: Optional[float] = None
        self.load_seconds: Optional[float] = None

    @classmethod
    def from_env(cls) -> "TranscriptionService":
        return cls(
            model_size=os.getenv("WHISPER_MODEL_SIZE", "large-v3"),
            device=os.getenv("WHISPER_DEVICE", "auto"),
            compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "default"),
            download_root=os.getenv("WHISPER_DOWNLOAD_ROOT") or None,
            hotwords=_split_hotwords(os.getenv("ACECALL_ASR_HOTWORDS", "")),
            beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "5")),
            vad_filter=os.getenv("WHISPER_VAD_FILTER", "1") not in {"0", "false", "False"},
            cpu_threads=int(os.getenv("WHISPER_CPU_THREADS", "0")),
            max_concurrency=int(os.getenv("WHISPER_MAX_CONCURRENCY", "1")),
        )

    @property
    def ready(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            started = time.time()
            logger.info(
                "loading faster-whisper model=%s device=%s compute_type=%s",
                self.model_size,
                self.device,
                self.compute_type,
            )
            try:
                from faster_whisper import WhisperModel  # imported lazily on purpose
            except ImportError as error:  # pragma: no cover - environment issue
                raise TranscriptionError(
                    "faster-whisper 未安装；请执行 pip install -r requirements.txt"
                ) from error
            kwargs: dict[str, Any] = {
                "device": self.device,
                "compute_type": self.compute_type,
            }
            if self.download_root:
                kwargs["download_root"] = self.download_root
            if self.cpu_threads:
                kwargs["cpu_threads"] = self.cpu_threads
            self._model = WhisperModel(self.model_size, **kwargs)
            self.load_seconds = round(time.time() - started, 3)
            self.loaded_at = time.time()
            logger.info("faster-whisper model ready in %ss", self.load_seconds)

    def describe(self) -> dict:
        return {
            "backend": "faster-whisper",
            "model": self.model_size,
            "device": self.device,
            "compute_type": self.compute_type,
            "vad_filter": self.vad_filter,
            "beam_size": self.beam_size,
            "hotword_count": len(self.hotwords),
            "ready": self.ready,
            "load_seconds": self.load_seconds,
        }

    def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        prompt: Optional[str] = None,
        timestamps: bool = False,
    ) -> Transcript:
        self.ensure_loaded()
        initial_prompt = prompt or build_initial_prompt(self.hotwords)
        acquired = self._inference_slots.acquire(timeout=float(os.getenv("WHISPER_QUEUE_TIMEOUT", "1800")))
        if not acquired:
            raise TranscriptionError("转写队列等待超时，请稍后重试")
        try:
            # faster-whisper decodes from the file path with PyAV, so a two-hour
            # recording never becomes one giant in-memory float array. This is
            # the main reason we run it here instead of inside the Node worker.
            segment_iter, info = self._model.transcribe(
                audio_path,
                language=language or None,
                initial_prompt=initial_prompt or None,
                beam_size=self.beam_size,
                vad_filter=self.vad_filter,
                word_timestamps=False,
                condition_on_previous_text=False,
            )
            segments: List[Segment] = []
            for item in segment_iter:
                text = str(getattr(item, "text", "") or "").strip()
                if not text:
                    continue
                segments.append(Segment(start=float(item.start or 0), end=float(item.end or 0), text=text))
            if not segments:
                raise TranscriptionError("转写引擎未返回有效文字")
            text = join_segments(segments)
            return Transcript(
                text=text,
                language=str(getattr(info, "language", "") or ""),
                duration=float(getattr(info, "duration", 0) or 0),
                segments=segments,
                speakers=[],
                model=self.model_size,
            )
        finally:
            self._inference_slots.release()


class FakeTranscriptionService(TranscriptionService):
    """Deterministic backend for tests and for wiring checks without a GPU."""

    def __init__(self, *args: Any, lines: Optional[Iterable[str]] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._lines = list(lines or ["这是一段用于联调的模拟转写文本。", "请配置真实模型后再用于正式招聘。"])

    def ensure_loaded(self) -> None:
        if self._model is None:
            self._model = "fake"
            self.load_seconds = 0.0
            self.loaded_at = time.time()

    def describe(self) -> dict:
        detail = super().describe()
        detail.update({"backend": "fake", "model": "fake", "fake": True})
        return detail

    def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        prompt: Optional[str] = None,
        timestamps: bool = False,
    ) -> Transcript:
        self.ensure_loaded()
        segments = [
            Segment(start=index * 3.0, end=index * 3.0 + 2.5, text=line)
            for index, line in enumerate(self._lines)
        ]
        return Transcript(
            text=join_segments(segments),
            language=language or "zh",
            duration=max(segment.end for segment in segments),
            segments=segments,
            speakers=[],
            model="fake",
        )


def join_segments(segments: Iterable[Segment], separator: str = "\n") -> str:
    """Join segment text without gluing CJK sentences or double-spacing latin."""
    parts: List[str] = []
    for segment in segments:
        text = str(segment.text or "").strip()
        if not text:
            continue
        if parts and _needs_space(parts[-1], text):
            parts.append(" " + text)
        else:
            parts.append(separator + text if parts else text)
    return "".join(parts).strip()


def _needs_space(previous: str, following: str) -> bool:
    if not previous or not following:
        return False
    return previous[-1].isascii() and following[0].isascii() and previous[-1].isalnum()


def create_service_from_env() -> TranscriptionService:
    backend = os.getenv("ASR_BACKEND", "faster-whisper").strip().lower()
    if backend in {"fake", "mock", "stub"}:
        logger.warning("ASR_BACKEND=%s：返回模拟转写，禁止用于正式招聘判断", backend)
        return FakeTranscriptionService.from_env()
    return TranscriptionService.from_env()
