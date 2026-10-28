import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTranscript, scoreInterviewSelection } from '../public/interview-signal.mjs';

test('communication lines do not count as interview questions', () => {
  const signal = analyzeTranscript('面试官：你好，可以听见吗？\n面试官：现在方便说话吗？');
  assert.deepEqual(signal, { questions: 0, followUps: 0 });
});

test('a result question after the candidate answers counts as a follow-up', () => {
  const signal = analyzeTranscript('面试官：你在交易系统里负责哪一块？\n候选人：我负责行情接入和订单状态。\n面试官：上线结果怎么衡量？');
  assert.equal(signal.questions, 2);
  assert.equal(signal.followUps, 1);
});

test('scores follow the selected interviewer and keep evaluation rate', () => {
  const records = Array.from({ length: 5 }, (_, index) => ({
    completed: true,
    interviewer: '胡亚辉',
    jobName: '券商后端',
    transcript: index < 4 ? '面试官：你负责过结算吗？\n候选人：负责过港股结算。\n面试官：上线结果怎么衡量？' : '',
    interviewPassed: index < 3
  }));
  const selected = scoreInterviewSelection(records, { interviewer: '胡亚辉' });
  assert.equal(selected.scope, '胡亚辉');
  assert.equal(selected.limited, false);
  assert.equal(selected.coverage, 100);
  assert.equal(selected.completeness, 60);
  assert.equal(selected.score > 0, true);
  assert.equal(scoreInterviewSelection(records, { job: '券商后端' }).scope, '券商后端');
  assert.equal(scoreInterviewSelection(records, {}).scope, '当前筛选整体');
});

test('fewer than five interviews does not produce a score', () => {
  const result = scoreInterviewSelection([{ completed: true, transcript: '面试官：你负责过结算吗？', outcome: '通过' }], {});
  assert.equal(result.limited, true);
  assert.equal(result.score, null);
  assert.equal(result.completeness, 100);
});
