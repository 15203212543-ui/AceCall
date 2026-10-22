const CLASSIFICATIONS = Object.freeze(['communication_check', 'condition_check', 'job_question', 'needs_context']);
const CONDITION_TYPES = Object.freeze(['location', 'availability', 'salary', 'non_compete', 'work_mode', 'travel', 'shift']);
const CONDITION_LABELS = Object.freeze({
  location: '地点',
  availability: '到岗',
  salary: '薪资',
  non_compete: '竞业',
  work_mode: '办公方式',
  travel: '出差',
  shift: '班次'
});
const RULES_VERSION = 'interview-question-rules-v1';
const CLASSIFICATION_SET = new Set(CLASSIFICATIONS);
const CONDITION_SET = new Set(CONDITION_TYPES);

const COMMUNICATION_PATTERNS = [
  /听[见清得到]/,
  /听得到|听得见/,
  /信号/,
  /方便说话|方便沟通|现在方便/,
  /稍等|等一下|等一会/,
  /开始录|录音|在录|录制/,
  /共享屏幕|看到屏幕|能看到吗|你能看到/,
  /我们开始|可以开始|准备好了吗/,
  /你好[，,]*(?:你)?(?:能|可以)?(?:听见|听得到|听得见)?/
];

const CONDITION_PATTERNS = [
  ['location', /人在哪|哪里|哪儿|所在地|工作地点|工作城市|哪个城市|(?:深圳|长沙|北京|上海|广州|杭州|成都).*(?:吗|可以|接受|还是)|(?:接受|可以).*(?:深圳|长沙|北京|上海|广州|杭州|成都)/],
  ['availability', /到岗|入职时间|什么时候能|多久能到|何时入职|离职时间/],
  ['salary', /薪资|工资|薪水|待遇|年薪|月薪|期望薪|薪酬/],
  ['non_compete', /竞业|入职限制|背调/],
  ['work_mode', /远程|坐班|办公方式|居家办公|混合办公/],
  ['travel', /出差|驻场/],
  ['shift', /班次|倒班|夜班/]
];

const JOB_CUES = /负责|职责|项目|结果|指标|上线|架构|经验|差异|例子|怎么做|如何|为什么|为何|偏向|哪些方面|工作机会|核心/;
const STRONG_JOB_CUES = /负责|职责|项目|结果|指标|上线|架构|经验|差异|例子|偏向|工作机会|核心/;
const QUESTION_CUES = /[？?]|吗$|呢$|吧$|什么|怎么|如何|为什么|为何|哪|是否|有没有|是不是|能不能|可不可以|介绍一下|说说|讲讲|举一个例子|举个例子/;
const FACT_TOKENS = /北京|上海|深圳|广州|杭州|成都|南京|武汉|苏州|长沙|香港|\d+(?:\.\d+)?(?:万|k|K|元)/g;

function samePerson(left, right) {
  const a = String(left || '').replace(/\s+/g, '');
  const b = String(right || '').replace(/\s+/g, '');
  return a.length >= 2 && b.length >= 2 && (a === b || a.includes(b) || b.includes(a));
}

function cleanClause(value) {
  return String(value || '')
    .replace(/^(?:okay|ok|嗯+|啊+|哎+|哦+|呃+|那个|就是|然后|好的|对+|呀+|呢+)[，,.\s]*/i, '')
    .replace(/\s+/g, '')
    .replace(/^[，,、：:]+|[。！？?]+$/g, '')
    .trim();
}

function looksLikeQuestion(text) {
  return QUESTION_CUES.test(cleanClause(text));
}

function isCommunication(text) {
  const clause = cleanClause(text);
  if (!clause || STRONG_JOB_CUES.test(clause) || /薪资|到岗|竞业/.test(clause)) return false;
  return COMMUNICATION_PATTERNS.some(pattern => pattern.test(clause));
}

function conditionTypeOf(text) {
  const clause = cleanClause(text);
  if (!clause || STRONG_JOB_CUES.test(clause)) return '';
  const found = CONDITION_PATTERNS.find(([, pattern]) => pattern.test(clause));
  return found ? found[0] : '';
}

