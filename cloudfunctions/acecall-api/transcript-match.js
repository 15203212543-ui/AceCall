const { SCREENING_JOBS } = require('./screening-jobs');

function personKey(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function labeledValue(text, labels) {
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[:：]\\s*([^\\n\\r]{1,80})`);
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/[，,。；;].*$/, '').trim();
}

function parseLooseDate(value = '') {
  const text = String(value || '');
  const date = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!date) return '';
  const clock = text.match(/(\d{1,2}):(\d{2})/);
  const day = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
  if (!clock) return day;
  return `${day}T${clock[1].padStart(2, '0')}:${clock[2]}:00+08:00`;
}

function extractTranscriptContext(fileName = '', text = '') {
  const head = String(text || '').slice(0, 4000);
  const candidateName = labeledValue(head, ['候选人姓名', '候选人', '姓名']);
  const interviewer = labeledValue(head, ['面试官姓名', '面试官']);
  const labeledJob = labeledValue(head, ['应聘岗位', '面试岗位', '岗位名称', '岗位']);
  const catalogJob = SCREENING_JOBS.find(job => head.includes(job.name) || String(fileName).includes(job.name));
  const interviewAt = parseLooseDate(labeledValue(head, ['面试时间', '面试日期', '开始时间']) || fileName);
  return {
    candidateName,
    interviewer,
    jobName: labeledJob || catalogJob?.name || '',
    interviewAt
  };
}

function samePerson(left, right) {
  const a = personKey(left);
  const b = personKey(right);
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function matchTranscriptToInterview(hint = {}, interviews = []) {
  const pool = interviews.filter(item => item && item.source !== 'acecall-local');
  const hintTime = Date.parse(hint.interviewAt || hint.startedAt || '') || 0;
  const scored = pool.map(item => {
    const nameMatched = samePerson(hint.candidateName, item.candidateName);
    const jobMatched = hint.jobName && item.jobName && (item.jobName.includes(hint.jobName) || hint.jobName.includes(item.jobName));
    const interviewerMatched = samePerson(hint.interviewer, item.interviewer);
    const time = Date.parse(item.startedAt || '') || 0;
    let timeScore = 0;
    if (hintTime && time) {
      const gap = Math.abs(hintTime - time);
      if (gap <= 36 * 60 * 60 * 1000) timeScore = 6;
      else if (gap <= 7 * 86400000) timeScore = 2;
      else timeScore = -4;
    }
    const score = (nameMatched ? 10 : 0) + (jobMatched ? 4 : 0) + (interviewerMatched ? 4 : 0) + timeScore;
    return { item, score, time, nameMatched };
  }).filter(entry => entry.nameMatched && entry.score >= 10);
  scored.sort((left, right) => right.score - left.score || (hintTime ? Math.abs((Date.parse(left.item.startedAt || '') || 0) - hintTime) - Math.abs((Date.parse(right.item.startedAt || '') || 0) - hintTime) : right.time - left.time));
  return scored[0]?.item || null;
}

function mergeTranscriptMetadata(metadata = {}, fileName = '', text = '') {
  const extracted = extractTranscriptContext(fileName, text);
  const merged = { ...extracted, ...metadata };
  for (const key of ['candidateName', 'interviewer', 'jobName', 'interviewAt']) {
    if (!merged[key]) merged[key] = extracted[key] || '';
  }
  return merged;
}

module.exports = { extractTranscriptContext, matchTranscriptToInterview, mergeTranscriptMetadata, samePerson };
