const path = require('node:path');

function resumeMimeType(fileName = '') {
  const extension = path.extname(String(fileName)).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.doc') return 'application/msword';
  if (extension === '.txt') return 'text/plain';
  if (extension === '.md') return 'text/markdown';
  return 'application/octet-stream';
}

function safeResumeFileName(fileName = '') {
  const base = path.basename(String(fileName || 'resume')).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '');
  return (base || 'resume').slice(0, 80);
}

function originalResumeCloudPath(tenantId = '', fileName = '', stamp = Date.now(), nonce = '') {
  const tenant = String(tenantId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
  return `acecall/resumes/${tenant}/inbox/${stamp}-${nonce}-${safeResumeFileName(fileName)}`;
}

function originalResumeMeta(fileName, buffer, fileId) {
  return {
    originalFileId: String(fileId || ''),
    originalFileName: path.basename(String(fileName || 'resume')).slice(0, 180),
    originalMimeType: resumeMimeType(fileName),
    originalFileSize: buffer?.length || 0
  };
}

function isEphemeralFileId(value) {
  return /^(?:blob:|data:|https?:)/i.test(String(value || '').trim());
}

function withoutPreviewUrl(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const next = { ...meta };
  delete next.originalFile;
  delete next.originalTempUrl;
  if (isEphemeralFileId(next.originalFileId)) delete next.originalFileId;
  return next;
}

function retainOriginalResume(incoming, stored) {
  const previous = withoutPreviewUrl(stored && typeof stored === 'object' ? stored : null);
  if (!incoming || typeof incoming !== 'object') return previous || incoming;
  const next = withoutPreviewUrl(incoming);
  if (!previous?.originalFileId || next.originalFileId) return next;
  return {
    ...next,
    originalFileId: previous.originalFileId,
    originalFileName: next.originalFileName || previous.originalFileName || '',
    originalMimeType: next.originalMimeType || previous.originalMimeType || '',
    originalFileSize: next.originalFileSize || previous.originalFileSize || 0
  };
}

module.exports = { resumeMimeType, safeResumeFileName, originalResumeCloudPath, originalResumeMeta, retainOriginalResume };
