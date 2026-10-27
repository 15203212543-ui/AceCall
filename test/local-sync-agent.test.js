const fs = require('node:fs');
const path = require('node:path');
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
  const resume = '姓名 简历\n项目经历：Candidate Engagement & Interview Scheduling，负责候选人沟通。\n学历：本科';
  assert.equal(looksLikeTranscript('/tmp/【人力管培_北京 12-24K】应届生.pdf', resume), false);
  assert.equal(looksLikeResume(resume), true);
  assert.equal(looksLikeTranscript('/tmp/notes.docx', '2026-10-22 14:00:38 会议已开启实时转写,机器识别结果仅供参考\n请介绍一个你负责的项目。'), true);
  const { looksLikeTranscript: desktopLooksLikeTranscript } = require('../desktop-app/local-sync-agent');
  assert.equal(desktopLooksLikeTranscript('/tmp/【人力管培_北京 12-24K】应届生.pdf', resume), false);
});

test('desktop app bundles job assignment and can load without the cloud function directory', () => {
  const root = path.join(__dirname, '..');
  const agent = fs.readFileSync(path.join(root, 'desktop-app/local-sync-agent.js'), 'utf8');
  assert.equal(agent.includes("require('../cloudfunctions/"), false);
  assert.equal(fs.readFileSync(path.join(root, 'desktop-app/job-assignment.js'), 'utf8'), fs.readFileSync(path.join(root, 'cloudfunctions/acecall-api/job-assignment.js'), 'utf8'));
  const { SyncAgent } = require('../desktop-app/local-sync-agent');
  const candidate = { jobId: 'old', roleName: '旧岗位' };
  const { applyJobAssignment } = require('../desktop-app/job-assignment');
  applyJobAssignment(candidate, [{ id: 'job-1', name: '法务BP', status: 'active' }], { result: { jobId: '', status: '无法匹配' } });
  assert.equal(candidate.jobId, '');
  assert.equal(candidate.ingestStatus, '无法匹配');
  assert.equal(typeof SyncAgent, 'function');
});

test('desktop sync skips files already present when listening starts', async () => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acecall-sync-'));
  const existing = path.join(root, 'existing.pdf');
  fs.writeFileSync(existing, Buffer.alloc(2048));
  const { SyncAgent, fileKey: desktopFileKey } = require('../desktop-app/local-sync-agent');
  const agent = new SyncAgent({ directory: root, statePath: path.join(root, 'state.json'), interval: 600000, once: true, apiBase: '' });
  await agent.start();
  const key = desktopFileKey(existing, fs.statSync(existing));
  assert.equal(agent.state.baseline.includes(key), true);
  assert.equal(agent.state.imported[key], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('local sync agent file key changes when the file changes', () => {
  assert.notEqual(fileKey('/tmp/resume.pdf', { size: 10, mtimeMs: 1 }), fileKey('/tmp/resume.pdf', { size: 11, mtimeMs: 1 }));
});
