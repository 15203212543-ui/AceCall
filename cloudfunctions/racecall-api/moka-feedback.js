function sameInterviewMoment(left, right) {
  const start = Date.parse(left || '');
  const other = Date.parse(right || '');
  return Number.isFinite(start) && Number.isFinite(other) && Math.abs(start - other) <= 15 * 60 * 1000;
}

function selectMokaFeedbacks(record = {}, pool = []) {
  if (!pool.length) return [];
  const interviewer = String(record.interviewer || '').trim();
  const round = String(record.round || '').trim();
  const startedAt = record.startedAt || record.raw?.startTime || '';
  const scored = pool.map(item => {
    const name = String(item.interviewerName || '').trim();
    const itemRound = String(item.roundName || item.round || '').trim();
    let score = 0;
    if (interviewer && name && interviewer === name) score += 4;
    if (round && itemRound && round === itemRound) score += 4;
    if (sameInterviewMoment(startedAt, item.startTime)) score += 3;
    if (interviewer && name && interviewer !== name) score -= 3;
    if (round && itemRound && round !== itemRound) score -= 2;
    return { item, score };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0]?.score || 0;
  if (best > 0) return scored.filter(entry => entry.score === best).map(entry => entry.item);
  return pool;
}

function summarizeMokaFeedback(record = {}, feedbacks = []) {
  const values = [
    record.result, record.interviewResult, record.outcome, record.decision, record.resultName,
    ...feedbacks.flatMap(item => [item.resultName, item.result, item.outcome, item.decision, item.conclusion])
  ].filter(value => value !== undefined && value !== null && String(value).trim());
  const namedResult = feedbacks.map(item => item.resultName).find(value => value !== undefined && value !== null && String(value).trim());
  const rejectedByType = feedbacks.some(item => String(item.resultType) === '0' && !String(item.resultName || '').trim());
  const outcome = String(namedResult || (rejectedByType ? '淘汰' : '') || values.find(value => /通过|淘汰|拒绝|不通过|未通过|待定|pending|pass|reject|fail|accept/i.test(String(value))) || '').trim();
  const passedExplicit = record.interviewPassed === true || feedbacks.some(item => item.interviewPassed === true);
  const rejectedExplicit = record.interviewRejected === true || record.interviewFailed === true || feedbacks.some(item => item.interviewRejected === true || item.interviewFailed === true);
  const passed = passedExplicit || (!/不通过|未通过/.test(outcome) && /通过|合格|录用|pass(?:ed)?|succeed/i.test(outcome));
  const rejected = rejectedExplicit || rejectedByType || /淘汰|拒绝|不通过|未通过|不合格|reject|fail(?:ed)?|不录用/i.test(outcome);
  const outcomeStatus = passed && rejected ? 'conflict' : passed ? 'passed' : rejected ? 'rejected' : outcome ? 'pending' : 'unknown';
  const feedback = feedbacks.map(item => {
    const text = String(item.feedback || item.comment || item.conclusion || '').trim();
    if (!text && !item.resultName) return '';
    const head = [item.roundName || item.round, item.interviewerName, item.resultName].filter(Boolean).join(' · ');
    return [head, text].filter(Boolean).join('：');
  }).filter(Boolean).join('\n');
  const feedbackTemplateResult = feedbacks.map(item => item.feedbackTemplateResult).find(Boolean) || record.feedbackTemplateResult || null;
  return {
    outcome, outcomeStatus, interviewPassed: passed ? true : rejected ? false : null,
    interviewRejected: rejected ? true : passed ? false : null,
    outcomeConflict: outcomeStatus === 'conflict', feedback, feedbackTemplateResult
  };
}

module.exports = { selectMokaFeedbacks, summarizeMokaFeedback };
