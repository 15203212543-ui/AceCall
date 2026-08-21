const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));

const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const provider = getModelProvider();
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        mode: provider === 'demo' ? 'demo' : 'ai',
        provider,
        model: provider === 'deepseek' ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat') : (process.env.OPENAI_MODEL || 'gpt-5.6-terra')
      });
    }

    if (request.method === 'POST' && request.url === '/api/generate') {
      const payload = await readJson(request);
      validatePayload(payload);
      const result = provider === 'deepseek'
        ? await generateWithDeepSeek(payload)
        : provider === 'openai' ? await generateWithOpenAI(payload) : generateDemo(payload);
      return sendJson(response, 200, { result, mode: provider === 'demo' ? 'demo' : 'ai', provider });
    }

    if (request.method === 'POST' && request.url?.startsWith('/api/parse-resume')) {
      const fileName = new URL(request.url, 'http://localhost').searchParams.get('name') || 'resume';
      const buffer = await readBuffer(request, 10_000_000);
      const parsed = await parseResumeFile(fileName, buffer);
      return sendJson(response, 200, parsed);
    }

    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
    serveStatic(request.url, response);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(response, status, { error: status === 500 ? '服务暂时不可用，请稍后重试。' : error.message });
  }
});

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

function serveStatic(rawUrl, response) {
  const pathname = decodeURIComponent((rawUrl || '/').split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, 'index.html')) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(data);
  });
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw Object.assign(new Error('输入内容过大'), { statusCode: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('请求格式无效'), { statusCode: 400 }); }
}

async function readBuffer(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('简历文件不能超过 10MB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseResumeFile(fileName, buffer) {
  const extension = path.extname(fileName).toLowerCase();
  let text = '';
  if (['.txt', '.md'].includes(extension)) {
    text = buffer.toString('utf8');
  } else if (extension === '.docx') {
    const mammoth = require('mammoth');
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (extension === '.pdf') {
    const pdfParse = require('pdf-parse');
    text = (await pdfParse(buffer)).text;
  } else {
    throw Object.assign(new Error('仅支持 PDF、DOCX、TXT 和 MD 文件'), { statusCode: 415 });
  }
  text = normalizeResumeText(text);
  if (text.length < 20) throw Object.assign(new Error('未提取到足够文字；如果是扫描版 PDF，请先进行 OCR'), { statusCode: 422 });
  return { text, metadata: { fileName, extension: extension.slice(1).toUpperCase(), characters: text.length, ...parseResumeBasics(text) } };
}

function normalizeResumeText(text = '') {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseResumeBasics(text = '') {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const phone = text.match(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/)?.[0] || '';
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const years = text.match(/(\d{1,2})\s*年[^。\n]{0,12}经验/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => text.includes(level)) || '';
  const firstLine = lines.find(line => line.length >= 2 && line.length <= 20 && !/简历|求职|电话|邮箱|手机/.test(line)) || '';
  return { candidateName: firstLine, phone, email, experienceYears: years, education };
}

function validatePayload(payload) {
  if (!['prepare', 'summarize', 'synthesize', 'match'].includes(payload.action)) throw Object.assign(new Error('未知工作流步骤'), { statusCode: 400 });
  if (payload.action === 'match' && (!payload.resume?.trim() || !Array.isArray(payload.jobs))) throw Object.assign(new Error('请提供简历和岗位列表'), { statusCode: 400 });
  if (payload.action === 'prepare' && (!payload.jd?.trim() || !payload.resume?.trim())) {
    throw Object.assign(new Error('请填写 JD 和候选人简历'), { statusCode: 400 });
  }
  if (payload.action === 'summarize' && !payload.transcript?.trim()) {
    throw Object.assign(new Error('请填写电话转写内容'), { statusCode: 400 });
  }
  if (payload.action === 'synthesize' && (!payload.preparation || !payload.communicationSummary)) {
    throw Object.assign(new Error('请先生成初筛方案和沟通总结'), { statusCode: 400 });
  }
}

function getModelProvider() {
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'demo';
}

function buildModelPrompt(payload) {
  const schema = payload.action === 'prepare' ? prepareSchema() : payload.action === 'summarize' ? summarySchema() : payload.action === 'synthesize' ? synthesisSchema() : matchSchema();
  const instructions = `你是金融与互联网行业的专业招聘电话初筛助手。只依据输入事实工作，不得推断性别、年龄、婚育、籍贯等非岗位因素。区分“材料陈述”“电话确认”“仍待核验”，未知信息写“待确认”。输出严格 JSON，不含 Markdown。每项判断必须附事实依据，不得自动淘汰，最终决策由招聘人员完成。${schema}`;
  return { instructions, input: JSON.stringify(payload) };
}

async function generateWithDeepSeek(payload) {
  const { instructions, input } = buildModelPrompt(payload);
  const apiResponse = await fetch(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      stream: false
    })
  });
  if (!apiResponse.ok) {
    const detail = await apiResponse.text();
    throw new Error(`DeepSeek API error: ${apiResponse.status}${detail ? ` ${detail.slice(0, 180)}` : ''}`);
  }
  const data = await apiResponse.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek 未返回有效内容');
  return JSON.parse(text);
}

