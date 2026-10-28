function compactJobName(name = '') {
  return String(name || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function planMokaLinks(jobs = [], mokaJobs = []) {
  const used = new Set(jobs.map(job => String(job.mokaJobId || '').trim()).filter(Boolean));
  const links = [];
  for (const job of jobs) {
    if (String(job.mokaJobId || '').trim() || !job.id) continue;
    const name = compactJobName(job.name);
    if (!name) continue;
    const matches = mokaJobs.filter(item => compactJobName(item.name) === name && item.id && !used.has(String(item.id)));
    if (matches.length !== 1) continue;
    const mokaJobId = String(matches[0].id);
    used.add(mokaJobId);
    links.push({ id: job.id, name: job.name, mokaJobId });
  }
  return links;
}

module.exports = { compactJobName, planMokaLinks };
