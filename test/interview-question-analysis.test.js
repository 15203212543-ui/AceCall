const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CLASSIFICATIONS, analyzeInterviewQuestions, classifyInterviewQuestions } = require('../cloudfunctions/acecall-api/interview-question-analysis');

const job = {
  id: 'job-cs',
  name: '券商服务端开发工程师',
  jd: '负责券商交易系统的方案设计与开发，工作地点为长沙。需要核实到岗时间和项目结果。',
  rules: '重点核实职责、结果和地点。',
  keywords: ['交易系统', '架构'],
  verify: ['地点', '到岗']
};

function session(text, extra = {}) {
  return { id: extra.id || 's1', interviewer: '胡亚辉', candidateName: '黄元', jobName: job.name, startedAt: '2026-10-20', text, ...extra };
}

function classes(result) {
  return result.items.map(item => item.classification);
}

test('uses one shared classification enum', () => {
  assert.deepEqual(CLASSIFICATIONS, ['communication_check', 'condition_check', 'job_question', 'needs_context']);
  const browser = fs.readFileSync('public/interview-questions.mjs', 'utf8');
  CLASSIFICATIONS.forEach(name => assert.match(browser, new RegExp(name)));
});

test('communication checks never become job questions', () => {
  const result = classifyInterviewQuestions({
    sessionCount: 1,
    job,
    sessions: [session('你好，可以听见吗？\n现在方便说话吗？\n信号可以吗？\n稍等一下\n我们开始录制\n你能看到共享屏幕吗？')]
  });
  assert.equal(result.excludedCommunicationCount, 6);
  assert.equal(result.items.some(item => item.classification === 'job_question'), false);
  assert.equal(result.items.some(item => /听见|方便说话|信号|稍等|录制|共享屏幕/.test(item.rawText)), false);
  const mixed = classifyInterviewQuestions({ sessionCount: 1, job, sessions: [session('稍等一下，架构的角色你可以举一个例子吗？')] });
  assert.equal(mixed.excludedCommunicationCount, 1);
  assert.match(mixed.items.find(item => item.classification === 'job_question').rawText, /例子/);
});

test('location questions stay condition checks and link only when the JD asks', () => {
  const linked = classifyInterviewQuestions({
    sessionCount: 2,
    job,
    sessions: [session('你现在人在哪里？\n深圳或者是长沙吗？')]
  });
  const locations = linked.items.filter(item => item.conditionType === 'location');
  assert.equal(locations.length, 2);
  assert.equal(locations.every(item => item.classification === 'condition_check'), true);
  assert.equal(locations.every(item => item.linkStatus === '岗位要求'), true);
  assert.equal(locations.some(item => item.normalizedText.includes('北京')), false);

  const generic = classifyInterviewQuestions({
    sessionCount: 1,
    job: { ...job, jd: '负责交易系统的接口设计和性能优化，不限定城市。', verify: [], rules: '' },
    sessions: [session('你现在人在哪里？')]
  });
  assert.equal(generic.items[0].linkStatus, '通用核验');
});

test('job questions keep the original ask and source session', () => {
  const result = classifyInterviewQuestions({
    sessionCount: 4,
    job,
    sessions: [session('面试官：架构的角色你可以举一个例子吗？\n候选人：我做过行情接入。\n面试官：你觉得最核心的差异是什么？')]
  });
  const questions = result.items.filter(item => item.classification === 'job_question');
  assert.equal(questions.length, 2);
  assert.equal(questions[0].sources[0].candidateName, '黄元');
  assert.match(questions[0].rawText, /例子/);
  assert.equal(questions.some(item => item.rawText.includes('行情接入')), false);
});

test('a short follow-up without a previous question stays needs_context', () => {
  const alone = classifyInterviewQuestions({ sessionCount: 1, job, sessions: [session('也是你们自己做吗？')] });
  assert.deepEqual(classes(alone), ['needs_context']);
  const merged = classifyInterviewQuestions({
    sessionCount: 1,
    job,
    sessions: [session('面试官：这个项目最终取得了什么结果？\n候选人：延迟下降了。\n面试官：也是你们自己做吗？')]
  });
  assert.equal(merged.items.some(item => item.rawText.includes('你们自己')), false);
  assert.match(merged.items.find(item => item.classification === 'job_question').mergedRaw.join(''), /你们自己/);
});

test('cross-line interviewer questions are kept and candidate lines are not', () => {
  const result = classifyInterviewQuestions({
    sessionCount: 1,
    job,
    sessions: [session('胡亚辉 2026-10-20 15:30:11\n你在交易系统中\n具体负责哪一部分？\n黄元 2026-10-20 15:31:00\n我负责行情，可以吗')]
  });
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].rawText, /负责哪一部分/);
  assert.equal(result.items[0].speaker, 'interviewer');
});

