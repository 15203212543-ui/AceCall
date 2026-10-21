const { SCREENING_JOBS } = require('./screening-jobs');
const { getMokaConfig } = require('./moka-client');

const FILE_NOISE = /面试转写|面试录音|面试记录|转写文本|转写稿|转写|录音文件|录音|字幕|transcript|transcription|interview/gi;
const NAME_BLOCK = /面试官|候选人|发言人|说话人|面试|转写|录音|记录|岗位|字幕|未知|未识别/;

function personKey(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
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

function catalogJobNames() {
  const names = [...SCREENING_JOBS.map(job => job.name), ...getMokaConfig({}).jobNames, ...getMokaConfig().jobNames];
  return [...new Set(names.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function parseStructuredFileName(fileName = '') {
  let base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  base = base.replace(/(?:\s*[（(]\d+[）)])+\s*$/g, '').trim();
  const withHr = base.match(/^([^_（()]+?)_(.+?)[（(]([^（）()]*)[）)]\s*$/);
  if (withHr) {
    const candidateName = withHr[1].trim();
    const jobName = withHr[2].trim();
    const hrName = withHr[3].trim().replace(/安排\s*$/, '').trim();
    return candidateName && jobName ? { candidateName, jobName, hrName } : null;
  }
  const plain = base.match(/^([^_（()]+?)_([^_（()]+)$/);
  if (!plain) return null;
  const candidateName = plain[1].trim();
  const jobName = plain[2].trim();
  return candidateName && jobName ? { candidateName, jobName, hrName: '' } : null;
}

function jobFromFileName(fileName = '') {
  const structured = parseStructuredFileName(fileName);
  if (structured?.jobName) return structured.jobName;
  const base = String(fileName || '');
  return catalogJobNames().find(name => base.includes(name)) || '';
}

function candidateFromFileName(fileName = '', jobName = '') {
  const structured = parseStructuredFileName(fileName);
  if (structured?.candidateName) return structured.candidateName;
  let base = String(fileName || '').replace(/\.[^.]+$/, '');
  if (jobName) base = base.split(jobName).join(' ');
  base = base.replace(FILE_NOISE, ' ').replace(/[【】\[\]()（）_+\-]+/g, ' ');
  const chinese = [...base.matchAll(/(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/g)].map(item => item[0]);
  const name = chinese.find(item => !NAME_BLOCK.test(item));
  if (name) return name;
  return base.match(/\b[A-Z][A-Za-z'·.]{1,20}(?:\s+[A-Z][A-Za-z'·.]{1,20}){0,2}\b/)?.[0] || '';
}

function labeledInterviewer(text = '') {
  const match = String(text).match(/面试官(?:姓名)?\s*[:：]?\s*([\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z .'-]{1,40})/);
  const name = match?.[1]?.trim() || '';
  return name && !NAME_BLOCK.test(name) ? name : '';
}

function libraryInterviewer(text = '', interviewerNames = []) {
  const names = [...new Set(interviewerNames.map(name => String(name || '').trim()).filter(name => name && !NAME_BLOCK.test(name)))];
  names.sort((left, right) => right.length - left.length);
  let found = '';
  let index = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const pattern = new RegExp(`(?<![\\u4e00-\\u9fffA-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\u4e00-\\u9fffA-Za-z])`);
    const match = pattern.exec(text);
    if (match && match.index < index) {
      found = name;
      index = match.index;
    }
  }
  return found;
}

function dateTimeAfter(text = '', anchor = '') {
  const name = String(anchor || '').trim();
  if (!name) return '';
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(name, from);
    if (index < 0) return '';
    const window = text.slice(index + name.length, index + name.length + 80);
    const parsed = parseLooseDate(window);
    if (parsed) return parsed;
    from = index + name.length;
  }
  return '';
}

function extractTranscriptContext(fileName = '', text = '', options = {}) {
  const body = String(text || '');
  const structured = parseStructuredFileName(fileName);
  const jobName = structured?.jobName || jobFromFileName(fileName);
  const candidateName = structured?.candidateName || candidateFromFileName(fileName, jobName);
  const interviewer = labeledInterviewer(body) || libraryInterviewer(body, options.interviewerNames || []);
  const interviewAt = dateTimeAfter(body, interviewer) || dateTimeAfter(body, candidateName);
  return { candidateName, interviewer, jobName, interviewAt, hrName: structured?.hrName || '' };
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

function mergeTranscriptMetadata(metadata = {}, fileName = '', text = '', interviewerNames = []) {
  const extracted = extractTranscriptContext(fileName, text, { interviewerNames });
  return {
    ...metadata,
    candidateName: extracted.candidateName || metadata.candidateName || '',
    jobName: extracted.jobName || metadata.jobName || '',
    hrName: extracted.hrName || metadata.hrName || '',
    interviewer: extracted.interviewer || metadata.interviewer || '',
    interviewAt: extracted.interviewAt || metadata.interviewAt || '',
    fileName: metadata.fileName || fileName
  };
}

module.exports = { extractTranscriptContext, matchTranscriptToInterview, mergeTranscriptMetadata, samePerson };
