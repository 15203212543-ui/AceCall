const test = require('node:test');
const assert = require('node:assert/strict');
const { selectMokaFeedbacks, summarizeMokaFeedback } = require('./moka-feedback');

test('interview feedback uses resultName and keeps 待定 pending', () => {
  const passed = summarizeMokaFeedback({}, [{ resultName: '通过', resultType: '1', feedback: '专业能力匹配', interviewerName: '魏欣欣', roundName: '初试' }]);
  assert.equal(passed.interviewPassed, true);
  assert.equal(passed.interviewRejected, false);
  assert.match(passed.feedback, /专业能力匹配/);

  const rejected = summarizeMokaFeedback({}, [{ resultName: '淘汰', resultType: '0', feedback: '经验不足' }]);
  assert.equal(rejected.interviewPassed, false);
  assert.equal(rejected.interviewRejected, true);

  const pending = summarizeMokaFeedback({}, [{ resultName: '待定', resultType: '1', feedback: '需要复试' }]);
  assert.equal(pending.interviewPassed, null);
  assert.equal(pending.interviewRejected, null);
  assert.equal(pending.outcome, '待定');

  const typedReject = summarizeMokaFeedback({}, [{ resultType: '0' }]);
  assert.equal(typedReject.outcome, '淘汰');
  assert.equal(typedReject.interviewRejected, true);

  const notPassed = summarizeMokaFeedback({}, [{ resultName: '不通过' }]);
  assert.equal(notPassed.interviewPassed, false);
  assert.equal(notPassed.interviewRejected, true);
});

test('feedback joins the matching round instead of another round on the same application', () => {
  const pool = [
    { applicationId: '1', interviewerName: '魏欣欣', roundName: '初试', startTime: '2026-10-01T10:00:00.000Z', resultName: '通过', feedback: '初试通过' },
    { applicationId: '1', interviewerName: '李明', roundName: '复试', startTime: '2026-10-08T10:00:00.000Z', resultName: '淘汰', feedback: '复试淘汰' }
  ];
  const selected = selectMokaFeedbacks({ interviewer: '李明', round: '复试', startedAt: '2026-10-08T10:00:00.000Z' }, pool);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].resultName, '淘汰');
});
