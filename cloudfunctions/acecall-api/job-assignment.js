const ASSIGNABLE = new Set(['已分配', '自动匹配']);
const ASSIGNMENT_STATUSES = new Set(['自动匹配', '待确认', '多岗位候选', '无法匹配', '待分配', '已分配']);
const ITEM_STATES = new Set(['命中', '待核验', '未发现', '冲突']);

function resolveJobAssignment({ jobs = [], match = {} } = {}) {
  const active = jobs.filter(job => job && job.id && job.status !== 'archived');
  const result = match.result && typeof match.result === 'object' ? match.result : (match || {});
  const job = active.find(item => item.id === result.jobId) || null;
  const status = ASSIGNMENT_STATUSES.has(String(result.status || '')) ? String(result.status) : '待分配';
  if (!job || !ASSIGNABLE.has(status)) {
    return {
      assigned: false,
      job: null,
      ingestStatus: status === '待分配' ? '已解析待分配' : status,
      matching: { ...result, jobId: '', status }
    };
  }
  return {
    assigned: true,
    job,
    ingestStatus: '已入库',
    matching: { ...result, jobId: job.id, status }
  };
}

function applyJobAssignment(candidate, jobs, match) {
  const decision = resolveJobAssignment({ jobs, match });
  candidate.matching = decision.matching;
  candidate.ingestStatus = decision.ingestStatus;
  if (!decision.assigned) {
    candidate.jobId = '';
    candidate.roleName = '';
    candidate.jd = '';
    candidate.rules = '';
    candidate.keywords = [];
    return candidate;
  }
  candidate.jobId = decision.job.id;
  candidate.roleName = decision.job.name || '';
  candidate.jd = decision.job.jd || '';
  candidate.rules = decision.job.rules || '';
  candidate.keywords = decision.job.keywords || [];
  return candidate;
}

function applyUploadedResumeAssignment(candidate, jobs = []) {
  const fileName = candidate.resumeMeta?.fileName || candidate.resumeMeta?.originalFileName || '';
  const decision = evaluateJobMatches({
    resume: candidate.resume || '',
    fileName,
    jobs
  });
  applyJobAssignment(candidate, jobs, decision);
  candidate.assignmentSource = decision.matchingBasis || 'automatic';
  candidate.assignmentStatus = decision.status;
  return candidate;
}

