const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeNameCandidates, chooseDisplayedName, extractProfileFields } = require('../cloudfunctions/acecall-api/resume-profile');
const { evaluateJobMatches, confirmJobProfile, draftJobProfile, applyJobAssignment } = require('../cloudfunctions/acecall-api/job-assignment');
const { buildCallQuestions } = require('../cloudfunctions/acecall-api/call-preparation');
const { bindTranscriptIdentity, splitSpeakerTurns, extractTranscriptFindings, checkCallSummary, checkSynthesis, protectInterviewerReview } = require('../cloudfunctions/acecall-api/transcript-analysis');
const { mergeTranscriptMetadata } = require('../cloudfunctions/acecall-api/transcript-match');
const { screeningWritePlan } = require('../cloudfunctions/acecall-api/moka-client');
const { internalCluesFromFacts, externalReport, rubricFromCorrections } = require('../cloudfunctions/acecall-api/industry-signals');
const { buildAiTaskRecord } = require('../cloudfunctions/acecall-api/ai-task');

test('name candidates keep their source and only a clear field is recognized', () => {
  const strong = chooseDisplayedName(proposeNameCandidates({ labeled: '示例甲', fromFile: '示例乙' }));
  assert.equal(strong.candidateName, '示例甲');
  assert.equal(strong.candidateNameStatus, '已识别');
  const weak = chooseDisplayedName(proposeNameCandidates({ fromFile: '示例乙' }));
  assert.equal(weak.candidateNameStatus, '待确认');
  assert.equal(proposeNameCandidates({ labeled: '示例甲', contextual: '示例乙', fromFile: '示例丙', fromBody: '示例丁' }).length, 3);
});

test('profile fields keep evidence and age cannot change a match', () => {
  const profile = extractProfileFields('姓名：示例甲\n示例大学\n硕士\n证券从业\n2020-2024 示例证券 做市交易员\n年龄：45岁');
  assert.equal(profile.school, '示例大学');
  assert.equal(profile.education, '硕士');
  assert.deepEqual(profile.certificates, ['证券从业']);
  assert.equal(profile.experiences[0].company, '示例证券');
  const dotted = extractProfileFields('2019.03-2022.06 示例证券 做市交易员');
  assert.equal(dotted.experiences[0].company, '示例证券');
  assert.equal(dotted.experiences[0].title, '做市交易员');
  assert.equal(profile.age.usedForMatch, false);
  const jobs = [{ id: 'job-1', name: '做市', status: 'active', keywords: ['做市'], exclusions: [] }];
  const younger = evaluateJobMatches({ resume: '做过做市\n年龄：25岁', jobs });
  const older = evaluateJobMatches({ resume: '做过做市\n年龄：45岁', jobs });
  assert.equal(younger.status, older.status);
  assert.equal(younger.jobId, older.jobId);
});

test('job decision uses required evidence and keeps a confirmed snapshot', () => {
  const jobs = [
    { id: 'job-a', name: '做市', status: 'active', keywords: ['做市'], bonus: ['期权'] },
    { id: 'job-b', name: '研究', status: 'active', keywords: ['研究'], exclusions: ['在校'] }
  ];
  const matched = evaluateJobMatches({ resume: '负责做市', jobs });
  assert.equal(matched.status, '自动匹配');
  assert.equal(matched.jobId, 'job-a');
  assert.equal(matched.results[0].items.find(item => item.item === '做市').state, '命中');
  const pending = evaluateJobMatches({ resume: '只写了行业兴趣', jobs: [jobs[0]] });
  assert.equal(pending.status, '无法匹配');
  const both = evaluateJobMatches({ resume: '做过做市，也做过研究', jobs });
  assert.equal(both.status, '多岗位候选');
  assert.equal(both.jobId, '');
  const blocked = evaluateJobMatches({ resume: '在校研究', jobs: [jobs[1]] });
  assert.equal(blocked.status, '无法匹配');
  const confirmed = confirmJobProfile(draftJobProfile(jobs[0]), 'recruiter@example.com', '2026-10-22T00:00:00.000Z');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.snapshot.required[0], '做市');
  const candidate = {};
  applyJobAssignment(candidate, jobs, { result: { jobId: 'job-a', status: '待确认' } });
  assert.equal(candidate.jobId, '');
  assert.equal(candidate.matching.status, '待确认');
});

