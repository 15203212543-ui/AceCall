const SCHOOLS_985 = [
  '北京大学', '清华大学', '中国人民大学', '北京航空航天大学', '北京理工大学', '中国农业大学', '北京师范大学',
  '南开大学', '天津大学', '大连理工大学', '东北大学', '吉林大学', '哈尔滨工业大学',
  '复旦大学', '同济大学', '上海交通大学', '华东师范大学', '南京大学', '东南大学', '浙江大学', '中国科学技术大学',
  '厦门大学', '山东大学', '中国海洋大学', '武汉大学', '华中科技大学', '湖南大学', '中南大学', '国防科技大学',
  '中山大学', '华南理工大学', '四川大学', '电子科技大学', '重庆大学', '西安交通大学', '西北工业大学', '西北农林科技大学', '兰州大学'
];

const SCHOOLS_211 = [
  ...SCHOOLS_985,
  '北京交通大学', '北京工业大学', '北京科技大学', '北京化工大学', '北京邮电大学', '北京林业大学', '北京中医药大学', '北京外国语大学', '中国传媒大学', '中央财经大学', '对外经济贸易大学', '北京体育大学', '中央音乐学院', '中国政法大学', '华北电力大学', '中央民族大学',
  '天津医科大学', '河北工业大学', '太原理工大学', '内蒙古大学', '辽宁大学', '大连海事大学', '延边大学', '东北师范大学', '东北农业大学', '东北林业大学',
  '华东理工大学', '东华大学', '上海外国语大学', '上海财经大学', '上海大学', '苏州大学', '南京航空航天大学', '南京理工大学', '中国矿业大学', '河海大学', '江南大学', '南京农业大学', '中国药科大学', '南京师范大学',
  '安徽大学', '合肥工业大学', '福州大学', '南昌大学', '中国石油大学（华东）', '中国石油大学(华东)', '郑州大学',
  '中国地质大学（武汉）', '中国地质大学(武汉)', '武汉理工大学', '华中农业大学', '华中师范大学', '中南财经政法大学', '湖南师范大学',
  '暨南大学', '华南师范大学', '广西大学', '海南大学', '西南大学', '西南交通大学', '四川农业大学', '西南财经大学', '贵州大学', '云南大学', '西藏大学',
  '西北大学', '西安电子科技大学', '长安大学', '陕西师范大学', '青海大学', '宁夏大学', '新疆大学', '石河子大学'
];

const SCHOOLS_DOUBLE_FIRST = [
  ...SCHOOLS_211,
  '南方科技大学', '上海科技大学', '中国科学院大学', '中国社会科学院大学', '南京邮电大学', '南京信息工程大学', '南京医科大学', '首都医科大学', '上海中医药大学', '广州医科大学', '成都理工大学', '宁波大学', '河南大学', '湘潭大学', '上海海洋大学', '中国美术学院', '中央美术学院', '外交学院'
];

const QS_2026 = new Map([
  ['北京大学', 14],
  ['清华大学', 17],
  ['复旦大学', 30],
  ['上海交通大学', 47],
  ['浙江大学', 49],
  ['南京大学', 103],
  ['中国科学技术大学', 132],
  ['同济大学', 177],
  ['武汉大学', 186],
  ['北京师范大学', 247],
  ['哈尔滨工业大学', 256],
  ['天津大学', 257],
  ['北京理工大学', 259],
  ['中山大学', 276],
  ['西安交通大学', 305]
]);

const INDUSTRY_RULES = [
  [/证券|券商/, '证券'],
  [/银行/, '银行'],
  [/基金|资管|资产管理/, '基金'],
  [/保险/, '保险'],
  [/信托/, '信托'],
  [/期货/, '期货'],
  [/软件|科技|网络|互联网|信息|数据/, '互联网'],
  [/教育|培训/, '教育'],
  [/医疗|医药|生物|医院/, '医疗'],
  [/地产|置业|房地产/, '房地产'],
  [/咨询/, '咨询'],
  [/汽车|制造|电子|工业/, '制造'],
  [/零售|消费|食品|电商/, '消费'],
  [/物流|供应链/, '物流'],
  [/传媒|文化|广告/, '传媒'],
  [/人力|猎头/, '人力资源']
];

function schoolName(value = '') {
  return String(value).replace(/\s+/g, '').match(/[\u4e00-\u9fff]{2,20}(?:大学|学院)/)?.[0] || '';
}

function listedSchool(name, schools) {
  return schools.find(school => name === school || name.startsWith(school));
}

