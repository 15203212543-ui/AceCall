function cleanName(value, limit = 40) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function takeFacts(list, limit) {
  return (Array.isArray(list) ? list : []).slice(0, limit).map(item => ({
    name: cleanName(item?.name),
    count: Math.max(0, Number(item?.count) || 0),
    candidates: Math.max(0, Number(item?.candidates) || 0),
    focus: cleanName(item?.focus, 80)
  })).filter(item => item.name);
}

function compactIntelligenceFacts(payload = {}) {
  return {
    industries: takeFacts(payload.industries, 4),
    companies: takeFacts(payload.companies, 4),
    talents: takeFacts(payload.talents, 3)
  };
}

function intelligencePrompt(facts) {
  return {
    instructions: '你是招聘行业情报编辑。只根据输入里已经统计好的行业、公司和能力方向写发现，不能补充输入中没有的公司、行业、数字、融资、新闻或趋势判断。每条 summary 用 40 到 90 个汉字，说明材料份数和已出现的方向。材料少于 2 份时写明样本有限。输出 JSON：{"findings":[{"kind":"industry|company|talent","name":"","summary":""}]}',
    input: JSON.stringify(facts)
  };
}

function sanitizeIntelligenceFindings(raw, facts) {
  const allowed = new Map();
  for (const [kind, list] of [['industry', facts.industries], ['company', facts.companies], ['talent', facts.talents]]) {
    for (const item of list || []) allowed.set(`${kind}:${item.name}`, item);
  }
  const findings = [];
  for (const item of Array.isArray(raw?.findings) ? raw.findings : []) {
    const kind = String(item?.kind || '');
    const name = cleanName(item?.name);
    const source = allowed.get(`${kind}:${name}`);
    if (!source) continue;
    const summary = String(item?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (summary.length < 12) continue;
    const allowedNumbers = new Set([String(source.count), String(source.candidates), ...(String(source.focus).match(/\d+/g) || [])]);
    const numbers = summary.match(/\d+/g) || [];
    if (numbers.some(number => !allowedNumbers.has(number))) continue;
    findings.push({ kind, name, summary });
    if (findings.length >= 6) break;
  }
  return findings;
}

module.exports = { compactIntelligenceFacts, intelligencePrompt, sanitizeIntelligenceFindings };
