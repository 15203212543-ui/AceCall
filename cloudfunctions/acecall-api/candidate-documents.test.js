const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeStoredCandidate, buildLegacyDocument, storedRecord, recordInTenant, presentCaseDetail } = require('./candidate-documents');

test('a later save keeps parsed resume text and the document id', () => {
  const stored = { _id: 'db', resume: '工作经历：负责后端开发', documentId: 'doc_12345678', resumeMeta: { fileName: '演示.pdf', originalFileId: 'cloud://file' }, candidateName: '演示' };
  const saved = mergeStoredCandidate(stored, { candidateName: '演示', roleName: '后端开发', resumeMeta: { fileName: '演示.pdf' } });
  assert.equal(saved.resume, '工作经历：负责后端开发');
  assert.equal(saved.documentId, 'doc_12345678');
  assert.equal(saved._id, undefined);
});

test('an incoming resume replaces the stored text', () => {
  const saved = mergeStoredCandidate({ resume: '旧正文' }, { resume: '新的工作经历正文' });
  assert.equal(saved.resume, '新的工作经历正文');
});

test('a page refresh includes the resume text and the saved screening', () => {
  const detail = presentCaseDetail(
    { id: 'cand-1', candidateName: '示例', resume: '旧正文' },
    { preparation: { questions: ['问职责'] }, transcript: '电话原文', report: { reviewConfirmed: true, finalDecision: '推荐业务面试' }, communicationSummary: { overview: '已沟通' } },
    { cleanedText: '新的简历正文' }
  );
  assert.equal(detail.resume, '新的简历正文');
  assert.equal(detail.resumeOmitted, false);
  assert.equal(detail.transcript, '电话原文');
  assert.equal(detail.preparation.questions[0], '问职责');
  assert.equal(detail.report.finalDecision, '推荐业务面试');
  assert.equal(detail.communicationSummary.overview, '已沟通');
  assert.equal(detail.hasReport, true);
});

test('a linked job is still readable when the driver wraps the document in an array', () => {
  const job = recordInTenant({ data: [{ tenantId: 'tenant-1', mokaJobId: 'moka-job-1', mokaJobCode: 'MJ005759' }] }, 'tenant-1');
  assert.equal(job.mokaJobId, 'moka-job-1');
  assert.equal(job.mokaJobCode, 'MJ005759');
  assert.equal(recordInTenant({ data: { tenantId: 'tenant-1', mokaJobId: 'direct-job' } }, 'tenant-1').mokaJobId, 'direct-job');
  assert.equal(recordInTenant({ data: [{ tenantId: 'other', mokaJobId: 'hidden' }] }, 'tenant-1'), null);
  assert.equal(recordInTenant({ data: [] }, 'tenant-1'), null);
});

test('a single document read is unwrapped when the driver returns an array', () => {
  const record = storedRecord({ data: [{ preparation: { summary: '已保存' }, report: { reviewConfirmed: true } }] });
  assert.equal(record.preparation.summary, '已保存');
  assert.equal(record.report.reviewConfirmed, true);
  assert.equal(storedRecord({ data: { preparation: { summary: '直接对象' } } }).preparation.summary, '直接对象');
  assert.equal(storedRecord({ data: [] }), null);
});

test('parsed text creates a stable document record', () => {
  const candidate = { id: 'candidate_12345678', tenantId: 'tenant_12345678', resume: '工作经历：负责后端服务开发，教育经历：本科', resumeMeta: { fileName: '演示.pdf' }, createdAt: '2026-10-27T00:00:00.000Z' };
  const first = buildLegacyDocument(candidate);
  const second = buildLegacyDocument(candidate);
  assert.equal(first.document.id, second.document.id);
  assert.equal(first.document.cleanedText.includes('工作经历'), true);
  assert.equal(first.candidatePatch.documentId, first.document.id);
});
