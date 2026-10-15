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
  `WHISPER_MODEL`.
- FunASR: `FUNASR_API_URL`, optionally `FUNASR_API_KEY`.

The worker exposes only a fixed `/health` response and never returns environment
variables, request headers, task audio, or provider credentials.