async function generateWithOpenAI(payload) {
  const { instructions, input } = buildModelPrompt(payload);
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      instructions,
      input,
      text: { format: { type: 'json_object' } }
    })
  });
  if (!apiResponse.ok) throw new Error(`OpenAI API error: ${apiResponse.status}`);
  const data = await apiResponse.json();
  const text = data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!text) throw new Error('模型未返回有效内容');
  return JSON.parse(text);
}

function prepareSchema() {
  return '初筛方案字段：summary 对象，含 headline、experience、relevantBackground、openFacts；matches 数组，每项含 requirement、evidence、confidence（高/中/低）；risks 数组，每项含 risk、evidence、impact；verification 数组，每项含 item、reason、priority（高/中/低）；questions 数组，每项含 category、question、reason、source（匹配点/风险点/重点核验/通用）。生成12-18个问题，并覆盖所有高优先级核验项。';
}

function matchSchema() {
  return '岗位匹配字段：jobId 字符串（主岗位ID）；score 0到100整数；confidence（高/中/低）；status（已分配/待分配）；dimensions 数组，每项含 item、score、evidence；alternativeJobs 数组，每项含 name、score、reason；risks 数组，每项含 risk、evidence。根据简历事实和岗位JD、关键词进行语义匹配，缺失信息不等于不匹配，不得使用年龄、性别、婚育、籍贯等因素。';
}

function summarySchema() {
  return '沟通总结字段：overview 字符串；confirmed、contradicted、missing 数组，每项含 item、evidence；questionCoverage 对象含 covered、total、unanswered 数组；keyFacts 对象含 currentCompanyRole、location、currentSalary、expectedSalary、availability、motivation、nonCompete；candidateSignals 字符串数组；followUps 字符串数组。只总结电话内容，不给推荐结论。';
}

function synthesisSchema() {
  return '综合审核字段：basicInfo 对象；capabilities 数组，每项含 item、evidence、assessment（匹配/部分匹配/信息不足/不匹配）；evidence 字符串数组；conflicts 数组，每项含 topic、resumeClaim、callEvidence；risks 字符串数组；conclusion（明确匹配/部分匹配/信息不足/明确不匹配）；conclusionReason 字符串；nextStep（推荐业务面试/补充电话沟通/转入其他岗位/暂不推进/纳入人才库长期维护）；followUps 字符串数组。综合初筛方案和沟通总结，明确哪些风险已关闭、哪些仍存在。';
}

function generateDemo(payload) {
  if (payload.action === 'match') return generateDemoMatch(payload);
  if (payload.action === 'prepare') {
    const role = firstMeaningfulLine(payload.jd) || '目标岗位';
    const name = firstMeaningfulLine(payload.resume) || '候选人';
    const shared = findSharedTerms(payload.jd, payload.resume, payload.keywords);
    return {
      summary: { headline: `${name}正在评估${role}`, experience: '简历体现相关从业经历，具体年限需核实', relevantBackground: shared.length ? `与岗位共同关键词：${shared.join('、')}` : '相关背景需在电话中补充', openFacts: '职责范围、项目结果、薪资及到岗条件待确认' },
      matches: (shared.length ? shared.slice(0, 5) : ['相关经历']).map(term => ({ requirement: term, evidence: `JD 与简历均提及“${term}”`, confidence: term === '相关经历' ? '低' : '中' })),
      risks: [{ risk: '个人职责边界不清', evidence: '简历未量化个人决策范围', impact: '可能无法区分参与和主导经验' }, { risk: '项目结果缺少量化', evidence: '未提供上线效果或业务指标', impact: '难以判断交付质量' }],
      verification: [{ item: '核心项目是否上线及使用方', reason: '核实项目真实性和业务影响', priority: '高' }, { item: '个人负责模块与团队分工', reason: '确认实际贡献边界', priority: '高' }, { item: '薪资、到岗和竞业条件', reason: '确认推进可行性', priority: '中' }],
      questions: defaultQuestions(payload.rules)
    };
  }
  if (payload.action === 'summarize') return generateDemoSummary(payload);
  return generateDemoSynthesis(payload);
}

function generateDemoMatch(payload) {
  const ranked = payload.jobs.map(job => { const terms = findSharedTerms(`${job.name} ${job.jd}`, payload.resume, job.keywords); const score = Math.min(99, Math.round((terms.length / Math.max((job.keywords || []).length, 4)) * 70 + (payload.resume.includes(job.industry || '') ? 15 : 0) + (terms.length ? 10 : 0))); return { job, score, terms }; }).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return { status: '待分配', score: 0, confidence: '低', alternativeJobs: [], risks: [{ risk: '岗位库为空', evidence: '暂无可匹配岗位' }] };
  return { jobId: first.job.id, score: first.score, confidence: first.score >= 75 ? '高' : first.score >= 50 ? '中' : '低', status: first.score >= 50 ? '已分配' : '待分配', dimensions: [{ item: '核心关键词', score: first.score, evidence: first.terms.join('、') || '未识别共同关键词' }], alternativeJobs: ranked.slice(1, 3).map(item => ({ name: item.job.name, score: item.score, reason: item.terms.join('、') || '共同信息较少' })), risks: first.score < 50 ? [{ risk: '岗位匹配度较低', evidence: '简历与岗位共同关键词有限' }] : [] };
}

