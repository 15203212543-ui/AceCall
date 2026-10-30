const path = require('node:path');

function normalizeResumeText(text = '') {
  const source = String(text).normalize('NFKC').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd\u200b\ufeff]/g, '');
  const lines = source.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const counts = new Map(); const fingerprints = new Map();
  lines.forEach(line => { counts.set(line, (counts.get(line) || 0) + 1); const fingerprint = line.replace(/[\s|·•,，。；;:：、_\-]+/g, '').toLowerCase(); if (fingerprint.length >= 4) fingerprints.set(fingerprint, (fingerprints.get(fingerprint) || 0) + 1); });
  const cleaned = lines.filter(line => {
    if ((counts.get(line) || 0) >= 3 && line.length < 100) return false;
    const fingerprint = line.replace(/[\s|·•,，。；;:：、_\-]+/g, '').toLowerCase();
    if ((fingerprints.get(fingerprint) || 0) >= 2 && line.length < 100 && !/[\u4e00-\u9fff]/.test(line)) return false;
    if (isResumeNoiseLine(line)) return false;
    const visible = line.replace(/[\u4e00-\u9fffA-Za-z0-9@.+#:/()（）、，。；：\-]/g, '');
    return visible.length / Math.max(line.length, 1) < 0.45;
  });
  return removeRepeatedWatermarkFragments(cleaned).join('\n').replace(/([A-Za-z])\-\n([A-Za-z])/g, '$1$2').replace(/\n{3,}/g, '\n\n').trim();
}

function isResumeNoiseLine(line = '') {
  const value = String(line).trim();
  if (!value || value.length > 100) return false;
  if (/20\d{2}-\d{1,2}-\d{1,2}/.test(value) && /\d{1,2}:\d{2}/.test(value)) return false;
  if (/(水印|仅供|内部资料|机密|严禁|勿传|招聘平台|简历编号|候选人编号)[^\n]{0,30}[A-Za-z0-9_-]{2,}/i.test(value)) return true;
  if (/1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[\u4e00-\u9fff]{2,}/.test(value)) return false;
  if (/^(?:第\s*)?\d{1,3}(?:\s*[|/\\-]\s*\d{1,3})?[.]?$/.test(value)) return true;
  if (/^[\s\dA-Za-z|·•._:/\\-]{2,60}$/.test(value)) {
    const compact = value.replace(/[\s|·•._:/\\-]/g, '');
    if (/^(?:\d+[A-Za-z]+|[A-Za-z]+\d+|[A-F0-9]{6,})$/i.test(compact)) return true;
    if (/^(?:[A-Za-z0-9]{2,8}[\s_-]?){2,8}$/.test(value) && /\d/.test(value)) return true;
  }
  return false;
}

function removeRepeatedWatermarkFragments(lines = []) {
  const tokenCounts = new Map();
  const tokensIn = line => line.match(/(?<![\u4e00-\u9fff])[A-Za-z0-9][A-Za-z0-9._-]{3,}(?![\u4e00-\u9fff])/g) || [];
  const isCalendarDate = token => /^20\d{2}-\d{1,2}-\d{1,2}$/.test(token);
  lines.forEach(line => { [...new Set(tokensIn(line))].forEach(token => { if (isCalendarDate(token)) return; tokenCounts.set(token.toLowerCase(), (tokenCounts.get(token.toLowerCase()) || 0) + 1); }); });
  const watermarkTokens = new Set([...tokenCounts.entries()].filter(([token, count]) => count >= 3 && /\d|[A-F]{4,}/i.test(token) && !/@/.test(token)).map(([token]) => token));
  return lines.map(line => line.replace(/(?<![\u4e00-\u9fff])[A-Za-z0-9][A-Za-z0-9._-]{3,}(?![\u4e00-\u9fff])/g, token => isCalendarDate(token) || !watermarkTokens.has(token.toLowerCase()) ? token : '').replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean);
}

function parseResumeBasics(text = '') {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const phone = extractPhone(text);
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '').replace(/[，。；;）)]+$/, '');
  const years = text.match(/(\d{1,2})\s*年[^。\n]{0,16}(?:工作|从业|经验|经历)/)?.[1] || '';
  const age = text.match(/(?:年龄|Age)\s*[:：]?\s*(\d{2})(?:岁)?/i)?.[1] || text.match(/(?<!\d)(2[0-9]|3[0-9]|4[0-9])\s*岁/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => text.includes(level)) || '';
  return { candidateName: extractCandidateName(lines), phone, email, age, experienceYears: years, education };
}

