const ASSIGNABLE = new Set(['已分配', '自动匹配']);

function resolveJobAssignment({ jobs = [], match = {} } = {}) {
  const active = jobs.filter(job => job && job.id && job.status !== 'archived');
  const result = match.result && typeof match.result === 'object' ? match.result : (match || {});
  const job = active.find(item => item.id === result.jobId) || null;
  const status = String(result.status || '');
  if (!job || !ASSIGNABLE.has(status)) {
    return {
      assigned: false,
      job: null,
      ingestStatus: '已解析待分配',
      matching: { ...result, jobId: '', status: '待分配' }
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

module.exports = { resolveJobAssignment, applyJobAssignment };