function generateDemoSummary(payload) {
  const transcript = payload.transcript;
  const unknown = value => extractAfter(transcript, value) || '待确认';
  const questions = payload.preparation?.questions || [];
  const evidence = transcript.split(/[。！？\n]/).map(item => item.trim()).filter(item => item.length > 12).slice(0, 5);
  return {
    overview: `电话沟通已记录 ${evidence.length} 条可复核陈述，仍需招聘人员核对原始转写。`,
    confirmed: evidence.slice(0, 3).map(item => ({ item: '候选人陈述', evidence: item })),
    contradicted: [],
    missing: [{ item: '量化业务结果', evidence: '转写中未识别到明确数据' }],
    questionCoverage: { covered: Math.min(evidence.length, questions.length), total: questions.length, unanswered: questions.slice(evidence.length, evidence.length + 3).map(item => item.question) },
    keyFacts: {
      currentCompanyRole: unknown('目前'),
      location: unknown('地点'),
      currentSalary: unknown('当前薪资'),
      expectedSalary: unknown('期望薪资'),
      availability: unknown('到岗'),
      motivation: unknown('考虑机会'),
      nonCompete: unknown('竞业')
    },
    candidateSignals: ['候选人已提供部分核心经历陈述', '项目结果仍需量化核实'],
    followUps: ['请确认个人负责模块及决策范围', '请量化项目上线结果或业务影响', '请确认薪资、到岗时间与竞业限制']
  };
}

function generateDemoSynthesis(payload) {
  const facts = payload.communicationSummary?.keyFacts || {};
  return {
    basicInfo: facts,
    capabilities: (payload.preparation?.matches || []).slice(0, 4).map(item => ({ item: item.requirement || item, evidence: item.evidence || '来自简历初筛', assessment: '信息不足' })),
    evidence: (payload.communicationSummary?.confirmed || []).map(item => item.evidence).slice(0, 5),
    conflicts: payload.communicationSummary?.contradicted || [],
    risks: [...(payload.communicationSummary?.missing || []).map(item => item.item), '演示模式不进行最终事实推断'],
    conclusion: '信息不足', conclusionReason: '初筛方案和沟通总结已经合并，但关键项目结果仍缺少充分证据。', nextStep: '补充电话沟通',
    followUps: payload.communicationSummary?.followUps || []
  };
}

function firstMeaningfulLine(text = '') {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 2)?.slice(0, 42);
}

function findSharedTerms(left = '', right = '', customTerms = []) {
  const terms = [...new Set(['证券', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风险', '管理', '金融科技', '询报价', '生命周期', ...customTerms])];
  return terms.filter(term => left.includes(term) && right.includes(term));
}

function extractAfter(text, label) {
  const match = text.match(new RegExp(`${label}[：:为是]?([^，。；;\\n]{2,24})`));
  return match?.[1]?.trim();
}

function defaultQuestions(rules = '') {
  const questions = [
    ['求职动机', '为什么在这个时间点考虑新的机会？', '判断动机与岗位内容是否一致'],
    ['核心项目', '请选一个最相关的项目，说明背景、你的职责和最终结果。', '核实经历真实性与贡献边界'],
    ['专业能力', '你负责过哪些业务模块？哪些决策由你直接负责？', '区分参与经验和负责经验'],
    ['项目结果', '项目是否上线？服务哪些用户，有哪些可量化结果？', '验证交付与业务影响'],
    ['协作管理', '项目团队如何分工，你如何与业务、技术或交易团队协作？', '评估跨团队推动能力'],
    ['风险核验', '经历中最困难的一次问题是什么，你具体如何处理？', '观察问题拆解与复盘能力'],
    ['稳定性', '过去几次工作变动的主要原因分别是什么？', '核实履历与稳定性风险'],
    ['基本条件', '目前地点、期望工作地点和可到岗时间是什么？', '确认基础可行性'],
    ['薪资', '目前薪资结构和期望范围是什么？', '确认预算匹配度'],
    ['合规', '是否存在竞业限制或其他入职约束？', '识别入职风险']
  ];
  if (rules.trim()) questions.push(['岗位规则', `结合岗位规则，请说明你最符合的一项以及仍需补足的一项。`, '让候选人针对岗位标准提供事实']);
  return questions.map(([category, question, reason], index) => ({ category, question, reason, source: index < 6 ? '重点核验' : '通用' }));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

if (require.main === module) server.listen(port, host, () => console.log(`AceCall running at http://${host}:${port}`));

module.exports = { generateDemo, validatePayload, findSharedTerms, normalizeResumeText, parseResumeBasics, getModelProvider, server };
