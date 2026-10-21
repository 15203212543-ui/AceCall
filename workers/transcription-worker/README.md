# AceCall transcription worker

This is a long-running CloudRun worker. It polls `acecall_transcription_tasks` for
`queued` tasks, claims one task, downloads its CloudBase Storage parts, merges and
normalizes the audio with ffmpeg, sends it to the selected transcription provider,
and writes the result back to the same task document.

## Required environment variables

- `TCB_ENV`: canonical CloudBase environment id.
- `CLOUDBASE_APIKEY`: server API key with database and storage access.
- `TRANSCRIPTION_PROVIDER`: `baidu`, `whisper`, or `funasr` (default: `baidu`).
- `WORKER_INTERVAL_MS`: polling interval, default `15000`.

Provider configuration is intentionally server-side:

- Baidu long audio: `BAIDU_API_KEY`, `BAIDU_SECRET_KEY`, optionally
  `BAIDU_ASR_CREATE_URL` and `BAIDU_ASR_QUERY_URL`.
- Whisper: `WHISPER_API_URL`, optionally `WHISPER_API_KEY` and
  `WHISPER_MODEL`. See `workers/faster-whisper-service` for the self-hosted
  gateway that implements this contract.
- FunASR: `FUNASR_API_URL`, optionally `FUNASR_API_KEY`.

The worker exposes only a fixed `/health` response and never returns environment
variables, request headers, task audio, or provider credentials.

## Long recordings

Two hard constraints shape this pipeline:

1. Cloud Run caps HTTP request bodies at ~32 MB, while two hours of 16 kHz mono
   PCM is ~230 MB. The Whisper path therefore hands the gateway a time-limited
   CloudBase URL (`audio_url`) instead of raw bytes.
2. CloudBase `uploadFile` only accepts a `Buffer`, so a single uploaded file must
   stay inside the worker's memory budget. Recordings longer than
   `TRANSCRIPTION_AUTO_SEGMENT_SECONDS` (default 900 s, i.e. ~28 MB per slice) are
   split by ffmpeg and transcribed slice by slice.

Parts are streamed to disk as they download; the previous implementation
concatenated every part in memory and held the whole recording twice.

| Variable | Default | Purpose |
|---|---|---|
| `TRANSCRIPTION_AUTO_SEGMENT_SECONDS` | `900` | Auto-split threshold; also the slice length |
| `TRANSCRIPTION_AUTO_SEGMENT_BYTES` | `33554432` | Size fallback when the duration probe fails |
| `TRANSCRIPTION_SEGMENT_SECONDS` | unset | Explicit slice length, overrides both thresholds |
| `TRANSCRIPTION_MAX_SOURCE_BYTES` | `1073741824` | Reject oversized merges |
| `WHISPER_UPLOAD_MODE` | `auto` | `auto` prefers `audio_url`; `file` forces multipart upload |
| `WHISPER_LANGUAGE` | unset (`zh` recommended) | Forced language, avoids mis-detecting Mandarin |
| `WHISPER_TIMEOUT_MS` | `2700000` | Per-slice timeout (45 min) |
| `WHISPER_RETURN_SEGMENTS` | `1` | Request `verbose_json` so timestamps survive merging |
| `ACECALL_ASR_HOTWORDS` | unset | Domain terms injected as `initial_prompt` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Binary overrides |

Slice timestamps are offset by `index × segmentSeconds` on merge, so
`result.segments` always carries a global, monotonic timeline.

Duration probing tries `ffprobe` first and falls back to parsing
`ffmpeg -i` output, because some distributions (including `imageio-ffmpeg`)
ship ffmpeg without ffprobe. If both fail, segmentation falls back to a file-size
check — a failed probe must never turn a two-hour recording into one 230 MB
upload.

## Offline end-to-end check

`tools/offline-e2e.js` runs the whole pipeline without CloudBase: it fakes the
object store and the task collection, splits a local file into "parts", then
exercises download → probe → slice → ASR → merge and prints the transcript.

```bash
# terminal 1: ASR service (fake backend is enough to check wiring)
cd workers/faster-whisper-service && ASR_BACKEND=fake uvicorn server:app --port 9001

# terminal 2
cd workers/transcription-worker
WHISPER_API_URL=http://127.0.0.1:9001/v1/audio/transcriptions \
  node tools/offline-e2e.js /path/to/call.wav
```

Use `--segment 600` to force slicing, or point `WHISPER_API_URL` at a real
model deployment to check Chinese accuracy and terminology.

## Known limitation: no speaker labels

Whisper returns plain text without speaker attribution.
`cloudfunctions/acecall-api/transcript-match.js` derives the interviewer from
transcript lines shaped like `说话人 2026-10-20 15:30:11`, which ASR output cannot
provide. Interviewer detection therefore does not work on the recording path;
keep using腾讯会议/Moka exported transcripts (`POST /api/transcript-imports`) for
that, or add diarization (WhisperX/pyannote) later.

## Tests

```bash
node --test                       # from the repository root
FFMPEG_PATH=/path/to/ffmpeg node --test   # enables the ffmpeg slicing tests
```

The slicing tests synthesise their own 65-second sine wave, so no sample audio
is checked into the repository.
