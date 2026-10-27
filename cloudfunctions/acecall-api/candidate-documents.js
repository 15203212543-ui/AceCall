const crypto = require('node:crypto');

function resumeSummary(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function screeningFlags(screening = {}) {
  const report = screening.report && typeof screening.report === 'object' ? screening.report : null;
  return {
    hasTranscript: Boolean(String(screening.transcript || '').trim()),
    hasSummary: Boolean(screening.communicationSummary),
    hasReport: Boolean(report),
    hasPreparation: Boolean(screening.preparation),
    reviewConfirmed: Boolean(report?.reviewConfirmed),
    finalDecision: String(report?.finalDecision || '').slice(0, 80),
    nextStep: String(report?.nextStep || '').slice(0, 80)
  };
}

function presentCaseSummary(candidate = {}, screening = {}) {
  const view = presentCandidateForState(candidate);
  for (const key of ['transcript', 'communicationSummary', 'report', 'preparation', 'callRecording']) delete view[key];
  if (screening.consentConfirmed) view.consentConfirmed = true;
  return { ...view, ...screeningFlags(screening) };
}

function presentCandidateForState(candidate = {}) {
  const resume = String(candidate.resume || '');
  const view = { ...candidate };
  if (!resume) return view;
  view.resumeSummary = candidate.resumeSummary || resumeSummary(resume);
  view.documentId = candidate.documentId || `legacy_${candidate.id || candidate._id || ''}`;
  view.resumeOmitted = true;
  delete view.resume;
  return view;
}

function buildLegacyDocument(candidate = {}, clean) {
  const rawText = String(candidate.resume || '');
  const versions = clean ? clean(rawText) : { rawText, cleanedText: rawText, parseVersion: 'legacy-migrated', lineMap: [] };
  const existingId = String(candidate.documentId || '');
  const id = existingId && !existingId.startsWith('legacy_')
    ? existingId
    : `doc_${crypto.createHash('sha1').update(`${candidate.tenantId || ''}\n${candidate.id || ''}\n${rawText.slice(0, 200)}`).digest('hex').slice(0, 24)}`;
  return {
    document: {
      _id: id,
      id,
      tenantId: candidate.tenantId || '',
      workspaceId: candidate.workspaceId || candidate.tenantId || '',
      candidateId: candidate.id || '',
      uploadedBy: candidate.createdBy || '',
      fileName: candidate.resumeMeta?.fileName || '',
      rawText: versions.rawText,
      cleanedText: versions.cleanedText,
      parseStatus: 'legacy-migrated',
      parseVersion: versions.parseVersion || 'legacy-migrated',
      pageOrLineMap: versions.lineMap || [],
      createdAt: candidate.createdAt || '',
      updatedAt: candidate.updatedAt || ''
    },
    candidatePatch: {
      documentId: id,
      resumeSummary: resumeSummary(versions.cleanedText || versions.rawText),
      resumeOmitted: true
    }
  };
}

function mergeStoredCandidate(stored, incoming = {}) {
  const { _id, _openid, ...base } = stored && typeof stored === 'object' ? stored : {};
  const next = { ...base, ...incoming };
  if (!String(next.resume || '').trim() && String(base.resume || '').trim()) next.resume = base.resume;
  if (!next.documentId && base.documentId) next.documentId = base.documentId;
  return next;
}

module.exports = { resumeSummary, presentCandidateForState, presentCaseSummary, screeningFlags, buildLegacyDocument, mergeStoredCandidate };
