const { mokaIdKey } = require('./job-moka-link');
const { normalizeEmail } = require('./capture-history');

const MOKA_JOB_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

function collectMokaEmails(job = {}) {
  const values = [job.jobManagerEmail, job.managerEmail, job.recruiterEmail, job.jobManager, job.recruitmentManager, job.manager, job.recruiter, job.owner];
  for (const key of ['jobHrAssistant', 'jobAssistants', 'assistants', 'jobAssistant', 'hiringManagers', 'jobHiringManagers']) {
    if (Array.isArray(job[key])) values.push(...job[key]);
  }
  const emails = [];
  const visit = value => {
    if (!value) return;
    if (typeof value === 'string') {
      const email = normalizeEmail(value);
      if (email) emails.push(email);
      return;
    }
    if (typeof value === 'object') visit(value.email || value.mail);
  };
  values.forEach(visit);
  return [...new Set(emails)];
}

function normalizeOpenMokaJob(job = {}) {
  const department = job.department && typeof job.department === 'object' ? job.department.name : job.department;
  return {
    id: String(job.id || '').trim(),
    name: String(job.title || job.name || '').trim(),
    code: String(job.mjCode || job.code || '').trim(),
    description: String(job.description || job.jobDescription || job.desc || job.responsibility || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
    department: String(department || job.departmentName || '').trim().slice(0, 80),
    emails: collectMokaEmails(job)
  };
}

const INTERVIEW_SCOPE_START = '2026-08-01T00:00:00+08:00';

function compactJobTitle(value = '') {
  return String(value || '').toLowerCase().replace(/[\s\-_/（）()【】[\]：:·,，、]/g, '');
}

function ownedOpenJobs(openJobs = [], email = '') {
  const actor = normalizeEmail(email);
  if (!actor) return [];
  const seen = new Set();
  const jobs = [];
  for (const job of openJobs) {
    const id = String(job.id || '').trim();
    const key = mokaIdKey(id);
    if (!key || seen.has(key) || !(job.emails || []).includes(actor)) continue;
    seen.add(key);
    jobs.push({ id, name: String(job.name || '').trim(), code: String(job.code || '').trim() });
  }
  return jobs;
}

function interviewJobIds(record = {}) {
  return [record.jobId, record.job_id, record.positionId, record.mokaJobId, record.job?.id, record.position?.id, record.application?.jobId, record.application?.job?.id, record.raw?.jobId, record.raw?.job?.id, record.raw?.positionId, record.raw?.application?.jobId, record.raw?.application?.job?.id];
}

function interviewJobCodes(record = {}) {
  const codes = [];
  for (const list of [record.jobs, record.raw?.jobs]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) codes.push(typeof item === 'string' ? item : item?.mjCode || item?.code || '');
  }
  return codes.map(item => String(item || '').trim().toLowerCase()).filter(Boolean);
}

function interviewBelongsToOwnedJobs(record = {}, jobs = []) {
  const keys = new Set(jobs.map(job => mokaIdKey(job.id)).filter(Boolean));
  const ids = interviewJobIds(record).map(mokaIdKey).filter(Boolean);
  if (ids.some(key => keys.has(key))) return true;
  const codes = new Set(jobs.map(job => String(job.code || '').trim().toLowerCase()).filter(Boolean));
  if (interviewJobCodes(record).some(code => codes.has(code))) return true;
  if (ids.length) return false;
  const role = compactJobTitle(record.jobName || record.jobTitle || record.name || '');
  if (!role) return false;
  return jobs.filter(job => compactJobTitle(job.name) === role).length === 1;
}

function interviewOnOrAfterScope(startedAt, floor = INTERVIEW_SCOPE_START) {
  const time = Date.parse(startedAt || '');
  if (!Number.isFinite(time)) return true;
  return time >= Date.parse(floor);
}

function mokaSyncDue(lastCheckedAt, now = Date.now(), intervalMs = MOKA_JOB_SYNC_INTERVAL_MS) {
  const time = Date.parse(lastCheckedAt || '');
  if (!Number.isFinite(time)) return true;
  return now - time >= intervalMs;
}

function planMokaJobSync({ localJobs = [], openJobs = [], email = '', catalogComplete = false } = {}) {
  const actor = normalizeEmail(email);
  const openById = new Map();
  for (const job of openJobs) {
    const key = mokaIdKey(job.id);
    if (key && job.name) openById.set(key, job);
  }
  const localByMoka = new Map();
  const localById = new Map();
  for (const job of localJobs) {
    const id = String(job.id || job._id || '');
    if (id) localById.set(id, job);
    const mokaKey = mokaIdKey(job.mokaJobId);
    if (mokaKey && !localByMoka.has(mokaKey)) localByMoka.set(mokaKey, job);
  }
  const creates = [];
  const updates = [];
  let matched = 0;
  if (actor) {
    for (const open of openById.values()) {
      if (!(open.emails || []).includes(actor)) continue;
      matched += 1;
      const local = localByMoka.get(mokaIdKey(open.id)) || localById.get(open.id);
      if (!local) {
        creates.push(open);
        continue;
      }
      const patch = {};
      if (open.name && open.name !== local.name) patch.name = open.name;
      if (open.code && open.code !== String(local.mokaJobCode || '')) patch.mokaJobCode = open.code;
      if (!local.mokaJobId) patch.mokaJobId = open.id;
      if (local.status === 'closed') patch.status = 'active';
      if (!String(local.jd || '').trim() && open.description) patch.jd = open.description;
      if (Object.keys(patch).length) updates.push({ id: local.id || local._id, patch });
    }
  }
  const closes = [];
  if (catalogComplete) {
    for (const local of localJobs) {
      const key = mokaIdKey(local.mokaJobId);
      if (!key || local.status === 'closed') continue;
      if (!openById.has(key)) closes.push({ id: local.id || local._id, name: local.name || '' });
    }
  }
  const emailCount = [...openById.values()].filter(job => (job.emails || []).length).length;
  let note = '';
  if (!catalogComplete) note = 'Moka 开放岗位没有完整返回，本次没有把岗位标成停招。';
  else if (!actor) note = '当前账号没有邮箱，无法匹配 Moka 职位负责人。已检查停招岗位。';
  else if (openById.size && !emailCount) note = 'Moka 开放岗位没有返回负责人邮箱，本次只更新了停招状态。';
  return { creates, updates, closes, matched, emailMatched: Boolean(actor), note };
}

module.exports = {
  INTERVIEW_SCOPE_START,
  MOKA_JOB_SYNC_INTERVAL_MS,
  collectMokaEmails,
  normalizeOpenMokaJob,
  ownedOpenJobs,
  interviewBelongsToOwnedJobs,
  interviewOnOrAfterScope,
  mokaSyncDue,
  planMokaJobSync
};
