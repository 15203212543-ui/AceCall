import cloudbase from 'https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@latest/+esm';

const CASES_KEY = 'acecall-cases-v1';
const JOBS_KEY = 'acecall-jobs-v1';
const RULES_KEY = 'acecall-team-rules-v1';
const API_BASE = String(window.ACECALL_CONFIG?.apiBaseUrl || '').replace(/\/$/, '');
const REMOTE_BACKEND = Boolean(API_BASE);
const STATIC_DEMO = (location.protocol === 'file:' || location.hostname.endsWith('.github.io')) && !REMOTE_BACKEND;
const CLOUD_CONFIG = window.ACECALL_CONFIG?.cloudbase || {};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const app = { cases: readStore(CASES_KEY), jobs: readStore(JOBS_KEY), view: 'dashboard', candidateId: null, detailTab: 'overview', resumeMeta: null };
let cloudbaseAuth = null;
const importFileCache = new Map();
const importedFileKeys = new Set(readStore('acecall-import-files-v1'));
const teamRules = readStore(RULES_KEY);
let folderWatchTimer = null;
let watchedDirectory = null;
let pendingTeamRule = '';

document.addEventListener('DOMContentLoaded', async () => {
  if (!await initializeAuth()) return;
  bindShell();
  await hydrateState();
  seedJobs();
  await checkService();
  navigate(location.hash.replace('#', '') || 'dashboard');
});

function bindShell() {
  $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  $$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $('#candidateForm').addEventListener('submit', createCandidate);
  $('#jobForm').addEventListener('submit', saveJob);
  $('#resumeUploadButton').addEventListener('click', () => $('#resumeFileInput').click());
  $('#resumeFileInput').addEventListener('change', event => parseResume(event.target.files?.[0]));
  window.addEventListener('hashchange', () => navigate(location.hash.replace('#', '') || 'dashboard', false));
  $('#logoutButton').addEventListener('click', signOut);
}

async function initializeAuth() {
  $('#loginForm').addEventListener('submit', signIn);
  if (!REMOTE_BACKEND) { $('#loginScreen').classList.add('hidden'); return true; }
  if (!CLOUD_CONFIG.env || !CLOUD_CONFIG.publishableKey) {
    showLoginMessage('CloudBase登录配置不完整');
    return false;
  }
  const cloudbaseApp = cloudbase.init({ env: CLOUD_CONFIG.env, region: CLOUD_CONFIG.region, accessKey: CLOUD_CONFIG.publishableKey });
  cloudbaseAuth = cloudbaseApp.auth({ persistence: 'local' });
  const { data, error } = await cloudbaseAuth.getSession();
  if (error) showLoginMessage(error.message || '登录状态读取失败');
  if (!data?.session) return false;
  $('#loginScreen').classList.add('hidden');
  return true;
}

async function signIn(event) {
  event.preventDefault();
  const button = $('#loginButton');
  button.disabled = true; button.textContent = '正在登录'; showLoginMessage('正在验证账号', false);
  try {
    const { data, error } = await cloudbaseAuth.signInWithPassword({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value });
    if (error || !data?.session) throw new Error(error?.message || '账号或密码错误');
    location.reload();
  } catch (error) {
    showLoginMessage(error.message || '登录失败');
    button.disabled = false; button.textContent = '登录';
  }
}

async function signOut() {
  await cloudbaseAuth?.signOut();
  location.reload();
}

function showLoginMessage(message, isError = true) {
  $('#loginMessage').textContent = message;
  $('#loginMessage').classList.toggle('error', isError);
}