function isFragment(text) {
  const clause = cleanClause(text).replace(/[？?]/g, '');
  if (!clause) return false;
  if (/也是|你们自己|自己做|这个后来|后来呢|你说的这个|具体是指|这个呢|然后呢/.test(clause)) return true;
  return clause.length <= 8 && !QUESTION_CUES.test(clause) && !conditionTypeOf(text);
}

function normalizeQuestion(text) {
  let value = cleanClause(text).replace(/(?:啊|呢|吧|呀|哦|哈|嘛|啦|呗)+$/g, '');
  if (value.length > 28) {
    const parts = value.split(/[，,]/).map(item => item.trim()).filter(item => item.length >= 6);
    value = parts[parts.length - 1] || value.slice(-28);
  }
  if (value.length < 6 || value.length > 28) return '';
  return `${value}？`;
}

function citiesIn(text) {
  return [...new Set((String(text).match(/深圳|长沙|北京|上海|广州|杭州|成都|南京|武汉|苏州|香港/g) || []))];
}

function normalizedCondition(type, text) {
  if (type === 'location') {
    const cities = citiesIn(text);
    return cities.length ? `是否接受${cities.join('或')}？` : '当前所在地？';
  }
  const labels = { availability: '到岗时间？', salary: '期望薪资？', non_compete: '是否存在竞业限制？', work_mode: '办公方式？', travel: '是否需要出差？', shift: '班次要求？' };
  return labels[type] || normalizeQuestion(text);
}

function linkStatusFor(type, job, jobBound) {
  if (!jobBound) return '待关联';
  const label = CONDITION_LABELS[type];
  const verify = Array.isArray(job.verify) ? job.verify : [];
  if (verify.includes(label) || verify.includes(type)) return '岗位要求';
  const haystack = `${job.jd || ''}\n${job.rules || ''}\n${(job.keywords || []).join('\n')}`;
  const signals = {
    location: /工作地点|办公地点|工作城市|长沙|深圳|北京|上海|广州|杭州/,
    availability: /到岗|入职时间/,
    salary: /薪资|薪酬|工资/,
    non_compete: /竞业/,
    work_mode: /远程|坐班|办公方式/,
    travel: /出差/,
    shift: /班次|倒班/
  };
  return signals[type] && signals[type].test(haystack) ? '岗位要求' : '通用核验';
}

function criteriaId(text, job) {
  const terms = [...(job.keywords || []), ...(job.required || [])].map(item => String(item || '').trim()).filter(item => item.length >= 2);
  return terms.find(term => text.includes(term)) || '';
}

function splitBlocks(text, session) {
  const blocks = [];
  let current = { speaker: 'unknown', lines: [] };
  const push = () => {
    const body = current.lines.join('\n').trim();
    if (body) blocks.push({ speaker: current.speaker, text: body });
  };
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const role = line.match(/^(面试官|候选人)\s*[：:]\s*(.*)$/);
    if (role) {
      push();
      current = { speaker: role[1] === '面试官' ? 'interviewer' : 'candidate', lines: role[2] ? [role[2]] : [] };
      continue;
    }
    const stamped = line.match(/^([\u4e00-\u9fffA-Za-z]{2,12})\s+20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/);
    if (stamped) {
      push();
      const speaker = samePerson(stamped[1], session.interviewer) ? 'interviewer' : samePerson(stamped[1], session.candidateName) ? 'candidate' : 'unknown';
      current = { speaker, lines: [] };
      continue;
    }
    const named = line.match(/^([\u4e00-\u9fff]{2,4})[：:](.+)$/);
    if (named && (samePerson(named[1], session.interviewer) || samePerson(named[1], session.candidateName))) {
      push();
      current = { speaker: samePerson(named[1], session.interviewer) ? 'interviewer' : 'candidate', lines: [named[2]] };
      continue;
    }
    current.lines.push(line);
  }
  push();
  return blocks;
}

function splitMixed(clause) {
  if (!STRONG_JOB_CUES.test(clause) && !conditionTypeOf(clause)) return [clause];
  const parts = clause.split(/[，,]/).map(item => item.trim()).filter(Boolean);
  if (parts.length < 2 || !parts.some(isCommunication)) return [clause];
  return parts;
}

