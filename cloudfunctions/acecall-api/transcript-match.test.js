const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTranscriptContext, matchTranscriptToInterview } = require('./transcript-match');

test('transcript file keeps interviewer, job and interview time', () => {
  const context = extractTranscriptContext('周宁-法务BP-面试转写.txt', '候选人：周宁\n面试官：魏欣欣\n应聘岗位：法务BP\n面试时间：2026-09-18 14:30\n发言人：请介绍一个项目结果？');
  assert.equal(context.candidateName, '周宁');
  assert.equal(context.interviewer, '魏欣欣');
  assert.equal(context.jobName, '法务BP');
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
