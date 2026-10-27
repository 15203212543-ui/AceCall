const { extractPhone } = require('./resume-text');

const CONFIDENCE = { explicit_field: 0.95, context_inference: 0.45, filename_pattern: 0.7, layout_inference: 0.6 };

function proposeNameCandidates({ labeled = '', contextual = '', fromFile = '', fromBody = '' } = {}) {
  const found = [];
  const add = (value, source, basis) => {
    const name = String(value || '').trim();
    if (!name || found.some(item => item.value === name)) return;
    found.push({ value: name, source, confidenceBasis: basis, confidence: CONFIDENCE[basis], quote: name });
  };
  add(labeled, '简历姓名字段', 'explicit_field');
  add(contextual, '联系方式附近文本', 'context_inference');
  add(fromFile, '文件名', 'filename_pattern');
  add(fromBody, '简历正文', 'layout_inference');
  return found.sort((left, right) => right.confidence - left.confidence).slice(0, 3);
}

function chooseDisplayedName(candidates = []) {
  const top = candidates[0];
  if (!top) return { candidateName: '', candidateNameStatus: '待确认', candidateNameSource: '' };
  const second = candidates[1];
  const recognized = top.confidence >= 0.9 && (!second || top.confidence - second.confidence >= 0.15);
  return { candidateName: top.value, candidateNameStatus: recognized ? '已识别' : '待确认', candidateNameSource: top.source };
}

function extractProfileFields(text = '') {
  const source = String(text || '');
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean);
  const quoteFor = value => lines.find(line => line.includes(value)) || value;
  const phone = extractPhone(source);
  const email = (source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '').replace(/[，。；;）)]+$/, '');
  const experienceYears = source.match(/(\d{1,2})\s*年[^。\n]{0,16}(?:工作|从业|经验|经历)/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => source.includes(level)) || '';
  const school = source.match(/([\u4e00-\u9fffA-Za-z]{2,24}(?:大学|学院))/)?.[1] || '';
  const certificates = [...new Set([...source.matchAll(/CPA|CFA|FRM|基金从业|证券从业|律师资格|注册会计师/g)].map(item => item[0]))];
  const ageMatch = source.match(/(?:年龄|Age)\s*[:：]?\s*(\d{2})(?:岁)?/i) || source.match(/(?<!\d)(2[0-9]|3[0-9]|4[0-9])\s*岁/);
  const experiences = lines.flatMap(line => {
    const match = line.match(/^((?:19|20)\d{2}(?:\s*[./年]\s*\d{1,2}(?:\s*月)?)?\s*[-–~至到]+\s*(?:至今|现在|(?:19|20)\d{2}(?:\s*[./年]\s*\d{1,2}(?:\s*月)?)?))\s*([\u4e00-\u9fffA-Za-z0-9（）()]{2,24})(?:\s+([\u4e00-\u9fffA-Za-z]{2,16}))?/);
    if (!match) return [];
    return [{ dates: match[1].replace(/\s+/g, ''), company: match[2], title: match[3] || '', scope: line, quote: line }];
  });
  const field = (factType, value) => value ? { factType, value, quote: quoteFor(String(value)), status: 'pending', confidenceBasis: 'exact_quote' } : null;
  return {
    fields: [field('phone', phone), field('email', email), field('education', education), field('school', school), field('experienceYears', experienceYears), ...certificates.map(item => field('certificate', item)), ...experiences.map(item => ({ factType: 'experience', value: item, quote: item.quote, status: 'pending', confidenceBasis: 'exact_quote' }))].filter(Boolean),
    phone, email, education, school, experienceYears, certificates, experiences,
    age: ageMatch ? { value: ageMatch[1], quote: quoteFor(ageMatch[0]), complianceOnly: true, usedForMatch: false } : null
  };
}

module.exports = { proposeNameCandidates, chooseDisplayedName, extractProfileFields };
