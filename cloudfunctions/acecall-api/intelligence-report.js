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

function reportTitles(kind) {
  const prefix = kind === 'company' ? '公司' : '行业';
  return [`${prefix}现状`, `${prefix}战略`, `${prefix}业务`, `${prefix}架构`];
}

function reportPrompt(input) {
  const titles = reportTitles(input.kind);
  const subject = input.kind === 'company' ? '这一家公司' : '这一个行业';
  return {
    instructions: `你是招聘调研编辑。只根据输入里的简历摘录和面试转写摘录，为${subject}写一份简短调研报告。按这四项输出，标题必须是${titles.join('、')}。每项 30 到 70 个汉字，写成调研结论，不要复述对话原句，不要写「候选人说」。现状写材料里已经出现的经营或任职情况；战略写材料里提到的方向或打法；业务写材料里提到的产品、客户或工作内容；架构写材料里提到的部门、团队或汇报关系。某一项摘录里没有，该项 text 只写「现有材料未提及。」不要编造摘录里没有的公司、数字、战略或组织。输出 JSON：{"sections":[{"title":"${titles[0]}","text":""},{"title":"${titles[1]}","text":""},{"title":"${titles[2]}","text":""},{"title":"${titles[3]}","text":""}]}`,
    input: JSON.stringify(input)
  };
}

function compactCompanyNameInput(payload = {}) {
  const names = [...new Set((Array.isArray(payload.names) ? payload.names : []).map(item => cleanLine(item, 24)).filter(item => item.length >= 2))].slice(0, 40);
  const excerpts = [...new Set((Array.isArray(payload.excerpts) ? payload.excerpts : []).map(item => cleanLine(item, 140)).filter(item => item.length >= 4))].slice(0, 12);
  return { names, excerpts };
}

function companyNamePrompt(input) {
  return {
    instructions: '你只做公司名称确认。从 names 里保留具体公司全称或常见简称，例如泰隆银行、工商银行、中信证券、华泰。去掉类别、口语和残句，例如一些银行、这些银行、港的银行、洋商业银行、手机银行、商业银行。简称必须是 names 里某个全称的开头，并且能在 excerpts 里对上同一家公司。不要新增 names 里没有的名称。输出 JSON：{"companies":[]}',
    input: JSON.stringify(input)
  };
}

function isSpecificCompanyLabel(name = '') {
  const value = String(name || '').trim();
  if (value.length < 2 || value.length > 16) return false;
  if (/[的些类种某]/.test(value)) return false;
  if (/一些|这些|那些|各类|多家|其他|其它|商业银|外资银|中资银|城市商业|农村商业|村镇银|网上银|手机银|电子银/.test(value)) return false;
  if (/^(银行|证券|基金|保险|科技|集团|公司|资本)$/.test(value)) return false;
  return true;
}

function sanitizeConfirmedCompanies(raw, input) {
  const names = [...new Set((input.names || []).map(item => String(item || '').trim()).filter(Boolean))];
  const picked = [];
  for (const item of Array.isArray(raw?.companies) ? raw.companies : []) {
    const name = String(item || '').replace(/\s+/g, '').trim();
    if (!isSpecificCompanyLabel(name)) continue;
    if (names.includes(name)) {
      picked.push(name);
      continue;
    }
    const fuller = names.find(candidate => candidate.startsWith(name) && isSpecificCompanyLabel(candidate));
    if (fuller) picked.push(fuller);
  }
  const unique = [...new Set(picked)];
  return unique.filter(name => !unique.some(other => other !== name && other.startsWith(name)));
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

function sectionText(value, input, numbers) {
  const text = cleanLine(value, 120);
  if (text === '现有材料未提及。' || text === '现有材料未提及') return '现有材料未提及。';
  return groundedText(text, input, numbers, 120) || '现有材料未提及。';
}

function sanitizeIntelligenceReport(raw, input) {
  if (!input.name || (!input.resumeExcerpts.length && !input.transcriptExcerpts.length)) return null;
  const numbers = allowedNumbers(input);
  const incoming = Array.isArray(raw?.sections) ? raw.sections : [];
  const sections = reportTitles(input.kind).map(title => {
    const found = incoming.find(item => String(item?.title || '').includes(title.slice(2)));
    return { title, text: sectionText(found?.text, input, numbers) };
  });
  return {
    kind: input.kind,
    name: input.name,
    overview: sections.map(item => `${item.title}：${item.text}`).join(''),
    sections,
    resumeFindings: [],
    transcriptFindings: [],
    gaps: '',
    materialCount: input.materialCount,
    candidateCount: input.candidateCount
  };
}

module.exports = { compactReportInput, compactCompanyNameInput, reportPrompt, companyNamePrompt, sanitizeIntelligenceReport, sanitizeConfirmedCompanies };