function clausesOf(text) {
  const lines = String(text || '').split(/\n/).map(item => item.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };
  for (const line of lines) {
    if (isCommunication(line)) {
      flush();
      chunks.push(line);
      continue;
    }
    buffer = buffer ? `${buffer}${line}` : line;
    if (/[？?。！]$/.test(line) || buffer.length > 80) flush();
  }
  flush();
  return chunks.flatMap(chunk => chunk.split(/(?<=[？?。！])/).map(item => item.trim()).filter(Boolean)).flatMap(splitMixed);
}

function stableId(transcriptId, raw) {
  const basis = `${transcriptId}|${String(raw).replace(/\s+/g, '')}`;
  let hash = 0;
  for (const char of basis) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return `q_${hash.toString(36)}`;
}

function boundJob(input) {
  const job = input.job && typeof input.job === 'object' ? input.job : {};
  const names = [...new Set((input.sessions || []).map(item => String(item.jobName || '').trim()).filter(Boolean))];
  const conflict = Boolean(job.conflict) || names.length > 1;
  const jd = String(job.jd || '').trim();
  const jobBound = !conflict && !job.unbound && jd.length >= 20;
  return {
    id: String(job.id || ''),
    name: String(job.name || names[0] || ''),
    jd,
    rules: String(job.rules || ''),
    keywords: Array.isArray(job.keywords) ? job.keywords.map(item => String(item)) : [],
    required: Array.isArray(job.required) ? job.required.map(item => String(item)) : [],
    verify: Array.isArray(job.verify) ? job.verify.map(item => String(item)) : [],
    conflict,
    jobBound
  };
}

function extractItems(input, job) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const items = [];
  sessions.forEach((session, sessionIndex) => {
    const transcriptId = String(session.id || session.transcriptId || `s${sessionIndex}`);
    const blocks = splitBlocks(session.text || '', session);
    const labeledInterviewer = blocks.some(block => block.speaker === 'interviewer');
    blocks.forEach((block, blockIndex) => {
      if (block.speaker === 'candidate') return;
      if (labeledInterviewer && block.speaker !== 'interviewer') return;
      const previous = blocks[blockIndex - 1];
      const next = blocks[blockIndex + 1];
      clausesOf(block.text).forEach(clause => {
        const raw = clause.trim();
        if (raw.length < 2 || raw.length > 120) return;
        if (!isCommunication(raw) && !looksLikeQuestion(raw) && !conditionTypeOf(raw)) return;
        items.push({
          id: stableId(transcriptId, raw),
          ids: [stableId(transcriptId, raw)],
          transcriptId,
          interviewerId: String(session.interviewer || input.interviewer || ''),
          candidateId: String(session.candidateId || session.candidateName || ''),
          jobId: job.id,
          rawText: raw,
          speaker: block.speaker === 'interviewer' ? 'interviewer' : 'unknown',
          timestamp: String(session.startedAt || ''),
          contextBefore: previous ? [previous.text.slice(0, 180)] : [],
          contextAfter: next ? [next.text.slice(0, 180)] : [],
          sourceRef: `${transcriptId}:${items.length}`,
          sources: [{ transcriptId, candidateName: String(session.candidateName || ''), startedAt: String(session.startedAt || ''), rawText: raw }],
          rulesVersion: RULES_VERSION
        });
      });
    });
  });
  return items;
}

