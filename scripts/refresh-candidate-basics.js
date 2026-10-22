#!/usr/bin/env node
// Re-extract candidate name and basic profile fields already stored in CloudBase.
// Prints counts only. Does not print resume text, names, phone numbers, or emails.

const { execFileSync } = require('node:child_process');
const { normalizeResumeText, extractCandidateName, extractLabeledCandidateName, extractContextualCandidateName, extractNameFromFileName } = require('../server');
const { prepareDocumentVersions } = require('../cloudfunctions/acecall-api/document-text');
const { proposeNameCandidates, chooseDisplayedName, extractProfileFields } = require('../cloudfunctions/acecall-api/resume-profile');
const { isTranscriptFileName } = require('../cloudfunctions/acecall-api/transcript-match');

const PAGE = 20;

function execute(table, commandType, command) {
  const payload = JSON.stringify([{ TableName: table, CommandType: commandType, Command: JSON.stringify(command) }]);
  const output = execFileSync('tcb', ['db', 'nosql', 'execute', '--json', '--command', payload], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(output.slice(output.indexOf('{')));
  return parsed.data.results[0];
}

function firstBatch(result) {
  if (Array.isArray(result)) return result;
  return result?.cursor?.firstBatch || [];
}

function documentId(record) {
  return record.id || record._id?.$oid || record._id || '';
}

function loadDocumentText(documentIdValue) {
  if (!documentIdValue || String(documentIdValue).startsWith('legacy_')) return '';
  const result = execute('acecall_documents', 'QUERY', { find: 'acecall_documents', filter: { id: documentIdValue }, projection: { cleanedText: 1, rawText: 1 }, limit: 1 });
  const document = firstBatch(result)[0];
  return String(document?.cleanedText || document?.rawText || '');
}

function buildUpdate(record) {
  const fileName = record.resumeMeta?.fileName || '';
  if (isTranscriptFileName(fileName)) return { action: 'skip-transcript' };
  const stored = String(record.resume || '').trim() || loadDocumentText(record.documentId);
  if (stored.length < 20) return { action: 'skip-empty' };
  const cleaned = prepareDocumentVersions(stored, normalizeResumeText).cleanedText;
  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
  const displayed = chooseDisplayedName(proposeNameCandidates({
    labeled: extractLabeledCandidateName(lines),
    contextual: extractContextualCandidateName(lines),
    fromFile: extractNameFromFileName(fileName),
    fromBody: extractCandidateName(lines)
  }));
  const profile = extractProfileFields(cleaned);
  const meta = { ...(record.resumeMeta || {}) };
  meta.candidateNameSource = displayed.candidateNameSource;
  meta.candidateNameStatus = displayed.candidateName || displayed.candidateNameStatus === '待确认' ? displayed.candidateNameStatus : '待确认';
  meta.nameCandidates = proposeNameCandidates({
    labeled: extractLabeledCandidateName(lines),
    contextual: extractContextualCandidateName(lines),
    fromFile: extractNameFromFileName(fileName),
    fromBody: extractCandidateName(lines)
  }).map(item => ({ value: item.value, source: item.source, confidence: item.confidence, confidenceBasis: item.confidenceBasis }));
  if (profile.phone) meta.phone = profile.phone;
  if (profile.email) meta.email = profile.email;
  if (profile.education) meta.education = profile.education;
  if (profile.school) meta.school = profile.school;
  if (profile.experienceYears) meta.experienceYears = profile.experienceYears;
  if (profile.certificates.length) meta.certificates = profile.certificates;
  if (profile.experiences.length) meta.experiences = profile.experiences.slice(0, 12);
  if (profile.age?.value) meta.age = profile.age.value;
  meta.ageUsedForMatch = false;
  meta.profileRefreshedAt = new Date().toISOString();
  const set = { resumeMeta: meta, updatedAt: meta.profileRefreshedAt };
  if (displayed.candidateName) set.candidateName = displayed.candidateName;
  else meta.candidateNameStatus = '待确认';
  return { action: 'update', id: documentId(record), set, nameChanged: Boolean(set.candidateName && set.candidateName !== record.candidateName), status: meta.candidateNameStatus, phone: Boolean(profile.phone), email: Boolean(profile.email), school: Boolean(profile.school), experience: profile.experiences.length > 0 };
}

function main() {
  const summary = { read: 0, updated: 0, nameChanged: 0, recognized: 0, pending: 0, skipEmpty: 0, skipTranscript: 0, failed: 0, phone: 0, email: 0, school: 0, experience: 0 };
  for (let skip = 0; skip < 1000; skip += PAGE) {
    const page = firstBatch(execute('acecall_candidates', 'QUERY', { find: 'acecall_candidates', filter: {}, projection: { id: 1, candidateName: 1, resume: 1, resumeMeta: 1, documentId: 1 }, limit: PAGE, skip }));
    if (!page.length) break;
    summary.read += page.length;
    const updates = [];
    for (const record of page) {
      try {
        const next = buildUpdate(record);
        if (next.action === 'skip-empty') summary.skipEmpty += 1;
        else if (next.action === 'skip-transcript') summary.skipTranscript += 1;
        else {
          updates.push(next);
          if (next.nameChanged) summary.nameChanged += 1;
          if (next.status === '已识别') summary.recognized += 1;
          else summary.pending += 1;
          if (next.phone) summary.phone += 1;
          if (next.email) summary.email += 1;
          if (next.school) summary.school += 1;
          if (next.experience) summary.experience += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
    for (let index = 0; index < updates.length; index += 5) {
      const chunk = updates.slice(index, index + 5).filter(item => item.id);
      if (!chunk.length) continue;
      try {
        const result = execute('acecall_candidates', 'UPDATE', { update: 'acecall_candidates', updates: chunk.map(item => ({ q: { id: item.id }, u: { $set: item.set } })) });
        const matched = Number(result?.[0]?.n?.$numberInt || result?.[0]?.n || result?.n?.$numberInt || result?.n || 0);
        if (!matched) throw new Error('update did not match stored records');
        summary.updated += chunk.length;
      } catch {
        summary.failed += chunk.length;
      }
    }
    if (page.length < PAGE) break;
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main();
