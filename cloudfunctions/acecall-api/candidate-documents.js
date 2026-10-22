const crypto = require('node:crypto');

function resumeSummary(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
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

module.exports = { resumeSummary, presentCandidateForState, buildLegacyDocument };
