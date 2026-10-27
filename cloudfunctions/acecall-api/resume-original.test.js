const test = require('node:test');
const assert = require('node:assert/strict');
const { resumeMimeType, originalResumeCloudPath, originalResumeMeta, retainOriginalResume } = require('./resume-original');

test('resume original metadata uses the file type and cloud file id', () => {
  assert.equal(resumeMimeType('林夏.pdf'), 'application/pdf');
  assert.equal(resumeMimeType('resume.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const meta = originalResumeMeta('林夏.pdf', Buffer.from('pdf'), 'cloud://env/acecall/resumes/file.pdf');
  assert.equal(meta.originalFileId, 'cloud://env/acecall/resumes/file.pdf');
  assert.equal(meta.originalFileName, '林夏.pdf');
  assert.equal(meta.originalMimeType, 'application/pdf');
  assert.equal(meta.originalFileSize, 3);
});

test('original resume cloud path stays inside the tenant inbox', () => {
  const cloudPath = originalResumeCloudPath('tenant_1', '../林夏 简历.pdf', 10, 'ab');
  assert.equal(cloudPath.startsWith('acecall/resumes/tenant_1/inbox/'), true);
  assert.equal(cloudPath.includes('..'), false);
});

test('later saves keep a stored original when the new payload omits it', () => {
  const stored = { phone: '13800000000', originalFileId: 'cloud://file', originalFileName: 'a.pdf', originalMimeType: 'application/pdf', originalFileSize: 8 };
  const kept = retainOriginalResume({ phone: '13800000000', fileName: 'a.pdf' }, stored);
  assert.equal(kept.originalFileId, 'cloud://file');
  assert.equal(kept.fileName, 'a.pdf');
  const replaced = retainOriginalResume({ originalFileId: 'cloud://new', originalFile: { name: 'b.pdf' } }, stored);
  assert.equal(replaced.originalFileId, 'cloud://new');
  assert.equal(replaced.originalFile, undefined);
  assert.deepEqual(retainOriginalResume(undefined, stored).originalFileId, 'cloud://file');
});