function navigate(view, updateHash = true) {
  if (!['dashboard', 'inbox', 'candidates', 'jobs', 'settings', 'candidate'].includes(view)) view = 'dashboard';
  app.view = view;
  $$('.view').forEach(section => section.classList.remove('active'));
  $$('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view || (view === 'candidate' && button.dataset.view === 'candidates')));
  const target = view === 'candidate' ? $('#candidateDetailView') : $(`#${view}View`);
  target.classList.add('active');
  $('#breadcrumb').textContent = view === 'candidate' ? '候选人 / 初筛详情' : ({ dashboard: '招聘工作台', inbox: '简历中心', candidates: '候选人管理', jobs: '岗位管理', settings: '系统设置' }[view]);
  if (updateHash) history.replaceState(null, '', `#${view}`);
  renderCurrent();
}

function renderCurrent() {
  $('#candidateNavCount').textContent = app.cases.length;
  $('#resumeInboxCount').textContent = app.cases.filter(item => item.ingestStatus === '解析中' || item.matching?.status === '待分配').length || '';
  if (app.view === 'dashboard') renderDashboard();
  if (app.view === 'inbox') renderInbox();
  if (app.view === 'candidates') renderCandidates();
  if (app.view === 'jobs') renderJobs();
  if (app.view === 'settings') renderSettings();
  if (app.view === 'candidate') renderCandidateDetail();
}

function renderDashboard() {
  const pendingCall = app.cases.filter(item => statusOf(item) === '待电话').length;
  const pendingReview = app.cases.filter(item => statusOf(item) === '待确认').length;
  const followUp = app.cases.filter(item => finalAction(item) === '补充电话沟通').length;
  const recommended = app.cases.filter(item => finalAction(item) === '推荐业务面试').length;
  const rows = [...app.cases].sort(byUpdated).slice(0, 6);
  $('#dashboardView').innerHTML = `<div class="page"><div class="page-title"><div><h1>招聘工作台</h1><p>集中处理待初筛候选人和待确认结果。</p></div><button class="primary" data-add-candidate>＋ 添加候选人</button></div><div class="metrics"><div class="metric"><b>${pendingCall}</b><span>待电话初筛</span><a>开始处理 →</a></div><div class="metric"><b>${pendingReview}</b><span>待确认结果</span><a>查看 →</a></div><div class="metric"><b>${followUp}</b><span>需要补充沟通</span></div><div class="metric"><b>${recommended}</b><span>已推荐业务面试</span></div></div>${candidateTable(rows, '今日待处理')}</div>`;
  bindCommonActions($('#dashboardView'));
}

function renderInbox() {
  const pending = app.cases.filter(item => item.ingestStatus === '解析中').length;
  const needsAssignment = app.cases.filter(item => item.matching?.status === '待分配').length;
  $('#inboxView').innerHTML = `<div class="page"><div class="page-title"><div><h1>简历中心</h1><p>直接导入简历，系统会自动解析、匹配岗位并建立候选人档案。</p></div><div class="import-actions"><label class="primary upload-trigger">＋ 批量导入简历<input id="batchResumeInput" type="file" accept=".pdf,.docx,.txt,.md" multiple hidden></label><label class="secondary upload-trigger">授权文件夹<input id="folderResumeInput" type="file" webkitdirectory directory multiple hidden></label></div></div><div class="metrics"><div class="metric"><b>${app.cases.length}</b><span>已建立档案</span></div><div class="metric"><b>${pending}</b><span>处理中</span></div><div class="metric"><b>${needsAssignment}</b><span>待分配岗位</span></div></div><div class="surface"><div class="surface-head"><h2>导入说明</h2><span>支持 PDF、DOCX、TXT、MD</span></div><div class="surface-body"><p style="font-size:11px;line-height:1.7;color:var(--muted);margin:0">可批量选择简历，或主动授权一个文件夹进行本次导入。页面保持打开时可再次选择同一文件夹，新增文件会自动去重并解析；低置信度简历仍会入库，不会自动淘汰。</p></div></div><div class="surface" style="margin-top:13px"><div class="surface-head"><h2>最近导入</h2><span>${app.cases.length} 位候选人</span></div><div class="table-wrap"><table><thead><tr><th>候选人</th><th>自动分配岗位</th><th>匹配度</th><th>解析状态</th><th>下一步</th></tr></thead><tbody>${app.cases.slice(0,12).map(item => `<tr><td><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.resumeMeta?.fileName || '文本录入')}</small></td><td>${escapeHtml(item.roleName || '待分配')}</td><td>${scoreLabel(item)}</td><td>${escapeHtml(item.ingestStatus || '已入库')}${item.ingestStatus?.startsWith('解析失败') && importFileCache.has(item.ingestFileKey) ? ` <button class="link-action" data-retry-import="${item.id}">重试</button>` : ''}</td><td><button class="link-action" data-open-candidate="${item.id}">查看 →</button></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">还没有导入简历</div></td></tr>'}</tbody></table></div></div></div>`;
  $('#batchResumeInput').addEventListener('change', event => importResumeBatch(event.target.files));
  $('#folderResumeInput').addEventListener('change', event => importResumeBatch(event.target.files));
  const watchButton = document.createElement('button');
  watchButton.className = 'secondary'; watchButton.id = 'watchFolderButton'; watchButton.type = 'button'; watchButton.textContent = '启动页面监听';
  $('#inboxView .import-actions').append(watchButton); watchButton.addEventListener('click', startFolderWatch);
  bindCommonActions($('#inboxView'));
  $$('#inboxView [data-retry-import]').forEach(button => button.addEventListener('click', () => retryImport(button.dataset.retryImport)));
}

async function startFolderWatch() {
  if (folderWatchTimer) { clearInterval(folderWatchTimer); folderWatchTimer = null; watchedDirectory = null; toast('已停止页面监听'); return; }
  if (!window.showDirectoryPicker) return toast('当前浏览器不支持持续文件夹监听，请使用“授权文件夹”导入');
  try {
    watchedDirectory = await window.showDirectoryPicker({ mode: 'read' });
    folderWatchTimer = setInterval(scanWatchedDirectory, 8000);
    await scanWatchedDirectory(); toast('文件夹监听已启动，页面保持打开即可自动导入新增简历');
  } catch (error) { if (error.name !== 'AbortError') toast('文件夹授权失败，请重新选择'); }
}

async function scanWatchedDirectory() {
  if (!watchedDirectory) return;
  const files = [];
  for await (const entry of watchedDirectory.values()) if (entry.kind === 'file' && /\.(pdf|docx?|txt|md)$/i.test(entry.name)) files.push(await entry.getFile());
  if (files.length) await importResumeBatch(files);
}

async function retryImport(id) {
  const candidate = app.cases.find(item => item.id === id); const file = importFileCache.get(candidate?.ingestFileKey);
  if (!candidate || !file) return toast('原文件已不在当前会话，请重新选择文件');
  candidate.ingestStatus = '解析中'; renderCurrent();
  try { const result = await parseResumeFileForImport(file); candidate.resume = result.text; candidate.resumeMeta = result.metadata; candidate.candidateName = result.metadata.candidateName || candidate.candidateName; applyJobMatch(candidate, await matchResumeToJobs(candidate.resume, candidate.candidateName)); candidate.ingestStatus = '已入库'; persistCases(candidate); renderCurrent(); toast('简历已重试成功'); } catch (error) { candidate.ingestStatus = `解析失败：${error.message}`; persistCases(candidate); renderCurrent(); toast(error.message); }
}

function renderCandidates() {
  $('#candidatesView').innerHTML = `<div class="page"><div class="page-title"><div><h1>候选人</h1><p>按下一步动作管理简历、电话初筛和推荐结果。</p></div><button class="primary" data-add-candidate>＋ 添加候选人</button></div><div class="toolbar"><input id="candidateSearch" placeholder="搜索姓名、公司或岗位"><select id="candidateJobFilter"><option value="">全部岗位</option>${app.jobs.map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}</select><select id="candidateStatusFilter"><option value="">全部状态</option>${['待分析','待电话','待确认','推荐面试','补充沟通','暂不推进'].map(value => `<option>${value}</option>`).join('')}</select></div><div id="candidateTableSlot">${candidateTable(app.cases, '全部候选人')}</div></div>`;
  bindCommonActions($('#candidatesView'));
  ['candidateSearch', 'candidateJobFilter', 'candidateStatusFilter'].forEach(id => $(`#${id}`).addEventListener('input', filterCandidates));
}