function extractPhone(text = '') {
  const normalized = String(text).normalize('NFKC').replace(/[‐‑‒–—―−﹣－]/g, '-');
  const match = normalized.match(/(?<!\d)(?:\+?86[\s-]*)?(1[3-9](?:[\s-]*\d){9})(?!\d)/);
  return (match?.[1] || '').replace(/\D/g, '');
}

function extractExperienceYearsFromFileName(fileName = '') {
  const base = path.basename(String(fileName), path.extname(String(fileName)));
  const matches = [...base.matchAll(/(?:^|[\s】_)])(\d{1,2})\s*年(?:以上|经验)?(?=$|[\s(（])/g)];
  const years = matches.map(match => Number(match[1])).filter(value => value >= 0 && value <= 15);
  return years.length ? String(years[years.length - 1]) : '';
}

function extractCandidateName(lines = []) {
  const labeled = extractLabeledCandidateName(lines);
  if (labeled) return labeled;
  for (const line of lines.slice(0, 8)) {
    if (line.length > 80 || isNameNoise(line) || /@|1[3-9]\d{9}|\d{2,4}[-/.年]/.test(line)) continue;
    const chinese = [...line.matchAll(/(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/g)].map(item => item[0]);
    const candidate = chinese.reverse().find(isPlausibleCandidateName);
    if (candidate) return normalizeCandidateName(candidate);
    const english = line.match(/\b[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,3}\b/)?.[0];
    if (isPlausibleCandidateName(english)) return normalizeCandidateName(english);
  }
  return '';
}

function extractContextualCandidateName(lines = []) {
  const limit = Math.min(lines.length, 12);
  const contactPattern = /性别|男|女|手机|电话|邮箱|email|联系方式|联系地址|出生|年龄|1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i;
  const candidates = [];
  for (let index = 0; index < limit; index += 1) {
    const start = Math.max(0, index - 1); const end = Math.min(limit, index + 2);
    const context = lines.slice(start, end).join(' ');
    if (!contactPattern.test(context)) continue;
    const source = lines[index];
    if (!source || source.length > 80 || isNameNoise(source)) continue;
    const chinese = [...source.matchAll(/(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/g)].map(match => match[0]);
    chinese.forEach(candidate => { if (isPlausibleCandidateName(candidate)) candidates.push({ candidate, score: contactPattern.test(source) ? 2 : 1 }); });
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.candidate ? normalizeCandidateName(candidates[0].candidate) : '';
}

function extractLabeledCandidateName(lines = []) {
  for (const line of lines.slice(0, 30)) {
    const source = String(line || '').trim();
    const nameField = source.match(/(?:^|[\s|｜])(?:姓名|Name)\s*[:：]\s*([\u4e00-\u9fff]{2,4})(?![\u4e00-\u9fff])/i) || source.match(/(?:^|[\s|｜])(?:姓名|Name)\s*[:：]\s*([A-Za-z][A-Za-z .'-]{1,30}?)(?=\s|$|[|｜,，])/i);
    const markedField = source.match(/(?:^|[\s|｜])(?:候选人|Candidate)\s*[:：]\s*([\u4e00-\u9fff]{2,4})(?![\u4e00-\u9fff])/i) || source.match(/(?:^|[\s|｜])(?:候选人|Candidate)\s*[:：]\s*([A-Za-z][A-Za-z .'-]{1,30}?)(?=\s|$|[|｜,，])/i);
    const labeled = nameField?.[1] || markedField?.[1];
    if (isPlausibleCandidateName(labeled)) return normalizeCandidateName(labeled);
  }
  return '';
}

function extractNameFromFileName(fileName = '') {
  const value = path.basename(fileName, path.extname(fileName)).replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[_-]+/g, ' ').replace(/\b(?:CV|Resume|for|cn|en)\b/gi, ' ').replace(/(?:的)?简历|工作\s*\d+\s*年|\d+\s*年(?:经验)?|\d{2,4}K|Golang|Java|开发工程师|产品经理|风控专员|服务端开发|应届生|候选人|人才报告|附件/g, ' ').replace(/\s+/g, ' ').trim();
  const chinese = [...value.matchAll(/(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/g)].map(item => item[0]).filter(isPlausibleCandidateName);
  if (chinese.length) return normalizeCandidateName(chinese[chinese.length - 1]);
  const english = value.match(/\b[A-Z][A-Za-z']{1,20}(?:\s+[A-Z][A-Za-z']{1,20}){1,3}\b/)?.[0] || '';
  return isPlausibleCandidateName(english) ? normalizeCandidateName(english) : '';
}

function normalizeCandidateName(value = '') {
  return String(value).replace(/[\u200b\ufeff]/g, '').replace(/^(?:姓名|候选人|Candidate|Name)\s*[:：]?\s*/i, '').replace(/^[\s:：|·•\-]+|[\s,，。；;、]+$/g, '').trim();
}

function isNameHeading(value = '') {
  return String(value || '').trim().length > 0 && String(value).trim().length <= 24;
}

const RESUME_SECTION_NAMES = new Set('外语水平、语言能力、英语水平、计算机水平、专业技能、技能特长、自我评价、求职意向、教育背景、工作经历、项目经历、实习经历、培训经历、证书荣誉、个人优势、基本信息、联系方式、兴趣爱好、主修课程、个人简介、获奖情况、技能证书、英语、法语、日语、德语、韩语、俄语、粤语、普通话、国语'.split('、'));

function isResumeSectionName(value = '') {
  const name = String(value || '').trim();
  if (!name) return false;
  if (RESUME_SECTION_NAMES.has(name)) return true;
  return /水平|能力|经历|背景|技能|评价|意向|证书|课程|荣誉/.test(name);
}

function isNonPersonName(value = '') {
  return isResumeSectionName(value) || /初步|撰写|到岗|入职|离职|在职|沟通|跟进|推动|负责|协助|执行|留痕|合规|核验|招聘|简历|应届|实习|全职|兼职|求职|背景|候选人|岗位|职位|大学|学院|公司|经验|学历|通过|推荐|匹配|确认|完成|目前|合适|数据|完整|要求|全程|已读|未读|产品|需求|方案|项目|职责|技能|能力|优势|总结|介绍|目标|结果|内容|运营|开发|设计|分析|管理|规划|维护|北京|上海|深圳|广州|杭州|成都|南京|武汉|苏州|香港/.test(String(value || ''));
}

function isNameNoise(value = '') {
  return /姓名|简历|个人信息|基本信息|工作经历|教育背景|教育经历|项目经历|专业技能|自我评价|求职意向|出生日期|年龄|电话|手机|邮箱|微信|职位|岗位|经验|任职|联系方式|画像|背景信息|建联沟通|绩点|寻访|大学|学院|学校|科技|计算机|公司|集团|招聘|应届生|summary|resume|experience|education/i.test(String(value));
}

function isPlausibleCandidateName(value = '') {
  const name = normalizeCandidateName(value);
  if (!name || isNameNoise(name) || isNonPersonName(name) || /[:：@]|\d{2,}/.test(name)) return false;
  return /^[\u4e00-\u9fff]{2,4}$/.test(name) || /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(name);
}

function chooseCandidateName(...values) {
  const selected = values.map(normalizeCandidateName).find(isPlausibleCandidateName);
  return selected || '';
}


module.exports = {
  normalizeResumeText,
  parseResumeBasics,
  extractPhone,
  extractExperienceYearsFromFileName,
  extractCandidateName,
  extractContextualCandidateName,
  extractLabeledCandidateName,
  extractNameFromFileName,
  normalizeCandidateName,
  isPlausibleCandidateName,
  isNonPersonName,
  isResumeSectionName,
  chooseCandidateName
};
