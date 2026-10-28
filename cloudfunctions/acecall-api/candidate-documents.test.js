const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeStoredCandidate, buildLegacyDocument, storedRecord } = require('./candidate-documents');

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
