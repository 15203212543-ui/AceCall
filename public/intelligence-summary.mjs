const DEFAULT_LEXICON = [
  '证券', '基金', '银行', '保险', '信托', '资管', '私募', '金融科技', '互联网', '企业服务', 'SaaS',
  '场外期权', 'RFQ', '交易系统', '风控系统', '清算系统', '估值系统', '订单管理', '投研平台', '数据服务', 'CRM',
  '机构业务', '资产管理', '做市', '自营交易', '量化交易', '风险管理', '合规', '清算', '产品研发', '销售获客', '客户成功', '招聘运营'
];

function unique(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function compactQuote(value = '') {
  return String(value)
    .replace(/^(?:面试官|候选人|招聘人员|HR|受访者)[A-Za-z0-9_\-]*\s*[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function collectKeywords(item = {}, lexicon = DEFAULT_LEXICON) {
  const structured = [
    ...(item.industries || []),
    ...(item.products || []),
    ...(item.businesses || []),
    ...(item.keywords || [])
  ];
  const evidence = String(item.evidence || '').toLowerCase();
  const matched = lexicon.filter(term => evidence.includes(String(term).toLowerCase()));
  return unique([...structured, ...matched]).filter(term => term !== item.name).slice(0, 6);
}

function subjectLabel(type = 'all') {
  return ({
    industry: '行业主题',
    company: '公司人才线索',
    product: '产品能力',
    business: '业务经验',
    talent: '人才能力',
    all: '招聘研究线索'
  })[type] || '招聘研究线索';
}

export function buildIntelligenceBrief(item = {}, options = {}) {
  const type = options.type || 'all';
  const name = String(item.name || options.name || '未命名主题').trim();
  const count = Math.max(1, Number(item.count) || 1);
  const sources = unique(item.sources || []);
  const keywords = collectKeywords(item, options.lexicon || DEFAULT_LEXICON);
  const focus = keywords.length ? keywords.join('、') : '相关从业经历与业务实践';
  const quote = compactQuote(item.evidence || '');
  const coverage = `${count} 条招聘材料${sources.length ? `，来源包括${sources.join('、')}` : ''}`;
  const strength = count >= 3 ? '多材料信号' : '单点线索';
  let summary;

  if (type === 'company') {
    summary = `招聘材料中识别到与${name}有关的人才经历，关联主题集中在${focus}。当前结论基于${coverage}，可用于内部人才与竞品研究，不代表该公司的公开经营动态。`;
  } else if (type === 'industry') {
    summary = `招聘沟通中出现${name}相关经验，讨论重点集中在${focus}。当前结论基于${coverage}，反映样本中的人才经验与岗位关注点，尚不足以代表整体行业趋势。`;
  } else if (type === 'product' || type === 'talent') {
    summary = `候选人材料中出现${name}相关能力，主要关联${focus}。当前结论基于${coverage}，用于观察人才经验分布，不等同于市场需求增长判断。`;
  } else if (type === 'business') {
    summary = `招聘材料中识别到${name}相关业务经验，主要涉及${focus}。当前结论基于${coverage}，需结合更多样本后再判断其普遍性。`;
  } else {
    summary = `招聘材料中识别到${name}相关线索，重点涉及${focus}。当前结论基于${coverage}，仅供内部研究并保留人工核验。`;
  }

  return {
    label: subjectLabel(type),
    title: `${name} · ${keywords[0] || '人才经验信号'}`,
    summary,
    keywords,
    strength,
    quote,
    sourceText: sources.join(' / ') || '招聘材料'
  };
}

export { compactQuote };
