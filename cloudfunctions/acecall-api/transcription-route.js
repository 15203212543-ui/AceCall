const SHORT_AUDIO_BYTES = 10 * 1024 * 1024;
const SHORT_AUDIO_SECONDS = 60;

function classifyTranscription({ bytes = 0, durationSeconds = 0 } = {}) {
  const tooLarge = Number(bytes) > SHORT_AUDIO_BYTES;
  const tooLong = Number(durationSeconds) > SHORT_AUDIO_SECONDS;
  if (tooLarge || tooLong) {
    return {
      useShortApi: false,
      status: 'queued',
      publicStatus: 'queued',
      provider: 'async-worker',
      message: '超过 60 秒或 10MB，进入异步转写，不调用短语音接口'
    };
  }
  return { useShortApi: true, status: 'short', publicStatus: 'short', provider: 'baidu-short' };
}

function presentTranscriptionStatus(status) {
  return {
    queued: 'queued',
    uploading: 'queued',
    uploaded: 'queued',
    converting: 'running',
    transcribing: 'running',
    merging: 'running',
    completed: 'succeeded',
    failed: 'failed'
  }[status] || status || 'queued';
}

module.exports = { SHORT_AUDIO_BYTES, SHORT_AUDIO_SECONDS, classifyTranscription, presentTranscriptionStatus };
