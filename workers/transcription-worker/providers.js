const DEFAULT_BAIDU_CREATE_URL = 'https://aip.baidubce.com/rpc/2.0/aasr/v1/create';
const DEFAULT_BAIDU_QUERY_URL = 'https://aip.baidubce.com/rpc/2.0/aasr/v1/query';
const DEFAULT_BAIDU_SHORT_URL = 'https://vop.baidu.com/server_api';

function providerError(message, status = 502) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function normalizeBaiduText(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text || item?.result || '').filter(Boolean).join('\n').trim();
  if (value && typeof value === 'object') return String(value.text || value.result || '').trim();
  return String(value || '').trim();
}

function assertUrl(value, name) {
  try { return new URL(value).toString(); } catch { throw providerError(`${name} 配置无效`, 503); }
}

async function jsonResponse(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError(`${label}请求失败（${response.status}）`);
  return body;
}

async function getBaiduToken() {
  const apiKey = process.env.BAIDU_API_KEY;
  const secretKey = process.env.BAIDU_SECRET_KEY;
  if (!apiKey || !secretKey) throw providerError('百度长音频服务未配置 BAIDU_API_KEY 或 BAIDU_SECRET_KEY', 503);
  const response = await fetch(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`, { method: 'POST' });
  const body = await jsonResponse(response, '百度授权');
  if (!body.access_token) throw providerError(`百度授权失败：${body.error_description || body.error || '未返回 access_token'}`, 502);
  return body.access_token;
}

class BaiduProvider {
  constructor() { this.name = 'baidu'; this.requiresNormalizedWav = true; }

  async transcribe(input = {}) {
    const durationSeconds = Number(input.durationSeconds || 0);
    const shortLimit = Math.max(1, Number(process.env.BAIDU_SHORT_AUDIO_MAX_SECONDS || 60));
    if (input.audioBuffer?.length && durationSeconds > 0 && durationSeconds <= shortLimit && process.env.BAIDU_SHORT_AUDIO !== '0') {
      try {
        return await this.transcribeShort(input);
      } catch (error) {
        if (process.env.BAIDU_SHORT_AUDIO_FALLBACK_LONG === '0') throw error;
        console.warn(`[AceCall transcription worker] 百度短语音快速路径失败，回退长语音：${error.message}`);
      }
    }
    return this.transcribeLong(input);
  }

  async transcribeShort({ audioBuffer, fileName, durationSeconds }) {
    const token = await getBaiduToken();
    const endpoint = assertUrl(process.env.BAIDU_SHORT_ASR_URL || DEFAULT_BAIDU_SHORT_URL, 'BAIDU_SHORT_ASR_URL');
    const extension = String(fileName || '').split('.').pop()?.toLowerCase() || 'wav';
    const format = extension === 'pcm' ? 'pcm' : 'wav';
    const cuid = encodeURIComponent(process.env.BAIDU_ASR_CUID || 'acecall-worker');
    const devPid = Number(process.env.BAIDU_SHORT_ASR_PID || 1537);
    const response = await fetch(`${endpoint}?cuid=${cuid}&token=${encodeURIComponent(token)}&dev_pid=${devPid}`, {
      method: 'POST',
      headers: { 'Content-Type': `audio/${format}; rate=16000`, 'Content-Length': String(audioBuffer.length) },
      body: audioBuffer,
      signal: AbortSignal.timeout(Number(process.env.BAIDU_SHORT_TIMEOUT_MS || 15_000))
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || Number(body.err_no || 0) !== 0) {
      throw providerError(`百度短语音识别失败（${response.status}）：${body.err_msg || body.err_no || '未知错误'}`, 422);
    }
    const text = normalizeBaiduText(body.result || body.text || '');
    if (!text) throw providerError('百度短语音未返回有效文字', 422);
    return { text, provider: this.name, providerTaskId: '', duration: durationSeconds, segments: [] };
  }

  async transcribeLong({ audioUrl, fileName }) {
    if (!audioUrl) throw providerError('百度长音频识别需要可访问的音频 URL', 422);
    const token = await getBaiduToken();
    const createUrl = assertUrl(process.env.BAIDU_ASR_CREATE_URL || DEFAULT_BAIDU_CREATE_URL, 'BAIDU_ASR_CREATE_URL');
    const queryUrl = assertUrl(process.env.BAIDU_ASR_QUERY_URL || DEFAULT_BAIDU_QUERY_URL, 'BAIDU_ASR_QUERY_URL');
    const extension = String(fileName || '').split('.').pop()?.toLowerCase() || 'wav';
    const createResponse = await fetch(`${createUrl}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speech_url: audioUrl, format: extension, rate: 16000, channel: 1, cuid: 'acecall-worker', pid: 1537 })
    });
    const created = await jsonResponse(createResponse, '百度长音频创建任务');
    const taskId = created.task_id || created.taskId;
    if (!taskId) throw providerError(`百度长音频创建失败：${created.err_msg || '未返回 task_id'}`, 502);
    const timeoutAt = Date.now() + Number(process.env.PROVIDER_TIMEOUT_MS || 20 * 60 * 1000);
    while (Date.now() < timeoutAt) {
      await new Promise(resolve => setTimeout(resolve, Number(process.env.PROVIDER_POLL_MS || 5000)));
      const queryResponse = await fetch(`${queryUrl}?access_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: [taskId] })
      });
      const queried = await jsonResponse(queryResponse, '百度长音频查询');
      const item = queried.tasks_info?.[0] || queried.tasks?.[0] || queried;
      const status = String(item.task_status || item.status || '').toLowerCase();
      if (['success', 'completed', 'finish', 'done'].includes(status)) {
        const text = item.result?.[0]?.result || item.result || item.text || '';
        if (Array.isArray(text)) return { text: text.join('\n').trim(), provider: this.name, providerTaskId: taskId };
        if (String(text).trim()) return { text: String(text).trim(), provider: this.name, providerTaskId: taskId };
        throw providerError('百度长音频未返回有效文字', 422);
      }
      if (['failure', 'failed', 'error'].includes(status)) throw providerError(`百度长音频识别失败：${item.err_msg || item.error_msg || status}`, 422);
    }
    throw providerError('百度长音频识别超时', 504);
  }
}

/**
 * OpenAI-compatible ASR endpoint. Runs against a self-hosted faster-whisper
 * gateway (workers/faster-whisper-service) or any service that speaks
 * /v1/audio/transcriptions.
 *
 * Prefers `audio_url` over a raw body: Cloud Run caps request payloads at
 * ~32 MB while long recordings are far larger, so the gateway downloads from
 * the time-limited CloudBase URL instead.
 */
class WhisperProvider {
  constructor() {
    this.name = 'whisper';
    this.requiresNormalizedWav = false;
  }

  async transcribe({ audioUrl, audioBuffer, fileName, mimeType, language, prompt }) {
    const endpoint = process.env.WHISPER_API_URL;
    if (!endpoint) throw providerError('Whisper 服务未配置 WHISPER_API_URL', 503);
    const uploadMode = String(process.env.WHISPER_UPLOAD_MODE || 'auto').toLowerCase();
    const useUrl = Boolean(audioUrl) && uploadMode !== 'file';
    const form = new FormData();
    if (useUrl) {
      form.append('audio_url', audioUrl);
    } else if (audioBuffer?.length) {
      form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), fileName || 'recording.wav');
    } else {
      throw providerError('Whisper 需要可访问的音频 URL 或音频内容', 422);
    }
    form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
    const targetLanguage = String(language || process.env.WHISPER_LANGUAGE || '').trim();
    if (targetLanguage) form.append('language', targetLanguage);
    const promptText = String(prompt || process.env.ACECALL_ASR_HOTWORDS || '').trim();
    if (promptText) form.append('prompt', promptText);
    const wantSegments = process.env.WHISPER_RETURN_SEGMENTS !== '0';
    form.append('response_format', wantSegments ? 'verbose_json' : 'json');

    const headers = process.env.WHISPER_API_KEY ? { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {};
    const timeoutMs = Number(process.env.WHISPER_TIMEOUT_MS || 45 * 60 * 1000);
    let response;
    try {
      response = await fetch(assertUrl(endpoint, 'WHISPER_API_URL'), {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw providerError(`Whisper 转写超时（${Math.round(timeoutMs / 60000)} 分钟）`, 504);
      }
      throw providerError(`Whisper 请求失败：${error.message}`, 502);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The gateway returns a readable Chinese detail for decode/auth failures.
      throw providerError(`Whisper 转写失败（${response.status}）${body.detail ? `：${body.detail}` : ''}`, 422);
    }
    const text = body.text || body.result?.text || body.transcript || '';
    if (!String(text).trim()) throw providerError('Whisper 未返回有效文字', 422);
    return {
      text: String(text).trim(),
      provider: this.name,
      providerTaskId: body.id || '',
      language: body.language || '',
      duration: Number(body.duration || 0),
      segments: Array.isArray(body.segments)
        ? body.segments.map(item => ({
          start: Number(item.start || 0),
          end: Number(item.end || 0),
          text: String(item.text || '').trim(),
          speaker: item.speaker || ''
        })).filter(item => item.text)
        : []
    };
  }
}

class FunASRProvider {
  constructor() { this.name = 'funasr'; this.requiresNormalizedWav = false; }

  async transcribe({ audioUrl, audioBuffer, fileName, mimeType }) {
    const endpoint = process.env.FUNASR_API_URL;
    if (!endpoint) throw providerError('FunASR 服务未配置 FUNASR_API_URL', 503);
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.FUNASR_API_KEY) headers.Authorization = `Bearer ${process.env.FUNASR_API_KEY}`;
    const body = await jsonResponse(await fetch(assertUrl(endpoint, 'FUNASR_API_URL'), {
      method: 'POST', headers, body: JSON.stringify({ audio_url: audioUrl, file_name: fileName, mime_type: mimeType, audio_base64: audioUrl ? undefined : audioBuffer.toString('base64') })
    }), 'FunASR');
    const text = body.text || body.result?.text || body.transcript || (Array.isArray(body.result) ? body.result.join('\n') : '');
    if (!String(text).trim()) throw providerError('FunASR 未返回有效文字', 422);
    return { text: String(text).trim(), provider: this.name, providerTaskId: body.id || body.task_id || '' };
  }
}

function createProvider(name = process.env.TRANSCRIPTION_PROVIDER || 'baidu') {
  const normalized = String(name).toLowerCase();
  if (normalized === 'baidu') return new BaiduProvider();
  if (normalized === 'whisper') return new WhisperProvider();
  if (normalized === 'funasr') return new FunASRProvider();
  throw providerError(`不支持的转写引擎：${name}`, 503);
}

module.exports = { BaiduProvider, WhisperProvider, FunASRProvider, createProvider, providerError };
