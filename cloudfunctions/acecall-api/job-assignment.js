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
    return candidate;
  }
  candidate.jobId = decision.job.id;
  candidate.roleName = decision.job.name || '';
  candidate.jd = decision.job.jd || '';
  candidate.rules = decision.job.rules || '';
  candidate.keywords = decision.job.keywords || [];
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

function classifyRequirement(item, resume, conflicts = []) {
  const conflict = conflicts.find(entry => String(entry.topic || entry.item || '').includes(item));
  if (conflict) return { item, state: '冲突', evidence: String(conflict.evidence || conflict.callEvidence || ''), role: '必备' };
  if (resume.includes(item)) return { item, state: '命中', evidence: item, role: '必备' };
  return { item, state: '未发现', evidence: '', role: '必备' };
}

function evaluateJob(resume, job, conflicts = []) {
  const profile = job.profile?.status === 'confirmed' ? job.profile : draftJobProfile(job);
  const text = resumeForMatch(resume);
  const exclusions = profile.exclusions.filter(item => text.includes(item)).map(item => ({ item, state: '命中', evidence: item, role: '排除' }));
  if (exclusions.length) return { jobId: job.id, name: job.name || '', status: '无法匹配', items: exclusions, score: 0, snapshot: profile };
  const required = profile.required.map(item => classifyRequirement(item, text, conflicts));
  const pendingItems = profile.verify.map(item => ({ item, state: text.includes(item) ? '命中' : '待核验', evidence: text.includes(item) ? item : '', role: '待核验' }));
  const bonus = profile.bonus.map(item => ({ item, state: text.includes(item) ? '命中' : '未发现', evidence: text.includes(item) ? item : '', role: '加分' }));
  const hits = required.filter(item => item.state === '命中');
  const pending = [...required.filter(item => item.state === '待核验'), ...pendingItems.filter(item => item.state === '待核验')];
  const blocked = required.filter(item => item.state === '未发现' || item.state === '冲突');
  let status = '待确认';
  if (!required.length) status = '待确认';
  else if (blocked.length / required.length > 0.5) status = blocked.some(item => item.state === '冲突') && hits.length ? '待确认' : '无法匹配';
  else if (hits.length === required.length) status = '自动匹配';
  else if (pending.length || blocked.length) status = '待确认';
  return { jobId: job.id, name: job.name || '', status, items: [...required, ...pendingItems, ...bonus], score: hits.length, snapshot: profile };
}

function evaluateJobMatches({ resume = '', jobs = [], conflicts = [] } = {}) {
  const active = jobs.filter(job => job && job.id && job.status !== 'archived');
  const results = active.map(job => evaluateJob(resume, job, conflicts));
  const passed = results.filter(item => item.status === '自动匹配').sort((left, right) => right.score - left.score);
  if (passed.length > 1) return { status: '多岗位候选', jobId: '', score: passed[0].score, results, ageIgnored: true };
  if (passed.length === 1) return { status: '自动匹配', jobId: passed[0].jobId, score: passed[0].score, results, ageIgnored: true };
  const waiting = results.filter(item => item.status === '待确认');
  if (waiting.length) return { status: '待确认', jobId: '', score: waiting[0].score, results, ageIgnored: true };
  if (results.length && results.every(item => item.status === '无法匹配')) return { status: '无法匹配', jobId: '', score: 0, results, ageIgnored: true };
  return { status: '待分配', jobId: '', score: 0, results, ageIgnored: true };
}

module.exports = {
  ASSIGNABLE,
  ASSIGNMENT_STATUSES,
  ITEM_STATES,
  resolveJobAssignment,
  applyJobAssignment,
  draftJobProfile,
  confirmJobProfile,
  resumeForMatch,
  evaluateJobMatches
};
