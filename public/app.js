const storageKey = 'acecall-cases-v1';
const jobStorageKey = 'acecall-jobs-v1';
const industries = ['全部行业', '金融', '互联网', '企业服务', '消费零售', '制造业', '其他'];
const state = { cases: loadCases(), jobs: loadJobs(), selectedJobId: null, currentId: null, preparation: null, communicationSummary: null, report: null, resumeMeta: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  checkHealth();
  renderJobSelectors();
  renderCaseList();
  newCase(false);
});

function bindEvents() {
  $$('.step').forEach(button => button.addEventListener('click', () => showStep(button.dataset.step)));
  $('#prepareButton').addEventListener('click', prepareCase);
  $('#reportButton').addEventListener('click', generateReport);
  $('#synthesizeButton').addEventListener('click', synthesizeReport);
  $('#newCaseButton').addEventListener('click', () => newCase(true));
  $('#exportButton').addEventListener('click', exportReport);
  $('#deleteButton').addEventListener('click', deleteCurrentCase);
  $('#loadSampleButton').addEventListener('click', loadSample);
  $('#industrySelect').addEventListener('change', handleIndustryChange);
  $('#jobSelect').addEventListener('change', handleJobChange);
  $('#newJobButton').addEventListener('click', () => openJobDialog());
  $('#manageJobButton').addEventListener('click', () => openJobDialog(state.selectedJobId));
  $('#closeJobDialog').addEventListener('click', closeJobDialog);
  $('#cancelJobButton').addEventListener('click', closeJobDialog);
  $('#jobForm').addEventListener('submit', saveJob);
  $('#deleteJobButton').addEventListener('click', deleteJob);
  $('#resumeUploadButton').addEventListener('click', () => $('#resumeFileInput').click());
  $('#resumeFileInput').addEventListener('change', event => handleResumeFile(event.target.files?.[0]));
  bindResumeDropzone();
  $$('.file-trigger').forEach(button => button.addEventListener('click', () => selectTextFile(button.dataset.target)));
}

async function checkHealth() {
  if (location.protocol === 'file:') {
    $('#serviceStatus').innerHTML = '<i></i>本地演示';
    return;
  }
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    $('#serviceStatus').innerHTML = `<i></i>${data.mode === 'ai' ? 'AI 模式' : '演示模式'}`;
  } catch { $('#serviceStatus').textContent = '服务离线'; }
}

async function prepareCase() {
  const payload = {
    action: 'prepare',
    roleName: $('#roleName').value.trim(),
    candidateName: $('#candidateName').value.trim(),
    jd: $('#jdInput').value.trim(),
    resume: $('#resumeInput').value.trim(),
    rules: $('#rulesInput').value.trim(),
    keywords: parseKeywords($('#keywordsInput').value)
  };
  await withLoading($('#prepareButton'), '正在分析', async () => {
    const { result, mode } = await postGenerate(payload);
    state.preparation = result;
    state.communicationSummary = null;
    state.report = null;
    renderPreparation(result);
    renderChecklist(result.questions || []);
    resetDownstreamOutputs();
    saveCurrent({ ...payload, preparation: result, communicationSummary: null, report: null, mode });
    toast('初筛方案已生成');
  });
}

async function generateReport() {
  if (!$('#consentConfirmed').checked) return toast('请先确认已完成录音或转写告知');
  const payload = {
    action: 'summarize',
    roleName: $('#roleName').value.trim(),
    candidateName: $('#candidateName').value.trim(),
    jd: $('#jdInput').value.trim(),
    resume: $('#resumeInput').value.trim(),
    rules: $('#rulesInput').value.trim(),
    keywords: parseKeywords($('#keywordsInput').value),
    preparation: state.preparation,
    transcript: $('#transcriptInput').value.trim()
  };
  await withLoading($('#reportButton'), '正在生成', async () => {
    const { result, mode } = await postGenerate(payload);
    state.communicationSummary = result;
    state.report = null;
    renderCommunicationSummary(result);
    $('#synthesizeButton').disabled = false;
    saveCurrent({ ...payload, communicationSummary: result, report: null, mode });
    toast('沟通总结已生成，请先核对后再综合审核');
  });
}

