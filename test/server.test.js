const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDemo, validatePayload, findSharedTerms, normalizeResumeText, parseResumeBasics, extractCandidateName, extractLabeledCandidateName, extractNameFromFileName, isPlausibleCandidateName, chooseCandidateName } = require('../server');

test('finds shared financial recruiting terms', () => {
  assert.deepEqual(findSharedTerms('证券场外期权产品', '负责证券场外期权产品系统'), ['证券', '场外期权', '产品']);
});

test('reuses custom job keywords in matching', () => {
  assert.deepEqual(findSharedTerms('负责交易簿记平台', '主导交易簿记模块', ['交易簿记']), ['交易', '交易簿记']);
});

test('prepare demo returns structured questions', () => {
  const result = generateDemo({ action: 'prepare', jd: '场外期权产品经理', resume: '候选人\n负责场外期权产品' });
  assert.ok(result.summary.headline);
  assert.ok(result.matches[0].evidence);
  assert.ok(result.verification[0].priority);
  assert.ok(result.questions.length >= 10);
  assert.equal(result.questions[0].category, '求职动机');
});

test('match demo ranks a resume against saved jobs', () => {
  const result = generateDemo({ action: 'match', resume: '证券 场外期权 RFQ 产品经理', jobs: [
    { id: 'job-a', name: '场外期权产品经理', industry: '金融', jd: '负责场外期权 RFQ 产品', keywords: ['场外期权', 'RFQ', '产品'] },
    { id: 'job-b', name: '互联网运营', industry: '互联网', jd: '负责用户增长和内容运营', keywords: ['用户增长'] }
  ] });
  assert.equal(result.jobId, 'job-a');
  assert.ok(result.score > 0);
  assert.ok(Array.isArray(result.alternativeJobs));
});

test('demo separates communication summary from synthesis', () => {
  const preparation = generateDemo({ action: 'prepare', jd: '交易产品经理', resume: '候选人\n负责交易产品' });
  const communicationSummary = generateDemo({ action: 'summarize', transcript: '候选人：我负责交易模块并推动系统上线。地点：上海。到岗：一个月。', preparation });
  assert.ok(communicationSummary.overview);
  assert.equal(communicationSummary.conclusion, undefined);
  const report = generateDemo({ action: 'synthesize', preparation, communicationSummary });
  assert.equal(report.conclusion, '信息不足');
  assert.ok(Array.isArray(report.capabilities));
});

test('communication summary requires transcript', () => {
  assert.throws(() => validatePayload({ action: 'summarize', transcript: '' }), /电话转写/);
});

test('synthesis requires preparation and communication summary', () => {
  assert.throws(() => validatePayload({ action: 'synthesize', preparation: {} }), /初筛方案和沟通总结/);
});

test('normalizes and parses resume basics', () => {
  const text = normalizeResumeText('张三  \n\n\n手机：13800138000\n邮箱：zhang@example.com\n本科，8年金融行业经验');
  assert.equal(text.includes('\n\n\n'), false);
  assert.deepEqual(parseResumeBasics(text), { candidateName: '张三', phone: '13800138000', email: 'zhang@example.com', age: '', experienceYears: '8', education: '本科' });
});

test('cleans repeated PDF watermark noise and extracts labeled identity fields', () => {
  const text = normalizeResumeText('姓名：李四\n年龄：29岁\n电话：138-0013-8000\n邮箱：li@example.com。\n水印 AceCall\n水印 AceCall\n水印 AceCall');
  assert.equal(text.includes('水印 AceCall'), false);
  assert.deepEqual(parseResumeBasics(text), { candidateName: '李四', phone: '13800138000', email: 'li@example.com', age: '29', experienceYears: '', education: '' });
});

test('extracts names from labeled and mixed header lines without section noise', () => {
  assert.equal(extractCandidateName(['工作经历', '【券商后端开发】代胜辉 6年']), '代胜辉');
  assert.equal(extractCandidateName(['姓名：周文超', '出生日期：1995年']), '周文超');
  assert.equal(extractCandidateName(['Education', 'John Smith', 'john@example.com']), 'John Smith');
  assert.equal(extractCandidateName(['教育背景', '7年经验', '联系方式']), '');
});

test('falls back to candidate names embedded in resume file names', () => {
  assert.equal(extractNameFromFileName('【券商后端开发-Golang_北京 25-50K】代胜辉 6年.pdf'), '代胜辉');
  assert.equal(extractNameFromFileName('张树伟的简历 (1).pdf'), '张树伟');
  assert.equal(extractNameFromFileName('【人力管培_北京 12-24K】菜苔 26年应届生.pdf'), '菜苔');
  assert.equal(extractNameFromFileName('【人力管培_北京 12-24K】韩先生 1年.pdf'), '韩先生');
  assert.equal(extractNameFromFileName('【人力管培_北京 12-24K】石淼晶 26年应届生.pdf'), '石淼晶');
  assert.equal(extractNameFromFileName('CV_for_Lo_Wai_Keung_cn.pdf'), 'Lo Wai Keung');
});

test('rejects resume section noise and uses a valid fallback name', () => {
  for (const noise of ['工作经历', '教育背景', '出生日期：95年08月25日', '建联沟通', '画像', '背景信息', '绩点前', '寻访', '武汉科技大学 本科 计算机科学与技术']) {
    assert.equal(isPlausibleCandidateName(noise), false);
  }
  assert.equal(chooseCandidateName('工作经历', '周文超'), '周文超');
  assert.equal(chooseCandidateName('姓名：周文超', ''), '周文超');
  assert.equal(chooseCandidateName(extractLabeledCandidateName(['姓名：李四']), '张三', '销售支持'), '李四');
});

test('cloud function keeps its resume normalization implementation in sync', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/acecall-api/index.js'), 'utf8');
  assert.match(source, /function normalizeResumeText\(text = ''\)/);
  assert.match(source, /function parseResumeBasics\(text = ''\)/);
});
