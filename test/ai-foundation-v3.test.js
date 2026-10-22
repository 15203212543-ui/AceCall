const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeResumeText } = require('../server');
const { prepareDocumentVersions, locateQuote } = require('../cloudfunctions/acecall-api/document-text');
const { resolveJobAssignment, applyJobAssignment } = require('../cloudfunctions/acecall-api/job-assignment');
const { consumeRateLimit, redactSecrets, assertSameTenant } = require('../cloudfunctions/acecall-api/request-guard');
const { presentCandidateForState, buildLegacyDocument } = require('../cloudfunctions/acecall-api/candidate-documents');
const { classifyTranscription, presentTranscriptionStatus } = require('../cloudfunctions/acecall-api/transcription-route');
const facts = require('../cloudfunctions/acecall-api/fact-center');
const { createProvider } = require('../workers/transcription-worker/providers');

const root = path.join(__dirname, '..');

test('document versions keep raw text and locate a quote after cleaning', () => {
  const raw = '姓名：示例甲\n姓名：示例甲\n\u0000工作经历：券商做市\n工作经历：券商做市';
  const versions = prepareDocumentVersions(raw, normalizeResumeText);
  assert.equal(versions.rawText, raw);
  assert.match(versions.cleanedText, /示例甲/);
  assert.notEqual(versions.cleanedText, versions.rawText);
  assert.equal(versions.parseVersion, 'resume-clean-v1');
  assert.ok(versions.lineMap.some(item => item.rawLine >= 0 && item.quote.includes('示例甲')));
  assert.equal(locateQuote('券商做市', versions).verified, 'exact');
});

test('job assignment never falls back to the first job', () => {
  const jobs = [
    { id: 'job-first', name: '无关岗位', status: 'active' },
    { id: 'job-second', name: '目标岗位', status: 'active' }
  ];
  const missed = resolveJobAssignment({ jobs, match: { result: { jobId: '', status: '待分配', score: 12 } } });
  assert.equal(missed.assigned, false);
  assert.equal(missed.matching.status, '待分配');
  assert.equal(missed.job, null);
  const candidate = { candidateName: '示例乙' };
  applyJobAssignment(candidate, jobs, { result: { jobId: 'job-first', status: '待分配' } });
  assert.equal(candidate.jobId, '');
  assert.notEqual(candidate.roleName, '无关岗位');
  const assigned = applyJobAssignment({}, jobs, { result: { jobId: 'job-second', status: '自动匹配' } });
  assert.equal(assigned.jobId, 'job-second');
  assert.equal(assigned.matching.status, '自动匹配');
});

test('call sites no longer force the first job', () => {
  const files = [
    'desktop-agent/index.js',
    'local-sync-agent/index.js',
    'desktop-app/local-sync-agent.js',
    'cloudfunctions/acecall-api/index.js'
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(source.includes('jobs[0]'), false, file);
  }
});

test('ai routes share request context and do not echo tokens', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/acecall-api/index.js'), 'utf8');
  for (const route of ['/api/generate', '/api/parse-resume', '/api/transcribe']) {
    assert.match(source, new RegExp(`guardAiRoute\\(request, '${route}'\\)`));
  }
  const store = new Map();
  assert.equal(consumeRateLimit({ tenantId: 'tenant-a', route: '/api/generate', now: 1_000, limit: 2, store }).remaining, 1);
  consumeRateLimit({ tenantId: 'tenant-a', route: '/api/generate', now: 1_100, limit: 2, store });
  assert.throws(() => consumeRateLimit({ tenantId: 'tenant-a', route: '/api/generate', now: 1_200, limit: 2, store }), error => error.statusCode === 429);
  assert.equal(consumeRateLimit({ tenantId: 'tenant-b', route: '/api/generate', now: 1_200, limit: 2, store }).remaining, 1);
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue';
  assert.equal(redactSecrets(`Bearer ${token} failed`).includes(token), false);
});

