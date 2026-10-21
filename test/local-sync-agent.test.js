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

test('local sync agent treats arranged download names as transcripts', () => {
  const { isTranscriptFileName } = require('../local-sync-agent');
  assert.equal(isTranscriptFileName('/tmp/谢晓东_OTC交易产品经理(张明亮01安排) (2).docx'), true);
  assert.equal(isTranscriptFileName('/tmp/谢晓东_OTC交易产品经理(张明亮01安排) 20.11.00 12.58.46.docx'), true);
  assert.equal(isTranscriptFileName('/tmp/【证券产品经理】谢先生.pdf'), false);
});

test('local sync agent recognizes interview transcripts', () => {
  const { looksLikeTranscript } = require('../local-sync-agent');
  assert.equal(looksLikeTranscript('/tmp/周宁-面试转写.txt', '候选人：周宁\n面试官：魏欣欣\n请介绍项目结果？'), true);
  assert.equal(looksLikeTranscript('/tmp/interview.vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\n请介绍一个你负责的项目。'), true);
  assert.equal(looksLikeTranscript('/tmp/notes.txt', '会议纪要：下周一开会讨论项目进度和负责人安排'), false);
});

test('local sync agent file key changes when the file changes', () => {
  assert.notEqual(fileKey('/tmp/resume.pdf', { size: 10, mtimeMs: 1 }), fileKey('/tmp/resume.pdf', { size: 11, mtimeMs: 1 }));
});
