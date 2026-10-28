const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTranscriptContext, matchTranscriptToInterview } = require('./transcript-match');

test('speaker lines supply the interviewer and the dated interview time', () => {
  const context = extractTranscriptContext(
    '谢晓东_OTC交易产品经理(张明亮01安排) 20.11.00 12.58.46.docx',
    '15:15:39 会议已开启实时转写\n谭理 2026-10-20 15:30:11\n你好。\n张明亮 2026-10-20 15:30:16\n我稍后退出。\n谭理 2026-10-20 15:30:31\n晓东自我介绍一下。\n谢晓东 2026-10-20 15:31:00\n我是谢晓东。\n谢晓东 2026-10-20 15:32:00\n面试官你好。'
  );
  assert.equal(context.candidateName, '谢晓东');
  assert.equal(context.jobName, 'OTC交易产品经理');
  assert.equal(context.hrName, '张明亮01');
  assert.equal(context.interviewer, '谭理');
  assert.equal(context.interviewAt, '2026-10-20T15:30:11+08:00');
});

test('default download name is candidate, job, and arranging HR', () => {
  const context = extractTranscriptContext(
    '谢晓东_OTC交易产品经理(张明亮01安排) (2).txt',
    '魏欣欣 谢晓东 2026-10-18 14:30\n请介绍一个项目结果？',
    { interviewerNames: ['魏欣欣'] }
  );
  assert.equal(context.candidateName, '谢晓东');
  assert.equal(context.jobName, 'OTC交易产品经理');
  assert.equal(context.hrName, '张明亮01');
  assert.equal(context.interviewer, '魏欣欣');
  assert.equal(context.interviewAt, '2026-10-18T14:30:00+08:00');
});

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

test('OTC交易产品经理 is read from the file name ahead of the shorter title', () => {
  const context = extractTranscriptContext(
    '周宁-OTC交易产品经理-面试转写.txt',
    '魏欣欣 周宁 2026-10-18 14:30\n请介绍一个项目结果？',
    { interviewerNames: ['魏欣欣'] }
  );
  assert.equal(context.candidateName, '周宁');
  assert.equal(context.jobName, 'OTC交易产品经理');
  assert.equal(context.interviewer, '魏欣欣');
  assert.equal(context.interviewAt, '2026-10-18T14:30:00+08:00');
});

test('labeled interviewer still matches and the following clock is the interview time', () => {
  const context = extractTranscriptContext('周宁-交易产品经理.txt', '面试官：魏欣欣\n2026-09-18 14:30 开始\n周宁介绍项目。');
  assert.equal(context.candidateName, '周宁');
  assert.equal(context.jobName, '交易产品经理');
  assert.equal(context.interviewer, '魏欣欣');
  assert.equal(context.interviewAt, '2026-09-18T14:30:00+08:00');
});

test('a surname-only speaker is the candidate, and the other speaker is the interviewer', () => {
  const context = extractTranscriptContext(
    '黄元_券商服务端开发工程师（长沙）(刘冰南安排).docx',
    '2026-10-19 18:54:48 会议已开启实时转写，机器识别结果仅供参考\n胡亚辉 2026-10-19 18:59:10\n你好。\n黄 2026-10-19 18:59:13\n我是黄元。\n黄 2026-10-19 18:59:20\n继续说。'
  );
  assert.equal(context.candidateName, '黄元');
  assert.equal(context.jobName, '券商服务端开发工程师（长沙）');
  assert.equal(context.hrName, '刘冰南');
  assert.equal(context.interviewer, '胡亚辉');
  assert.equal(context.interviewAt, '2026-10-19T18:59:10+08:00');
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