function classifyClause(item, job, previous) {
  if (isCommunication(item.rawText)) {
    return { classification: 'communication_check', classificationSource: 'rule', confidenceBasis: 'communication_phrase', pendingAi: false, confirmed: false };
  }
  const conditionType = conditionTypeOf(item.rawText);
  if (conditionType) {
    return {
      classification: 'condition_check',
      conditionType,
      conditionLabel: CONDITION_LABELS[conditionType],
      linkStatus: linkStatusFor(conditionType, job, job.jobBound),
      normalizedText: normalizedCondition(conditionType, item.rawText),
      jobCriteriaId: criteriaId(item.rawText, job),
      classificationSource: 'rule',
      confidenceBasis: 'condition_phrase',
      pendingAi: false,
      confirmed: true
    };
  }
  if (isFragment(item.rawText)) {
    if (previous && previous.classification !== 'communication_check') {
      previous.mergedRaw = [...(previous.mergedRaw || []), item.rawText];
      previous.sources = [...previous.sources, ...item.sources];
      return { classification: 'needs_context', mergedInto: previous.id, classificationSource: 'rule', confidenceBasis: 'merged_fragment', pendingAi: false, confirmed: false };
    }
    return { classification: 'needs_context', classificationSource: 'rule', confidenceBasis: 'missing_context', pendingAi: false, confirmed: false };
  }
  if (looksLikeQuestion(item.rawText) && JOB_CUES.test(cleanClause(item.rawText))) {
    return {
      classification: 'job_question',
      normalizedText: normalizeQuestion(item.rawText),
      jobCriteriaId: criteriaId(item.rawText, job),
      classificationSource: 'rule',
      confidenceBasis: job.jobBound ? 'job_cue' : 'job_cue_without_jd',
      pendingAi: false,
      confirmed: Boolean(job.jobBound)
    };
  }
  if (looksLikeQuestion(item.rawText)) {
    return { classification: 'needs_context', classificationSource: 'rule', confidenceBasis: 'boundary', pendingAi: Boolean(job.jobBound), confirmed: false };
  }
  return { classification: 'needs_context', classificationSource: 'rule', confidenceBasis: 'undecided', pendingAi: false, confirmed: false };
}

function corpusOf(sessions) {
  return (sessions || []).map(item => String(item.text || '')).join('\n');
}

function introducesFact(normalized, quote) {
  const facts = String(normalized || '').match(FACT_TOKENS) || [];
  return facts.some(fact => !String(quote || '').includes(fact));
}

function validateAiDecision(decision, item, corpus) {
  const classification = String(decision?.classification || '');
  if (!CLASSIFICATION_SET.has(classification)) return { ok: false, reasonCode: 'invalid_enum' };
  const quote = String(decision.evidenceQuote || '');
  if (!quote || (!item.rawText.includes(quote) && !corpus.includes(quote))) return { ok: false, reasonCode: 'evidence_missing' };
  if (classification === 'condition_check' && decision.conditionType && !CONDITION_SET.has(decision.conditionType)) return { ok: false, reasonCode: 'invalid_condition' };
  if (decision.normalizedQuestion && introducesFact(decision.normalizedQuestion, quote)) return { ok: false, reasonCode: 'new_fact' };
  return { ok: true };
}

function applyDecision(item, decision, corpus) {
  const check = validateAiDecision(decision, item, corpus);
  item.pendingAi = false;
  item.evidenceVerified = check.ok;
  if (!check.ok) {
    item.classification = 'needs_context';
    item.classificationSource = 'ai';
    item.confirmed = false;
    item.confidenceBasis = check.reasonCode;
    item.reviewStatus = 'pending';
    return;
  }
  item.classification = decision.classification;
  item.classificationSource = 'ai';
  item.confidenceBasis = String(decision.reasonCode || 'ai_classification');
  item.reviewStatus = 'auto';
  if (decision.classification === 'condition_check') {
    item.conditionType = CONDITION_SET.has(decision.conditionType) ? decision.conditionType : (item.conditionType || conditionTypeOf(item.rawText) || null);
    item.conditionLabel = item.conditionType ? CONDITION_LABELS[item.conditionType] : '条件';
    item.confirmed = true;
  } else {
    item.conditionType = null;
    item.confirmed = decision.classification === 'job_question';
  }
  if (decision.normalizedQuestion && !introducesFact(decision.normalizedQuestion, decision.evidenceQuote)) item.normalizedText = String(decision.normalizedQuestion).slice(0, 40);
  if (decision.mergeWithPrevious) item.confidenceBasis = 'ai_merge';
}

