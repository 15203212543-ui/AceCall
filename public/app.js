const storageKey = 'acecall-cases-v1';
const state = { cases: loadCases(), currentId: null, preparation: null, report: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  checkHealth();
  renderCaseList();
  newCase(false);
});

function bindEvents() {
  $$('.step').forEach(button => button.addEventListener('click', () => showStep(button.dataset.step)));
  $('#prepareButton').addEventListener('click', prepareCase);
  $('#reportButton').addEventListener('click', generateReport);
  $('#newCaseButton').addEventListener('click', () => newCase(true));
  $('#exportButton').addEventListener('click', exportReport);
  $('#deleteButton').addEventListener('click', deleteCurrentCase);
  $('#loadSampleButton').addEventListener('click', loadSample);
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
    rules: $('#rulesInput').value.trim()
  };
  await withLoading($('#prepareButton'), '正在分析', async () => {
    const { result, mode } = await postGenerate(payload);
    state.preparation = result;
    renderPreparation(result);
    renderChecklist(result.questions || []);
    saveCurrent({ ...payload, preparation: result, mode });
    toast('初筛方案已生成');
  });
}

async function generateReport() {
  if (!$('#consentConfirmed').checked) return toast('请先确认已完成录音或转写告知');
  const payload = {
    action: 'report',
    roleName: $('#roleName').value.trim(),
    candidateName: $('#candidateName').value.trim(),
    jd: $('#jdInput').value.trim(),
    resume: $('#resumeInput').value.trim(),
    rules: $('#rulesInput').value.trim(),
    preparation: state.preparation,
    transcript: $('#transcriptInput').value.trim()
  };
  await withLoading($('#reportButton'), '正在生成', async () => {
    const { result, mode } = await postGenerate(payload);
    state.report = result;
    renderReport(result);
    saveCurrent({ ...payload, report: result, mode });
    showStep('3');
    toast('报告已生成，请进行人工审核');
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
    const terms = ['证券', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风险', '管理', '金融科技', '询报价', '生命周期'];
    const shared = terms.filter(term => payload.jd.includes(term) && payload.resume.includes(term));
    return {
      summary: `${payload.candidateName || '候选人'}正在评估${payload.roleName || '目标岗位'}。简历体现了相关金融科技经历，工作年限、职责边界、项目结果及求职条件仍需在电话中核实。`,
      matches: shared.length ? shared.slice(0, 5).map(term => `岗位与简历均提及：${term}`) : ['具备待进一步核实的相关经历'],
      risks: ['项目中的个人职责边界未量化', '项目结果与业务影响需核实', '期望薪资与到岗周期待确认'],
      verification: ['核心项目是否真实上线及使用方', '个人负责模块与团队分工', '当前薪资、期望薪资与到岗时间'],
      questions: localQuestions(payload.rules)
    };
  }
  const statements = payload.transcript.split(/[。！？\n]/).map(item => item.trim()).filter(item => item.length > 10);
  const readField = label => payload.transcript.match(new RegExp(`${label}[：:为是]?([^，。；;\\n]{2,24})`))?.[1]?.trim() || '待确认';
  return {
    basicInfo: { currentCompanyRole: readField('目前'), location: readField('地点'), currentSalary: readField('当前薪资'), expectedSalary: readField('期望薪资'), availability: readField('到岗'), motivation: readField('考虑机会'), nonCompete: readField('竞业') },
    capabilities: ['已提供核心经历陈述，需由招聘人员核对原始转写', '项目职责与成果仍需结合岗位标准判断'],
    evidence: statements.slice(0, 4),
    risks: ['本地演示模式不进行事实推断', '未明确回答的字段均应补充核实'],
    conclusion: '信息不足', conclusionReason: '已有信息可形成初步纪要，但不足以自动得出推荐结论。', nextStep: '补充电话沟通',
    followUps: ['请确认个人负责模块及决策范围', '请量化项目上线结果或业务影响', '请确认薪资、到岗时间与竞业限制']
  };
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
  return rows.map(([category, question, reason]) => ({ category, question, reason }));
}

function renderPreparation(result) {
  $('#prepareResult').classList.remove('hidden');
  $('#prepareResult').innerHTML = `<div class="result-grid">
    ${block('候选人摘要', `<p>${escapeHtml(result.summary)}</p>`, true)}
    ${block('匹配点', list(result.matches))}
    ${block('风险点', list(result.risks))}
    ${block('重点核验', list(result.verification), true)}
  </div>`;
}

function renderChecklist(questions) {
  const container = $('#questionChecklist');
  container.className = 'checklist';
  container.innerHTML = questions.map((item, index) => `<label class="check-item">
    <input type="checkbox" data-question="${index}"><b>${escapeHtml(item.category)}</b><span>${escapeHtml(item.question)}<br><small>${escapeHtml(item.reason || '')}</small></span>
  </label>`).join('');
}

function renderReport(report) {
  const info = report.basicInfo || {};
  $('#reportResult').className = 'report-layout';
  $('#reportResult').innerHTML = `<div class="decision">
    <div><small>AI 初步结论 · 待人工确认</small><strong>${escapeHtml(report.conclusion)}</strong><p>${escapeHtml(report.conclusionReason)}</p></div>
    <label><span>最终动作</span><select id="finalDecision">${['推荐业务面试','补充电话沟通','转入其他岗位','暂不推进','纳入人才库长期维护'].map(value => `<option ${value === report.nextStep ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
  </div><div class="report-grid" style="margin-top:14px">
    ${block('基本信息', `<dl class="facts">${Object.entries(info).map(([key,value]) => `<div><dt>${escapeHtml(infoLabels[key] || key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`, true)}
    ${block('能力与经历', list(report.capabilities))}
    ${block('事实依据', list(report.evidence))}
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
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }

function showStep(step) {
  $$('.step').forEach(item => item.classList.toggle('active', item.dataset.step === step));
  $$('.step-panel').forEach(item => item.classList.toggle('active', item.dataset.panel === step));
}

function saveCurrent(patch) {
  const now = new Date().toISOString();
  const id = state.currentId || crypto.randomUUID();
  const old = state.cases.find(item => item.id === id) || { id, createdAt: now };
  const current = { ...old, ...patch, id, updatedAt: now, roleName: $('#roleName').value.trim(), candidateName: $('#candidateName').value.trim(), jd: $('#jdInput').value, resume: $('#resumeInput').value, rules: $('#rulesInput').value, transcript: $('#transcriptInput').value, consentConfirmed: $('#consentConfirmed').checked };
  state.currentId = id;
  state.cases = [current, ...state.cases.filter(item => item.id !== id)];
  localStorage.setItem(storageKey, JSON.stringify(state.cases));
  $('#caseTitle').textContent = current.candidateName ? `${current.candidateName} · ${current.roleName || '初筛'}` : '新候选人初筛';
  renderCaseList();
}

function loadCases() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { return []; }
}

function renderCaseList() {
  $('#caseCount').textContent = state.cases.length;
  $('#caseList').innerHTML = state.cases.map(item => `<button class="case-item ${item.id === state.currentId ? 'active' : ''}" data-id="${item.id}"><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.roleName || '岗位待填写')}</small></button>`).join('') || '<div class="empty-state">暂无案例</div>';
  $$('.case-item').forEach(button => button.addEventListener('click', () => openCase(button.dataset.id)));
}

function openCase(id) {
  const item = state.cases.find(entry => entry.id === id);
  if (!item) return;
  state.currentId = id;
  state.preparation = item.preparation || null;
  state.report = item.report || null;
  $('#roleName').value = item.roleName || '';
  $('#candidateName').value = item.candidateName || '';
  $('#jdInput').value = item.jd || '';
  $('#resumeInput').value = item.resume || '';
  $('#rulesInput').value = item.rules || '';
  $('#transcriptInput').value = item.transcript || '';
  $('#consentConfirmed').checked = Boolean(item.consentConfirmed);
  $('#caseTitle').textContent = item.candidateName ? `${item.candidateName} · ${item.roleName || '初筛'}` : '新候选人初筛';
  if (item.preparation) { renderPreparation(item.preparation); renderChecklist(item.preparation.questions || []); } else resetOutputs();
  if (item.report) renderReport(item.report); else $('#reportResult').className = 'report-layout empty-state';
  renderCaseList();
}

function newCase(showMessage) {
  state.currentId = null; state.preparation = null; state.report = null;
  ['roleName','candidateName','jdInput','resumeInput','rulesInput','transcriptInput'].forEach(id => $(`#${id}`).value = '');
  $('#consentConfirmed').checked = false;
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
  $('#reportResult').className = 'report-layout empty-state';
  $('#reportResult').textContent = '完成电话记录后，这里将生成结构化报告。';
}

function exportReport() {
  if (!state.report) return toast('请先生成初筛报告');
  if (!state.report.reviewConfirmed) return toast('请先完成人工审核确认');
  const item = state.cases.find(entry => entry.id === state.currentId) || {};
  const report = { candidate: item.candidateName, role: item.roleName, generatedAt: new Date().toISOString(), preparation: state.preparation, report: state.report };
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

function loadSample() {
  newCase(false);
  $('#roleName').value = '场外期权产品经理';
  $('#candidateName').value = '示例候选人';
  $('#jdInput').value = '场外期权产品经理\n负责 RFQ、交易簿记及生命周期管理产品规划；与交易、风控、研发团队协作推动上线。\n必备：3年以上证券或衍生品产品经验，能独立负责复杂项目。\n加分：熟悉定价、Greeks及风险管理。';
  $('#resumeInput').value = '示例候选人\n8年金融科技产品经验，其中4年参与证券场外期权系统建设。负责询报价与交易簿记模块，协调6人研发团队完成需求分析和交付。项目已上线，具体客户规模及业务结果待核实。';
  $('#rulesInput').value = '必须核实本人职责、项目上线结果、服务客户、交易规模。没有场外衍生品经验不直接淘汰，可接受相邻证券交易系统经验。最终结论必须由招聘人员确认。';
  $('#transcriptInput').value = '招聘人员：请介绍最相关的项目。\n候选人：我负责场外期权询报价和交易簿记模块，协调研发推进上线，主要使用方是机构客户。\n招聘人员：项目结果如何？\n候选人：系统已经上线，但交易规模不方便披露。\n招聘人员：为什么考虑机会？\n候选人：希望承担更完整的产品规划职责。地点：上海。到岗：一个月。期望薪资：面议。竞业：没有。';
  $('#consentConfirmed').checked = true;
  toast('示例数据已加载，可直接生成方案');
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
