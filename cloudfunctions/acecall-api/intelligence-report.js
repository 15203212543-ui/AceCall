function cleanLine(value, limit = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function compactReportInput(payload = {}) {
  const kind = payload.kind === 'company' ? 'company' : 'industry';
  const take = list => [...new Set((Array.isArray(list) ? list : []).map(item => cleanLine(item)).filter(item => item.length >= 8))].slice(0, 6);
  return {
    kind,
    name: cleanLine(payload.name, 40),
    materialCount: Math.max(0, Number(payload.materialCount) || 0),
    candidateCount: Math.max(0, Number(payload.candidateCount) || 0),
    resumeExcerpts: take(payload.resumeExcerpts),
    transcriptExcerpts: take(payload.transcriptExcerpts)
  };
}

function reportPrompt(input) {
  return {
    instructions: '你是招聘行业情报编辑。只根据输入里的简历摘录和面试转写摘录，为这一个行业或这一家公司写一份简短报告。overview 用 80 到 160 个汉字写成一段报告正文，覆盖摘录里已经出现的公司、职责和业务说法，句子连在一起，简短精炼。不要写材料份数、样本有限、无法覆盖、尚未形成这类说明，不要编造摘录里没有的公司、数字或趋势。resumeFindings、transcriptFindings 都输出空数组，gaps 输出空字符串。输出 JSON：{"overview":"","resumeFindings":[],"transcriptFindings":[],"gaps":""}',
    input: JSON.stringify(input)
  };
}

function allowedNumbers(input) {
  const corpus = [...input.resumeExcerpts, ...input.transcriptExcerpts].join('\n');
  return new Set([String(input.materialCount), String(input.candidateCount), ...(corpus.match(/\d+/g) || [])]);
}

function groundedText(value, input, numbers, limit) {
  const text = cleanLine(value, limit);
  if (text.length < 8) return '';
  const used = text.match(/\d+/g) || [];
  if (used.some(number => !numbers.has(number))) return '';
  const corpus = `${input.name}\n${input.resumeExcerpts.join('\n')}\n${input.transcriptExcerpts.join('\n')}`;
  const suffix = /公司|集团|证券|银行|基金|科技/g;
  let match;
  while ((match = suffix.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    const heads = [];
    for (let size = 2; size <= Math.min(8, before.length); size += 1) {
      const head = before.slice(-size);
      if (/^[\u4e00-\u9fffA-Za-z0-9]+$/.test(head)) heads.push(head + match[0]);
    }
    if (heads.length && !heads.some(name => corpus.includes(name))) return '';
  }
  return text;
}

function sanitizeIntelligenceReport(raw, input) {
  if (!input.name || (!input.resumeExcerpts.length && !input.transcriptExcerpts.length)) return null;
  const numbers = allowedNumbers(input);
  const overview = groundedText(raw?.overview, input, numbers, 220);
  if (!overview) return null;
  const takeFindings = list => [...new Set((Array.isArray(list) ? list : []).map(item => groundedText(item, input, numbers, 120)).filter(Boolean))].slice(0, 4);
  return {
    kind: input.kind,
    name: input.name,
    overview,
    resumeFindings: takeFindings(raw?.resumeFindings),
    transcriptFindings: takeFindings(raw?.transcriptFindings),
    gaps: groundedText(raw?.gaps, input, numbers, 120),
    materialCount: input.materialCount,
    candidateCount: input.candidateCount
  };
}

module.exports = { compactReportInput, reportPrompt, sanitizeIntelligenceReport };
