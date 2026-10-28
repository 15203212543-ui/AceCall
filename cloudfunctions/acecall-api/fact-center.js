const CONFIDENCE = {
  explicit_field: 0.95,
  exact_quote: 0.9,
  moka_record: 0.9,
  filename_pattern: 0.7,
  layout_inference: 0.6,
  context_inference: 0.45,
  model_inference: 0.4,
  ocr_text: 0.3
};

const COLLECTIONS = {
  documents: 'acecall_documents',
  facts: 'acecall_candidate_facts',
  jobProfiles: 'acecall_job_profiles',
  aiTasks: 'acecall_ai_tasks'
};

function createFact(input = {}) {
  const now = input.now || new Date().toISOString();
  const basis = input.confidenceBasis || 'model_inference';
  return {
    _id: input.id,
    tenantId: input.tenantId || '',
    workspaceId: input.workspaceId || input.tenantId || '',
    candidateId: input.candidateId || '',
    factType: input.factType || '',
    layer: input.layer || 'profile',
    value: input.value ?? '',
    status: input.status || 'pending',
    confidence: CONFIDENCE[basis] ?? CONFIDENCE.model_inference,
    confidenceBasis: basis,
    extractedBy: input.extractedBy || 'rule',
    evidences: Array.isArray(input.evidences) ? input.evidences : [],
    conflicts: [],
    revisions: [],
    locked: false,
    confirmedBy: '',
    confirmedAt: '',
    version: 1,
    createdBy: input.createdBy || '',
    updatedBy: input.createdBy || '',
    retentionUntil: input.retentionUntil || '',
    legalHold: false,
    createdAt: now,
    updatedAt: now
  };
}

function valuesEqual(left, right) {
  return JSON.stringify(left ?? '') === JSON.stringify(right ?? '');
}

function mergeIncomingFact(current, incoming) {
  if (!current) return { fact: incoming, conflict: null };
  if (current.locked && !valuesEqual(current.value, incoming.value)) {
    const conflict = {
      at: incoming.updatedAt || incoming.createdAt,
      currentValue: current.value,
      incomingValue: incoming.value,
      evidences: incoming.evidences || []
    };
    return {
      fact: { ...current, status: 'conflict', conflicts: [...(current.conflicts || []), conflict] },
      conflict
    };
  }
  if (current.locked) return { fact: current, conflict: null };
  return { fact: { ...incoming, revisions: current.revisions || [], version: (current.version || 1) + 1 }, conflict: null };
}

function confirmFact(fact, actor, now = new Date().toISOString()) {
  const revision = { version: (fact.version || 1) + 1, value: fact.value, by: actor, at: now, action: 'confirm' };
  return {
    ...fact,
    status: 'confirmed',
    locked: true,
    confirmedBy: actor,
    confirmedAt: now,
    updatedBy: actor,
    updatedAt: now,
    version: revision.version,
    revisions: [...(fact.revisions || []), revision]
  };
}

function reviseFact(fact, value, actor, now = new Date().toISOString()) {
  const revision = { version: (fact.version || 1) + 1, previous: fact.value, value, by: actor, at: now, action: 'revise' };
  return {
    ...fact,
    value,
    status: 'confirmed',
    locked: true,
    updatedBy: actor,
    updatedAt: now,
    version: revision.version,
    revisions: [...(fact.revisions || []), revision]
  };
}

function verifyEvidence(quote, versions = {}) {
  const needle = String(quote || '').replace(/\s+/g, ' ').trim();
  const raw = String(versions.rawText || '').replace(/\s+/g, ' ');
  const cleaned = String(versions.cleanedText || '').replace(/\s+/g, ' ');
  if (!needle) return { verified: 'failed', status: 'pending' };
  if (raw.includes(needle) || cleaned.includes(needle)) return { verified: 'exact', status: 'pending' };
  const compact = needle.replace(/[\s,，。；;]/g, '');
  const rawCompact = raw.replace(/[\s,，。；;]/g, '');
  const cleanedCompact = cleaned.replace(/[\s,，。；;]/g, '');
  if (compact.length >= 4 && (rawCompact.includes(compact) || cleanedCompact.includes(compact))) return { verified: 'fuzzy', status: 'pending' };
  return { verified: 'failed', status: 'pending' };
}

function applyEvidenceCheck(fact, versions) {
  const evidences = (fact.evidences || []).map(item => ({ ...item, ...verifyEvidence(item.quote, versions) }));
  const failed = evidences.length === 0 || evidences.every(item => item.verified === 'failed');
  return { ...fact, evidences, status: failed ? 'pending' : fact.status };
}

function readCompatibleResume(candidate = {}, document = null) {
  if (document?.cleanedText) return document.cleanedText;
  if (document?.rawText) return document.rawText;
  return String(candidate.resume || '');
}

function auditDetail(detail) {
  const text = JSON.stringify(detail || {});
  return JSON.parse(text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, '[redacted-token]'));
}

function planRetention(records = [], now = Date.now()) {
  const deleted = [];
  const held = [];
  const retry = [];
  for (const record of records) {
    if (record.legalHold) {
      held.push(record.id);
      continue;
    }
    const due = Date.parse(record.retentionUntil || '');
    if (!Number.isFinite(due) || due > now) continue;
    if (record.deleteAttempts >= 3 && record.lastDeleteError) {
      retry.push(record.id);
      continue;
    }
    deleted.push({
      id: record.id,
      storageFileId: record.storageFileId || '',
      dropFields: ['rawText', 'cleanedText', 'resume', 'phone', 'email', 'quote'],
      audit: { action: 'retention.delete', entityId: record.id, piiRemoved: true }
    });
  }
  return { deleted, held, retry };
}

module.exports = {
  CONFIDENCE,
  COLLECTIONS,
  createFact,
  mergeIncomingFact,
  confirmFact,
  reviseFact,
  verifyEvidence,
  applyEvidenceCheck,
  readCompatibleResume,
  auditDetail,
  planRetention
};
