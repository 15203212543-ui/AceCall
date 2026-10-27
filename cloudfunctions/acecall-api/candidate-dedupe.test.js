const test = require('node:test');
const assert = require('node:assert/strict');
const { duplicateReason, findDuplicateCandidate } = require('./candidate-dedupe');

const resume = (id, meta = {}, extra = {}) => ({ id, candidateName: extra.candidateName || '候选人', resumeMeta: meta, ...extra });

test('same normalized phone identifies an existing candidate', () => {
  assert.equal(duplicateReason(resume('new', { phone: '+86 138-0013-8000' }), resume('old', { phone: '13800138000' })), 'phone');
});

test('same normalized email identifies an existing candidate', () => {
  assert.equal(duplicateReason(resume('new', { email: 'Name@Example.com ' }), resume('old', { email: 'name@example.com' })), 'email');
});

test('file fingerprint is used only when both records lack contact details', () => {
  const fingerprint = { fileName: ' 张三简历.PDF ', originalSize: 2048, characters: 900 };
  assert.equal(duplicateReason(resume('new', fingerprint), resume('old', { fileName: '张三简历.pdf', originalSize: 2048, characters: 900 })), 'resume-file');
  assert.equal(duplicateReason(resume('new', { ...fingerprint, phone: '13800138000' }), resume('old', fingerprint)), '');
});

test('same name alone is not a duplicate and the current id is excluded', () => {
  assert.equal(duplicateReason(resume('new', {}, { candidateName: '张伟' }), resume('old', {}, { candidateName: '张伟' })), '');
  assert.equal(findDuplicateCandidate(resume('same', { email: 'a@b.com' }), [resume('same', { email: 'a@b.com' })], 'same'), null);
});

test('the oldest matching record is selected as the canonical candidate', () => {
  const found = findDuplicateCandidate(resume('new', { phone: '13800138000' }), [
    resume('later', { phone: '13800138000' }, { createdAt: '2026-10-27T07:00:00Z' }),
    resume('earlier', { phone: '13800138000' }, { createdAt: '2026-10-27T06:00:00Z' })
  ], 'new');
  assert.equal(found.candidate.id, 'earlier');
});
