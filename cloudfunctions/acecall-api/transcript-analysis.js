const { verifyEvidence } = require('./fact-center');
const { parseStructuredFileName } = require('./transcript-match');

function bindTranscriptIdentity({ metadata = {}, fileName = '' } = {}) {
  const fromMoka = metadata.source === 'moka' || metadata.mokaInterviewId;
  if (fromMoka && metadata.candidateName) {
    return { candidateName: metadata.candidateName, jobName: metadata.jobName || '', interviewer: metadata.interviewer || '', hrName: metadata.hrName || '', interviewAt: metadata.interviewAt || '', identitySource: 'moka_record' };
  }
  const parsed = parseStructuredFileName(fileName);
  if (parsed?.candidateName) return { ...parsed, interviewer: metadata.interviewer || '', interviewAt: metadata.interviewAt || '', identitySource: 'filename_pattern' };
  return { candidateName: metadata.candidateName || '', jobName: metadata.jobName || '', interviewer: metadata.interviewer || '', hrName: metadata.hrName || '', interviewAt: metadata.interviewAt || '', identitySource: metadata.candidateName ? 'metadata' : '未匹配' };
}

function splitSpeakerTurns(text = '') {
  const turns = [];
  let current = { speaker: '未识别说话人', lines: [] };
  const push = () => {
    const body = current.lines.join('\n').trim();
    if (!body) return;
    turns.push({ speaker: current.speaker, text: body, weight: current.speaker === '未识别说话人' ? 0.4 : 1 });
  };
  for (const line of String(text).split(/\n/)) {
    const labeled = line.match(/^(面试官|候选人|说话人\s*\d*|发言人\s*\d*)\s*[：:](.*)$/);
    if (!labeled) {
      if (current.speaker !== '未识别说话人') {
        push();
        current = { speaker: '未识别说话人', lines: [] };
      }
      current.lines.push(line);
      continue;
    }
    push();
    const speaker = labeled[1] === '面试官' ? '面试官' : labeled[1] === '候选人' ? '候选人' : '未识别说话人';
    current = { speaker, lines: [labeled[2]] };
  }
  push();
  return turns;
}

function extractTranscriptFindings(text = '', resume = '') {
  const turns = splitSpeakerTurns(text);
  const confirmed = [];
  const conflicts = [];
  const unanswered = [];
  turns.forEach((turn, index) => {
    if (turn.speaker === '候选人' && turn.weight === 1 && /我|负责|做过|在/.test(turn.text)) {
      confirmed.push({ item: turn.text.slice(0, 80), quote: turn.text.slice(0, 80), weight: turn.weight });
    }
    if (turn.speaker === '面试官' && /[？?]/.test(turn.text)) {
      const next = turns[index + 1];
      if (!next || next.speaker !== '候选人' || /不清楚|不知道|没说|没有想好/.test(next.text)) unanswered.push({ question: turn.text.slice(0, 80), quote: turn.text.slice(0, 80) });
    }
    if (turn.speaker === '候选人' && resume && /不是|实际|写错/.test(turn.text)) conflicts.push({ topic: '简历与口述', resumeClaim: String(resume).slice(0, 80), callEvidence: turn.text.slice(0, 80) });
  });
  return { confirmed, conflicts, unanswered, turns };
}

function downgradeUnsupported(items = [], transcript = '') {
  return items.map(item => {
    const quote = item.evidence || item.quote || '';
    if (!quote) return { ...item, verified: 'failed', status: 'pending' };
    const check = verifyEvidence(quote, { rawText: transcript, cleanedText: transcript });
    return check.verified === 'failed' ? { ...item, verified: 'failed', status: 'pending' } : { ...item, verified: check.verified };
  });
}

function checkCallSummary(summary = {}, transcript = '') {
  const confirmed = downgradeUnsupported(summary.confirmed || [], transcript);
  const contradicted = downgradeUnsupported(summary.contradicted || [], transcript);
  return { ...summary, confirmed: confirmed.filter(item => item.status !== 'pending'), contradicted: contradicted.filter(item => item.status !== 'pending'), pendingEvidence: [...confirmed, ...contradicted].filter(item => item.status === 'pending') };
}

function checkSynthesis(report = {}, source = '') {
  const capabilities = (report.capabilities || []).map(item => {
    const check = verifyEvidence(item.evidence || '', { rawText: source, cleanedText: source });
    if (!item.evidence || check.verified === 'failed') return { ...item, assessment: '信息不足', verified: 'failed' };
    return { ...item, verified: check.verified };
  });
  const allowed = new Set(['明确匹配', '部分匹配', '信息不足', '明确不匹配']);
  return { ...report, capabilities, conclusion: allowed.has(report.conclusion) ? report.conclusion : '信息不足' };
}

function protectInterviewerReview(review = {}, sessionCount = 0) {
  const questions = review.questions || [];
  if (sessionCount < 5) return { sampleLimited: true, visibility: 'personal-objective', sessionCount, questions, summary: '', themes: [], followUpStyle: '' };
  return { ...review, sampleLimited: false, visibility: 'personal', sessionCount, questions };
}

function applyTeamVisibility(analytics = {}) {
  const count = Number(analytics.interviewer?.completed || 0);
  if (count >= 5) return { ...analytics, sampleLimited: false, visibility: 'team' };
  return {
    ...analytics,
    sampleLimited: true,
    visibility: 'team-objective',
    interviewer: { completed: count, passed: analytics.interviewer?.passed || 0, rejected: analytics.interviewer?.rejected || 0, pending: analytics.interviewer?.pending || 0 },
    dimensions: {},
    recommendations: []
  };
}

module.exports = { bindTranscriptIdentity, splitSpeakerTurns, extractTranscriptFindings, checkCallSummary, checkSynthesis, protectInterviewerReview, applyTeamVisibility };
