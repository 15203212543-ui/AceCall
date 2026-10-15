const DEFAULT_BAIDU_CREATE_URL = 'https://aip.baidubce.com/rpc/2.0/aasr/v1/create';
const DEFAULT_BAIDU_QUERY_URL = 'https://aip.baidubce.com/rpc/2.0/aasr/v1/query';

function providerError(message, status = 502) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
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
  constructor() { this.name = 'baidu'; }

  async transcribe({ audioUrl, fileName }) {
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

class WhisperProvider {
  constructor() { this.name = 'whisper'; }

  async transcribe({ audioBuffer, fileName, mimeType }) {
    const endpoint = process.env.WHISPER_API_URL;
    if (!endpoint) throw providerError('Whisper 服务未配置 WHISPER_API_URL', 503);
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), fileName || 'recording.wav');
    form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
    const headers = process.env.WHISPER_API_KEY ? { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {};
    const body = await jsonResponse(await fetch(assertUrl(endpoint, 'WHISPER_API_URL'), { method: 'POST', headers, body: form }), 'Whisper');
    const text = body.text || body.result?.text || body.transcript || '';
    if (!String(text).trim()) throw providerError('Whisper 未返回有效文字', 422);
    return { text: String(text).trim(), provider: this.name, providerTaskId: body.id || '' };
  }
}

class FunASRProvider {
  constructor() { this.name = 'funasr'; }

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