test('call questions come only from pending, conflicts, required items and manual prompts', () => {
  const questions = buildCallQuestions({
    profile: { verify: ['到岗'] },
    items: [{ item: '做市', state: '命中', role: '必备' }, { item: '规模', state: '待核验', role: '必备' }, { item: '公司', state: '冲突', role: '必备' }],
    manual: ['请补充可到岗城市']
  });
  assert.deepEqual(questions.map(item => item.source), ['待核验', '冲突', '必备', '人工配置']);
  assert.equal(questions.some(item => item.question.includes('做市')), false);
});

test('transcript identity prefers Moka, splits speakers and checks evidence', () => {
  const bound = bindTranscriptIdentity({ metadata: { source: 'moka', candidateName: '示例甲', jobName: '做市' }, fileName: '另一个人_研究（张三安排）.txt' });
  assert.equal(bound.identitySource, 'moka_record');
  assert.equal(bound.candidateName, '示例甲');
  const merged = mergeTranscriptMetadata({ source: 'moka', candidateName: '示例甲', jobName: '做市' }, '另一个人_研究（张三安排）.txt', '');
  assert.equal(merged.candidateName, '示例甲');
  assert.equal(merged.identitySource, 'moka_record');
  const turns = splitSpeakerTurns('面试官：到岗时间？\n候选人：不清楚。\n后面没标名字');
  assert.equal(turns.at(-1).speaker, '未识别说话人');
  assert.equal(turns.at(-1).weight, 0.4);
  const findings = extractTranscriptFindings('面试官：到岗时间？\n候选人：不清楚。', '简历写了研究');
  assert.equal(findings.unanswered.length, 1);
  const summary = checkCallSummary({ confirmed: [{ item: '到岗', evidence: '这句话不在转写里' }] }, '候选人只说了在职');
  assert.equal(summary.confirmed.length, 0);
  assert.equal(summary.pendingEvidence[0].status, 'pending');
  const report = checkSynthesis({ conclusion: '随便写', capabilities: [{ item: '做市', evidence: '没说过' }] }, '候选人在职');
  assert.equal(report.conclusion, '信息不足');
  assert.equal(report.capabilities[0].assessment, '信息不足');
});

test('small samples hide evaluation and Moka notes stay idempotent', () => {
  const limited = protectInterviewerReview({ summary: '个人评价', followUpStyle: '建议改变提问', questions: ['结果怎么衡量？'] }, 4);
  assert.equal(limited.sampleLimited, true);
  assert.equal(limited.summary, '');
  assert.equal(limited.followUpStyle, '');
  assert.deepEqual(limited.questions, ['结果怎么衡量？']);
  const record = { reviewConfirmed: false, report: { conclusion: '推荐' }, communicationSummary: { overview: '在职' } };
  assert.equal(screeningWritePlan(record).action, 'draft');
  const decision = { ...record, reviewConfirmed: true, report: { ...record.report, reviewDecisionId: 'rd_same' } };
  assert.equal(screeningWritePlan(decision).action, 'write');
  assert.equal(screeningWritePlan(decision, { status: '已同步', reviewDecisionId: 'rd_same' }).action, 'skip');
});

test('industry clues stay internal and corrections become a rubric', () => {
  const clues = internalCluesFromFacts([{ status: 'confirmed', factType: 'company', value: '示例证券', evidences: [{ quote: '在示例证券做市', verified: 'exact' }] }, { status: 'pending', factType: 'company', value: '另一家', evidences: [{ quote: '听说', verified: 'failed' }] }]);
  assert.deepEqual(clues.map(item => item.clue), ['示例证券']);
  const report = externalReport({ conclusion: '部分匹配', internalClues: clues, industrySignals: ['增长'] });
  assert.equal(report.internalClues, undefined);
  assert.equal(report.industrySignals, undefined);
  assert.equal(report.conclusion, '部分匹配');
  const rubric = rubricFromCorrections([{ item: '做市规模', corrected: true, from: '命中', to: '待核验', promoteToRequired: true, followUp: '请追问做市规模' }]);
  assert.deepEqual(rubric.required, ['做市规模']);
  assert.equal(rubric.followUpTemplates[0], '请追问做市规模');
});

test('ai task records hash duration and error without storing the resume', () => {
  const record = buildAiTaskRecord({ action: 'match', payload: { resume: '姓名：示例甲' }, result: { status: '待确认' }, startedAt: Date.now() - 20 });
  assert.equal(record.promptVersion, 'ai-foundation-v3');
  assert.equal(record.inputHash.length, 64);
  assert.equal(JSON.stringify(record).includes('示例甲'), false);
  assert.equal(record.status, 'succeeded');
  const failed = buildAiTaskRecord({ action: 'match', payload: {}, error: new Error('模型超时') });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /模型超时/);
});