function applyHumanReviews(items, reviews) {
  for (const review of reviews || []) {
    if (!CLASSIFICATION_SET.has(review.classification)) continue;
    const item = items.find(entry => entry.id === review.questionId || (entry.ids || []).includes(review.questionId));
    if (!item || item.mergedInto) continue;
    item.classification = review.classification;
    item.classificationSource = 'human';
    item.pendingAi = false;
    item.confirmed = review.classification === 'job_question' || review.classification === 'condition_check';
    item.conditionType = review.classification === 'condition_check' ? (CONDITION_SET.has(review.conditionType) ? review.conditionType : item.conditionType || null) : null;
    item.conditionLabel = item.conditionType ? CONDITION_LABELS[item.conditionType] : '';
    item.reviewStatus = review.classification === 'needs_context' ? 'pending' : 'confirmed';
    item.version = Number(review.version || item.version || 1);
    item.confidenceBasis = 'human_review';
    item.reviews = [...(item.reviews || []), { classification: review.classification, version: item.version, at: review.at || '' }];
  }
}

function dedupe(items) {
  const kept = [];
  const index = new Map();
  for (const item of items) {
    if (item.mergedInto || item.classification === 'communication_check') {
      kept.push(item);
      continue;
    }
    const key = `${item.classification}|${item.conditionType || ''}|${item.normalizedText || item.rawText}`;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, item);
      kept.push(item);
      continue;
    }
    existing.sources = [...existing.sources, ...item.sources];
    existing.ids = [...new Set([...(existing.ids || []), item.id])];
    existing.mergedRaw = [...(existing.mergedRaw || []), ...(item.mergedRaw || [])];
  }
  return kept;
}

function coverageFor(items, job) {
  const questions = items.filter(item => item.classification === 'job_question' && item.confirmed && !item.mergedInto);
  const required = [...new Set([...(job.keywords || []), ...(job.required || [])].map(item => String(item || '').trim()).filter(Boolean))];
  const rows = required.map(term => {
    const matched = questions.filter(item => item.rawText.includes(term) || String(item.normalizedText || '').includes(term));
    return { item: term, covered: matched.length > 0, sources: matched.flatMap(item => item.sources.map(source => source.candidateName || source.transcriptId)).filter(Boolean) };
  });
  return {
    jobQuestionCount: questions.length,
    conditionCount: items.filter(item => item.classification === 'condition_check' && !item.mergedInto).length,
    required: rows,
    missing: rows.filter(row => !row.covered).map(row => row.item),
    supplements: rows.filter(row => !row.covered).map(row => `岗位要求中的「${row.item}」在这些转写里还没有对应问题。`)
  };
}

function followUpStyle(items) {
  const questions = items.filter(item => item.classification === 'job_question' && item.confirmed && !item.mergedInto);
  if (!questions.length) return '';
  const followed = questions.filter(item => (item.contextBefore || []).some(text => String(text).length > 8));
  return followed.length
    ? `${followed.length} 条岗位问题出现在前一段发言之后，追问顺着上一句展开。`
    : '这些岗位问题按职责、结果和条件依次提出，较少顺着候选人上一句展开。';
}