async function synthesizeReport() {
  if (!state.preparation || !state.communicationSummary) return toast('请先完成初筛方案和沟通总结');
  const payload = { action: 'synthesize', roleName: $('#roleName').value.trim(), jd: $('#jdInput').value.trim(), rules: $('#rulesInput').value.trim(), keywords: parseKeywords($('#keywordsInput').value), preparation: state.preparation, communicationSummary: state.communicationSummary };
  await withLoading($('#synthesizeButton'), '正在综合', async () => {
    const { result, mode } = await postGenerate(payload);
    state.report = result;
    renderReport(result);
    saveCurrent({ report: result, mode });
    toast('综合审核已生成，请进行人工确认');
  });
}

async function postGenerate(payload) {
  if (location.protocol === 'file:') return { result: generateLocalDemo(payload), mode: 'demo' };
  const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '生成失败');
  return data;
}

function generateLocalDemo(payload) {
  if (payload.action === 'prepare') {
    const terms = [...new Set(['证券', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风险', '管理', '金融科技', '询报价', '生命周期', ...(payload.keywords || [])])];
    const shared = terms.filter(term => payload.jd.includes(term) && payload.resume.includes(term));
    return {
      summary: { headline: `${payload.candidateName || '候选人'}正在评估${payload.roleName || '目标岗位'}`, experience: '简历体现相关从业经历，具体年限需在电话中核实', relevantBackground: shared.length ? `共同关键词：${shared.join('、')}` : '岗位相关背景需进一步确认', openFacts: '个人职责、项目结果、薪资和到岗条件仍待核验' },
      matches: (shared.length ? shared.slice(0, 5) : ['相关经历']).map(term => ({ requirement: term, evidence: `岗位与简历均提及“${term}”`, confidence: term === '相关经历' ? '低' : '中' })),
      risks: [{ risk: '个人职责边界不清', evidence: '简历未量化个人决策范围', impact: '可能无法区分参与和主导经验' }, { risk: '项目结果缺少量化', evidence: '未提供上线效果或业务指标', impact: '难以判断实际交付质量' }],
      verification: [{ item: '核心项目是否上线及使用方', reason: '核实真实性和业务影响', priority: '高' }, { item: '个人负责模块与团队分工', reason: '确认贡献边界', priority: '高' }, { item: '薪资、到岗和竞业条件', reason: '确认推进可行性', priority: '中' }],
      questions: localQuestions(payload.rules)
    };
  }
  if (payload.action === 'summarize') return generateLocalSummary(payload);
  return generateLocalSynthesis(payload);
}

function generateLocalSummary(payload) {
  const statements = payload.transcript.split(/[。！？\n]/).map(item => item.trim()).filter(item => item.length > 10);
  const readField = label => payload.transcript.match(new RegExp(`${label}[：:为是]?([^，。；;\\n]{2,24})`))?.[1]?.trim() || '待确认';
  const questions = payload.preparation?.questions || [];
  return {
    overview: `本次沟通识别到 ${statements.length} 条候选人陈述，请对照原始转写核验。`,
    confirmed: statements.slice(0, 3).map(item => ({ item: '候选人陈述', evidence: item })), contradicted: [],
    missing: [{ item: '量化业务结果', evidence: '转写中未识别到明确数据' }],
    questionCoverage: { covered: Math.min(statements.length, questions.length), total: questions.length, unanswered: questions.slice(statements.length, statements.length + 3).map(item => item.question) },
    keyFacts: { currentCompanyRole: readField('目前'), location: readField('地点'), currentSalary: readField('当前薪资'), expectedSalary: readField('期望薪资'), availability: readField('到岗'), motivation: readField('考虑机会'), nonCompete: readField('竞业') },
    candidateSignals: ['已提供部分核心经历陈述', '项目结果仍需量化核实'],
    followUps: ['请确认个人负责模块及决策范围', '请量化项目上线结果或业务影响', '请确认薪资、到岗时间与竞业限制']
  };
}

function generateLocalSynthesis(payload) {
  return { basicInfo: payload.communicationSummary?.keyFacts || {}, capabilities: (payload.preparation?.matches || []).slice(0, 4).map(item => ({ item: item.requirement, evidence: item.evidence, assessment: '信息不足' })), evidence: (payload.communicationSummary?.confirmed || []).map(item => item.evidence), conflicts: payload.communicationSummary?.contradicted || [], risks: [...(payload.communicationSummary?.missing || []).map(item => item.item), '本地演示模式不进行最终事实推断'], conclusion: '信息不足', conclusionReason: '初筛方案和沟通总结已经合并，但关键项目结果仍缺少充分证据。', nextStep: '补充电话沟通', followUps: payload.communicationSummary?.followUps || [] };
}

function localQuestions(rules) {
  const rows = [
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
  if (rules?.trim()) rows.push(['岗位规则', '你最符合哪项岗位要求，仍需补足哪一项？', '针对岗位标准补充事实']);
  return rows.map(([category, question, reason], index) => ({ category, question, reason, source: index < 6 ? '重点核验' : '通用' }));
}

function renderPreparation(result) {
  const summary = typeof result.summary === 'string' ? { headline: result.summary } : result.summary || {};
  $('#prepareResult').classList.remove('hidden');
  $('#prepareResult').innerHTML = `<div class="result-grid">
    ${block('候选人摘要', `<div class="evidence-item"><strong>${escapeHtml(summary.headline || '候选人概况')}</strong><p>${escapeHtml(summary.experience || '')}</p><p>${escapeHtml(summary.relevantBackground || '')}</p><p>${escapeHtml(summary.openFacts || '')}</p></div>`, true)}
    ${block('匹配点', evidenceList(result.matches, 'requirement', 'evidence', 'confidence'))}
    ${block('风险点', evidenceList(result.risks, 'risk', 'evidence', 'impact'))}
    ${block('重点核验', evidenceList(result.verification, 'item', 'reason', 'priority'), true)}
  </div>`;
}

function renderChecklist(questions) {
  const container = $('#questionChecklist');
  container.className = 'checklist';
  container.innerHTML = questions.map((item, index) => `<label class="check-item">
    <input type="checkbox" data-question="${index}"><b>${escapeHtml(item.category)}</b><span>${escapeHtml(item.question)} <i class="source-tag">${escapeHtml(item.source || '初筛方案')}</i><br><small>${escapeHtml(item.reason || '')}</small></span>
  </label>`).join('');
}

function renderCommunicationSummary(summary) {
  const coverage = summary.questionCoverage || { covered: 0, total: 0, unanswered: [] };
  $('#communicationResult').classList.remove('hidden');
  $('#communicationResult').innerHTML = `<div class="summary-band"><div class="summary-stat"><strong>${coverage.covered || 0}</strong><span>已覆盖问题</span></div><div class="summary-stat"><strong>${Math.max((coverage.total || 0) - (coverage.covered || 0), 0)}</strong><span>未覆盖问题</span></div><div class="summary-stat"><strong>${(summary.confirmed || []).length}</strong><span>确认事实</span></div></div><div class="result-grid">
    ${block('沟通概览', `<p>${escapeHtml(summary.overview || '')}</p>`, true)}
    ${block('已确认信息', evidenceList(summary.confirmed, 'item', 'evidence'))}
    ${block('矛盾或修正', evidenceList(summary.contradicted, 'item', 'evidence'))}
    ${block('仍缺失信息', evidenceList(summary.missing, 'item', 'evidence'))}
    ${block('关键条件', `<dl class="facts">${Object.entries(summary.keyFacts || {}).map(([key,value]) => `<div><dt>${escapeHtml(infoLabels[key] || key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`)}
    ${block('未覆盖问题', list(coverage.unanswered), true)}
  </div><div class="action-row"><button class="secondary-button" type="button" id="goSynthesisButton">进入综合审核 →</button></div>`;
  $('#goSynthesisButton').addEventListener('click', () => showStep('3'));
}

function renderReport(report) {
  const info = report.basicInfo || {};
  $('#reportResult').className = 'report-layout';
  $('#reportResult').innerHTML = `<div class="decision">
    <div><small>AI 初步结论 · 待人工确认</small><strong>${escapeHtml(report.conclusion)}</strong><p>${escapeHtml(report.conclusionReason)}</p></div>
    <label><span>最终动作</span><select id="finalDecision">${['推荐业务面试','补充电话沟通','转入其他岗位','暂不推进','纳入人才库长期维护'].map(value => `<option ${value === report.nextStep ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
  </div><div class="report-grid" style="margin-top:14px">
    ${block('基本信息', `<dl class="facts">${Object.entries(info).map(([key,value]) => `<div><dt>${escapeHtml(infoLabels[key] || key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`, true)}
    ${block('能力与经历', evidenceList(report.capabilities, 'item', 'evidence', 'assessment'))}
    ${block('事实依据', list(report.evidence))}
    ${block('材料矛盾', evidenceList(report.conflicts, 'topic', 'callEvidence'))}
    ${block('风险与缺口', list(report.risks))}
    ${block('建议补充问题', list(report.followUps))}
  </div><section class="review-box"><label><span>招聘人员审核备注</span><textarea id="reviewNotes" rows="4" placeholder="补充事实核验、判断依据或后续安排">${escapeHtml(report.reviewNotes || '')}</textarea></label><label class="review-confirm"><input type="checkbox" id="reviewConfirmed" ${report.reviewConfirmed ? 'checked' : ''}><span>我已核对原始材料并确认最终动作</span></label></section>`;
  $('#finalDecision').addEventListener('change', event => {
    state.report.finalDecision = event.target.value;
    saveCurrent({ report: state.report });
  });
  $('#reviewNotes').addEventListener('input', event => { state.report.reviewNotes = event.target.value; saveCurrent({ report: state.report }); });
  $('#reviewConfirmed').addEventListener('change', event => { state.report.reviewConfirmed = event.target.checked; saveCurrent({ report: state.report }); });
}

const infoLabels = { currentCompanyRole: '当前公司及职位', location: '当前地点', currentSalary: '当前薪资', expectedSalary: '期望薪资', availability: '到岗时间', motivation: '求职动机', nonCompete: '竞业限制' };

function block(title, content, wide = false) { return `<section class="result-block ${wide ? 'wide' : ''}"><h3>${title}</h3>${content}</section>`; }
function list(items = []) { return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>待确认</li>'}</ul>`; }
function evidenceList(items = [], titleKey, detailKey, tagKey) {
  if (!items.length) return '<p>暂无</p>';
  return items.map(item => {
    if (typeof item === 'string') return `<div class="evidence-item"><strong>${escapeHtml(item)}</strong></div>`;
    const tag = tagKey && item[tagKey] ? `<span class="${tagKey === 'priority' ? `priority ${item[tagKey] === '高' ? 'high' : ''}` : 'confidence'}">${escapeHtml(item[tagKey])}</span>` : '';
    return `<div class="evidence-item"><strong>${escapeHtml(item[titleKey] || '待确认')}${tag}</strong><p>${escapeHtml(item[detailKey] || '')}</p></div>`;
  }).join('');
}
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }

function showStep(step) {
  $$('.step').forEach(item => item.classList.toggle('active', item.dataset.step === step));
  $$('.step-panel').forEach(item => item.classList.toggle('active', item.dataset.panel === step));
}

function saveCurrent(patch) {
  const now = new Date().toISOString();
  const id = state.currentId || crypto.randomUUID();
  const old = state.cases.find(item => item.id === id) || { id, createdAt: now };
  const current = { ...old, ...patch, id, jobId: state.selectedJobId, updatedAt: now, roleName: $('#roleName').value.trim(), candidateName: $('#candidateName').value.trim(), jd: $('#jdInput').value, resume: $('#resumeInput').value, resumeMeta: state.resumeMeta, rules: $('#rulesInput').value, keywords: parseKeywords($('#keywordsInput').value), transcript: $('#transcriptInput').value, consentConfirmed: $('#consentConfirmed').checked };
  state.currentId = id;
  state.cases = [current, ...state.cases.filter(item => item.id !== id)];
  localStorage.setItem(storageKey, JSON.stringify(state.cases));
  $('#caseTitle').textContent = current.candidateName ? `${current.candidateName} · ${current.roleName || '初筛'}` : '新候选人初筛';
  renderCaseList();
}

function loadCases() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { return []; }
}

function loadJobs() {
  try { return JSON.parse(localStorage.getItem(jobStorageKey) || '[]'); } catch { return []; }
}

function renderCaseList() {
  const industry = $('#industrySelect')?.value || '全部行业';
  const industryJobIds = new Set(state.jobs.filter(job => job.industry === industry).map(job => job.id));
  const cases = state.selectedJobId
    ? state.cases.filter(item => item.jobId === state.selectedJobId)
    : industry === '全部行业' ? state.cases : state.cases.filter(item => industryJobIds.has(item.jobId));
  $('#caseListTitle').textContent = state.selectedJobId ? '该岗位候选人' : industry === '全部行业' ? '全部候选人' : `${industry}候选人`;
  $('#caseCount').textContent = cases.length;
  $('#caseList').innerHTML = cases.map(item => `<button class="case-item ${item.id === state.currentId ? 'active' : ''}" data-id="${item.id}"><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.roleName || '岗位待填写')}</small></button>`).join('') || '<div class="empty-state">该岗位暂无候选人</div>';
  $$('.case-item').forEach(button => button.addEventListener('click', () => openCase(button.dataset.id)));
}

function openCase(id) {
  const item = state.cases.find(entry => entry.id === id);
  if (!item) return;
  state.currentId = id;
  state.preparation = item.preparation || null;
  state.communicationSummary = item.communicationSummary || null;
  state.report = item.report || null;
  state.resumeMeta = item.resumeMeta || null;
  $('#roleName').value = item.roleName || '';
  $('#candidateName').value = item.candidateName || '';
  $('#jdInput').value = item.jd || '';
  $('#resumeInput').value = item.resume || '';
  $('#rulesInput').value = item.rules || '';
  $('#keywordsInput').value = (item.keywords || []).join('、');
  $('#transcriptInput').value = item.transcript || '';
  $('#consentConfirmed').checked = Boolean(item.consentConfirmed);
  renderResumeStatus(state.resumeMeta);
  $('#caseTitle').textContent = item.candidateName ? `${item.candidateName} · ${item.roleName || '初筛'}` : '新候选人初筛';
  resetDownstreamOutputs();
  if (item.preparation) { renderPreparation(item.preparation); renderChecklist(item.preparation.questions || []); } else resetOutputs();
  if (item.communicationSummary) renderCommunicationSummary(item.communicationSummary);
  $('#synthesizeButton').disabled = !item.communicationSummary;
  if (item.report) renderReport(item.report);
  renderCaseList();
}

function newCase(showMessage) {
  state.currentId = null; state.preparation = null; state.communicationSummary = null; state.report = null; state.resumeMeta = null;
  ['roleName','candidateName','jdInput','resumeInput','rulesInput','keywordsInput','transcriptInput'].forEach(id => $(`#${id}`).value = '');
  applySelectedJob();
  $('#consentConfirmed').checked = false;
  renderResumeStatus(null);
  $('#caseTitle').textContent = '新候选人初筛';
  resetOutputs();
  showStep('1');
  renderCaseList();
  if (showMessage) toast('已新建候选人案例');
}

function resetOutputs() {
  $('#prepareResult').className = 'result-area hidden';
  $('#prepareResult').innerHTML = '';
  $('#questionChecklist').className = 'checklist empty-state';
  $('#questionChecklist').textContent = '生成初筛方案后，问题清单会显示在这里。';
  resetDownstreamOutputs();
}

function resetDownstreamOutputs() {
  $('#communicationResult').className = 'result-area hidden';
  $('#communicationResult').innerHTML = '';
  $('#synthesizeButton').disabled = true;
  $('#reportResult').className = 'report-layout empty-state';
  $('#reportResult').textContent = '完成并核对沟通总结后，可生成综合审核。';
}

function exportReport() {
  if (!state.report) return toast('请先生成综合审核');
  if (!state.report.reviewConfirmed) return toast('请先完成人工审核确认');
  const item = state.cases.find(entry => entry.id === state.currentId) || {};
  const report = { candidate: item.candidateName, role: item.roleName, generatedAt: new Date().toISOString(), preparation: state.preparation, communicationSummary: state.communicationSummary, report: state.report };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `AceCall-${item.candidateName || '候选人'}-${new Date().toISOString().slice(0,10)}.json`;
  link.click(); URL.revokeObjectURL(link.href);
}

function deleteCurrentCase() {
  if (!state.currentId) return toast('当前案例尚未保存');
  const item = state.cases.find(entry => entry.id === state.currentId);
  if (!confirm(`确认删除“${item?.candidateName || '未命名候选人'}”案例？此操作只删除当前浏览器中的数据。`)) return;
  state.cases = state.cases.filter(entry => entry.id !== state.currentId);
  localStorage.setItem(storageKey, JSON.stringify(state.cases));
  newCase(false); toast('案例已删除');
}

function selectTextFile(targetId) {
  const input = $('#textFileInput');
  input.value = '';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) return toast('文本文件不能超过 1MB');
    $(`#${targetId}`).value = await file.text();
    toast(`已导入 ${file.name}`);
  };
  input.click();
}

function bindResumeDropzone() {
  const zone = $('#resumeUploadButton');
  for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.add('dragging'); });
  for (const eventName of ['dragleave', 'drop']) zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.remove('dragging'); });
  zone.addEventListener('drop', event => handleResumeFile(event.dataTransfer?.files?.[0]));
}