function filterCandidates() {
  const search = $('#candidateSearch').value.trim().toLowerCase();
  const jobId = $('#candidateJobFilter').value;
  const status = $('#candidateStatusFilter').value;
  const filtered = app.cases.filter(item => (!search || `${item.candidateName} ${item.roleName} ${item.resume}`.toLowerCase().includes(search)) && (!jobId || item.jobId === jobId) && (!status || displayStatus(item) === status));
  $('#candidateTableSlot').innerHTML = candidateTable(filtered, `候选人 ${filtered.length}`);
  bindCommonActions($('#candidateTableSlot'));
}

function candidateTable(items, title) {
  return `<div class="surface"><div class="surface-head"><h2>${title}</h2><span>${items.length} 位候选人</span></div><div class="table-wrap"><table><thead><tr><th>候选人</th><th>应聘岗位</th><th>匹配度</th><th>负责人</th><th>初筛状态</th><th>更新时间</th><th>下一步</th></tr></thead><tbody>${items.map(item => `<tr><td><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${resumeHint(item)}</small></td><td>${escapeHtml(item.roleName || '待分配')}</td><td>${scoreLabel(item)}</td><td>Rick</td><td><span class="status ${statusClass(displayStatus(item))}">${displayStatus(item)}</span></td><td>${formatDate(item.updatedAt || item.createdAt)}</td><td><button class="link-action" data-open-candidate="${item.id}">${nextAction(item)} →</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderJobs() {
  $('#jobsView').innerHTML = `<div class="page"><div class="page-title"><div><h1>岗位</h1><p>一次维护JD、关键词和初筛规则，后续候选人自动复用。</p></div><button class="primary" data-add-job>＋ 新建岗位</button></div><div class="toolbar"><input id="jobSearch" placeholder="搜索岗位名称、行业或关键词"><select id="jobIndustryFilter"><option value="">全部行业</option>${[...new Set(app.jobs.map(job => job.industry))].map(value => `<option>${escapeHtml(value)}</option>`).join('')}</select></div><div class="job-grid" id="jobGrid">${jobCards(app.jobs)}</div></div>`;
  bindCommonActions($('#jobsView'));
  $('#jobSearch').addEventListener('input', filterJobs); $('#jobIndustryFilter').addEventListener('input', filterJobs);
  const library = document.createElement('div'); library.className = 'surface rules-library'; library.innerHTML = `<div class="surface-head"><h2>团队规则库</h2><span>共享给团队成员</span></div><div class="surface-body"><div class="rule-add"><input id="teamRuleInput" placeholder="添加常用核验规则"><button class="secondary" id="addTeamRule" type="button">添加规则</button></div><div class="rule-list">${teamRules.map((rule, index) => `<button class="rule-chip" data-use-rule="${index}" type="button">＋ ${escapeHtml(rule)}</button>`).join('') || '<span class="muted-text">还没有共享规则</span>'}</div></div>`; $('#jobsView .page').append(library);
  $('#addTeamRule').addEventListener('click', addTeamRule); $$('#jobsView [data-use-rule]').forEach(button => button.addEventListener('click', () => useTeamRule(Number(button.dataset.useRule))));
}

function addTeamRule() { const value = $('#teamRuleInput').value.trim(); if (!value) return toast('请输入规则内容'); if (!teamRules.includes(value)) teamRules.push(value); localStorage.setItem(RULES_KEY, JSON.stringify(teamRules)); renderJobs(); toast('规则已加入团队库'); }
function useTeamRule(index) { const value = teamRules[index]; if (!value) return; pendingTeamRule = value; openJobDialog(); }

function jobCards(jobs) {
  if (!jobs.length) return '<div class="surface empty">暂无岗位，请先建立岗位标准。</div>';
  return jobs.map(job => { const count = app.cases.filter(item => item.jobId === job.id).length; return `<article class="job-item"><header><div><h2>${escapeHtml(job.name)}</h2><p>${escapeHtml(job.industry || '其他')} · 招聘中</p></div><button class="link-action" data-edit-job="${job.id}">编辑</button></header><div class="keywords">${(job.keywords || []).slice(0,6).map(word => `<span>${escapeHtml(word)}</span>`).join('') || '<span>待设置关键词</span>'}</div><div class="job-meta"><span>${count} 位候选人</span><span>${app.cases.filter(item => item.jobId === job.id && statusOf(item) === '待电话').length} 位待初筛</span><span>更新于 ${formatDate(job.updatedAt)}</span></div></article>`; }).join('');
}

function filterJobs() {
  const query = $('#jobSearch').value.trim().toLowerCase(); const industry = $('#jobIndustryFilter').value;
  const filtered = app.jobs.filter(job => (!industry || job.industry === industry) && (!query || `${job.name} ${job.industry} ${(job.keywords || []).join(' ')}`.toLowerCase().includes(query)));
  $('#jobGrid').innerHTML = jobCards(filtered); bindCommonActions($('#jobGrid'));
}

function renderCandidateDetail() {
  const item = currentCandidate();
  if (!item) { navigate('candidates'); return; }
  $('#candidateDetailView').innerHTML = `<div class="detail-header"><div class="identity"><div class="person"><span class="portrait">${escapeHtml((item.candidateName || '候').slice(0,1))}</span><div><h1>${escapeHtml(item.candidateName || '未命名候选人')}</h1><p>${escapeHtml(item.roleName || '岗位待设置')} · ${displayStatus(item)}</p></div></div><div><button class="secondary" data-back-candidates>返回列表</button> ${statusOf(item) === '待电话' ? '<button class="primary" data-detail-tab="call">进入电话工作台</button>' : ''}</div></div><div class="tabs">${[['overview','概览'],['call','电话初筛'],['resume','简历'],['history','历史记录']].map(([id,label]) => `<button class="tab ${app.detailTab === id ? 'active' : ''}" data-detail-tab="${id}">${label}</button>`).join('')}</div></div><div class="detail-content" id="detailBody"></div>`;
  renderDetailTab(item);
  bindCommonActions($('#candidateDetailView'));
}

function renderDetailTab(item) {
  const body = $('#detailBody');
  if (app.detailTab === 'overview') body.innerHTML = overviewTab(item);
  if (app.detailTab === 'call') body.innerHTML = callTab(item);
  if (app.detailTab === 'resume') body.innerHTML = resumeTab(item);
  if (app.detailTab === 'history') body.innerHTML = historyTab(item);
  bindDetailActions(body);
}

function overviewTab(item) {
  const prep = item.preparation;
  if (!prep) return `<div class="surface empty">尚未生成电话准备。<br><button class="primary" style="margin-top:12px" data-generate-prep>生成电话准备</button></div>`;
  const summary = typeof prep.summary === 'string' ? { headline: prep.summary } : prep.summary || {};
  const matching = item.matching || {};
  return `<div class="grid-2"><div><div class="surface"><div class="surface-head"><h2>候选人摘要</h2><span>AI电话准备</span></div><div class="surface-body"><p style="font-size:11px;line-height:1.65;margin:0">${escapeHtml(summary.headline || '')}</p><p style="font-size:10px;color:var(--muted)">${escapeHtml(summary.experience || '')}<br>${escapeHtml(summary.relevantBackground || '')}</p></div></div><div class="surface" style="margin-top:13px"><div class="surface-head"><h2>岗位匹配</h2><strong class="score-large">${scoreValue(item)}</strong></div><div class="surface-body"><div class="fact"><span>主岗位</span><b>${escapeHtml(item.roleName || '待分配')}</b></div><div class="fact"><span>匹配置信度</span><b>${escapeHtml(matching.confidence || '待评估')}</b></div>${(matching.alternativeJobs || []).slice(0,2).map(job => `<div class="point"><strong>备选：${escapeHtml(job.name || '')} · ${Number(job.score || 0)}分</strong><small>${escapeHtml(job.reason || '')}</small></div>`).join('')}${(matching.risks || []).slice(0,3).map(point => `<div class="point risk"><strong>${escapeHtml(point.risk || point)}</strong><small>${escapeHtml(point.evidence || '')}</small></div>`).join('')}</div></div><div class="surface" style="margin-top:13px"><div class="surface-head"><h2>匹配与风险</h2><span>${escapeHtml(item.roleName || '')}</span></div><div class="surface-body">${(prep.matches || []).slice(0,4).map(point => `<div class="point"><strong>${escapeHtml(point.requirement || point)}</strong><small>${escapeHtml(point.evidence || '')}</small></div>`).join('')}${(prep.risks || []).slice(0,3).map(point => `<div class="point risk"><strong>${escapeHtml(point.risk || point)}</strong><small>${escapeHtml(point.evidence || '')}</small></div>`).join('')}</div></div></div><div><div class="surface"><div class="surface-head"><h2>当前进度</h2><span class="status ${statusClass(displayStatus(item))}">${displayStatus(item)}</span></div><div class="surface-body"><div class="fact"><span>应聘岗位</span><b>${escapeHtml(item.roleName || '待分配')}</b></div><div class="fact"><span>招聘负责人</span><b>Rick</b></div><div class="fact"><span>简历文件</span><b>${escapeHtml(item.resumeMeta?.fileName || '文本录入')}</b></div><div class="fact"><span>更新时间</span><b>${formatDate(item.updatedAt)}</b></div></div></div><div class="surface" style="margin-top:13px"><div class="surface-head"><h2>下一步</h2></div><div class="surface-body"><p style="font-size:10px;color:var(--muted)">${nextGuidance(item)}</p><button class="primary" style="width:100%;margin-top:10px" data-detail-tab="call">${nextAction(item)}</button></div></div></div></div>`;
}

function callTab(item) {
  if (item.report) return resultTab(item);
  const questions = item.preparation?.questions || [];
  return `<div class="call-grid"><div class="surface"><div class="surface-head"><h2>本次核验问题</h2><span>${questions.length} 项</span></div><div class="surface-body">${questions.length ? questions.map((question,index) => `<label class="question"><input type="checkbox" data-question="${index}"><span><b>${escapeHtml(question.question || question)}</b><small>${escapeHtml(question.reason || question.source || '初筛必问项')}</small></span></label>`).join('') : '<div class="empty">请先生成电话准备</div>'}</div></div><div class="surface"><div class="surface-head"><h2>电话记录</h2><span>保存原始事实</span></div><div class="surface-body"><textarea class="call-notes" id="callTranscript" placeholder="粘贴电话转写，或按原意记录候选人回答…">${escapeHtml(item.transcript || '')}</textarea></div></div></div><div class="call-footer"><label style="display:flex;align-items:center;gap:7px"><input type="checkbox" id="consentConfirmed" ${item.consentConfirmed ? 'checked' : ''}> 已完成录音或转写告知</label><button class="primary" data-complete-call>完成电话并生成结果</button></div>`;
}

function resultTab(item) {
  const report = item.report || {}; const info = report.basicInfo || {};
  return `<div class="decision"><span class="tag">待人工确认</span><small>AI综合建议</small><h2>${escapeHtml(report.conclusion || '信息不足')}</h2><p>${escapeHtml(report.conclusionReason || '')}</p></div><div class="grid-2" style="margin-top:13px"><div class="surface"><div class="surface-head"><h2>结论依据</h2><span>${(report.capabilities || []).length} 项</span></div><div class="surface-body">${(report.capabilities || []).map(point => `<div class="evidence"><span class="tag">${escapeHtml(point.assessment || '待确认')}</span><strong>${escapeHtml(point.item || point)}</strong><p>${escapeHtml(point.evidence || '')}</p></div>`).join('') || '<div class="empty">暂无能力判断</div>'}${(report.risks || []).map(risk => `<div class="point risk"><strong>${escapeHtml(risk)}</strong></div>`).join('')}</div></div><div><div class="surface"><div class="surface-head"><h2>基础条件</h2></div><div class="surface-body">${Object.entries(info).map(([key,value]) => `<div class="fact"><span>${escapeHtml(infoLabel(key))}</span><b>${escapeHtml(value)}</b></div>`).join('') || '<div class="empty">待确认</div>'}</div></div><div class="review"><label>最终动作<select id="finalDecision">${['推荐业务面试','补充电话沟通','转入其他岗位','暂不推进','纳入人才库长期维护'].map(value => `<option ${value === (report.finalDecision || report.nextStep) ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label style="margin-top:10px">审核备注<textarea id="reviewNotes" placeholder="补充事实或后续安排">${escapeHtml(report.reviewNotes || '')}</textarea></label><label class="review-check"><input type="checkbox" id="reviewConfirmed" ${report.reviewConfirmed ? 'checked' : ''}> 我已核对材料并确认最终动作</label><button class="primary" style="width:100%" data-confirm-result>确认完成</button></div></div></div>`;
}

function resumeTab(item) { return `<div class="surface"><div class="surface-head"><h2>候选人简历</h2><span>${escapeHtml(item.resumeMeta?.fileName || '文本录入')}</span></div><div class="surface-body"><pre style="white-space:pre-wrap;font:11px/1.7 inherit;margin:0">${escapeHtml(item.resume || '暂无简历内容')}</pre></div></div>`; }
function historyTab(item) { const events = [['建立候选人档案',item.createdAt],item.preparation&&['AI完成电话准备',item.createdAt],item.communicationSummary&&['生成沟通总结',item.updatedAt],item.report&&['生成综合初筛结果',item.updatedAt],item.report?.reviewConfirmed&&['招聘人员确认结果',item.updatedAt]].filter(Boolean); return `<div class="surface"><div class="surface-head"><h2>处理记录</h2><span>保留人工与AI操作痕迹</span></div><div class="surface-body">${events.map(event => `<div class="fact"><span>${formatDate(event[1])}</span><b>${event[0]}</b></div>`).join('')}</div></div>`; }

function renderSettings() {
  $('#settingsView').innerHTML = `<div class="page"><div class="page-title"><div><h1>设置</h1><p>模型密钥和候选人数据均由服务端管理。</p></div></div><div class="settings-grid"><div class="surface"><div class="surface-head"><h2>AI与数据服务</h2><span>${STATIC_DEMO ? '演示模式' : REMOTE_BACKEND ? 'CloudBase模式' : '本地服务模式'}</span></div><div class="surface-body"><div class="setting-row"><span>AI服务</span><b>DeepSeek API</b></div><div class="setting-row"><span>模型配置</span><b>DEEPSEEK_MODEL</b></div><div class="setting-row"><span>数据存储</span><b>${REMOTE_BACKEND ? 'CloudBase文档数据库' : '浏览器本地存储'}</b></div><p style="font-size:10px;color:var(--muted);line-height:1.6">API Key仅保存在服务端环境变量中。CloudBase远端接口启用后，本地历史数据会自动迁移，不会把密钥写入浏览器。</p></div></div><div class="surface"><div class="surface-head"><h2>人工决策边界</h2></div><div class="surface-body"><div class="setting-row"><span>自动淘汰候选人</span><b>关闭</b></div><div class="setting-row"><span>敏感属性评分</span><b>禁止</b></div><div class="setting-row"><span>结果人工确认</span><b>必须</b></div></div></div></div></div>`;
}

function bindCommonActions(root) {
  root.querySelectorAll('[data-add-candidate]').forEach(button => button.addEventListener('click', openCandidateDialog));
  root.querySelectorAll('[data-open-candidate]').forEach(button => button.addEventListener('click', () => openCandidate(button.dataset.openCandidate)));
  root.querySelectorAll('[data-add-job]').forEach(button => button.addEventListener('click', () => openJobDialog()));
  root.querySelectorAll('[data-edit-job]').forEach(button => button.addEventListener('click', () => openJobDialog(button.dataset.editJob)));
  root.querySelectorAll('[data-back-candidates]').forEach(button => button.addEventListener('click', () => navigate('candidates')));
  root.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => { app.detailTab = button.dataset.detailTab; renderCandidateDetail(); }));
}

function bindDetailActions(root) {
  bindCommonActions(root);
  root.querySelector('[data-generate-prep]')?.addEventListener('click', () => generatePreparation(currentCandidate()));
  root.querySelector('[data-complete-call]')?.addEventListener('click', completeCall);
  root.querySelector('[data-confirm-result]')?.addEventListener('click', confirmResult);
}

function openCandidateDialog() {
  if (!app.jobs.length) return toast('请先创建岗位');
  $('#candidateForm').reset(); app.resumeMeta = null; $('#resumeStatus').className = 'file-status hidden';
  $('#candidateJobInput').innerHTML = `<option value="">自动匹配岗位</option>${app.jobs.map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}`;
  $('#candidateDialog').showModal();
}

async function createCandidate(event) {
  event.preventDefault(); const selectedJob = app.jobs.find(item => item.id === $('#candidateJobInput').value); const candidate = { id: crypto.randomUUID(), jobId: selectedJob?.id || '', candidateName: $('#candidateNameInput').value.trim(), roleName: selectedJob?.name || '', jd: selectedJob?.jd || '', rules: selectedJob?.rules || '', keywords: selectedJob?.keywords || [], resume: $('#candidateResumeInput').value.trim(), resumeMeta: app.resumeMeta, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!candidate.candidateName || !candidate.resume) return toast('请填写候选人姓名和简历');
  if (!selectedJob) { const match = await matchResumeToJobs(candidate.resume, candidate.candidateName); applyJobMatch(candidate, match); }
  app.cases.unshift(candidate); persistCases(candidate); $('#candidateDialog').close(); app.candidateId = candidate.id; app.detailTab = 'overview'; navigate('candidate');
  await generatePreparation(candidate);
}

async function importResumeBatch(files) {
  const selected = [...(files || [])];
  if (!selected.length) return;
  if (!app.jobs.length) return toast('请先创建至少一个岗位');
  let queued = 0;
  for (const file of selected) {
    const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
    if (importedFileKeys.has(fileKey)) continue;
    importedFileKeys.add(fileKey); importFileCache.set(fileKey, file); queued += 1;
    const candidate = { id: crypto.randomUUID(), candidateName: '', roleName: '', jobId: '', jd: '', rules: '', keywords: [], resume: '', resumeMeta: null, ingestStatus: '解析中', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    app.cases.unshift(candidate); renderCurrent();
    try {
      const result = await parseResumeFileForImport(file);
      candidate.resume = result.text; candidate.resumeMeta = result.metadata; candidate.candidateName = result.metadata.candidateName || file.name.replace(/\.[^.]+$/, '');
      const match = await matchResumeToJobs(candidate.resume, candidate.candidateName);
      applyJobMatch(candidate, match); candidate.ingestStatus = '已入库'; candidate.updatedAt = new Date().toISOString(); persistCases(candidate);
    } catch (error) { candidate.ingestStatus = `解析失败：${error.message}`; candidate.ingestFileKey = fileKey; candidate.updatedAt = new Date().toISOString(); persistCases(candidate); }
    renderCurrent();
  }
  localStorage.setItem('acecall-import-files-v1', JSON.stringify([...importedFileKeys]));
  toast(queued ? `已处理 ${queued} 份简历${queued < selected.length ? '，重复文件已跳过' : ''}` : '所选文件已导入过，未重复创建');
}

async function parseResumeFileForImport(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (STATIC_DEMO && ['txt', 'md'].includes(extension)) return { text: await file.text(), metadata: { fileName: file.name, extension: extension.toUpperCase(), characters: file.size } };
  const response = await authenticatedFetch(apiUrl(`/api/parse-resume?name=${encodeURIComponent(file.name)}`), { method: 'POST', body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '简历解析失败'); return data;
}

async function matchResumeToJobs(resume, candidateName = '') {
  const response = await generate({ action: 'match', candidateName, resume, jobs: app.jobs.map(job => ({ id: job.id, name: job.name, industry: job.industry, jd: job.jd, keywords: job.keywords, rules: job.rules })) });
  return response;
}

function applyJobMatch(candidate, match) {
  const primary = app.jobs.find(job => job.id === match?.jobId) || app.jobs[0];
  if (!primary) return;
  candidate.jobId = primary.id; candidate.roleName = primary.name; candidate.jd = primary.jd; candidate.rules = primary.rules || ''; candidate.keywords = primary.keywords || [];
  candidate.matching = { ...match, jobId: primary.id, status: match?.status || '已分配' };
}

async function generatePreparation(candidate) {
  if (!candidate) return; const button = $('[data-generate-prep]'); if (button) button.disabled = true;
  try { candidate.preparation = await generate({ action:'prepare', roleName:candidate.roleName, candidateName:candidate.candidateName, jd:candidate.jd, resume:candidate.resume, rules:candidate.rules, keywords:candidate.keywords }); candidate.updatedAt = new Date().toISOString(); persistCases(candidate); renderCandidateDetail(); toast('电话准备已自动完成'); } catch (error) { toast(error.message); if (button) button.disabled = false; }
}

async function completeCall() {
  const candidate = currentCandidate(); const transcript = $('#callTranscript').value.trim(); if (!transcript) return toast('请先填写电话记录'); if (!$('#consentConfirmed').checked) return toast('请先确认已完成录音或转写告知');
  const button = $('[data-complete-call]'); button.disabled = true; button.textContent = '正在生成结果';
  try {
    candidate.transcript = transcript; candidate.consentConfirmed = true;
    candidate.communicationSummary = await generate({ action:'summarize', roleName:candidate.roleName, jd:candidate.jd, resume:candidate.resume, rules:candidate.rules, preparation:candidate.preparation, transcript });
    candidate.report = await generate({ action:'synthesize', roleName:candidate.roleName, jd:candidate.jd, rules:candidate.rules, keywords:candidate.keywords, preparation:candidate.preparation, communicationSummary:candidate.communicationSummary });
    candidate.updatedAt = new Date().toISOString(); persistCases(candidate); renderCandidateDetail(); toast('初筛结果已生成，请人工确认');
  } catch (error) { toast(error.message); button.disabled = false; button.textContent = '完成电话并生成结果'; }
}

function confirmResult() {
  const candidate = currentCandidate(); if (!$('#reviewConfirmed').checked) return toast('请先确认已核对材料');
  candidate.report.finalDecision = $('#finalDecision').value; candidate.report.reviewNotes = $('#reviewNotes').value.trim(); candidate.report.reviewConfirmed = true; candidate.updatedAt = new Date().toISOString(); persistCases(candidate); renderCandidateDetail(); toast('初筛结果已确认');
}

function openCandidate(id) { app.candidateId = id; app.detailTab = statusOf(app.cases.find(item => item.id === id)) === '待确认' ? 'call' : 'overview'; navigate('candidate'); }

function openJobDialog(id) {
  const job = app.jobs.find(item => item.id === id); $('#jobForm').reset(); $('#jobDialogTitle').textContent = job ? '编辑岗位' : '新建岗位'; $('#jobIdInput').value = job?.id || ''; $('#jobIndustryInput').value = job?.industry || '金融'; $('#jobNameInput').value = job?.name || ''; $('#jobJdInput').value = job?.jd || ''; $('#jobKeywordsInput').value = (job?.keywords || []).join('、'); $('#jobRulesInput').value = `${job?.rules || ''}${pendingTeamRule ? `${job?.rules ? '\n' : ''}${pendingTeamRule}` : ''}`; pendingTeamRule = ''; $('#jobDialog').showModal();
  const keywordLabel = $('#jobKeywordsInput').parentElement; if (!keywordLabel.querySelector('[data-generate-job]')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'link-action'; button.dataset.generateJob = 'keywords'; button.textContent = '自动提取'; keywordLabel.append(button); button.addEventListener('click', () => generateJobProfile('keywords')); }
  const rulesLabel = $('#jobRulesInput').parentElement; if (!rulesLabel.querySelector('[data-generate-job]')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'link-action'; button.dataset.generateJob = 'rules'; button.textContent = '自动生成'; rulesLabel.append(button); button.addEventListener('click', () => generateJobProfile('rules')); }
}

function generateJobProfile(type) {
  const jd = $('#jobJdInput').value.trim(); if (!jd) return toast('请先填写岗位JD'); const terms = [...new Set(findSharedTerms(jd, `${jd} ${$('#jobNameInput').value}`, []))];
  if (type === 'keywords') { const extra = jd.match(/[A-Za-z][A-Za-z0-9+#.-]{1,20}/g) || []; $('#jobKeywordsInput').value = parseKeywords(`${$('#jobKeywordsInput').value}、${[...terms, ...extra].join('、')}`).join('、'); toast('关键词已自动提取，可继续手动调整'); }
  else { const rules = ['核实候选人个人职责边界与主导程度', '确认核心项目是否上线及可量化结果', '补充业务规模、协作对象和团队分工']; $('#jobRulesInput').value = `${$('#jobRulesInput').value.trim()}${$('#jobRulesInput').value.trim() ? '\n' : ''}${rules.join('\n')}`; toast('初筛规则已生成，可继续手动调整'); }
}

function saveJob(event) {
  event.preventDefault(); const id = $('#jobIdInput').value || crypto.randomUUID(); const old = app.jobs.find(job => job.id === id); const job = { id, industry:$('#jobIndustryInput').value, name:$('#jobNameInput').value.trim(), jd:$('#jobJdInput').value.trim(), keywords:parseKeywords($('#jobKeywordsInput').value), rules:$('#jobRulesInput').value.trim(), createdAt:old?.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString() }; if (!job.name || !job.jd) return toast('请填写岗位名称和JD'); app.jobs = [job,...app.jobs.filter(item => item.id !== id)]; persistJobs(job); $('#jobDialog').close(); renderJobs(); toast(old ? '岗位已更新' : '岗位已创建');
}

async function parseResume(file) {
  if (!file) return; if (file.size > 10_000_000) return toast('文件不能超过10MB'); const extension = file.name.split('.').pop().toLowerCase(); $('#resumeStatus').className = 'file-status'; $('#resumeStatus').textContent = `正在解析 ${file.name}…`;
  try { let result; if (STATIC_DEMO && ['txt','md'].includes(extension)) { const text = await file.text(); result = { text, metadata:{ fileName:file.name, extension:extension.toUpperCase(), characters:text.length } }; } else if (STATIC_DEMO) throw new Error('在线演示版PDF/DOCX解析需要后端服务'); else { const response = await authenticatedFetch(apiUrl(`/api/parse-resume?name=${encodeURIComponent(file.name)}`), { method:'POST', body:file }); result = await response.json(); if (!response.ok) throw new Error(result.error || '解析失败'); } $('#candidateResumeInput').value = result.text; app.resumeMeta = result.metadata; if (!$('#candidateNameInput').value && result.metadata.candidateName) $('#candidateNameInput').value = result.metadata.candidateName; $('#resumeStatus').textContent = `${file.name} · 已提取 ${result.metadata.characters || result.text.length} 字`; } catch (error) { $('#resumeStatus').textContent = error.message; toast(error.message); }
}

async function generate(payload) {
  if (STATIC_DEMO) return localGenerate(payload);
  const response = await authenticatedFetch(apiUrl('/api/generate'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'AI服务调用失败'); return data.result;
}

function localGenerate(payload) {
  if (payload.action === 'match') return localMatch(payload);
  if (payload.action === 'prepare') { const terms = [...new Set([...(payload.keywords || []),'证券','交易','产品','研发','风险','管理'])].filter(term => payload.resume.includes(term)); return { summary:{ headline:`${payload.candidateName}具备与${payload.roleName}相关的经历，核心职责和项目结果需要电话核实。`,experience:'简历信息已完成结构化，具体年限以原始简历为准。',relevantBackground:terms.length ? `相关关键词：${terms.join('、')}` : '相关经验需要电话补充。' }, matches:(terms.length?terms:['相关经验']).map(term=>({requirement:term,evidence:`简历提及“${term}”`,confidence:'中'})), risks:[{risk:'个人职责边界待确认',evidence:'简历描述无法区分参与和主导'},{risk:'项目结果待量化',evidence:'缺少上线效果或业务指标'}], questions:defaultQuestions() }; }
  if (payload.action === 'summarize') { const lines=payload.transcript.split(/[。！？\n]/).map(v=>v.trim()).filter(v=>v.length>8); return { overview:`已识别${lines.length}条候选人陈述。`,confirmed:lines.slice(0,4).map(v=>({item:'候选人陈述',evidence:v})),missing:[{item:'量化业务结果',evidence:'未识别到明确数据'}],contradicted:[],keyFacts:{location:readField(payload.transcript,'地点'),expectedSalary:readField(payload.transcript,'期望薪资'),availability:readField(payload.transcript,'到岗'),nonCompete:readField(payload.transcript,'竞业')},followUps:['补充项目结果和个人职责边界'] }; }
  return { basicInfo:payload.communicationSummary.keyFacts || {}, capabilities:(payload.preparation.matches || []).map(point=>({item:point.requirement,evidence:point.evidence,assessment:'部分匹配'})), risks:(payload.communicationSummary.missing || []).map(point=>point.item), conclusion:'部分匹配', conclusionReason:'候选人具备相关经历，但项目结果与职责边界仍需业务面试进一步验证。', nextStep:'推荐业务面试', followUps:payload.communicationSummary.followUps || [] };
}

function localMatch(payload) {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const ranked = jobs.map(job => { const terms = findSharedTerms(`${job.name} ${job.jd}`, payload.resume, job.keywords); const required = (job.keywords || []).length; const score = Math.min(99, Math.round((terms.length / Math.max(required, 4)) * 70 + (payload.resume.includes(job.industry || '') ? 15 : 0) + (terms.length ? 10 : 0))); return { job, score, terms }; }).sort((a, b) => b.score - a.score);
  const first = ranked[0]; if (!first) return { status: '待分配', score: 0, confidence: '低', alternativeJobs: [], risks: [{ risk: '岗位库为空', evidence: '暂无可匹配岗位' }] };
  return { jobId: first.job.id, score: first.score, confidence: first.score >= 75 ? '高' : first.score >= 50 ? '中' : '低', status: first.score >= 50 ? '已分配' : '待分配', dimensions: [{ item: '核心关键词', score: first.score, evidence: first.terms.join('、') || '未识别共同关键词' }], alternativeJobs: ranked.slice(1, 3).map(item => ({ name: item.job.name, score: item.score, reason: item.terms.join('、') || '共同信息较少' })), risks: first.score < 50 ? [{ risk: '岗位匹配度较低', evidence: '简历与岗位共同关键词有限' }] : [] };
}

function defaultQuestions(){return [['基本条件','请确认目前地点、期望工作地点、薪资和到岗时间。','确认基础可行性','必问'],['求职动机','为什么在这个时间点考虑新的机会？','判断动机与岗位内容是否一致','必问'],['核心项目','请选择最相关的项目，说明背景、职责和结果。','核实经历真实性','必问'],['职责边界','哪些决策由你直接负责？哪些工作是参与完成？','区分参与和主导','必问'],['项目结果','项目是否上线，有哪些可量化结果？','验证交付质量','必问'],['专业能力','你负责过哪些业务模块，如何与业务和研发协作？','验证岗位专业能力','建议问'],['风险核验','过去几次工作变动的主要原因分别是什么？','识别稳定性风险','风险追问'],['合规','是否存在竞业限制或其他入职约束？','识别入职风险','必问']].map(([category,question,reason,priority])=>({category,question,reason,priority,source:'初筛准备'}));}

function statusOf(item) { if (item.report?.reviewConfirmed) return '已完成'; if (item.report || item.communicationSummary) return '待确认'; if (item.preparation) return '待电话'; return '待分析'; }
function displayStatus(item) { if (item.report?.reviewConfirmed) return ({'推荐业务面试':'推荐面试','补充电话沟通':'补充沟通','暂不推进':'暂不推进'}[item.report.finalDecision] || item.report.finalDecision || '已完成'); return statusOf(item); }
function finalAction(item) { return item.report?.finalDecision || item.report?.nextStep || ''; }
function nextAction(item) { const status=statusOf(item); return status==='待分析'?'生成电话准备':status==='待电话'?'开始初筛':status==='待确认'?'查看结果':'查看记录'; }
function nextGuidance(item) { const status=statusOf(item); return status==='待电话'?'按初筛准备中的重点问题完成电话沟通。':status==='待确认'?'核对AI整理的事实与结论，确认最终动作。':'查看完整初筛记录和人工确认结果。'; }
function statusClass(status){return ['待确认','补充沟通'].includes(status)?'warn':['暂不推进','待分析'].includes(status)?'neutral':'';}
function scoreValue(item){const value=Number(item.matching?.score);return Number.isFinite(value)&&value>0?value:'—';}
function scoreLabel(item){const value=scoreValue(item);return value==='—'?'<span class="score muted">—</span>':`<strong class="score">${value}分</strong>`;}
function currentCandidate(){return app.cases.find(item=>item.id===app.candidateId);}
function readStore(key){try{return JSON.parse(localStorage.getItem(key)||'[]');}catch{return [];}}
function persistCases(candidate){localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));$('#candidateNavCount').textContent=app.cases.length;if(REMOTE_BACKEND&&candidate)saveRemote(`/api/candidates/${candidate.id}`,candidate);}
function persistJobs(job){localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));if(REMOTE_BACKEND&&job)saveRemote(`/api/jobs/${job.id}`,job);}
function parseKeywords(value=''){return [...new Set(value.split(/[、,，;；\n]/).map(v=>v.trim()).filter(Boolean))];}
function seedJobs(){if(app.jobs.length)return;const job={id:crypto.randomUUID(),industry:'金融',name:'场外期权产品经理',jd:'负责场外期权RFQ、交易簿记和生命周期管理产品规划，推动交易、风控和研发团队协作上线。',keywords:['场外期权','RFQ','交易簿记','生命周期管理'],rules:'重点核实个人职责、项目上线结果、业务规模和团队分工。',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};app.jobs=[job];persistJobs(job);}
function resumeHint(item){return item.resumeMeta?.experienceYears?`${item.resumeMeta.experienceYears}年经验`:item.resumeMeta?.fileName||'简历已录入';}
function formatDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':`${date.getMonth()+1}月${date.getDate()}日`;}
function byUpdated(a,b){return new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt);}
function infoLabel(key){return({currentCompanyRole:'当前公司及职位',location:'当前地点',currentSalary:'当前薪资',expectedSalary:'期望薪资',availability:'到岗时间',motivation:'求职动机',nonCompete:'竞业限制'}[key]||key);}
function readField(text,label){return text.match(new RegExp(`${label}[：:为是]?([^，。；;\\n]{2,24})`))?.[1]?.trim()||'待确认';}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));}
function apiUrl(path){return `${API_BASE}${path}`;}
async function saveRemote(path,payload){try{const response=await authenticatedFetch(apiUrl(path),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw new Error('远端保存失败');}catch(error){console.error(error);toast('已保存在本机，CloudBase同步失败');}}
async function hydrateState(){if(!REMOTE_BACKEND)return;try{const response=await authenticatedFetch(apiUrl('/api/state'));if(!response.ok)throw new Error('CloudBase数据读取失败');const remote=await response.json();if((remote.jobs||[]).length||(remote.cases||[]).length){app.jobs=remote.jobs||[];app.cases=remote.cases||[];localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));return;}for(const job of app.jobs)await saveRemote(`/api/jobs/${job.id}`,job);for(const candidate of app.cases)await saveRemote(`/api/candidates/${candidate.id}`,candidate);}catch(error){console.error(error);toast('CloudBase暂不可用，已使用本机数据');}}
async function checkService(){if(STATIC_DEMO){$('#serviceStatus').innerHTML='<i></i>在线演示';return;}try{const response=await authenticatedFetch(apiUrl('/api/health'));const data=await response.json();if(!response.ok)throw new Error(data.error||'服务离线');$('#serviceStatus').innerHTML=`<i></i>${data.mode==='ai'?'DeepSeek AI · CloudBase':'CloudBase演示模式'}`;}catch{$('#serviceStatus').textContent='服务离线';}}
async function authenticatedFetch(url, options = {}) { const { data, error } = await cloudbaseAuth.getSession(); const token = data?.session?.access_token; if (error || !token) { $('#loginScreen').classList.remove('hidden'); throw new Error('登录已过期，请重新登录'); } const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${token}`); return fetch(url, { ...options, headers }); }
let toastTimer;function toast(message){const element=$('#toast');element.textContent=message;element.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>element.classList.remove('show'),2600);}