test('cross-tenant resource access is not found', () => {
  assert.throws(() => assertSameTenant({ tenantId: 'other' }, { tenantId: 'mine' }), error => error.statusCode === 404 && error.message === 'Not found');
  assert.doesNotThrow(() => assertSameTenant({ tenantId: 'mine' }, { tenantId: 'mine' }));
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/acecall-api/index.js'), 'utf8');
  assert.match(source, /assertSameTenant\(existing/);
  assert.equal(source.includes('无权操作其他公司工作区的数据'), false);
});

test('state view omits the resume body and legacy backfill keeps both versions', () => {
  const view = presentCandidateForState({ id: 'cand-12345678', resume: '姓名：示例丙\n做过市', tenantId: 'tenant-a' });
  assert.equal(view.resume, undefined);
  assert.equal(view.documentId, 'legacy_cand-12345678');
  assert.match(view.resumeSummary, /示例丙/);
  const built = buildLegacyDocument({ id: 'cand-12345678', tenantId: 'tenant-a', resume: '姓名：示例丙\n姓名：示例丙' }, raw => prepareDocumentVersions(raw, normalizeResumeText));
  assert.match(built.document.rawText, /姓名：示例丙\n姓名：示例丙/);
  assert.match(built.document.cleanedText, /示例丙/);
  assert.equal(built.candidatePatch.documentId, built.document.id);
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/acecall-api/index.js'), 'utf8');
  assert.match(source, /presentCandidateForState/);
  assert.match(source, /factCenter\.COLLECTIONS\.documents/);
  assert.equal(facts.COLLECTIONS.documents, 'acecall_documents');
});

test('long audio stays off the short speech api and worker engines stay swappable', () => {
  assert.equal(classifyTranscription({ bytes: 11 * 1024 * 1024, durationSeconds: 10 }).useShortApi, false);
  assert.equal(classifyTranscription({ bytes: 1000, durationSeconds: 61 }).status, 'queued');
  assert.equal(classifyTranscription({ bytes: 1000, durationSeconds: 30 }).provider, 'baidu-short');
  assert.equal(presentTranscriptionStatus('transcribing'), 'running');
  assert.equal(presentTranscriptionStatus('completed'), 'succeeded');
  assert.equal(presentTranscriptionStatus('failed'), 'failed');
  assert.deepEqual(['baidu', 'whisper', 'funasr'].map(name => createProvider(name).name), ['baidu', 'whisper', 'funasr']);
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/acecall-api/index.js'), 'utf8');
  const route = source.slice(source.indexOf("pathname === '/api/transcribe'"), source.indexOf("pathname === '/api/recordings/init'"));
  assert.match(route, /classifyTranscription/);
  assert.ok(route.indexOf('classifyTranscription') < route.indexOf('transcribeWithBaidu'));
});

test('recording cannot start before consent is recorded', () => {
  const source = fs.readFileSync(path.join(root, 'public/app-v2.js'), 'utf8');
  assert.match(source, /id="recordingConsent"/);
  assert.match(source, /recordingConsent = \{ accepted: true/);
  assert.match(source, /未同意时请直接填写电话记录/);
  const gate = source.indexOf("const consent = $('#recordingConsent')");
  const media = source.indexOf('getUserMedia', gate);
  assert.ok(gate > 0 && media > gate);
});

test('dev and held-out samples stay separate and desensitized', () => {
  const resumes = fs.readdirSync(path.join(root, 'evals/dev-set/resumes')).filter(name => name.endsWith('.txt'));
  const transcripts = fs.readdirSync(path.join(root, 'evals/dev-set/transcripts')).filter(name => name.endsWith('.txt'));
  assert.ok(resumes.length >= 15 && resumes.length <= 20);
  assert.ok(transcripts.length >= 8 && transcripts.length <= 10);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'evals/held-out/manifest.json'), 'utf8'));
  assert.equal(manifest.sealed, true);
  assert.equal(manifest.resumes.length, 60);
  assert.equal(manifest.transcripts.length, 30);
  assert.equal(fs.existsSync(path.join(root, 'evals/held-out/resumes')), false);
  const sample = fs.readFileSync(path.join(root, 'evals/dev-set/resumes', resumes[0]), 'utf8');
  assert.equal(/1[3-9]\d{9}/.test(sample), false);
});

test('facts lock, conflicts, evidence failure and retention stay deterministic', () => {
  const fact = facts.createFact({ id: 'fact-1', tenantId: 'tenant-a', factType: 'name', value: '示例甲', confidenceBasis: 'explicit_field', evidences: [{ quote: '姓名：示例甲' }] });
  assert.equal(fact.confidence, 0.95);
  assert.equal(fact.locked, false);
  const confirmed = facts.confirmFact(fact, 'recruiter@example.com', '2026-10-22T00:00:00.000Z');
  assert.equal(confirmed.locked, true);
  assert.equal(confirmed.revisions.at(-1).action, 'confirm');
  const conflict = facts.mergeIncomingFact(confirmed, facts.createFact({ value: '另一个名字', evidences: [{ quote: '不存在' }] }));
  assert.equal(conflict.fact.status, 'conflict');
  assert.equal(conflict.fact.value, '示例甲');
  const checked = facts.applyEvidenceCheck(fact, { rawText: '其他内容', cleanedText: '其他内容' });
  assert.equal(checked.status, 'pending');
  assert.equal(checked.evidences[0].verified, 'failed');
  const kept = facts.applyEvidenceCheck(fact, { rawText: '姓名：示例甲', cleanedText: '姓名：示例甲' });
  assert.equal(kept.evidences[0].verified, 'exact');
  assert.equal(facts.readCompatibleResume({ resume: '旧正文' }, null), '旧正文');
  assert.equal(facts.readCompatibleResume({ resume: '旧正文' }, { cleanedText: '新正文' }), '新正文');
  const detail = facts.auditDetail({ token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue' });
  assert.equal(JSON.stringify(detail).includes('eyJ'), false);
  const now = Date.parse('2026-10-22T00:00:00.000Z');
  const plan = facts.planRetention([
    { id: 'due', retentionUntil: '2026-10-01T00:00:00.000Z', storageFileId: 'cloud://file' },
    { id: 'held', retentionUntil: '2026-10-01T00:00:00.000Z', legalHold: true },
    { id: 'retry', retentionUntil: '2026-10-01T00:00:00.000Z', deleteAttempts: 3, lastDeleteError: 'storage' }
  ], now);
  assert.deepEqual(plan.deleted.map(item => item.id), ['due']);
  assert.equal(plan.deleted[0].storageFileId, 'cloud://file');
  assert.ok(plan.deleted[0].dropFields.includes('phone'));
  assert.deepEqual(plan.held, ['held']);
  assert.deepEqual(plan.retry, ['retry']);
  assert.deepEqual(Object.keys(facts.COLLECTIONS).sort(), ['aiTasks', 'documents', 'facts', 'jobProfiles']);
});
