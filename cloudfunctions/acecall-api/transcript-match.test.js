const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTranscriptContext, matchTranscriptToInterview } = require('./transcript-match');

test('filename supplies candidate and job, body supplies interviewer and the time after the names', () => {
  const context = extractTranscriptContext(
    '周宁-法务BP-面试转写.txt',
    '魏欣欣 周宁 2026-09-18 14:30\n请介绍一个项目结果？',
    { interviewerNames: ['魏欣欣', '李明'] }
  );
  assert.equal(context.candidateName, '周宁');
  assert.equal(context.jobName, '法务BP');
  assert.equal(context.interviewer, '魏欣欣');
  assert.equal(context.interviewAt, '2026-09-18T14:30:00+08:00');
});

test('labeled interviewer still matches and the following clock is the interview time', () => {
  const context = extractTranscriptContext('周宁-交易产品经理.txt', '面试官：魏欣欣\n2026-09-18 14:30 开始\n周宁介绍项目。');
  assert.equal(context.candidateName, '周宁');
  assert.equal(context.jobName, '交易产品经理');
  assert.equal(context.interviewer, '魏欣欣');
  assert.equal(context.interviewAt, '2026-09-18T14:30:00+08:00');
});

test('transcript matches the interview with the same candidate, job and time', () => {
  const interviews = [
    { source: 'moka', candidateName: '周宁', jobName: '法务BP', interviewer: '魏欣欣', startedAt: '2026-08-01T10:00:00+08:00', id: 'old' },
    { source: 'moka', candidateName: '周宁', jobName: '法务BP', interviewer: '魏欣欣', startedAt: '2026-09-18T14:30:00+08:00', id: 'target' },
    { source: 'moka', candidateName: '李明', jobName: '法务BP', interviewer: '魏欣欣', startedAt: '2026-09-18T14:30:00+08:00', id: 'other' }
  ];
  const matched = matchTranscriptToInterview({ candidateName: '周宁', jobName: '法务BP', interviewer: '魏欣欣', interviewAt: '2026-09-18T14:30:00+08:00' }, interviews);
  assert.equal(matched.id, 'target');
});
