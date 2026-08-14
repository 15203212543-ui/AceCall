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
}

async function checkHealth() {
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
  const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '生成失败');
  return data;
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
  </div>`;
  $('#finalDecision').addEventListener('change', event => {
    state.report.finalDecision = event.target.value;
    saveCurrent({ report: state.report });
  });
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
  const current = { ...old, ...patch, id, updatedAt: now, roleName: $('#roleName').value.trim(), candidateName: $('#candidateName').value.trim(), jd: $('#jdInput').value, resume: $('#resumeInput').value, rules: $('#rulesInput').value, transcript: $('#transcriptInput').value };
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
  $('#caseTitle').textContent = item.candidateName ? `${item.candidateName} · ${item.roleName || '初筛'}` : '新候选人初筛';
  if (item.preparation) { renderPreparation(item.preparation); renderChecklist(item.preparation.questions || []); } else resetOutputs();
  if (item.report) renderReport(item.report); else $('#reportResult').className = 'report-layout empty-state';
  renderCaseList();
}

function newCase(showMessage) {
  state.currentId = null; state.preparation = null; state.report = null;
  ['roleName','candidateName','jdInput','resumeInput','rulesInput','transcriptInput'].forEach(id => $(`#${id}`).value = '');
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
  const item = state.cases.find(entry => entry.id === state.currentId) || {};
  const report = { candidate: item.candidateName, role: item.roleName, generatedAt: new Date().toISOString(), preparation: state.preparation, report: state.report };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `AceCall-${item.candidateName || '候选人'}-${new Date().toISOString().slice(0,10)}.json`;
  link.click(); URL.revokeObjectURL(link.href);
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
