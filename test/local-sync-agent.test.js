const test = require('node:test');
const assert = require('node:assert/strict');
const { platformPolicy, isCandidateFile, looksLikeResume, fileKey } = require('../local-sync-agent');

test('local sync agent exposes the current platform policy', () => {
  const policy = platformPolicy();
  assert.ok(['mac', 'windows', 'other'].includes(policy.platform));
  assert.equal(typeof policy.defaultDirectory, 'string');
});

test('local sync agent filters supported resume files and temporary downloads', () => {
  assert.equal(isCandidateFile('/tmp/a.pdf', { isFile: () => true, size: 2048 }), true);
  assert.equal(isCandidateFile('/tmp/a.crdownload', { isFile: () => true, size: 2048 }), false);
  assert.equal(isCandidateFile('/tmp/a.pdf', { isFile: () => true, size: 10 }), false);
});

test('local sync agent recognizes resume-like text', () => {
  assert.equal(looksLikeResume('个人信息 姓名：张三 工作经历：某证券公司 教育经历：本科'), true);
  assert.equal(looksLikeResume('会议纪要：下周一开会讨论项目'), false);
});

test('local sync agent file key changes when the file changes', () => {
  assert.notEqual(fileKey('/tmp/resume.pdf', { size: 10, mtimeMs: 1 }), fileKey('/tmp/resume.pdf', { size: 11, mtimeMs: 1 }));
});
