const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));

const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
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
        mode: process.env.OPENAI_API_KEY ? 'ai' : 'demo',
        model: process.env.OPENAI_MODEL || 'gpt-5.6-terra'
      });
    }

    if (request.method === 'POST' && request.url === '/api/generate') {
      const payload = await readJson(request);
      validatePayload(payload);
      const result = process.env.OPENAI_API_KEY
        ? await generateWithOpenAI(payload)
        : generateDemo(payload);
      return sendJson(response, 200, { result, mode: process.env.OPENAI_API_KEY ? 'ai' : 'demo' });
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

function validatePayload(payload) {
  if (!['prepare', 'report'].includes(payload.action)) throw Object.assign(new Error('未知工作流步骤'), { statusCode: 400 });
  if (payload.action === 'prepare' && (!payload.jd?.trim() || !payload.resume?.trim())) {
    throw Object.assign(new Error('请填写 JD 和候选人简历'), { statusCode: 400 });
  }
  if (payload.action === 'report' && !payload.transcript?.trim()) {
    throw Object.assign(new Error('请填写电话转写内容'), { statusCode: 400 });
  }
}

async function generateWithOpenAI(payload) {
  const instructions = `你是金融招聘电话初筛助手。只依据输入事实工作，不得推断性别、年龄、婚育、籍贯等非岗位因素。未知信息写“待确认”。输出严格 JSON，不含 Markdown。所有结论必须附事实依据，最终决策由招聘人员完成。${payload.action === 'prepare' ? prepareSchema() : reportSchema()}`;
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      instructions,
      input: JSON.stringify(payload),
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
  return '字段：summary 字符串；matches、risks 字符串数组；questions 数组，每项含 category、question、reason；verification 字符串数组。问题 10-15 个。';
}

function reportSchema() {
  return '字段：basicInfo 对象；capabilities 字符串数组；evidence 字符串数组；risks 字符串数组；conclusion（明确匹配/部分匹配/信息不足/明确不匹配）；conclusionReason 字符串；nextStep（推荐业务面试/补充电话沟通/转入其他岗位/暂不推进/纳入人才库长期维护）；followUps 字符串数组。';
}

function generateDemo(payload) {
  if (payload.action === 'prepare') {
    const role = firstMeaningfulLine(payload.jd) || '目标岗位';
    const name = firstMeaningfulLine(payload.resume) || '候选人';
    const shared = findSharedTerms(payload.jd, payload.resume);
    return {
      summary: `${name}正在评估${role}。演示引擎已完成文本结构化；工作年限、职责范围、项目结果及求职条件需在电话中核实。`,
      matches: shared.length ? shared.slice(0, 5).map(term => `JD 与简历均提及：${term}`) : ['具备待进一步核实的相关经历'],
      risks: ['项目中的个人职责边界未量化', '项目结果与业务影响需核实', '期望薪资与到岗周期待确认'],
      verification: ['核心项目是否真实上线及使用方', '个人负责模块与团队分工', '当前薪资、期望薪资与到岗时间'],
      questions: defaultQuestions(payload.rules)
    };
  }
  const transcript = payload.transcript;
  const unknown = value => extractAfter(transcript, value) || '待确认';
  return {
    basicInfo: {
      currentCompanyRole: unknown('目前'),
      location: unknown('地点'),
      currentSalary: unknown('当前薪资'),
      expectedSalary: unknown('期望薪资'),
      availability: unknown('到岗'),
      motivation: unknown('考虑机会'),
      nonCompete: unknown('竞业')
    },
    capabilities: ['已提供核心经历陈述，需由招聘人员核对原始转写', '项目职责与成果仍需结合岗位标准判断'],
    evidence: transcript.split(/[。！？\n]/).map(item => item.trim()).filter(item => item.length > 12).slice(0, 4),
    risks: ['演示模式不进行事实推断', '未明确回答的字段均应补充核实'],
    conclusion: '信息不足',
    conclusionReason: '当前为本地演示分析，已有信息可形成初步纪要，但不足以自动得出推荐结论。',
    nextStep: '补充电话沟通',
    followUps: ['请确认个人负责模块及决策范围', '请量化项目上线结果或业务影响', '请确认薪资、到岗时间与竞业限制']
  };
}

function firstMeaningfulLine(text = '') {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 2)?.slice(0, 42);
}

function findSharedTerms(left = '', right = '') {
  const terms = ['证券', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风险', '管理', '金融科技', '询报价', '生命周期'];
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
  return questions.map(([category, question, reason]) => ({ category, question, reason }));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

if (require.main === module) server.listen(port, host, () => console.log(`AceCall running at http://${host}:${port}`));

module.exports = { generateDemo, validatePayload, findSharedTerms, server };
