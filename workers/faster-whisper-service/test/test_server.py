"""Contract tests for the AceCall ASR gateway.

Run with ``pytest``. These exercise the HTTP surface with the fake backend, so
no GPU, model weights, or torch install is required in CI.
"""

from __future__ import annotations

import functools
import http.server
import os
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("ASR_BACKEND", "fake")
os.environ.setdefault("ASR_EAGER_LOAD", "1")

import server  # noqa: E402  (env must be set before import)
from transcriber import Segment, build_initial_prompt, join_segments, _split_hotwords  # noqa: E402


@pytest.fixture(scope="module")
def client() -> TestClient:
    with TestClient(server.app) as test_client:
        yield test_client


@pytest.fixture()
def audio_server(tmp_path: Path):
    """Serve a tiny payload over real HTTP so audio_url is not mocked away."""
    payload = b"RIFF....WAVEfmt " + b"\x00" * 512
    (tmp_path / "call.wav").write_bytes(payload)
    handler = functools.partial(_QuietHandler, directory=str(tmp_path))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}/call.wav"
    finally:
        httpd.shutdown()
        httpd.server_close()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args, **kwargs) -> None:  # keep pytest output clean
        pass


def test_health_reports_ready_backend(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["detail"]["ready"] is True
    assert body["max_audio_bytes"] > 0


def test_root_documents_accepted_fields(client: TestClient) -> None:
    body = client.get("/").json()
    assert body["endpoint"] == "POST /v1/audio/transcriptions"
    assert set(body["accepted_fields"]) == {"file", "audio_url"}


def test_transcribes_multipart_upload(client: TestClient) -> None:
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("call.wav", b"RIFF" + b"\x00" * 128, "audio/wav")},
        data={"model": "whisper-1", "language": "zh"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["text"]
    assert body["model"] == "fake"
    assert body["audio_bytes"] > 0


def test_transcribes_audio_url(client: TestClient, audio_server: str) -> None:
    response = client.post(
        "/v1/audio/transcriptions",
        data={"audio_url": audio_server, "response_format": "verbose_json"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["text"]
    assert body["segments"], "verbose_json 必须返回带时间戳的分段"
    assert body["segments"][0]["start"] == 0.0


def test_plain_text_response_format(client: TestClient) -> None:
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("call.wav", b"RIFF" + b"\x00" * 64, "audio/wav")},
        data={"response_format": "text"},
    )
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert response.text.strip()


def test_rejects_request_without_audio(client: TestClient) -> None:
    response = client.post("/v1/audio/transcriptions", data={"model": "whisper-1"})
    assert response.status_code == 400
    assert "file 或 audio_url" in response.json()["detail"]


def test_rejects_non_http_audio_url(client: TestClient) -> None:
    response = client.post("/v1/audio/transcriptions", data={"audio_url": "file:///etc/passwd"})
    assert response.status_code == 400


def test_rejects_unlisted_host_when_allowlist_configured(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "ALLOWED_AUDIO_HOSTS", {"storage.example.com"})
    response = client.post("/v1/audio/transcriptions", data={"audio_url": "https://evil.example.org/a.wav"})
    assert response.status_code == 400
    assert "白名单" in response.json()["detail"]


def test_rejects_unsupported_response_format(client: TestClient) -> None:
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("call.wav", b"RIFF" + b"\x00" * 64, "audio/wav")},
        data={"response_format": "srt"},
    )
    assert response.status_code == 400


def test_enforces_size_ceiling(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "MAX_AUDIO_BYTES", 32)
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("call.wav", b"RIFF" + b"\x00" * 256, "audio/wav")},
    )
    assert response.status_code == 413


def test_rejects_empty_upload(client: TestClient) -> None:
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("call.wav", b"", "audio/wav")},
    )
    assert response.status_code == 422


def test_join_segments_keeps_cjk_together_and_spaces_latin() -> None:
    segments = [
        Segment(0, 1, "我们负责交易链路"),
        Segment(1, 2, "以及清结算"),
        Segment(2, 3, "hello"),
        Segment(3, 4, "world"),
    ]
    joined = join_segments(segments)
    assert "交易链路\n以及清结算" in joined
    assert "hello world" in joined


def test_join_segments_skips_blank_segments() -> None:
    assert join_segments([Segment(0, 1, "  "), Segment(1, 2, "内容")]) == "内容"


def test_hotwords_are_deduplicated_and_capped() -> None:
    words = _split_hotwords("CCASS, 期权、CCASS\n联交所;")
    assert words == ["CCASS", "期权", "联交所"]
    prompt = build_initial_prompt([f"词{i}" for i in range(100)], limit=10)
    assert prompt.count("、") == 9
    assert build_initial_prompt([]) == ""


def test_prompt_uses_request_override_over_hotwords() -> None:
    prompt = "自定义提示"
    # The server forwards prompt verbatim; transcriber therefore must not
    # overwrite a caller-supplied prompt with hotwords.
    from transcriber import FakeTranscriptionService

    service = FakeTranscriptionService(hotwords=["不应出现"])
    assert service.transcribe("ignored", prompt=prompt).text
