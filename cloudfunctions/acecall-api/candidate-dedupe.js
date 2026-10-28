function normalizePhone(value = '') {
  const digits = String(value).normalize('NFKC').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('86')) return digits.slice(2);
  return digits;
}

function normalizeEmail(value = '') {
  return String(value).normalize('NFKC').trim().toLowerCase();
}

function normalizeFileName(value = '') {
  return String(value).normalize('NFKC').trim().toLowerCase().replace(/\.(pdf|docx?|txt|md|rtf)$/i, '').replace(/\s+/g, '');
}

function normalizePersonName(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
}

function resumeIdentity(candidate = {}) {
  const meta = candidate.resumeMeta || {};
  return {
    phone: normalizePhone(meta.phone || candidate.phone),
    email: normalizeEmail(meta.email || candidate.email),
    fileName: normalizeFileName(meta.fileName || meta.originalFileName),
    size: Number(meta.originalSize || meta.originalFileSize || meta.size || 0),
    characters: Number(meta.characters || meta.characterCount || 0)
  };
}

function duplicateReason(incoming, existing) {
  const left = resumeIdentity(incoming);
  const right = resumeIdentity(existing);
  if (left.phone && right.phone && left.phone === right.phone) return 'phone';
  if (left.email && right.email && left.email === right.email) return 'email';
  if (left.fileName && left.fileName === right.fileName
    && left.size > 0 && left.size === right.size
    && left.characters > 0 && left.characters === right.characters) return 'resume-file';
  const leftName = normalizePersonName(incoming.candidateName);
  const rightName = normalizePersonName(existing.candidateName);
  if (leftName.length >= 2 && leftName === rightName && left.size > 0 && left.size === right.size && left.characters > 0 && left.characters === right.characters) return 'resume-content';
  return '';
}

function duplicateGroupKey(candidate = {}) {
  const identity = resumeIdentity(candidate);
  if (identity.phone) return `phone:${identity.phone}`;
  if (identity.email) return `email:${identity.email}`;
  const name = normalizePersonName(candidate.candidateName);
  if (name.length >= 2 && identity.size > 0 && identity.characters > 0) return `resume:${name}:${identity.size}:${identity.characters}`;
  return '';
}

function preferVisibleCandidate(left, right) {
  if (Boolean(left?.reviewConfirmed) !== Boolean(right?.reviewConfirmed)) return left?.reviewConfirmed ? left : right;
  return createdTime(left) <= createdTime(right) ? left : right;
}

function collapseDuplicateCases(cases = []) {
  const groups = new Map();
  const unique = [];
  for (const item of cases) {
    const key = duplicateGroupKey(item);
    if (!key) { unique.push(item); continue; }
    groups.set(key, groups.has(key) ? preferVisibleCandidate(groups.get(key), item) : item);
  }
  return [...unique, ...groups.values()];
}

function createdTime(candidate = {}) {
  const value = Date.parse(candidate.createdAt || candidate.capturedAt || '');
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function findDuplicateCandidate(incoming, candidates = [], currentId = '') {
  return candidates
    .filter(candidate => String(candidate.id || candidate._id || '') !== String(currentId || ''))
    .map(candidate => ({ candidate, reason: duplicateReason(incoming, candidate) }))
    .filter(result => result.reason)
    .sort((a, b) => createdTime(a.candidate) - createdTime(b.candidate))[0] || null;
}

module.exports = { normalizePhone, normalizeEmail, normalizeFileName, normalizePersonName, resumeIdentity, duplicateReason, duplicateGroupKey, collapseDuplicateCases, findDuplicateCandidate };