async function handleResumeFile(file) {
  if (!file) return;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['pdf', 'docx', 'txt', 'md'].includes(extension)) return renderResumeError('仅支持 PDF、DOCX、TXT 和 MD 文件');
  if (file.size > 10_000_000) return renderResumeError('简历文件不能超过 10MB');
  renderResumeLoading(file.name);
  try {
    let result;
    if (location.protocol === 'file:' && ['txt', 'md'].includes(extension)) {
      const text = (await file.text()).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length < 20) throw new Error('未提取到足够文字');
      result = { text, metadata: { fileName: file.name, extension: extension.toUpperCase(), characters: text.length } };
    } else if (location.protocol === 'file:') {
      throw new Error('PDF/DOCX 解析需要运行本地服务：在项目目录执行 npm start');
    } else {
      const response = await fetch(`/api/parse-resume?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      result = await response.json();
      if (!response.ok) throw new Error(result.error || '简历解析失败');
    }
    $('#resumeInput').value = result.text;
    state.resumeMeta = result.metadata;
    if (!$('#candidateName').value.trim() && result.metadata.candidateName) $('#candidateName').value = result.metadata.candidateName;
    renderResumeStatus(result.metadata);
    toast('简历文字已提取，请核对解析内容');
  } catch (error) {
    state.resumeMeta = null;
    renderResumeError(error.message);
  } finally {
    $('#resumeFileInput').value = '';
  }
}

function renderResumeLoading(fileName) {
  const container = $('#resumeParseStatus');
  container.className = 'parse-status';
  container.innerHTML = `<span><strong>正在解析 ${escapeHtml(fileName)}</strong><small>正在提取正文和基础字段…</small></span><span>处理中</span>`;
}

function renderResumeStatus(metadata) {
  const container = $('#resumeParseStatus');
  if (!metadata) { container.className = 'parse-status hidden'; container.innerHTML = ''; return; }
  const basics = [metadata.experienceYears ? `${metadata.experienceYears}年经验` : '', metadata.education || '', metadata.email ? '已识别邮箱' : '', metadata.phone ? '已识别电话' : ''].filter(Boolean).join(' · ');
  container.className = 'parse-status';
  container.innerHTML = `<span><strong>${escapeHtml(metadata.fileName || '已导入简历')}</strong><small>${escapeHtml(metadata.extension || 'TEXT')} · ${metadata.characters || 0} 字${basics ? ` · ${escapeHtml(basics)}` : ''}</small></span><span>解析完成</span>`;
}

function renderResumeError(message) {
  const container = $('#resumeParseStatus');
  container.className = 'parse-status error';
  container.innerHTML = `<span><strong>解析失败</strong><small>${escapeHtml(message)}</small></span><span>请重试</span>`;
  toast(message);
}

function loadSample() {
  newCase(false);
  const sampleJob = {
    id: state.jobs.find(job => job.name === '场外期权产品经理')?.id || crypto.randomUUID(),
    industry: '金融', name: '场外期权产品经理',
    jd: '场外期权产品经理\n负责 RFQ、交易簿记及生命周期管理产品规划；与交易、风控、研发团队协作推动上线。\n必备：3年以上证券或衍生品产品经验，能独立负责复杂项目。\n加分：熟悉定价、Greeks及风险管理。',
    keywords: ['场外期权', 'RFQ', '交易簿记', '生命周期管理', 'Greeks', '风险管理'],
    rules: '必须核实本人职责、项目上线结果、服务客户、交易规模。没有场外衍生品经验不直接淘汰，可接受相邻证券交易系统经验。最终结论必须由招聘人员确认。',
    updatedAt: new Date().toISOString()
  };
  state.jobs = [sampleJob, ...state.jobs.filter(job => job.id !== sampleJob.id)];
  persistJobs(); state.selectedJobId = sampleJob.id; renderJobSelectors('金融'); applySelectedJob();
  $('#candidateName').value = '示例候选人';
  $('#resumeInput').value = '示例候选人\n8年金融科技产品经验，其中4年参与证券场外期权系统建设。负责询报价与交易簿记模块，协调6人研发团队完成需求分析和交付。项目已上线，具体客户规模及业务结果待核实。';
  $('#transcriptInput').value = '招聘人员：请介绍最相关的项目。\n候选人：我负责场外期权询报价和交易簿记模块，协调研发推进上线，主要使用方是机构客户。\n招聘人员：项目结果如何？\n候选人：系统已经上线，但交易规模不方便披露。\n招聘人员：为什么考虑机会？\n候选人：希望承担更完整的产品规划职责。地点：上海。到岗：一个月。期望薪资：面议。竞业：没有。';
  $('#consentConfirmed').checked = true;
  toast('示例数据已加载，可直接生成方案');
}

function renderJobSelectors(preferredIndustry) {
  const industry = preferredIndustry || $('#industrySelect')?.value || '全部行业';
  $('#industrySelect').innerHTML = industries.map(value => `<option ${value === industry ? 'selected' : ''}>${value}</option>`).join('');
  const available = industry === '全部行业' ? state.jobs : state.jobs.filter(job => job.industry === industry);
  $('#jobSelect').innerHTML = `<option value="">${available.length ? '请选择岗位' : '暂无岗位'}</option>${available.map(job => `<option value="${job.id}" ${job.id === state.selectedJobId ? 'selected' : ''}>${escapeHtml(job.name)}</option>`).join('')}`;
  renderJobMemory();
}

function handleIndustryChange() {
  state.selectedJobId = null;
  renderJobSelectors($('#industrySelect').value);
  newCase(false);
}

function handleJobChange() {
  state.selectedJobId = $('#jobSelect').value || null;
  newCase(false);
  renderJobMemory(); renderCaseList();
}

function applySelectedJob() {
  const job = state.jobs.find(item => item.id === state.selectedJobId);
  if (!job) return;
  $('#roleName').value = job.name;
  $('#jdInput').value = job.jd;
  $('#rulesInput').value = job.rules || '';
  $('#keywordsInput').value = (job.keywords || []).join('、');
}

function renderJobMemory() {
  const job = state.jobs.find(item => item.id === state.selectedJobId);
  $('#jobMemory').innerHTML = job
    ? `<b>${escapeHtml(job.keywords?.length || 0)} 个关键词已记忆</b><br>${escapeHtml((job.keywords || []).slice(0, 5).join(' · ') || '尚未设置关键词')}`
    : '选择岗位后，JD、关键词和初筛规则会自动复用。';
}

function openJobDialog(jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  $('#jobDialogTitle').textContent = job ? '编辑岗位' : '新建岗位';
  $('#jobIdInput').value = job?.id || '';
  $('#jobIndustryInput').value = job?.industry || ($('#industrySelect').value === '全部行业' ? '金融' : $('#industrySelect').value);
  $('#jobNameInput').value = job?.name || '';
  $('#jobJdInput').value = job?.jd || '';
  $('#jobKeywordsInput').value = (job?.keywords || []).join('、');
  $('#jobRulesInput').value = job?.rules || '';
  $('#deleteJobButton').hidden = !job;
  $('#jobDialog').showModal();
}

function closeJobDialog() { $('#jobDialog').close(); }

function saveJob(event) {
  event.preventDefault();
  const name = $('#jobNameInput').value.trim();
  const jd = $('#jobJdInput').value.trim();
  if (!name || !jd) return toast('请填写岗位名称和 JD');
  const id = $('#jobIdInput').value || crypto.randomUUID();
  const old = state.jobs.find(job => job.id === id);
  const job = { id, industry: $('#jobIndustryInput').value, name, jd, rules: $('#jobRulesInput').value.trim(), keywords: parseKeywords($('#jobKeywordsInput').value).length ? parseKeywords($('#jobKeywordsInput').value) : extractKeywords(jd), createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.jobs = [job, ...state.jobs.filter(item => item.id !== id)];
  state.selectedJobId = id; persistJobs(); closeJobDialog();
  renderJobSelectors(job.industry); newCase(false); renderCaseList();
  toast(old ? '岗位资产已更新，新案例将使用最新版本' : '岗位已保存，后续候选人可直接复用');
}

function deleteJob() {
  const id = $('#jobIdInput').value;
  if (state.cases.some(item => item.jobId === id)) return toast('该岗位已有候选人案例，请保留岗位以便追溯');
  const job = state.jobs.find(item => item.id === id);
  if (!job || !confirm(`确认删除岗位“${job.name}”？`)) return;
  state.jobs = state.jobs.filter(item => item.id !== id); state.selectedJobId = null;
  persistJobs(); closeJobDialog(); renderJobSelectors(); newCase(false); toast('岗位已删除');
}

function persistJobs() { localStorage.setItem(jobStorageKey, JSON.stringify(state.jobs)); }

function parseKeywords(value = '') { return [...new Set(value.split(/[、,，;；\n]/).map(item => item.trim()).filter(Boolean))]; }

function extractKeywords(jd) {
  const dictionary = ['证券', '银行', '保险', '基金', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风控', '金融科技', '询报价', '交易簿记', '生命周期管理', '定价', 'Greeks', '用户增长', '商业化', 'SaaS', '大模型', '数据分析'];
  const uppercase = jd.match(/\b[A-Z][A-Z0-9.+-]{1,12}\b/g) || [];
  return [...new Set([...dictionary.filter(term => jd.includes(term)), ...uppercase])].slice(0, 16);
}

async function withLoading(button, label, task) {
  const original = button.innerHTML;
  button.disabled = true; button.textContent = label;
  try { await task(); } catch (error) { toast(error.message); } finally { button.disabled = false; button.innerHTML = original; }
}

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message; element.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
}