function schoolLabels(name = '') {
  const school = schoolName(name);
  if (!school) return [];
  const labels = [];
  if (listedSchool(school, SCHOOLS_985)) labels.push('985');
  else if (listedSchool(school, SCHOOLS_211)) labels.push('211');
  else if (listedSchool(school, SCHOOLS_DOUBLE_FIRST)) labels.push('双一流');
  if (listedSchool(school, SCHOOLS_211) && !labels.includes('985') && listedSchool(school, SCHOOLS_DOUBLE_FIRST)) labels.push('双一流');
  const qs = QS_2026.get(listedSchool(school, [...QS_2026.keys()]) || '');
  if (qs) labels.push(`QS ${qs}`);
  return labels;
}

function endScore(value = '') {
  const text = String(value).replace(/\s+/g, '');
  if (/至今|现在/.test(text)) return 999999;
  const end = text.split(/[-–~至到]+/).pop() || '';
  const match = end.match(/(20|19)(\d{2})(?:[./年](\d{1,2}))?/);
  if (!match) return 0;
  return Number(match[1] + match[2]) * 100 + Number(match[3] || 1);
}

function industryOf(company = '') {
  const name = String(company);
  return INDUSTRY_RULES.find(([pattern]) => pattern.test(name))?.[1] || '';
}

function workEntries(text = '') {
  const lines = String(text).replace(/\r/g, '').split(/\n+/).map(line => line.trim()).filter(Boolean);
  const start = lines.findIndex(line => /^(?:工作经历|工作经验|职业经历|任职经历|工作背景)/.test(line.replace(/[：:].*$/, '')));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^(?:教育经历|教育背景|项目经历|专业技能|技能证书|自我评价|证书|荣誉|求职意向)/.test(line.replace(/[：:].*$/, '')));
  const section = lines.slice(start + 1, end > start ? end : Math.min(lines.length, start + 80));
  return section.flatMap(line => {
    const match = line.match(/^((?:19|20)\d{2}[./年]\s*\d{1,2})\s*[-–~至到]+\s*(至今|现在|(?:19|20)\d{2}[./年]\s*\d{1,2})\s*(.+)$/);
    if (!match || /大学|学院|本科|硕士|博士/.test(match[3])) return [];
    const body = match[3].replace(/^[|｜·•,，、:：\s]+/, '');
    const company = (body.split(/[|｜]/)[0] || '').replace(/(实习生|助理|专员|经理|总监|工程师|顾问).*$/, '').trim();
    if (company.length < 2) return [];
    return [{ company, end: endScore(`${match[1]}-${match[2]}`) }];
  });
}

function storedWorkEntries(experiences = []) {
  return experiences.flatMap(item => {
    const company = String(item?.company || '').trim();
    if (!company || /大学|学院|本科|硕士|博士/.test(company)) return [];
    return [{ company, end: endScore(item.dates || '') }];
  });
}

function recentCompany(text = '', experiences = []) {
  const entries = [...workEntries(text), ...storedWorkEntries(experiences)].sort((left, right) => right.end - left.end);
  const company = entries[0]?.company || '';
  return { company, industry: industryOf(company) };
}

function educationEntries(text = '', meta = {}) {
  const lines = String(text).replace(/\r/g, '').split(/\n+/).map(line => line.trim()).filter(Boolean);
  const found = [];
  lines.forEach(line => {
    const school = schoolName(line);
    if (!school) return;
    const degree = /博士/.test(line) ? '博士' : /硕士|研究生|MBA|MSc|Master/i.test(line) ? '硕士' : /本科|学士|Bachelor/i.test(line) ? '本科' : '';
    if (!degree || degree === '博士') return;
    if (!found.some(item => item.degree === degree && item.school === school)) found.push({ degree, school });
  });
  if (!found.length && schoolName(meta.school)) {
    const degree = /硕士/.test(meta.education || '') ? '硕士' : /本科/.test(meta.education || '') ? '本科' : '';
    if (degree) found.push({ degree, school: schoolName(meta.school) });
  }
  const record = degree => {
    const item = found.find(entry => entry.degree === degree);
    if (!item) return null;
    return { name: item.school, labels: schoolLabels(item.school) };
  };
  return { bachelor: record('本科'), master: record('硕士') };
}

export function analyzeCandidateBackground(item = {}) {
  const meta = item.resumeMeta || {};
  const company = recentCompany(item.resume || '', meta.experiences || []);
  const education = educationEntries(item.resume || '', meta);
  return { ...company, ...education };
}