function unique(values = []) {
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function draftJobProfile(job = {}) {
  return {
    version: Number(job.profileVersion || job.profile?.version || 1),
    status: 'draft',
    required: unique(job.required || job.profile?.required || job.keywords || []),
    bonus: unique(job.bonus || job.profile?.bonus || []),
    exclusions: unique(job.exclusions || job.profile?.exclusions || []),
    verify: unique(job.verify || job.profile?.verify || ['地点', '薪资', '到岗', '竞业']),
    rules: String(job.rules || job.profile?.rules || ''),
    confirmedBy: ''
  };
}

function confirmJobProfile(profile, actor, now = new Date().toISOString()) {
  const snapshot = { ...profile, status: 'confirmed', confirmedBy: actor, confirmedAt: now };
  return { ...snapshot, version: Number(profile.version || 1) + 1, snapshot };
}

function resumeForMatch(resume = '') {
  return String(resume || '').split('\n').filter(line => !/(?:年龄|Age)\s*[:：]?|\d{1,2}\s*岁/.test(line)).join('\n');
}

function normalizeForMatch(value = '') {
  return String(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

const LOCATIONS = ['北京', '上海', '深圳', '广州', '长沙', '杭州', '成都', '武汉', '南京', '苏州', '西安', '香港'];
const ROLE_FAMILIES = [
  ['legal', /法务|legal/i],
  ['hr', /人力|人事|招聘|hrbp|hr管培/i],
  ['settlement', /清结算|结算/],
  ['quant', /量化/],
  ['backend', /后端|服务端|后台开发/],
  ['risk-development', /风控开发/],
  ['risk', /风控/],
  ['product', /产品总监|产品负责人|产品专家|产品经理|产品岗/],
  ['analytics', /数据分析|商业分析|数据岗|\bbi\b/i],
  ['operations', /运营/],
  ['trading', /交易员/],
  ['testing', /测试工程师|测试开发/],
  ['design', /设计师|视觉设计|交互设计/]
];

function locationFrom(value = '') {
  return LOCATIONS.find(location => String(value).includes(location)) || '';
}

function roleFamily(value = '') {
  return ROLE_FAMILIES.find(([, pattern]) => pattern.test(String(value)))?.[0] || '';
}

function rawRoleTitle(value = '') {
  return normalizeForMatch(String(value).replace(/\.[a-z0-9]{1,6}$/i, ''));
}

function canonicalRoleTitle(value = '') {
  return normalizeForMatch(String(value)
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/[（(](?:北京|上海|深圳|广州|长沙|杭州|成都|武汉|南京|苏州|西安|香港|港美股)[）)]/g, '')
    .replace(/服务端|后台开发/g, '后端')
    .replace(/券商业务|券商|证券系统/g, '')
    .replace(/工程师|职位|岗位/g, ''));
}

function filenameTitleSignal(fileName = '', job = {}) {
  const fileRaw = rawRoleTitle(fileName);
  const jobRaw = rawRoleTitle(job.name);
  const fileLocation = locationFrom(fileName);
  const jobLocation = locationFrom(`${job.name || ''} ${job.location || ''}`);
  if (!fileRaw || !jobRaw || (fileLocation && jobLocation && fileLocation !== jobLocation)) return 0;
  if (fileRaw.includes(jobRaw)) return 100;
  const fileCanonical = canonicalRoleTitle(fileName);
  const jobCanonical = canonicalRoleTitle(job.name);
  if (jobCanonical.length >= 3 && fileCanonical.includes(jobCanonical)) return 92 + (fileLocation && jobLocation === fileLocation ? 4 : 0);
  return 0;
}

function dedupeJobs(jobs = []) {
  const uniqueJobs = new Map();
  for (const job of jobs.filter(job => job && job.id && job.status !== 'archived' && job.status !== 'closed')) {
    const key = `${rawRoleTitle(job.name)}:${locationFrom(`${job.name || ''} ${job.location || ''}`)}`;
    if (!uniqueJobs.has(key)) uniqueJobs.set(key, job);
  }
  return [...uniqueJobs.values()];
}

function matchableTerms(value = '') {
  const text = String(value || '');
  const terms = text.match(/[a-zA-Z][a-zA-Z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
  return unique(terms.flatMap(term => {
    if (!/[\u4e00-\u9fff]/.test(term) || term.length <= 4) return [term];
    return [term, ...Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))];
  })).filter(term => !/^(负责|岗位|工作|要求|相关|经验|能力|优先|以上|以及|进行|完成|公司|团队)$/.test(term));
}

function termMatch(item, text) {
  const normalizedItem = normalizeForMatch(item);
  const normalizedText = normalizeForMatch(text);
  if (!normalizedItem || !normalizedText) return false;
  if (normalizedText.includes(normalizedItem)) return true;
  const parts = matchableTerms(item).map(normalizeForMatch).filter(part => part.length >= 2);
  return parts.length > 1 && parts.filter(part => normalizedText.includes(part)).length / parts.length >= 0.6;
}

function classifyRequirement(item, resume, conflicts = []) {
  const conflict = conflicts.find(entry => String(entry.topic || entry.item || '').includes(item));
  if (conflict) return { item, state: '冲突', evidence: String(conflict.evidence || conflict.callEvidence || ''), role: '必备' };
  if (termMatch(item, resume)) return { item, state: '命中', evidence: item, role: '必备' };
  return { item, state: '未发现', evidence: '', role: '必备' };
}

function evaluateJob(resume, job, conflicts = []) {
  const profile = job.profile?.status === 'confirmed' ? job.profile : draftJobProfile(job);
  const text = resumeForMatch(resume);
  const exclusions = profile.exclusions.filter(item => termMatch(item, text)).map(item => ({ item, state: '命中', evidence: item, role: '排除' }));
  if (exclusions.length) return { jobId: job.id, name: job.name || '', status: '无法匹配', items: exclusions, score: 0, snapshot: profile };
  const required = profile.required.map(item => classifyRequirement(item, text, conflicts));
  const pendingItems = profile.verify.map(item => ({ item, state: termMatch(item, text) ? '命中' : '待核验', evidence: termMatch(item, text) ? item : '', role: '待核验' }));
  const bonus = profile.bonus.map(item => ({ item, state: termMatch(item, text) ? '命中' : '未发现', evidence: termMatch(item, text) ? item : '', role: '加分' }));
  const hits = required.filter(item => item.state === '命中');
  const blocked = required.filter(item => item.state === '未发现' || item.state === '冲突');
  const requiredCoverage = required.length ? hits.length / required.length : 0;
  const bonusHits = bonus.filter(item => item.state === '命中').length;
  const bonusCoverage = bonus.length ? bonusHits / bonus.length : 0;
  const relevanceTerms = unique([...(matchableTerms(job.name)), ...(matchableTerms(job.industry)), ...(matchableTerms(job.jd))]).slice(0, 40);
  const relevanceHits = relevanceTerms.filter(term => termMatch(term, text));
  const relevanceCoverage = relevanceTerms.length ? relevanceHits.length / relevanceTerms.length : 0;
  const availableWeight = (required.length ? 60 : 0) + (bonus.length ? 10 : 0) + (relevanceTerms.length ? 30 : 0);
  const weightedScore = requiredCoverage * 60 + bonusCoverage * 10 + relevanceCoverage * 30;
  const score = Math.max(0, Math.min(100, Math.round(availableWeight ? weightedScore / availableWeight * 100 : 0)));
  let status = score >= 60 ? '自动匹配' : score >= 45 ? '待确认' : '无法匹配';
  if (blocked.some(item => item.state === '冲突')) status = '待确认';
  return { jobId: job.id, name: job.name || '', status, items: [...required, ...pendingItems, ...bonus], score, dimensions: { requiredCoverage: Math.round(requiredCoverage * 100), bonusCoverage: Math.round(bonusCoverage * 100), relevanceCoverage: Math.round(relevanceCoverage * 100) }, evidenceTerms: relevanceHits.slice(0, 8), snapshot: profile };
}

function evaluateJobMatches({ resume = '', fileName = '', jobs = [], conflicts = [] } = {}) {
  const active = dedupeJobs(jobs);
  const filenameFamily = roleFamily(fileName);
  const results = active.map(job => {
    const evaluated = evaluateJob(resume, job, conflicts);
    const titleScore = filenameTitleSignal(fileName, job);
    const jobFamily = roleFamily(job.name);
    if (filenameFamily && jobFamily && filenameFamily !== jobFamily && !titleScore) {
      return { ...evaluated, contentScore: evaluated.score, score: 0, status: '无法匹配', titleScore: 0, titleConflict: true };
    }
    return { ...evaluated, contentScore: evaluated.score, titleScore, titleFamily: jobFamily };
  }).sort((left, right) => right.titleScore - left.titleScore || right.score - left.score);
  const first = results[0];
  const second = results[1];
  const alternatives = results.slice(1, 3).map(item => ({ jobId: item.jobId, name: item.name, score: item.score }));
  if (first?.titleScore >= 90) return { status: '自动匹配', jobId: first.jobId, score: first.contentScore, assignmentConfidence: first.titleScore, matchingBasis: 'filename-title', ruleVersion: 4, alternativeJobs: alternatives, results, ageIgnored: true };
  if (filenameFamily) {
    const compatible = results.filter(item => item.titleFamily === filenameFamily && !item.titleConflict);
    const compatibleFirst = compatible[0];
    if (compatibleFirst?.score >= 45) return { status: '待确认', jobId: '', suggestedJobId: compatibleFirst.jobId, score: compatibleFirst.score, matchingBasis: 'filename-family', ruleVersion: 3, alternativeJobs: compatible.slice(1, 3).map(item => ({ jobId: item.jobId, name: item.name, score: item.score })), results, ageIgnored: true };
    return { status: '待分配', jobId: '', suggestedJobId: '', score: 0, matchingBasis: 'filename-family-unmatched', ruleVersion: 3, results, ageIgnored: true };
  }
  if (first?.score >= 60 && (!second || first.score - second.score >= 8)) return { status: '自动匹配', jobId: first.jobId, score: first.score, matchingBasis: 'resume-content', ruleVersion: 3, alternativeJobs: alternatives, results, ageIgnored: true };
  if (first?.score >= 45 || (first?.score >= 60 && second && first.score - second.score < 8)) return { status: second && first.score - second.score < 8 ? '多岗位候选' : '待确认', jobId: '', suggestedJobId: first.jobId, score: first.score, matchingBasis: 'resume-content', ruleVersion: 3, alternativeJobs: alternatives, results, ageIgnored: true };
  if (results.length && results.every(item => item.status === '无法匹配')) return { status: '无法匹配', jobId: '', suggestedJobId: first?.jobId || '', score: first?.score || 0, matchingBasis: 'resume-content', ruleVersion: 3, results, ageIgnored: true };
  return { status: '待分配', jobId: '', score: 0, matchingBasis: 'resume-content', ruleVersion: 3, results, ageIgnored: true };
}

module.exports = {
  ASSIGNABLE,
  ASSIGNMENT_STATUSES,
  ITEM_STATES,
  resolveJobAssignment,
  applyJobAssignment,
  applyUploadedResumeAssignment,
  draftJobProfile,
  confirmJobProfile,
  resumeForMatch,
  roleFamily,
  filenameTitleSignal,
  evaluateJob,
  evaluateJobMatches
};