function classifyInterviewQuestions(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const sessionCount = Number(input.sessionCount || sessions.length);
  const job = boundJob(input);
  const sampleLimited = sessionCount < 5;
  const aiEligible = !sampleLimited && job.jobBound;
  const extracted = extractItems(input, job);
  let previous = null;
  for (const item of extracted) {
    const decision = classifyClause(item, job, previous);
    Object.assign(item, decision, {
      evidenceVerified: true,
      reviewStatus: decision.classification === 'needs_context' ? 'pending' : 'auto',
      version: 1,
      normalizedText: item.normalizedText || decision.normalizedText || (decision.classification === 'job_question' ? normalizeQuestion(item.rawText) : item.rawText)
    });
    if (!sampleLimited && item.classification === 'job_question' && !job.jobBound) {
      item.confirmed = false;
      item.classification = 'needs_context';
      item.confidenceBasis = 'no_job_binding';
    }
    if (item.classification === 'needs_context' && item.confidenceBasis === 'boundary') item.pendingAi = aiEligible;
    if (item.classification !== 'communication_check' && !item.mergedInto) previous = item;
  }
  const corpus = corpusOf(sessions);
  const decisions = Array.isArray(input.aiDecisions) ? input.aiDecisions : [];
  let previousVisible = null;
  for (const item of extracted) {
    if (!item.pendingAi) {
      if (!item.mergedInto && item.classification !== 'communication_check') previousVisible = item;
      continue;
    }
    const decision = decisions.find(entry => entry && (entry.id === item.id || entry.questionId === item.id));
    if (!decision) {
      if (decisions.length) {
        item.pendingAi = false;
        item.classification = 'needs_context';
        item.confidenceBasis = 'ai_missing';
        item.confirmed = false;
      }
      continue;
    }
    if (decision.mergeWithPrevious && previousVisible) {
      previousVisible.mergedRaw = [...(previousVisible.mergedRaw || []), item.rawText];
      previousVisible.sources = [...previousVisible.sources, ...item.sources];
      item.mergedInto = previousVisible.id;
      item.pendingAi = false;
      item.classification = 'needs_context';
      item.classificationSource = 'ai';
      item.confidenceBasis = 'ai_merge';
      continue;
    }
    applyDecision(item, decision, corpus);
    if (!item.mergedInto && item.classification !== 'communication_check') previousVisible = item;
  }
  applyHumanReviews(extracted, input.humanReviews);
  const items = dedupe(extracted);
  const visible = items.filter(item => item.classification !== 'communication_check' && !item.mergedInto);
  const allowPersonalReview = aiEligible;
  return {
    rulesVersion: RULES_VERSION,
    classifications: CLASSIFICATIONS,
    sampleLimited,
    sessionCount,
    aiEligible,
    jobBound: job.jobBound,
    excludedCommunicationCount: items.filter(item => item.classification === 'communication_check').length,
    allowPersonalReview,
    followUpStyle: allowPersonalReview ? followUpStyle(items) : '',
    coverage: allowPersonalReview ? coverageFor(items, job) : null,
    items: visible,
    pendingAi: visible.filter(item => item.pendingAi).map(item => ({ id: item.id, rawText: item.rawText, contextBefore: item.contextBefore, contextAfter: item.contextAfter }))
  };
}

function boundaryPrompt(pending, job) {
  return {
    instructions: '你只给面试官已经问出的句子分类，不能新编问题。classification 只能是 communication_check、condition_check、job_question、needs_context。evidenceQuote 必须是该句原文中的连续片段。normalizedQuestion 不能加入原句没有的城市、金额或日期。无法判断时返回 needs_context。输出 JSON：{"items":[{"id":"","classification":"","conditionType":null,"normalizedQuestion":null,"evidenceQuote":"","mergeWithPrevious":false,"reasonCode":""}]}',
    input: JSON.stringify({
      job: { name: job.name, jd: String(job.jd || '').slice(0, 1200), rules: job.rules, verify: job.verify, keywords: job.keywords },
      items: pending
    })
  };
}

async function analyzeInterviewQuestions(input = {}, completeAi) {
  const preview = classifyInterviewQuestions(input);
  const pending = preview.pendingAi || [];
  if (!preview.aiEligible || !pending.length) return preview;
  let decisions = pending.map(item => ({ id: item.id, classification: 'needs_context', evidenceQuote: item.rawText, reasonCode: 'ai_unavailable' }));
  if (typeof completeAi === 'function') {
    try {
      const job = boundJob(input);
      const raw = await completeAi(boundaryPrompt(pending, job));
      if (Array.isArray(raw?.items)) decisions = raw.items;
    } catch {
      decisions = pending.map(item => ({ id: item.id, classification: 'needs_context', evidenceQuote: item.rawText, reasonCode: 'ai_failed' }));
    }
  }
  return classifyInterviewQuestions({ ...input, aiDecisions: decisions });
}

module.exports = {
  CLASSIFICATIONS,
  CONDITION_TYPES,
  CONDITION_LABELS,
  RULES_VERSION,
  classifyInterviewQuestions,
  analyzeInterviewQuestions,
  boundaryPrompt
};