test('rejects invalid AI output and does not send communication lines to AI', async () => {
  const sessions = [session('你好，可以听见吗？\n这个说法你怎么看？', { id: 'boundary' })];
  const seen = [];
  const result = await analyzeInterviewQuestions({ sessionCount: 5, job, sessions }, async prompt => {
    seen.push(prompt.input);
    return { items: [
      { id: 'missing', classification: 'talent_score', evidenceQuote: '不存在的原句', normalizedQuestion: '是否接受北京？' },
      { id: JSON.parse(prompt.input).items[0].id, classification: 'later', evidenceQuote: '完全没问过', normalizedQuestion: '是否接受北京？' }
    ] };
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes('可以听见吗'), false);
  assert.equal(result.items.some(item => item.classification === 'job_question' && item.classificationSource === 'ai'), false);
  assert.equal(result.items.some(item => item.confidenceBasis === 'invalid_enum' || item.confidenceBasis === 'evidence_missing' || item.confidenceBasis === 'new_fact'), true);
});

test('sample size controls personal review and AI eligibility', () => {
  const sessions = [session('面试官：你在交易系统中具体负责哪一部分？')];
  for (const count of [1, 2, 4]) {
    const result = classifyInterviewQuestions({ sessionCount: count, job, sessions });
    assert.equal(result.sampleLimited, true);
    assert.equal(result.allowPersonalReview, false);
    assert.equal(result.followUpStyle, '');
    assert.equal(result.coverage, null);
  }
  for (const count of [5, 6]) {
    const ready = classifyInterviewQuestions({ sessionCount: count, job, sessions });
    assert.equal(ready.sampleLimited, false);
    assert.equal(ready.allowPersonalReview, true);
    assert.match(ready.followUpStyle, /岗位问题/);
    const unbound = classifyInterviewQuestions({ sessionCount: count, job: { name: job.name }, sessions });
    assert.equal(unbound.allowPersonalReview, false);
    assert.equal(unbound.items.some(item => item.classification === 'job_question' && item.confirmed), false);
  }
});

test('dedupe keeps every source session and human review overrides the class', () => {
  const first = classifyInterviewQuestions({
    sessionCount: 2,
    job,
    sessions: [
      session('你现在人在哪里？', { id: 'a', candidateName: '甲' }),
      session('你现在人在哪里？', { id: 'b', candidateName: '乙' })
    ]
  });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].sources.length, 2);
  const reviewed = classifyInterviewQuestions({
    sessionCount: 1,
    job,
    sessions: [session('也是你们自己做吗？')],
    humanReviews: [{ questionId: first.items[0] ? classifyInterviewQuestions({ sessionCount: 1, job, sessions: [session('也是你们自己做吗？')] }).items[0].id : '', classification: 'job_question', version: 2 }]
  });
  const target = classifyInterviewQuestions({ sessionCount: 1, job, sessions: [session('也是你们自己做吗？')] }).items[0];
  const after = classifyInterviewQuestions({
    sessionCount: 1,
    job,
    sessions: [session('也是你们自己做吗？')],
    humanReviews: [{ questionId: target.id, classification: 'condition_check', conditionType: 'location', version: 2 }]
  });
  assert.equal(after.items[0].classification, 'condition_check');
  assert.equal(after.items[0].classificationSource, 'human');
  assert.equal(after.items[0].version, 2);
  assert.equal(reviewed.items[0].classificationSource, 'human');
});

test('deepseek classifies one transcript and rejects a summary that adds a city', async () => {
  const sessions = [session('面试官：你在交易系统中具体负责哪一部分？')];
  const result = await analyzeInterviewQuestions({ sessionCount: 1, job, sessions }, async prompt => {
    const item = JSON.parse(prompt.input).items[0];
    assert.equal(prompt.input.includes('可以听见吗'), false);
    return {
      summary: '提问集中在交易系统中的职责范围。',
      followUpStyle: '是否接受北京？',
      items: [{ id: item.id, classification: 'job_question', evidenceQuote: '具体负责哪一部分', normalizedQuestion: item.rawText, reasonCode: 'job_cue' }]
    };
  });
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.summary, '提问集中在交易系统中的职责范围。');
  assert.equal(result.followUpStyle, '');
  assert.equal(result.items[0].classificationSource, 'ai');
});

test('communication lines are not sent to deepseek even for a single transcript', async () => {
  let called = false;
  const result = await analyzeInterviewQuestions({
    sessionCount: 1,
    job,
    sessions: [session('你好，可以听见吗？')]
  }, async () => { called = true; return { items: [] }; });
  assert.equal(called, false);
  assert.equal(result.provider, undefined);
  assert.equal(result.items.some(item => item.classification === 'job_question'), false);
});

test('multiple jobs are not treated as one JD', () => {
  const result = classifyInterviewQuestions({
    sessionCount: 5,
    job,
    sessions: [
      session('面试官：你在交易系统中具体负责哪一部分？', { jobName: '券商服务端开发工程师' }),
      session('面试官：你在交易系统中具体负责哪一部分？', { id: 's2', jobName: '客服主管' })
    ]
  });
  assert.equal(result.jobBound, false);
  assert.equal(result.allowPersonalReview, false);
});
