import cloudbase from 'https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@latest/+esm';

const CASES_KEY = 'acecall-cases-v1';
const JOBS_KEY = 'acecall-jobs-v1';
const RULES_KEY = 'acecall-team-rules-v1';
const API_BASE = String(window.ACECALL_CONFIG?.apiBaseUrl || '').replace(/\/$/, '');
const REMOTE_BACKEND = Boolean(API_BASE);
const STATIC_DEMO = (location.protocol === 'file:' || location.hostname.endsWith('.github.io')) && !REMOTE_BACKEND;
const FORCE_MIGRATION = new URLSearchParams(location.search).has('migrate');
const CLOUD_CONFIG = window.ACECALL_CONFIG?.cloudbase || {};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const app = { cases: readStore(CASES_KEY), jobs: readStore(JOBS_KEY), view: 'dashboard', candidateId: null, detailTab: 'overview', resumeMeta: null, resumeFile: null, workspace: null };
app.dashboardFilter = '';
let cloudbaseAuth = null;
let cloudbaseClient = null;
const importFileCache = new Map();
const importedFileKeys = new Set(readStore('acecall-import-files-v1'));
let teamRules = readStore(RULES_KEY);
let folderWatchTimer = null;
let watchedDirectory = null;
let folderWatchStartedAt = null;
let folderWatchPolicy = null;
let folderWatchBaselineKeys = new Set();
let folderWatchSeenKeys = new Set();
let inboxQueueFilter = '';
const fileStability = new Map();
const FOLDER_SCAN_INTERVAL_MS = 300000;
let pendingTeamRule = '';
let recordingDraft = { candidateId: null, file: null, url: '', source: '' };

document.addEventListener('DOMContentLoaded', async () => {
  if (!await initializeAuth()) return;
  bindShell();
  await hydrateWorkspace();
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
  $('#applyJobRuleLibrary').addEventListener('click', applySelectedTeamRule);
  $('#saveJobRuleLibrary').addEventListener('click', saveCurrentRuleToLibrary);
}

async function initializeAuth() {
  $('#loginForm').addEventListener('submit', signIn);
  if (!REMOTE_BACKEND) { $('#loginScreen').classList.add('hidden'); return true; }
  if (!CLOUD_CONFIG.env || !CLOUD_CONFIG.publishableKey) {
    showLoginMessage('CloudBase登录配置不完整');
    return false;
  }
  cloudbaseClient = cloudbase.init({ env: CLOUD_CONFIG.env, region: CLOUD_CONFIG.region, accessKey: CLOUD_CONFIG.publishableKey });
  cloudbaseAuth = cloudbaseClient.auth({ persistence: 'local' });
  const { data, error } = await cloudbaseAuth.getSession();
  if (error) {
    await cloudbaseAuth.signOut().catch(() => {});
    showLoginMessage('登录状态已重置，请重新输入账号密码', false);
    return false;
  }
  if (!data?.session) return false;
  $('#loginScreen').classList.add('hidden');
  return true;
}

async function signIn(event) {
  event.preventDefault();
  const button = $('#loginButton');
  button.disabled = true; button.textContent = '正在登录'; showLoginMessage('正在验证账号', false);
  try {
    let result = await cloudbaseAuth.signInWithPassword({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value });
    if (result.error && /refresh token/i.test(result.error.message || '')) {
      await cloudbaseAuth.signOut().catch(() => {});
      result = await cloudbaseAuth.signInWithPassword({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value });
    }
    const { data, error } = result;
    if (error || !data?.session) throw new Error(error?.message || '账号或密码错误');
    $('#loginScreen').classList.add('hidden');
    await hydrateWorkspace();
    await hydrateState();
    seedJobs();
    await checkService();
    navigate(location.hash.replace('#', '') || 'dashboard');
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
  const activeJobs = app.jobs.filter(job => job.status !== 'closed');
  const total = app.cases.length;
  const pendingCall = app.cases.filter(item => statusOf(item) === '待电话').length;
  const pendingReview = app.cases.filter(item => statusOf(item) === '待确认').length;
  const assignmentReview = app.cases.filter(needsAssignmentReview).length;
  const recommended = app.cases.filter(item => finalAction(item) === '推荐业务面试').length;
  const highMatch = app.cases.filter(item => scoreValue(item) >= 80).length;
  const structures = talentStructure(app.cases);
  const actionRows = [...app.cases].filter(item => ['待分析', '待电话', '待确认'].includes(statusOf(item)) || scoreValue(item) >= 80).sort((a,b) => scoreValue(b) - scoreValue(a) || byUpdated(a,b)).slice(0, 8);
  $('#dashboardView').innerHTML = `<div class="page dashboard-page">
    <div class="page-title dashboard-title"><div><span class="eyebrow">RECRUITING CONTROL ROOM</span><h1>招聘工作台</h1><p>从岗位推进到人才结构，集中查看今天最值得处理的招聘动作。</p></div><div class="dashboard-actions"><select id="dashboardJobFilter"><option value="">全部活跃岗位</option>${activeJobs.map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}</select><button class="primary" data-add-candidate>＋ 添加候选人</button></div></div>
    <div class="dashboard-strip"><div class="dashboard-strip-label"><span>当前招聘面</span><b>${activeJobs.length} 个岗位</b></div><div class="dashboard-strip-note">统计范围：全部候选人，包含已淘汰与待处理人选 · 标签来源：简历事实 / AI识别 / 人工确认</div><button class="link-action" data-dashboard-refresh>刷新视图 ↻</button></div>
    <div class="metrics dashboard-metrics"><button class="metric metric-action" data-dashboard-filter="all"><b>${total}</b><span>候选人总数</span><small>全量人才池</small></button><button class="metric metric-action" data-dashboard-filter="high"><b>${highMatch}</b><span>高匹配候选人</span><small>匹配度 80 分以上</small></button><button class="metric metric-action" data-dashboard-filter="call"><b>${pendingCall}</b><span>待电话沟通</span><small>需要推进</small></button><button class="metric metric-action" data-dashboard-filter="assignment-review"><b>${assignmentReview}</b><span>待确认简历</span><small>岗位分配需人工确认</small></button><button class="metric metric-action" data-dashboard-filter="review"><b>${pendingReview}</b><span>待审核结果</span><small>需要确认</small></button><div class="metric"><b>${recommended}</b><span>已推荐业务面试</span><small>已完成动作</small></div></div>
    <div class="dashboard-layout"><div class="dashboard-main"><section class="surface progress-surface"><div class="surface-head"><div><h2>岗位推进</h2><p class="surface-subtitle">按岗位查看候选人在哪个环节停留</p></div><span>${activeJobs.length} 个活跃岗位</span></div><div class="surface-body job-progress-list">${activeJobs.length ? activeJobs.map(jobProgressRow).join('') : '<div class="empty">还没有活跃岗位，请先建立岗位标准。</div>'}</div></section><section class="surface action-surface"><div class="surface-head"><div><h2>优先处理</h2><p class="surface-subtitle">高匹配、待沟通和待审核候选人</p></div><button class="link-action" data-dashboard-filter="all">查看全部 →</button></div>${candidateTable(actionRows, '')}</section></div><aside class="dashboard-aside"><section class="surface structure-surface"><div class="surface-head"><div><h2>人才池结构</h2><p class="surface-subtitle">基于全部候选人统计</p></div><span>AI识别</span></div><div class="surface-body"><div class="structure-block"><div class="structure-heading"><strong>直接竞品经历</strong><span>${structures.competitor.known}/${total || 0} 人</span></div>${structureBar(structures.competitor, '竞品公司') }<p class="structure-note">按岗位 JD 与候选人最近 1-2 段经历识别</p></div><div class="structure-block"><div class="structure-heading"><strong>大厂经历</strong><span>${structures.major.known}/${total || 0} 人</span></div>${structureBar(structures.major, '行业前 5') }<p class="structure-note">同业务行业内按规模、业务体量和市场排名识别</p></div><div class="structure-block"><div class="structure-heading"><strong>学校层次</strong><span>${structures.school.known}/${total || 0} 人</span></div>${structureBar(structures.school, '985/211/双一流') }<p class="structure-note">优先读取简历教育经历，无法确认则保留未知</p></div><button class="structure-link" data-dashboard-filter="competitor">查看结构命中候选人 →</button></div></section><section class="surface funnel-surface"><div class="surface-head"><div><h2>招聘漏斗</h2><p class="surface-subtitle">全部岗位累计</p></div></div><div class="surface-body"><div class="funnel-row"><span>简历已导入</span><b>${total}</b></div><div class="funnel-row"><span>已完成解析</span><b>${app.cases.filter(item => item.resume).length}</b></div><div class="funnel-row"><span>已完成沟通</span><b>${app.cases.filter(item => item.communicationSummary || item.report).length}</b></div><div class="funnel-row"><span>已推荐面试</span><b>${recommended}</b></div></div></section></aside></div></div>`;
  bindCommonActions($('#dashboardView'));
  $('#dashboardJobFilter').addEventListener('change', filterDashboardJob);
  $$('#dashboardView [data-dashboard-filter-job]').forEach(button => button.addEventListener('click', () => { app.dashboardFilter = 'job'; navigate('candidates'); requestAnimationFrame(() => { $('#candidateJobFilter').value = button.dataset.dashboardFilterJob; filterCandidates(); }); }));
  $$('#dashboardView [data-dashboard-filter]').forEach(button => button.addEventListener('click', () => openDashboardFilter(button.dataset.dashboardFilter)));
  $('#dashboardView [data-dashboard-refresh]').addEventListener('click', () => { renderDashboard(); toast('工作台数据已刷新'); });
}

function filterDashboardJob(event) {
  const jobId = event.target.value;
  $$('#dashboardView .job-progress-row').forEach(row => { row.hidden = Boolean(jobId && row.dataset.jobId !== jobId); });
}

function openDashboardFilter(filter) {
  app.dashboardFilter = filter;
  navigate('candidates');
  requestAnimationFrame(() => {
    const input = $('#candidateSearch'); const status = $('#candidateStatusFilter'); const job = $('#candidateJobFilter');
    if (filter === 'call') status.value = '待电话';
    else if (filter === 'review') status.value = '待确认';
    else if (filter === 'assignment-review') input.value = '待确认岗位';
    else if (filter === 'high') input.value = '高匹配度';
    else if (filter === 'competitor') input.value = '竞品经历';
    filterCandidates();
    if (filter === 'all') { input.value = ''; status.value = ''; job.value = ''; filterCandidates(); }
  });
}

function jobProgressRow(job) {
  const items = app.cases.filter(item => item.jobId === job.id);
  const stages = [['新增', items.length], ['已解析', items.filter(item => item.resume).length], ['待沟通', items.filter(item => ['待电话', '待分析'].includes(statusOf(item))).length], ['已沟通', items.filter(item => item.communicationSummary || item.report).length], ['已推荐', items.filter(item => finalAction(item) === '推荐业务面试').length]];
  const topScore = items.length ? Math.max(...items.map(scoreValue)) : 0;
  return `<div class="job-progress-row" data-job-id="${job.id}"><div class="job-progress-head"><div><strong>${escapeHtml(job.name)}</strong><span>${escapeHtml(job.industry || '其他')} · ${items.length} 位候选人</span></div><div class="job-progress-meta"><b>${topScore}分</b><small>最高匹配</small></div></div><div class="stage-track">${stages.map((stage,index) => `<div class="stage-item ${index === 0 ? 'active' : ''}"><b>${stage[1]}</b><span>${stage[0]}</span></div>`).join('')}</div><div class="job-progress-foot"><span>高匹配 ${items.filter(item => scoreValue(item) >= 80).length} 人</span><span>待审核 ${items.filter(item => statusOf(item) === '待确认').length} 人</span><button class="link-action" data-dashboard-filter-job="${job.id}">查看岗位候选人 →</button></div></div>`;
}

function talentStructure(items) {
  const total = items.length;
  const profile = items.map(item => inferTalentProfile(item));
  const tally = values => ({ known: values.filter(Boolean).length, hit: values.filter(value => value === true).length, unknown: values.filter(value => value === null).length, total });
  return { competitor: tally(profile.map(item => item.competitor)), major: tally(profile.map(item => item.major)), school: tally(profile.map(item => item.school)) };
}

function structureBar(value, label) {
  const known = value.known ? Math.round(value.hit / value.known * 100) : 0;
  const unknown = value.total ? Math.round(value.unknown / value.total * 100) : 0;
  const filter = label === '竞品公司' ? 'competitor' : label === '行业前 5' ? 'major' : 'school';
  return `<div class="structure-bar"><button class="bar-hit" style="width:${known}%" data-dashboard-filter="${filter}" title="${label} ${value.hit} 人">${known}%</button><button class="bar-unknown" style="width:${unknown}%" data-dashboard-filter="all" title="未知 ${value.unknown} 人">${unknown ? `${unknown}%` : ''}</button></div><div class="structure-legend"><span><i class="legend-hit"></i>已识别 ${value.hit} 人</span><span><i class="legend-unknown"></i>未知 ${value.unknown} 人</span></div>`;
}

function inferTalentProfile(item) {
  const stored = item.talentProfile || item.resumeMeta?.talentProfile || {};
  const text = `${item.resume || ''} ${item.roleName || ''}`;
  const job = app.jobs.find(candidateJob => candidateJob.id === item.jobId) || {};
  const competitorCompanies = [...new Set([...(stored.competitorCompanies || []), ...text.match(/中信证券|华泰证券|国泰君安|海通证券|招商证券|中金公司|广发证券|申万宏源|银河证券/g) || []])];
  const financeCompanyHit = competitorCompanies.length > 0;
  const majorCompanyHit = /(腾讯|阿里巴巴|字节跳动|百度|美团|京东|蚂蚁集团|拼多多)/i.test(text);
  const schoolHit = /(清华大学|北京大学|复旦大学|上海交通大学|浙江大学|中国人民大学|南京大学|武汉大学|华中科技大学|西安交通大学|中山大学|哈尔滨工业大学|北京航空航天大学|同济大学|四川大学|南开大学|天津大学|厦门大学|东南大学)/.test(text);
  const sameFinanceIndustry = /金融|证券|券商|衍生品|交易/.test(`${job.industry || ''} ${job.name || item.roleName || ''}`);
  const competitor = typeof stored.competitor === 'boolean' ? stored.competitor : (stored.companyTags?.includes?.('direct_competitor') ? true : (financeCompanyHit && sameFinanceIndustry ? true : null));
  const major = typeof stored.major === 'boolean' ? stored.major : (stored.companyTags?.includes?.('internet_major') ? true : (majorCompanyHit ? true : null));
  const school = typeof stored.school === 'boolean' ? stored.school : (stored.schoolTags?.some?.(tag => ['985', '211', 'double_first_class', 'target_school'].includes(tag)) ? true : (schoolHit ? true : null));
  return { competitor, competitorCompanies, major, school };
}

function renderInboxLegacy() {
  const pending = app.cases.filter(item => item.ingestStatus === '解析中').length;
  const needsAssignment = app.cases.filter(item => item.matching?.status === '待分配').length;
  const policy = getPlatformPolicy();
  const watchStatus = folderWatchTimer ? '监听中' : '未启动';
  const watchLabel = policy.defaultMode === 'downloads' ? '选择 Downloads 并开始监听' : '选择文件夹并开始监听';
  $('#inboxView').innerHTML = `<div class="page"><div class="page-title"><div><h1>简历中心</h1><p>直接导入简历，系统会自动解析、匹配岗位并建立候选人档案。</p></div><div class="import-actions"><label class="primary upload-trigger"><span class="button-icon" aria-hidden="true">+</span><span>批量导入简历</span><input id="batchResumeInput" type="file" accept=".pdf,.doc,.docx,.txt,.md,.rtf" multiple hidden></label><label class="secondary upload-trigger"><span class="button-icon" aria-hidden="true">&#8943;</span><span>本次选择文件夹</span><input id="folderResumeInput" type="file" webkitdirectory directory multiple hidden></label></div></div><div class="metrics"><div class="metric"><b>${app.cases.length}</b><span>已建立档案</span></div><div class="metric"><b>${pending}</b><span>处理中</span></div><div class="metric"><b>${needsAssignment}</b><span>待分配岗位</span></div></div><div class="surface watch-panel"><div class="surface-head"><h2>页面文件监听</h2><span>${watchStatus}</span></div><div class="surface-body"><div class="watch-facts"><span>当前设备：<b>${policy.label}</b></span><span>扫描周期：<b>每 5 分钟</b></span><span>处理范围：<b>仅监听开始后新增文件</b></span></div><p class="muted-text">${policy.platform === 'mac' ? 'Mac 浏览器无法直接读取 Downloads 路径，请在系统选择器中授权 Downloads 文件夹。' : 'Windows 请选择需要持续读取的授权文件夹。'} 支持 PDF、DOC、DOCX、TXT、MD、RTF；页面关闭后监听会停止。</p><button class="secondary" id="watchFolderButton" type="button"><span class="button-icon" aria-hidden="true">${folderWatchTimer ? '&#9632;' : '&#9654;'}</span><span>${folderWatchTimer ? '停止页面监听' : watchLabel}</span></button>${folderWatchStartedAt ? `<small class="watch-started">监听开始：${formatDate(folderWatchStartedAt)}</small>` : ''}</div></div><div class="surface desktop-agent-panel"><div class="surface-head"><h2>桌面同步助手</h2><span>推荐</span></div><div class="surface-body"><p class="muted-text">下载本地助手后，可在页面关闭时继续监听 Mac Downloads 或 Windows 授权文件夹，并自动将新增简历同步到 AceCall。</p><div class="desktop-agent-actions"><a class="primary" href="downloads/AceCall-Sync-Mac.zip" download><span class="button-icon" aria-hidden="true">&#8595;</span><span>下载 Mac 助手</span></a><a class="secondary" href="downloads/AceCall-Sync-Windows.zip" download><span class="button-icon" aria-hidden="true">&#8595;</span><span>下载 Windows 助手</span></a></div><small class="watch-started">当前为运行包，首次使用需 Node.js 18+；免安装桌面版正在开发。</small></div></div><div class="surface"><div class="surface-head"><h2>导入说明</h2><span>自动筛选疑似简历</span></div><div class="surface-body"><p class="muted-text">系统会跳过临时下载文件、空文件和不具备简历特征的文档；无法判断的文件不会删除，可通过批量导入或手动粘贴处理。</p></div></div><div class="surface" style="margin-top:13px"><div class="surface-head"><h2>最近导入</h2><span>${app.cases.length} 位候选人</span></div><div class="table-wrap"><table><thead><tr><th>候选人</th><th>自动分配岗位</th><th>匹配度</th><th>解析状态</th><th>下一步</th></tr></thead><tbody>${app.cases.slice(0,12).map(item => `<tr><td><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.resumeMeta?.fileName || '文本录入')}</small></td><td>${escapeHtml(item.roleName || '待分配')}</td><td>${scoreLabel(item)}</td><td>${escapeHtml(item.ingestStatus || '已入库')}${item.ingestStatus?.startsWith('解析失败') && importFileCache.has(item.ingestFileKey) ? ` <button class="link-action" data-retry-import="${item.id}">重试</button>` : ''}</td><td><button class="link-action" data-open-candidate="${item.id}">查看 →</button></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">还没有导入简历</div></td></tr>'}</tbody></table></div></div></div>`;
  $('#batchResumeInput').addEventListener('change', event => importResumeBatch(event.target.files));
  $('#folderResumeInput').addEventListener('change', event => importResumeBatch(event.target.files));
  $('#watchFolderButton').addEventListener('click', startFolderWatch);
  bindCommonActions($('#inboxView'));
  $$('#inboxView [data-retry-import]').forEach(button => button.addEventListener('click', () => retryImport(button.dataset.retryImport)));
}

function renderInbox() {
  const pending = app.cases.filter(item => item.ingestStatus === '解析中').length;
  const needsAssignment = app.cases.filter(item => !item.jobId || item.matching?.status === '待分配').length;
  const failed = app.cases.filter(item => String(item.ingestStatus || '').startsWith('解析失败')).length;
  const duplicate = app.cases.filter(item => item.ingestStatus === '重复待确认').length;
  const batches = [...new Set(app.cases.map(item => item.ingestBatchId).filter(Boolean))].slice(0, 5);
  const policy = getPlatformPolicy();
  const watchStatus = folderWatchTimer ? '监听中' : '未启动';
  const watchLabel = policy.defaultMode === 'downloads' ? '选择 Downloads 并开始监听' : '选择文件夹并开始监听';
  const filterCases = inboxQueueFilter ? app.cases.filter(item => inboxQueueFilterMatches(item, inboxQueueFilter)) : app.cases;
  const queue = [...filterCases].sort(byUpdated).slice(0, inboxQueueFilter ? filterCases.length : 30);
  const filterLabel = { all: '全部简历', processing: '解析中', assignment: '待岗位确认', duplicate: '重复待确认', failed: '解析异常' }[inboxQueueFilter] || '';
  $('#inboxView').innerHTML = `<div class="page resume-center-page"><div class="page-title"><div><span class="eyebrow">INGESTION & QUALITY</span><h1>简历中心</h1><p>管理文件进入 AceCall 的导入、解析、岗位分配和异常处理。</p></div><div class="import-actions"><label class="primary upload-trigger"><span class="button-icon" aria-hidden="true">+</span><span>批量导入简历</span><input id="batchResumeInput" type="file" accept=".pdf,.doc,.docx,.txt,.md,.rtf" multiple hidden></label><label class="secondary upload-trigger"><span class="button-icon" aria-hidden="true">&#8943;</span><span>选择文件夹</span><input id="folderResumeInput" type="file" webkitdirectory directory multiple hidden></label></div></div><div class="ingest-kpis"><button class="metric metric-action ${!inboxQueueFilter ? 'active' : ''}" data-inbox-filter="all" type="button"><b>${app.cases.length}</b><span>已建立档案</span><small>进入候选人池</small></button><button class="metric metric-action ${inboxQueueFilter === 'processing' ? 'active' : ''}" data-inbox-filter="processing" type="button"><b>${pending}</b><span>解析中</span><small>正在处理</small></button><button class="metric metric-action ${inboxQueueFilter === 'assignment' ? 'active' : ''}" data-inbox-filter="assignment" type="button"><b>${needsAssignment}</b><span>待岗位确认</span><small>无法高置信分配</small></button><button class="metric metric-action ${inboxQueueFilter === 'duplicate' ? 'active' : ''}" data-inbox-filter="duplicate" type="button"><b>${duplicate}</b><span>重复待确认</span><small>需要合并或更新</small></button><button class="metric metric-action ${inboxQueueFilter === 'failed' ? 'active' : ''}" data-inbox-filter="failed" type="button"><b>${failed}</b><span>解析异常</span><small>支持重试</small></button></div><div class="ingest-layout"><div class="ingest-main"><section class="surface ingest-queue"><div class="surface-head"><div><h2>文件处理队列</h2><p class="surface-subtitle">${filterLabel ? `当前筛选：${filterLabel}` : '这里处理文件，不在此管理电话和审核流程'}</p></div><span>${queue.length} 条记录</span></div><div class="table-wrap"><table><thead><tr><th>文件 / 候选人</th><th>岗位分配</th><th>解析质量</th><th>重复检查</th><th>来源</th><th>操作</th></tr></thead><tbody>${queue.map(resumeQueueRow).join('') || '<tr><td colspan="6"><div class="empty">当前状态下没有简历</div></td></tr>'}</tbody></table></div></section></div><aside class="ingest-aside"><section class="surface watch-panel"><div class="surface-head"><div><h2>文件来源</h2><p class="surface-subtitle">本机文件持续进入队列</p></div><span>${watchStatus}</span></div><div class="surface-body"><div class="watch-facts"><span>设备：<b>${policy.label}</b></span><span>扫描：<b>每 5 分钟</b></span></div><p class="muted-text">${policy.platform === 'mac' ? 'Mac 默认监听 Downloads，需在系统选择器中授权。' : 'Windows 请选择授权文件夹。'} 只处理监听启动后新增的简历文件。</p><button class="secondary" id="watchFolderButton" type="button"><span class="button-icon" aria-hidden="true">${folderWatchTimer ? '&#9632;' : '&#9654;'}</span><span>${folderWatchTimer ? '停止页面监听' : watchLabel}</span></button></div></section><section class="surface batch-surface"><div class="surface-head"><div><h2>导入批次</h2><p class="surface-subtitle">最近批次处理结果</p></div><span>${batches.length} 个</span></div><div class="surface-body">${batches.map(id => { const items = app.cases.filter(item => item.ingestBatchId === id); return `<div class="batch-row"><span>${formatDate(items[0]?.createdAt)} · ${items.length} 份</span><b>${items.filter(item => item.ingestStatus === '已入库').length} 成功</b></div>`; }).join('') || '<div class="empty">导入后显示批次结果</div>'}</div></section><section class="surface desktop-agent-panel"><div class="surface-head"><div><h2>桌面同步助手</h2><p class="surface-subtitle">页面关闭后继续监听</p></div><span>推荐</span></div><div class="surface-body"><p class="muted-text">支持 Mac Downloads 和 Windows 授权文件夹，新增文件会进入同一处理队列。</p><div class="desktop-agent-actions"><a class="primary" href="downloads/AceCall-Sync-Mac.zip" download>下载 Mac 助手</a><a class="secondary" href="downloads/AceCall-Sync-Windows.zip" download>下载 Windows 助手</a></div></div></section></aside></div></div>`;
  $('#batchResumeInput').addEventListener('change', event => importResumeBatch(event.target.files, { source: 'manual' }));
  $('#folderResumeInput').addEventListener('change', event => importResumeBatch(event.target.files, { source: 'folder' }));
  $('#watchFolderButton').addEventListener('click', startFolderWatch);
  $$('#inboxView [data-inbox-filter]').forEach(button => button.addEventListener('click', () => {
    inboxQueueFilter = button.dataset.inboxFilter === 'all' ? '' : button.dataset.inboxFilter;
    renderInbox();
    $('#inboxView .ingest-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  bindCommonActions($('#inboxView'));
  $$('#inboxView [data-retry-import]').forEach(button => button.addEventListener('click', () => retryImport(button.dataset.retryImport)));
}

function inboxQueueFilterMatches(item, filter) {
  if (filter === 'processing') return item.ingestStatus === '解析中';
  if (filter === 'assignment') return !item.jobId || item.matching?.status === '待分配';
  if (filter === 'duplicate') return item.ingestStatus === '重复待确认';
  if (filter === 'failed') return String(item.ingestStatus || '').startsWith('解析失败');
  return true;
}

function resumeQueueRow(item) {
  const meta = item.resumeMeta || {};
  const quality = resumeQuality(item);
  const duplicateLabel = item.ingestStatus === '重复待确认' ? '<span class="status warn">疑似重复</span>' : '<span class="status">未发现</span>';
  const action = item.ingestStatus?.startsWith('解析失败') && importFileCache.has(item.ingestFileKey) ? `<button class="link-action" data-retry-import="${item.id}">重试</button>` : `<button class="link-action" data-open-candidate="${item.id}">查看 →</button>`;
  return `<tr><td><strong>${escapeHtml(meta.fileName || '文本录入')}</strong><small>${escapeHtml(item.candidateName || '姓名待确认')}</small></td><td>${escapeHtml(item.roleName || '待分配')} ${item.matching?.status === '待分配' ? '<span class="status warn">需确认</span>' : ''}</td><td><span class="quality quality-${quality.level}">${quality.label}</span><small>${quality.missing ? `缺少：${escapeHtml(quality.missing)}` : '基础字段完整'}</small></td><td>${duplicateLabel}</td><td>${escapeHtml(item.ingestSource === 'folder-watch' ? '文件夹监听' : item.ingestSource === 'folder' ? '文件夹导入' : '手动导入')}</td><td>${action}</td></tr>`;
}

function resumeQuality(item) {
  const meta = item.resumeMeta || {};
  const missing = [['姓名', item.candidateName || meta.candidateName], ['手机', meta.phone], ['邮箱', meta.email], ['工作经历', meta.experienceYears || item.resume]].filter(([, value]) => !value).map(([label]) => label);
  if (String(item.ingestStatus || '').startsWith('解析失败')) return { level: 'error', label: '需人工处理', missing: '文本解析失败' };
  if (missing.length >= 2) return { level: 'warn', label: '部分完整', missing: missing.join('、') };
  return { level: 'good', label: '完整', missing: '' };
}

async function startFolderWatch() {
  if (folderWatchTimer) { clearInterval(folderWatchTimer); folderWatchTimer = null; watchedDirectory = null; folderWatchStartedAt = null; folderWatchPolicy = null; folderWatchBaselineKeys = new Set(); folderWatchSeenKeys = new Set(); fileStability.clear(); renderInbox(); toast('已停止页面监听'); return; }
  if (!window.showDirectoryPicker) return toast('当前浏览器不支持持续文件夹监听，请使用“授权文件夹”导入');
  try {
    folderWatchPolicy = getPlatformPolicy();
    watchedDirectory = await window.showDirectoryPicker({ mode: 'read' });
    folderWatchStartedAt = Date.now(); folderWatchBaselineKeys = new Set(); folderWatchSeenKeys = new Set(); fileStability.clear();
    await scanWatchedDirectory(true);
    folderWatchTimer = setInterval(() => scanWatchedDirectory(false), FOLDER_SCAN_INTERVAL_MS);
    renderInbox(); toast(`已启动${folderWatchPolicy.label}监听，每 5 分钟检查一次新增简历`);
  } catch (error) { if (error.name !== 'AbortError') toast('文件夹授权失败，请重新选择'); }
}

async function scanWatchedDirectory(isBaseline = false) {
  if (!watchedDirectory) return;
  const files = [];
  for await (const entry of watchedDirectory.values()) {
    if (entry.kind !== 'file' || !isSupportedResumeFileName(entry.name)) continue;
    const file = await entry.getFile(); const key = fileKeyFor(file);
    if (isBaseline) { folderWatchBaselineKeys.add(key); folderWatchSeenKeys.add(key); continue; }
    if (folderWatchBaselineKeys.has(key) || folderWatchSeenKeys.has(key)) continue;
    if (!isFileStable(file)) continue;
    folderWatchSeenKeys.add(key); files.push(file);
  }
  if (files.length) await importResumeBatch(files, { source: 'folder-watch' });
}

async function retryImport(id) {
  const candidate = app.cases.find(item => item.id === id); const file = importFileCache.get(candidate?.ingestFileKey);
  if (!candidate || !file) return toast('原文件已不在当前会话，请重新选择文件');
  candidate.ingestStatus = '解析中'; renderCurrent();
  try { const result = await parseResumeFileForImport(file); candidate.resume = result.text; candidate.resumeMeta = result.metadata; candidate.candidateName = result.metadata.candidateName || candidate.candidateName; applyJobMatch(candidate, await matchResumeToJobs(candidate.resume, candidate.candidateName)); candidate.ingestStatus = '已入库'; persistCases(candidate); renderCurrent(); toast('简历已重试成功'); } catch (error) { candidate.ingestStatus = `解析失败：${error.message}`; persistCases(candidate); renderCurrent(); toast(error.message); }
}

function renderCandidatesLegacy() {
  $('#candidatesView').innerHTML = `<div class="page"><div class="page-title"><div><h1>候选人</h1><p>按下一步动作管理简历、电话初筛和推荐结果。</p></div><button class="primary" data-add-candidate>＋ 添加候选人</button></div><div class="toolbar"><input id="candidateSearch" placeholder="搜索姓名、公司或岗位"><select id="candidateJobFilter"><option value="">全部岗位</option>${app.jobs.map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}</select><select id="candidateStatusFilter"><option value="">全部状态</option>${['待分析','待电话','待确认','推荐面试','补充沟通','暂不推进'].map(value => `<option>${value}</option>`).join('')}</select></div><div id="candidateTableSlot">${candidateTable(app.cases, '全部候选人')}</div></div>`;
  bindCommonActions($('#candidatesView'));
  ['candidateSearch', 'candidateJobFilter', 'candidateStatusFilter'].forEach(id => $(`#${id}`).addEventListener('input', filterCandidates));
}

function renderCandidates() {
  const counts = ['全部', '待分析', '待电话', '待确认', '推荐面试', '补充沟通', '已完成', '暂不推进'].map(status => ({ status, count: status === '全部' ? app.cases.length : app.cases.filter(item => displayStatus(item) === status).length }));
  $('#candidatesView').innerHTML = `<div class="page candidates-page"><div class="page-title"><div><span class="eyebrow">TALENT PIPELINE</span><h1>候选人</h1><p>管理已进入招聘流程的人才，不再处理原始文件导入。</p></div><button class="primary" data-add-candidate>＋ 手动添加候选人</button></div><div class="candidate-stages">${counts.map(item => `<button class="candidate-stage ${item.status === '全部' ? 'active' : ''}" data-stage-filter="${item.status}"><b>${item.count}</b><span>${item.status}</span></button>`).join('')}</div><div class="toolbar candidate-toolbar"><input id="candidateSearch" placeholder="搜索姓名、公司、学校或岗位"><select id="candidateJobFilter"><option value="">全部岗位</option>${app.jobs.map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}</select><select id="candidateStatusFilter"><option value="">全部阶段</option>${['待分析','待电话','待确认','推荐面试','补充沟通','已完成','暂不推进'].map(value => `<option>${value}</option>`).join('')}</select><select id="candidateTagFilter"><option value="">全部标签</option><option value="competitor">直接竞品</option><option value="major">行业前 5</option><option value="school">985/211/双一流</option><option value="quality">资料待补全</option><option value="moka">Moka待配置</option></select></div><div class="candidate-summary-line"><span>当前显示 <b id="candidateResultCount">${app.cases.length}</b> 人</span><span>统计包含已淘汰候选人 · 标签依据可在详情查看</span></div><div id="candidateTableSlot">${candidatePoolTable(app.cases)}</div></div>`;
  bindCommonActions($('#candidatesView'));
  ['candidateSearch', 'candidateJobFilter', 'candidateStatusFilter', 'candidateTagFilter'].forEach(id => $(`#${id}`).addEventListener('input', filterCandidates));
  $$('#candidatesView [data-stage-filter]').forEach(button => button.addEventListener('click', () => { $('#candidateStatusFilter').value = button.dataset.stageFilter === '全部' ? '' : button.dataset.stageFilter; $$('#candidatesView [data-stage-filter]').forEach(item => item.classList.toggle('active', item === button)); filterCandidates(); }));
}

function candidatePoolTable(items) {
  return `<div class="surface"><div class="table-wrap"><table><thead><tr><th>候选人</th><th>岗位</th><th>匹配度</th><th>人才标签</th><th>当前阶段</th><th>资料 / Moka</th><th>下一步</th></tr></thead><tbody>${items.map(item => { const tags = candidateTags(item); const quality = resumeQuality(item); return `<tr><td><strong>${escapeHtml(item.candidateName || '姓名待确认')}</strong><small>${escapeHtml(item.resumeMeta?.fileName || '文本录入')}</small></td><td>${escapeHtml(item.roleName || '待分配')}</td><td>${scoreLabel(item)}</td><td><div class="candidate-tags">${tags.map(tag => `<span class="mini-tag ${tag.tone}">${escapeHtml(tag.label)}</span>`).join('') || '<span class="muted-text">待识别</span>'}</div></td><td><span class="status ${statusClass(displayStatus(item))}">${displayStatus(item)}</span><small>${formatDate(item.updatedAt || item.createdAt)}</small></td><td><span class="quality quality-${quality.level}">${quality.label}</span><small class="moka-placeholder">${mokaStatusLabel(item)}</small></td><td><button class="link-action" data-open-candidate="${item.id}">${nextAction(item)} →</button></td></tr>`; }).join('') || '<tr><td colspan="7"><div class="empty">没有符合条件的候选人</div></td></tr>'}</tbody></table></div></div>`;
}

function candidateTags(item) {
  const profile = inferTalentProfile(item); const tags = [];
  if (profile.competitor === true) tags.push({ label: profile.competitorCompanies?.length ? `竞品·${profile.competitorCompanies[0]}` : '竞品', tone: 'tag-positive' });
  if (profile.major === true) tags.push({ label: '行业前5', tone: 'tag-accent' });
  if (profile.school === true) tags.push({ label: '985/211/双一流', tone: 'tag-neutral' });
  if (item.talentProfile?.function) tags.push({ label: item.talentProfile.function, tone: 'tag-neutral' });
  return tags.slice(0, 3);
}

function mokaStatusLabel(item) { return item.mokaSync?.status ? `Moka：${item.mokaSync.status}` : 'Moka：接口待配置'; }

function filterCandidates() {
  const search = $('#candidateSearch').value.trim().toLowerCase();
  const jobId = $('#candidateJobFilter').value;
  const status = $('#candidateStatusFilter').value;
  const tag = $('#candidateTagFilter')?.value || '';
  const dashboardMatch = item => {
    if (app.dashboardFilter === 'high') return scoreValue(item) >= 80;
    if (app.dashboardFilter === 'assignment-review') return needsAssignmentReview(item);
    if (app.dashboardFilter === 'competitor') return inferTalentProfile(item).competitor === true;
    if (app.dashboardFilter === 'major') return inferTalentProfile(item).major === true;
    if (app.dashboardFilter === 'school') return inferTalentProfile(item).school === true;
    return true;
  };
  const tagMatch = item => { const profile = inferTalentProfile(item); if (tag === 'competitor') return profile.competitor === true; if (tag === 'major') return profile.major === true; if (tag === 'school') return profile.school === true; if (tag === 'quality') return resumeQuality(item).level !== 'good'; if (tag === 'moka') return !item.mokaSync?.status || item.mokaSync.status !== '已同步'; return true; };
  const filtered = app.cases.filter(item => dashboardMatch(item) && tagMatch(item) && (!search || `${item.candidateName} ${item.roleName} ${item.resume} ${item.resumeMeta?.fileName || ''} ${(inferTalentProfile(item).competitorCompanies || []).join(' ') } ${needsAssignmentReview(item) ? '待确认岗位' : ''}`.toLowerCase().includes(search)) && (!jobId || item.jobId === jobId) && (!status || displayStatus(item) === status));
  $('#candidateResultCount').textContent = filtered.length;
  $('#candidateTableSlot').innerHTML = candidatePoolTable(filtered);
  bindCommonActions($('#candidateTableSlot'));
}

function candidateTable(items, title) {
  return `<div class="surface"><div class="surface-head"><h2>${title}</h2><span>${items.length} 位候选人</span></div><div class="table-wrap"><table><thead><tr><th>候选人</th><th>应聘岗位</th><th>负责人</th><th>初筛状态</th><th>更新时间</th><th>匹配度</th><th>下一步</th></tr></thead><tbody>${items.map(item => `<tr><td><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${resumeHint(item)}</small></td><td>${escapeHtml(item.roleName || '待分配')}</td><td>Rick</td><td><span class="status ${statusClass(displayStatus(item))}">${displayStatus(item)}</span></td><td>${formatDate(item.updatedAt || item.createdAt)}</td><td>${scoreLabel(item)}</td><td><button class="link-action" data-open-candidate="${item.id}">${nextAction(item)} →</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderJobs() {
  $('#jobsView').innerHTML = `<div class="page"><div class="page-title"><div><h1>岗位</h1><p>一次维护 JD、关键词和初筛规则，后续候选人自动复用。</p></div><button class="primary" data-add-job>＋ 新建岗位</button></div><div class="toolbar"><input id="jobSearch" placeholder="搜索岗位名称、行业或关键词"><select id="jobIndustryFilter"><option value="">全部行业</option>${[...new Set(app.jobs.map(job => job.industry).filter(Boolean))].map(value => `<option>${escapeHtml(value)}</option>`).join('')}</select><select id="jobStatusFilter"><option value="active">在招岗位</option><option value="closed">已关闭岗位</option><option value="">全部岗位</option></select></div><div class="job-grid" id="jobGrid">${jobCards(app.jobs.filter(job => job.status !== 'closed'))}</div></div>`;
  bindCommonActions($('#jobsView'));
  $('#jobSearch').addEventListener('input', filterJobs); $('#jobIndustryFilter').addEventListener('input', filterJobs); $('#jobStatusFilter').addEventListener('change', filterJobs);
  const library = document.createElement('div'); library.className = 'surface rules-library'; library.innerHTML = `<div class="surface-head"><h2>团队规则库</h2><span>共享给团队成员</span></div><div class="surface-body"><div class="rule-add"><input id="teamRuleInput" placeholder="添加常用核验规则"><button class="secondary" id="addTeamRule" type="button">添加规则</button></div><div class="rule-list">${teamRules.map((rule, index) => `<button class="rule-chip" data-use-rule="${index}" type="button">＋ ${escapeHtml(rule)}</button>`).join('') || '<span class="muted-text">还没有共享规则</span>'}</div></div>`; $('#jobsView .page').append(library);
  $('#addTeamRule').addEventListener('click', addTeamRule); $$('#jobsView [data-use-rule]').forEach(button => button.addEventListener('click', () => useTeamRule(Number(button.dataset.useRule))));
}

function addTeamRule() { const value = $('#teamRuleInput').value.trim(); if (!value) return toast('请输入规则内容'); if (!teamRules.includes(value)) { teamRules.push(value); const rule = { id: crypto.randomUUID(), content: value, version: 1, createdAt: new Date().toISOString() }; if (REMOTE_BACKEND) saveRemote(`/api/rules/${rule.id}`, rule); } localStorage.setItem(RULES_KEY, JSON.stringify(teamRules)); renderJobs(); toast('规则已加入团队库'); }
function useTeamRule(index) { const value = teamRules[index]; if (!value) return; pendingTeamRule = value; openJobDialog(); }

function jobCards(jobs) {
  if (!jobs.length) return '<div class="surface empty">暂无岗位，请先建立岗位标准。</div>';
  return jobs.map(job => { const count = app.cases.filter(item => item.jobId === job.id).length; const closed = job.status === 'closed'; return `<article class="job-item ${closed ? 'job-closed' : ''}"><header><div><h2>${escapeHtml(job.name)} <span class="job-status ${closed ? 'closed' : 'active'}">${closed ? '已关闭' : '在招'}</span></h2><p>${escapeHtml(job.industry || '其他')} · ${closed ? '保留历史记录' : '可接收新候选人'}</p></div><div class="job-actions"><button class="link-action" data-edit-job="${job.id}">编辑</button><button class="link-action" data-toggle-job="${job.id}">${closed ? '重新开启' : '关闭岗位'}</button></div></header><div class="keywords">${(job.keywords || []).slice(0,6).map(word => `<span>${escapeHtml(word)}</span>`).join('') || '<span>待设置关键词</span>'}</div><div class="job-meta"><span>${count} 位候选人</span><span>${app.cases.filter(item => item.jobId === job.id && statusOf(item) === '待电话').length} 位待初筛</span><span>更新于 ${formatDate(job.updatedAt)}</span></div></article>`; }).join('');
}

function filterJobs() {
  const query = $('#jobSearch').value.trim().toLowerCase(); const industry = $('#jobIndustryFilter').value; const status = $('#jobStatusFilter').value;
  const filtered = app.jobs.filter(job => (!industry || job.industry === industry) && (!status || (job.status === 'closed' ? 'closed' : 'active') === status) && (!query || `${job.name} ${job.industry} ${(job.keywords || []).join(' ')}`.toLowerCase().includes(query)));
  $('#jobGrid').innerHTML = jobCards(filtered); bindCommonActions($('#jobGrid')); bindJobActions($('#jobGrid'));
}

function bindJobActions(root) { root.querySelectorAll('[data-toggle-job]').forEach(button => button.addEventListener('click', () => toggleJobStatus(button.dataset.toggleJob))); }
async function toggleJobStatus(id) {
  const job = app.jobs.find(item => item.id === id); if (!job) return;
  const closing = job.status !== 'closed';
  if (closing && !window.confirm(`关闭“${job.name}”？历史候选人会保留，但新简历不会再自动分配到此岗位。`)) return;
  job.status = closing ? 'closed' : 'active'; job.updatedAt = new Date().toISOString(); persistJobs(job); renderJobs(); toast(closing ? '岗位已关闭，历史数据已保留' : '岗位已重新开启');
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
  if (app.detailTab === 'overview') body.innerHTML = talentProfilePanel(item) + overviewTab(item);
  if (app.detailTab === 'call') body.innerHTML = callTab(item);
  if (app.detailTab === 'resume') body.innerHTML = resumeTab(item);
  if (app.detailTab === 'history') body.innerHTML = historyTab(item);
  bindDetailActions(body);
}

function talentProfilePanel(item) {
  const profile = inferTalentProfile(item); const quality = resumeQuality(item); const text = item.resume || '';
  const evidence = [];
  if (profile.competitor === true) evidence.push('从最近经历识别到证券同业公司，结合岗位行业判断为直接竞品');
  if (profile.major === true) evidence.push('从简历经历识别到行业头部公司名称');
  if (profile.school === true) evidence.push('从教育经历识别到 985/211/双一流学校');
  return `<section class="surface talent-profile-panel"><div class="surface-head"><div><h2>人才画像</h2><p class="surface-subtitle">优先归类最近 1-2 段经历，标签可追溯</p></div><span>AI识别 · 允许人工修正</span></div><div class="surface-body"><div class="profile-grid"><div class="profile-fact"><span>公司层级</span><div>${profile.competitor === true ? '<b class="profile-chip positive">直接竞品</b>' : '<b class="profile-chip muted">待确认</b>'}${profile.major === true ? '<b class="profile-chip accent">行业前 5</b>' : ''}</div></div><div class="profile-fact"><span>学校层级</span><div>${profile.school === true ? '<b class="profile-chip neutral">985/211/双一流</b>' : '<b class="profile-chip muted">待确认</b>'}</div></div><div class="profile-fact"><span>资料质量</span><div><b class="quality quality-${quality.level}">${quality.label}</b>${quality.missing ? `<small>缺少：${escapeHtml(quality.missing)}</small>` : ''}</div></div><div class="profile-fact"><span>Moka状态</span><div><b class="profile-chip muted">${escapeHtml(mokaStatusLabel(item))}</b></div></div></div><div class="profile-evidence"><strong>识别依据</strong><span>${escapeHtml(evidence.join('；') || '暂未识别到可确认的公司或学校标签，未知信息不会强行归类。')}</span></div></div></section>`;
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
  const draft = recordingDraft.candidateId === item.id ? recordingDraft : null;
  const recordingLabel = draft?.file ? `${draft.file.name} · ${formatBytes(draft.file.size)}` : item.callRecording?.fileName || '尚未添加录音';
  return `<div class="call-grid"><div class="surface"><div class="surface-head"><h2>本次核验问题</h2><span>${questions.length} 项</span></div><div class="surface-body">${questions.length ? questions.map((question,index) => `<label class="question"><input type="checkbox" data-question="${index}"><span><b>${escapeHtml(question.question || question)}</b><small>${escapeHtml(question.reason || question.source || '初筛必问项')}</small></span></label>`).join('') : '<div class="empty">请先生成电话准备</div>'}</div></div><div class="surface"><div class="surface-head"><h2>电话记录</h2><span>保存原始事实</span></div><div class="surface-body"><div class="recording-tools"><div class="recording-actions"><button class="secondary" type="button" id="startRecording">开始录音</button><button class="secondary" type="button" id="stopRecording" disabled>停止录音</button><label class="secondary upload-trigger"><span>上传录音</span><input id="callAudioInput" type="file" accept="audio/*" hidden></label></div><small id="recordingStatus" class="muted-text">${escapeHtml(recordingLabel)}。录音前请先向候选人告知并取得同意。</small><audio id="callAudioPreview" controls class="audio-preview" ${draft?.url ? '' : 'hidden'} src="${draft?.url || ''}"></audio></div><textarea class="call-notes" id="callTranscript" placeholder="粘贴电话转写，或按原意记录候选人回答…">${escapeHtml(item.transcript || '')}</textarea><small class="muted-text">当前版本支持录音归档和人工粘贴转写；接入语音识别服务后可自动填充此处。</small></div></div></div><div class="call-footer"><label style="display:flex;align-items:center;gap:7px"><input type="checkbox" id="consentConfirmed" ${item.consentConfirmed ? 'checked' : ''}> 已完成录音或转写告知</label><button class="primary" data-complete-call>完成电话并生成结果</button></div>`;
}

function resultTab(item) {
  const report = item.report || {}; const info = report.basicInfo || {};
  return `<div class="decision"><span class="tag">待人工确认</span><small>AI综合建议</small><h2>${escapeHtml(report.conclusion || '信息不足')}</h2><p>${escapeHtml(report.conclusionReason || '')}</p></div><div class="grid-2" style="margin-top:13px"><div class="surface"><div class="surface-head"><h2>结论依据</h2><span>${(report.capabilities || []).length} 项</span></div><div class="surface-body">${(report.capabilities || []).map(point => `<div class="evidence"><span class="tag">${escapeHtml(point.assessment || '待确认')}</span><strong>${escapeHtml(point.item || point)}</strong><p>${escapeHtml(point.evidence || '')}</p></div>`).join('') || '<div class="empty">暂无能力判断</div>'}${(report.risks || []).map(risk => `<div class="point risk"><strong>${escapeHtml(risk)}</strong></div>`).join('')}</div></div><div><div class="surface"><div class="surface-head"><h2>基础条件</h2></div><div class="surface-body">${Object.entries(info).map(([key,value]) => `<div class="fact"><span>${escapeHtml(infoLabel(key))}</span><b>${escapeHtml(value)}</b></div>`).join('') || '<div class="empty">待确认</div>'}</div></div><div class="review"><label>最终动作<select id="finalDecision">${['推荐业务面试','补充电话沟通','转入其他岗位','暂不推进','纳入人才库长期维护'].map(value => `<option ${value === (report.finalDecision || report.nextStep) ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label style="margin-top:10px">推荐理由<textarea id="recommendationReason" placeholder="AI根据简历与沟通事实生成，可人工修订">${escapeHtml(report.recommendationReason || '')}</textarea></label><label style="margin-top:10px">审核备注<textarea id="reviewNotes" placeholder="补充事实或后续安排">${escapeHtml(report.reviewNotes || '')}</textarea></label><label class="review-check"><input type="checkbox" id="reviewConfirmed" ${report.reviewConfirmed ? 'checked' : ''}> 我已核对材料并确认最终动作</label><button class="primary" style="width:100%" data-confirm-result>确认完成</button></div></div></div>`;
}

function resumeTab(item) { const meta=item.resumeMeta||{}; const original = meta.originalFileId; const preview = meta.originalTempUrl; const originalView = original ? (meta.originalMimeType === 'application/pdf' && preview ? `<div class="resume-original"><iframe title="原始PDF简历" src="${escapeHtml(preview)}"></iframe></div>` : `<div class="resume-original resume-original-file"><p>Word 原文件已保存，可按原格式打开查看。</p><button class="secondary" data-resume-download type="button">打开 / 下载原简历</button></div>`) : ''; return `<div class="surface"><div class="surface-head"><div><h2>候选人简历</h2><p class="surface-subtitle">${original ? '原始文件优先，解析文本用于搜索和AI分析' : '文本录入'}</p></div><span>${escapeHtml(meta.fileName || '文本录入')}</span></div><div class="surface-body"><div class="resume-basics"><div class="fact"><span>姓名</span><b>${escapeHtml(item.candidateName||'待确认')}</b></div><div class="fact"><span>年龄</span><b>${escapeHtml(meta.age?`${meta.age}岁`:'待确认')}</b></div><div class="fact"><span>手机</span><b>${escapeHtml(meta.phone||'待确认')}</b></div><div class="fact"><span>邮箱</span><b>${escapeHtml(meta.email||'待确认')}</b></div><div class="fact"><span>工作年限</span><b>${escapeHtml(meta.experienceYears?`${meta.experienceYears}年`:'待确认')}</b></div><div class="fact"><span>学历</span><b>${escapeHtml(meta.education||'待确认')}</b></div></div>${originalView}<details class="resume-text-fallback" ${original ? '' : 'open'}><summary>查看解析文本</summary><pre>${escapeHtml(item.resume || '暂无简历内容')}</pre></details></div></div>`; }
function historyTab(item) { const events = [['建立候选人档案',item.createdAt],item.preparation&&['AI完成电话准备',item.createdAt],item.communicationSummary&&['生成沟通总结',item.updatedAt],item.report&&['生成综合初筛结果',item.updatedAt],item.report?.reviewConfirmed&&['招聘人员确认结果',item.updatedAt]].filter(Boolean); return `<div class="surface"><div class="surface-head"><h2>处理记录</h2><span>保留人工与AI操作痕迹</span></div><div class="surface-body">${events.map(event => `<div class="fact"><span>${formatDate(event[1])}</span><b>${event[0]}</b></div>`).join('')}</div></div>`; }

function renderSettings() {
  const workspace = app.workspace || {}; const current = workspace.currentMember || {}; const members = workspace.members || [];
  $('#settingsView').innerHTML = `<div class="page"><div class="page-title"><div><span class="eyebrow">WORKSPACE ADMIN</span><h1>设置</h1><p>公司工作区、团队成员和服务配置。</p></div></div><div class="settings-grid"><div class="surface"><div class="surface-head"><h2>当前公司工作区</h2><span>${escapeHtml(current.role || '成员')}</span></div><div class="surface-body"><div class="setting-row"><span>公司名称</span><b>${escapeHtml(workspace.workspace?.name || '未设置')}</b></div><div class="setting-row"><span>工作区 ID</span><b>${escapeHtml(workspace.workspace?.id || workspace.workspace?.tenantId || '—')}</b></div><div class="setting-row"><span>当前账号</span><b>${escapeHtml(current.displayName || current.username || current.uid || '—')}</b></div><div class="setting-row"><span>成员数量</span><b>${members.length} 人</b></div><p style="font-size:10px;color:var(--muted);line-height:1.6">同一公司主体下的岗位、候选人、规则和工作台统计共享；不同公司使用独立租户数据空间，互不可见。</p></div></div><div class="surface"><div class="surface-head"><h2>团队成员</h2><span>共享工作区</span></div><div class="surface-body">${members.length ? members.map(member => `<div class="setting-row"><span><b>${escapeHtml(member.displayName || member.username || '未命名')}</b><small style="display:block;color:var(--muted)">${escapeHtml(member.uid || '')}</small></span><b>${escapeHtml(member.role || 'recruiter')}</b></div>`).join('') : '<div class="empty">暂无成员信息</div>'}<p style="font-size:10px;color:var(--muted);line-height:1.6">成员邀请和角色管理将在管理后台开放；当前阶段先展示工作区共享状态。</p></div></div><div class="surface"><div class="surface-head"><h2>AI与数据服务</h2><span>${STATIC_DEMO ? '演示模式' : REMOTE_BACKEND ? 'CloudBase模式' : '本地服务模式'}</span></div><div class="surface-body"><div class="setting-row"><span>AI服务</span><b>DeepSeek API</b></div><div class="setting-row"><span>数据存储</span><b>${REMOTE_BACKEND ? 'CloudBase文档数据库' : '浏览器本地存储'}</b></div><p style="font-size:10px;color:var(--muted);line-height:1.6">API Key仅保存在服务端环境变量中，不会写入浏览器。</p></div></div><div class="surface"><div class="surface-head"><h2>人工决策边界</h2></div><div class="surface-body"><div class="setting-row"><span>自动淘汰候选人</span><b>关闭</b></div><div class="setting-row"><span>敏感属性评分</span><b>禁止</b></div><div class="setting-row"><span>结果人工确认</span><b>必须</b></div></div></div></div></div>`;
  if (['owner', 'admin'].includes(current.role)) {
    $('#settingsView .settings-grid').insertAdjacentHTML('beforeend', '<div class="surface"><div class="surface-head"><h2>邀请团队成员</h2><span>管理员操作</span></div><div class="surface-body"><div class="toolbar"><input id="inviteMemberUid" placeholder="员工 UID"><select id="inviteMemberRole"><option value="recruiter">招聘人员</option><option value="admin">管理员</option><option value="viewer">只读成员</option></select><button class="primary" id="inviteMemberButton" type="button">邀请</button></div><small style="color:var(--muted)">员工首次登录后会自动加入当前公司工作区。</small></div></div>');
    $('#inviteMemberButton').addEventListener('click', inviteMember);
  }
}

async function inviteMember() {
  const uid = $('#inviteMemberUid').value.trim();
  if (!uid) return toast('请输入员工 UID');
  try {
    const response = await authenticatedFetch(apiUrl('/api/members/invite'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid, role: $('#inviteMemberRole').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '邀请失败');
    await hydrateWorkspace(); renderSettings(); toast('成员邀请已创建');
  } catch (error) { toast(error.message || '邀请失败'); }
}

function bindCommonActions(root) {
  root.querySelectorAll('[data-add-candidate]').forEach(button => button.addEventListener('click', openCandidateDialog));
  root.querySelectorAll('[data-open-candidate]').forEach(button => button.addEventListener('click', () => openCandidate(button.dataset.openCandidate)));
  root.querySelectorAll('[data-add-job]').forEach(button => button.addEventListener('click', () => openJobDialog()));
  root.querySelectorAll('[data-edit-job]').forEach(button => button.addEventListener('click', () => openJobDialog(button.dataset.editJob)));
  bindJobActions(root);
  root.querySelectorAll('[data-back-candidates]').forEach(button => button.addEventListener('click', () => navigate('candidates')));
  root.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => { app.detailTab = button.dataset.detailTab; renderCandidateDetail(); }));
}

function bindDetailActions(root) {
  bindCommonActions(root);
  root.querySelector('[data-generate-prep]')?.addEventListener('click', () => generatePreparation(currentCandidate()));
  root.querySelector('[data-complete-call]')?.addEventListener('click', completeCall);
  root.querySelector('[data-confirm-result]')?.addEventListener('click', confirmResult);
  root.querySelector('#callAudioInput')?.addEventListener('change', event => setRecordingFile(event.target.files?.[0]));
  root.querySelector('#startRecording')?.addEventListener('click', startBrowserRecording);
  root.querySelector('#stopRecording')?.addEventListener('click', stopBrowserRecording);
  root.querySelector('[data-resume-download]')?.addEventListener('click', async () => { const item = currentCandidate(); const url = item?.resumeMeta?.originalTempUrl || await resolveResumePreview(item); if (url) window.open(url, '_blank', 'noopener'); else toast('原始简历链接暂不可用'); });
  if (app.detailTab === 'resume' && currentCandidate()?.resumeMeta?.originalFileId && !currentCandidate()?.resumeMeta?.originalTempUrl) resolveResumePreview(currentCandidate()).then(url => { if (url) { currentCandidate().resumeMeta.originalTempUrl = url; renderCandidateDetail(); } }).catch(error => console.warn('resume preview unavailable', error));
}

function openCandidateDialog() {
  if (!app.jobs.some(job => job.status !== 'closed')) return toast('请先创建一个在招岗位');
  $('#candidateForm').reset(); app.resumeMeta = null; app.resumeFile = null; $('#resumeStatus').className = 'file-status hidden';
  $('#candidateJobInput').innerHTML = `<option value="">自动匹配岗位</option>${app.jobs.filter(job => job.status !== 'closed').map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}`;
  $('#candidateDialog').showModal();
}

async function createCandidate(event) {
  event.preventDefault(); const selectedJob = app.jobs.find(item => item.id === $('#candidateJobInput').value); const candidate = { id: crypto.randomUUID(), jobId: selectedJob?.id || '', candidateName: $('#candidateNameInput').value.trim(), roleName: selectedJob?.name || '', jd: selectedJob?.jd || '', rules: selectedJob?.rules || '', keywords: selectedJob?.keywords || [], resume: $('#candidateResumeInput').value.trim(), resumeMeta: app.resumeMeta, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!candidate.candidateName || !candidate.resume) return toast('请填写候选人姓名和简历');
  if (!selectedJob) { const match = await matchResumeToJobs(candidate.resume, candidate.candidateName); applyJobMatch(candidate, match); }
  if (app.resumeFile) candidate.resumeMeta = await persistOriginalResume(candidate.id, app.resumeFile, candidate.resumeMeta || {});
  app.cases.unshift(candidate); persistCases(candidate); $('#candidateDialog').close(); app.candidateId = candidate.id; app.detailTab = 'overview'; navigate('candidate');
  await generatePreparation(candidate);
}

async function importResumeBatch(files, options = {}) {
  const selected = [...(files || [])].filter(file => isSupportedResumeFile(file));
  if (!selected.length) return;
  if (!app.jobs.length) return toast('请先创建至少一个岗位');
  const batchId = options.batchId || crypto.randomUUID();
  let queued = 0;
  for (const file of selected) {
    const fileKey = fileKeyFor(file);
    if (importedFileKeys.has(fileKey)) continue;
    importedFileKeys.add(fileKey); importFileCache.set(fileKey, file); queued += 1;
    const candidate = { id: crypto.randomUUID(), candidateName: '', roleName: '', jobId: '', jd: '', rules: '', keywords: [], resume: '', resumeMeta: null, ingestStatus: '解析中', ingestBatchId: batchId, ingestSource: options.source || 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    app.cases.unshift(candidate); renderCurrent();
    try {
      const result = await parseResumeFileForImport(file);
      if (!looksLikeResume(result.text)) throw new Error('文件内容不像简历，已跳过，请确认文件后重试');
      candidate.resume = result.text; candidate.resumeMeta = await persistOriginalResume(candidate.id, file, result.metadata); candidate.candidateName = result.metadata.candidateName || file.name.replace(/\.[^.]+$/, '');
      const sameContact = app.cases.find(item => item.id !== candidate.id && ((result.metadata.phone && item.resumeMeta?.phone === result.metadata.phone) || (result.metadata.email && item.resumeMeta?.email && item.resumeMeta.email.toLowerCase() === result.metadata.email.toLowerCase())));
      const match = await matchResumeToJobs(candidate.resume, candidate.candidateName);
      applyJobMatch(candidate, match); candidate.ingestStatus = sameContact ? '重复待确认' : '已入库'; candidate.duplicateOf = sameContact?.id || ''; candidate.updatedAt = new Date().toISOString(); persistCases(candidate);
    } catch (error) { candidate.ingestStatus = `解析失败：${error.message}`; candidate.ingestFileKey = fileKey; candidate.updatedAt = new Date().toISOString(); persistCases(candidate); }
    renderCurrent();
  }
  localStorage.setItem('acecall-import-files-v1', JSON.stringify([...importedFileKeys]));
  toast(queued ? `已处理 ${queued} 份简历${queued < selected.length ? '，重复文件已跳过' : ''}` : '所选文件已导入过，未重复创建');
}

function getPlatformPolicy() {
  const userAgent = navigator.userAgent || '';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return { platform: 'mac', label: 'Mac', defaultMode: 'downloads', scanIntervalMs: FOLDER_SCAN_INTERVAL_MS };
  if (/Windows/i.test(userAgent)) return { platform: 'windows', label: 'Windows', defaultMode: 'directory', scanIntervalMs: FOLDER_SCAN_INTERVAL_MS };
  return { platform: 'other', label: '其他设备', defaultMode: 'manual', scanIntervalMs: FOLDER_SCAN_INTERVAL_MS };
}

function isSupportedResumeFileName(name = '') {
  return /\.(pdf|docx?|txt|md|rtf)$/i.test(name) && !/\.(crdownload|part|tmp|download)$/i.test(name);
}

function isSupportedResumeFile(file) {
  return Boolean(file && isSupportedResumeFileName(file.name) && Number(file.size || 0) > 1024);
}

function fileKeyFor(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function isFileStable(file) {
  const key = fileKeyFor(file); const now = Date.now(); const previous = fileStability.get(key);
  if (!previous || previous.size !== file.size) { fileStability.set(key, { size: file.size, seenAt: now }); return false; }
  return now - previous.seenAt >= 10000;
}

function looksLikeResume(text = '') {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length < 20) return false;
  const signals = ['简历', '个人信息', '工作经历', '教育经历', '项目经历', '任职', '工作经验', '学历', '邮箱', '手机', '电话', 'resume', 'experience', 'education'];
  return signals.filter(signal => normalized.toLowerCase().includes(signal.toLowerCase())).length >= 2;
}

async function parseResumeFileForImport(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (STATIC_DEMO && ['txt', 'md'].includes(extension)) return { text: await file.text(), metadata: { fileName: file.name, extension: extension.toUpperCase(), characters: file.size } };
  const response = await authenticatedFetch(apiUrl(`/api/parse-resume?name=${encodeURIComponent(file.name)}`), { method: 'POST', body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '简历解析失败'); data.metadata = { ...(data.metadata || {}), originalFile: file }; return data;
}

async function matchResumeToJobs(resume, candidateName = '') {
  const response = await generate({ action: 'match', candidateName, resume, jobs: app.jobs.filter(job => job.status !== 'closed').map(job => ({ id: job.id, name: job.name, industry: job.industry, jd: job.jd, keywords: job.keywords, rules: job.rules })) });
  return response;
}

function applyJobMatch(candidate, match) {
  const primary = app.jobs.find(job => job.id === match?.jobId);
  const score = normalizedMatchScore(match, candidate.resume, primary || {});
  const secondScore = Number(match?.alternativeJobs?.[0]?.score || 0);
  const ambiguous = !primary || match?.status === '待分配' || score < 60 || (secondScore > 0 && score - secondScore < 8) || match?.confidence === '低';
  if (primary && !ambiguous) {
    candidate.jobId = primary.id; candidate.roleName = primary.name; candidate.jd = primary.jd; candidate.rules = primary.rules || ''; candidate.keywords = primary.keywords || [];
  } else {
    candidate.jobId = ''; candidate.roleName = ''; candidate.jd = ''; candidate.rules = ''; candidate.keywords = [];
  }
  candidate.matching = { ...match, jobId: candidate.jobId, suggestedJobId: primary?.id || match?.jobId || '', score, status: ambiguous ? '待分配' : '已分配', assignmentReview: ambiguous, assignmentReviewReason: ambiguous ? (!primary ? '没有可靠的主岗位匹配' : secondScore && score - secondScore < 8 ? `前两名岗位仅相差 ${score - secondScore} 分` : score < 60 ? `最高匹配度仅 ${score} 分` : '匹配置信度较低') : '' };
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
    if (recordingDraft.candidateId === candidate.id && recordingDraft.file) candidate.callRecording = await uploadCallRecording(candidate, recordingDraft.file);
    candidate.communicationSummary = await generate({ action:'summarize', roleName:candidate.roleName, jd:candidate.jd, resume:candidate.resume, rules:candidate.rules, preparation:candidate.preparation, transcript });
    candidate.report = await generate({ action:'synthesize', roleName:candidate.roleName, jd:candidate.jd, rules:candidate.rules, keywords:candidate.keywords, preparation:candidate.preparation, communicationSummary:candidate.communicationSummary });
    candidate.updatedAt = new Date().toISOString(); persistCases(candidate); renderCandidateDetail(); toast('初筛结果已生成，请人工确认');
  } catch (error) { toast(error.message); button.disabled = false; button.textContent = '完成电话并生成结果'; }
}

let activeRecorder = null;
let activeRecorderChunks = [];
let recorderStopping = false;

function setRecordingFile(file) {
  if (!file) return;
  if (file.size > 50_000_000) return toast('录音文件不能超过 50MB');
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const supportedAudio = ['mp3', 'wav', 'pcm', 'amr', 'm4a', 'webm'];
  if (file.type && !file.type.startsWith('audio/') && !supportedAudio.includes(extension)) return toast('请选择音频文件');
  if (recordingDraft.url) URL.revokeObjectURL(recordingDraft.url);
  recordingDraft = { candidateId: app.candidateId, file, url: URL.createObjectURL(file), source: 'upload' };
  renderCandidateDetail();
  transcribeRecording(file);
}

async function transcribeRecording(file) {
  const status = $('#recordingStatus');
  if (status) status.textContent = `${file.name} · 正在进行语音解析…`;
  const supported = ['mp3', 'wav', 'pcm', 'amr', 'm4a'];
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  let sourceFile = file;
  if (extension === 'webm') {
    try {
      if (status) status.textContent = `${file.name} · 正在转换为百度支持的 WAV…`;
      sourceFile = await convertWebmToWav(file);
    } catch (error) {
      if (status) status.textContent = `${file.name} · 格式转换失败：${error.message}`;
      return toast('WebM 格式转换失败，请上传 MP3、WAV 或 M4A 文件');
    }
  }
  if (sourceFile.size > 10 * 1024 * 1024) {
    if (status) status.textContent = `${file.name} · 文件超过百度短语音 10MB 限制`;
    return toast('录音文件超过 10MB，请压缩或拆分后重试');
  }
  if (extension !== 'webm' && !supported.includes(extension)) {
    if (status) status.textContent = `${file.name} · 录音已添加，百度语音暂不支持 ${extension || '此'} 格式自动转写`;
    return toast('当前录音格式暂不支持自动转写，请上传 MP3、WAV、AMR 或 M4A');
  }
  if (!REMOTE_BACKEND) {
    if (status) status.textContent = `${file.name} · 已添加；在线服务模式下自动转写`;
    return toast('录音已添加，当前本地演示模式不会调用语音服务');
  }
  try {
    const uploadName = sourceFile.name;
    const response = await authenticatedFetch(apiUrl(`/api/transcribe?name=${encodeURIComponent(uploadName)}`), { method: 'POST', headers: { 'Content-Type': sourceFile.type || 'audio/wav' }, body: sourceFile });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '语音解析失败');
    if (recordingDraft.candidateId !== app.candidateId) return;
    const transcript = $('#callTranscript');
    if (transcript && !transcript.value.trim()) transcript.value = result.text;
    if (status) status.textContent = `${file.name} · 已完成语音解析 ${result.characters || result.text.length} 字`;
    toast('录音已自动转写到电话记录');
  } catch (error) {
    if (status) status.textContent = `${file.name} · 自动转写失败：${error.message}`;
    toast(error.message || '自动转写失败，可手动粘贴转写内容');
  }
}

async function convertWebmToWav(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前浏览器不支持音频解码');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const targetRate = 16000;
    const frameCount = Math.max(1, Math.round(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, frameCount, targetRate);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const wav = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(wav);
    const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); }
    return new File([wav], `${file.name.replace(/\.webm$/i, '')}.wav`, { type: 'audio/wav' });
  } finally { await context.close().catch(() => {}); }
}

async function startBrowserRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('当前浏览器不支持录音，请上传录音文件');
  if (activeRecorder && activeRecorder.state !== 'inactive') return toast('当前已经在录音中');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeRecorderChunks = [];
    activeRecorder = new MediaRecorder(stream);
    recorderStopping = false;
    activeRecorder.ondataavailable = event => { if (event.data.size) activeRecorderChunks.push(event.data); };
    activeRecorder.onerror = event => {
      stream.getTracks().forEach(track => track.stop());
      activeRecorder = null; recorderStopping = false;
      const start = $('#startRecording'); const stop = $('#stopRecording');
      if (start) start.disabled = false; if (stop) stop.disabled = true;
      if (stop) stop.textContent = '停止录音';
      if ($('#recordingStatus')) $('#recordingStatus').textContent = '录音异常结束，请重试或上传录音文件。';
      toast(event.error?.message || '录音发生异常，请重试');
    };
    activeRecorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(activeRecorderChunks, { type: activeRecorder.mimeType || 'audio/webm' });
      const extension = blob.type.includes('mp4') || blob.type.includes('m4a') ? 'm4a' : 'webm';
      activeRecorder = null; recorderStopping = false;
      const start = $('#startRecording'); const stop = $('#stopRecording');
      if (start) start.disabled = false; if (stop) stop.disabled = true;
      if ($('#recordingStatus')) $('#recordingStatus').textContent = '录音已停止，正在准备语音解析…';
      if (blob.size) setRecordingFile(new File([blob], `call-${Date.now()}.${extension}`, { type: blob.type }));
      else { if ($('#recordingStatus')) $('#recordingStatus').textContent = '未检测到有效录音内容，请重试。'; toast('未检测到有效录音内容'); }
    };
    activeRecorder.onstart = () => { if ($('#recordingStatus')) $('#recordingStatus').textContent = '正在录音，请在通话结束后点击停止录音。'; };
    activeRecorder.start();
    $('#startRecording').disabled = true; $('#stopRecording').disabled = false; $('#recordingStatus').textContent = '正在录音，请在通话结束后停止录音。';
  } catch (error) { activeRecorder = null; recorderStopping = false; toast(error.name === 'NotAllowedError' ? '浏览器未获得麦克风权限' : `无法开始录音：${error.message || '请重试'}`); }
}

function stopBrowserRecording() {
  if (!activeRecorder || activeRecorder.state === 'inactive') return toast('当前没有正在进行的录音');
  if (recorderStopping) return;
  recorderStopping = true;
  const recorder = activeRecorder;
  const start = $('#startRecording'); const stop = $('#stopRecording');
  if (start) start.disabled = true; if (stop) { stop.disabled = true; stop.textContent = '正在停止…'; }
  if ($('#recordingStatus')) $('#recordingStatus').textContent = '正在停止录音，请稍候…';
  try {
    if (recorder.state === 'recording') recorder.requestData?.();
    recorder.stop();
  } catch (error) {
    recorderStopping = false; activeRecorder = null;
    if (start) start.disabled = false; if (stop) { stop.disabled = true; stop.textContent = '停止录音'; }
    if ($('#recordingStatus')) $('#recordingStatus').textContent = '停止录音失败，请重试。';
    toast(`停止录音失败：${error.message || '请重试'}`);
  }
}

async function uploadCallRecording(candidate, file) {
  const metadata = { fileName: file.name, mimeType: file.type || 'audio/webm', size: file.size, source: recordingDraft.source || 'upload', recordedAt: new Date().toISOString(), status: 'local' };
  if (!REMOTE_BACKEND) return metadata;
  if (!cloudbaseClient?.uploadFile) throw new Error('CloudBase存储未初始化，当前只能保存转写文本');
  const cloudPath = `acecall/call-recordings/${candidate.id}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const result = await cloudbaseClient.uploadFile({ cloudPath, filePath: file });
  return { ...metadata, status: 'uploaded', fileId: result.fileID || result.fileId || '' };
}

function formatBytes(value) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }

function confirmResult() {
  const candidate = currentCandidate(); if (!$('#reviewConfirmed').checked) return toast('请先确认已核对材料');
  candidate.report.finalDecision = $('#finalDecision').value; candidate.report.recommendationReason = $('#recommendationReason').value.trim(); candidate.report.reviewNotes = $('#reviewNotes').value.trim(); candidate.report.reviewConfirmed = true; candidate.updatedAt = new Date().toISOString(); persistCases(candidate); renderCandidateDetail(); toast('初筛结果已确认');
}

function openCandidate(id) { app.candidateId = id; app.detailTab = statusOf(app.cases.find(item => item.id === id)) === '待确认' ? 'call' : 'overview'; navigate('candidate'); }

function openJobDialog(id) {
  const job = app.jobs.find(item => item.id === id); $('#jobForm').reset(); $('#jobDialogTitle').textContent = job ? '编辑岗位' : '新建岗位'; $('#jobIdInput').value = job?.id || ''; $('#jobIndustryInput').value = job?.industry || '金融'; $('#jobNameInput').value = job?.name || ''; $('#jobJdInput').value = job?.jd || ''; $('#jobKeywordsInput').value = (job?.keywords || []).join('、'); $('#jobRulesInput').value = `${job?.rules || ''}${pendingTeamRule ? `${job?.rules ? '\n' : ''}${pendingTeamRule}` : ''}`; pendingTeamRule = ''; populateRuleLibrary(); $('#jobDialog').showModal();
  const keywordLabel = $('#jobKeywordsInput').parentElement; if (!keywordLabel.querySelector('[data-generate-job]')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'link-action'; button.dataset.generateJob = 'keywords'; button.textContent = '自动提取'; keywordLabel.append(button); button.addEventListener('click', () => generateJobProfile('keywords')); }
  const rulesLabel = $('#jobRulesInput').parentElement; if (!rulesLabel.querySelector('[data-generate-job]')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'link-action'; button.dataset.generateJob = 'rules'; button.textContent = '自动生成'; rulesLabel.append(button); button.addEventListener('click', () => generateJobProfile('rules')); }
}

function generateJobProfile(type) {
  const jd = $('#jobJdInput').value.trim(); if (!jd) return toast('请先填写岗位JD');
  if (type === 'keywords') { const terms = extractJobKeywords(jd, $('#jobNameInput').value.trim()); const before = parseKeywords($('#jobKeywordsInput').value); const merged = parseKeywords([...before, ...terms].join('、')); $('#jobKeywordsInput').value = merged.join('、'); toast(terms.length ? `已提取 ${terms.length} 个关键词，可继续手动调整` : '未识别到明确关键词，请补充岗位名称或手动输入'); }
  else { const rules = ['核实候选人个人职责边界与主导程度', '确认核心项目是否上线及可量化结果', '补充业务规模、协作对象和团队分工']; $('#jobRulesInput').value = `${$('#jobRulesInput').value.trim()}${$('#jobRulesInput').value.trim() ? '\n' : ''}${rules.join('\n')}`; toast('初筛规则已生成，可继续手动调整'); }
}

const JOB_KEYWORD_TERMS = ['证券', '基金', '银行', '保险', '互联网', '金融科技', '场外期权', '期权', '期货', '衍生品', '量化', '交易', '询报价', '簿记', '清算', '结算', '风控', '风险管理', '生命周期管理', '产品规划', '产品设计', '用户增长', '运营策略', '客户成功', '市场营销', '数据分析', '机器学习', '深度学习', '推荐系统', '搜索', '广告', '支付', '电商', '供应链', '研发', '软件开发', '架构设计', '接口', '数据库', 'Java', 'Python', 'Go', 'C++', 'React', 'Vue', 'SQL', '团队管理', '项目管理', '招聘', '组织发展'];
function extractJobKeywords(jd = '', roleName = '') {
  const source = `${roleName} ${jd}`; const results = [];
  JOB_KEYWORD_TERMS.forEach(term => { if (source.toLowerCase().includes(term.toLowerCase())) results.push(term); });
  const english = source.match(/\b[A-Za-z][A-Za-z0-9+#.-]{1,24}\b/g) || [];
  english.forEach(term => { if (term.length > 1 && !/^(?:and|or|with|the|for|from|this|that|have|work|team|years?)$/i.test(term)) results.push(term); });
  const phrases = source.match(/[\u4e00-\u9fff]{2,12}(?:系统|平台|产品|项目|业务|模块|管理|运营|分析|开发|设计|策略|流程|模型|算法|架构|接口|能力|经验|交付|方案|服务)/g) || [];
  phrases.forEach(phrase => { if (!/^(负责|具有|具备|能够|参与|推动|协助|完成|相关|岗位|工作|优先|熟悉|了解|以及|并且)/.test(phrase)) results.push(phrase); });
  return parseKeywords(results.join('、')).slice(0, 24);
}

function populateRuleLibrary() { const select = $('#jobRuleLibraryInput'); if (!select) return; select.innerHTML = `<option value="">选择团队规则</option>${teamRules.map((rule, index) => `<option value="${index}">${escapeHtml(rule.slice(0, 48))}</option>`).join('')}`; }
function applySelectedTeamRule() { const index = Number($('#jobRuleLibraryInput').value); const value = teamRules[index]; if (!value) return toast('请先选择共享规则'); const current = $('#jobRulesInput').value.trim(); if (!current.split(/\n+/).includes(value)) $('#jobRulesInput').value = `${current ? `${current}\n` : ''}${value}`; toast('已添加共享规则，可继续调整'); }
function saveCurrentRuleToLibrary() { const value = $('#jobRulesInput').value.trim(); if (!value) return toast('请先填写初筛规则'); const lines = value.split(/\n+/).map(item => item.trim()).filter(Boolean); const added = lines.filter(item => !teamRules.includes(item)); if (!added.length) return toast('规则库中已存在这些规则'); added.forEach(item => { teamRules.push(item); const rule = { id: crypto.randomUUID(), content: item, version: 1, createdAt: new Date().toISOString() }; if (REMOTE_BACKEND) saveRemote(`/api/rules/${rule.id}`, rule); }); localStorage.setItem(RULES_KEY, JSON.stringify(teamRules)); populateRuleLibrary(); renderJobs(); toast(`已共享 ${added.length} 条规则`); }

function saveJob(event) {
  event.preventDefault(); const id = $('#jobIdInput').value || crypto.randomUUID(); const old = app.jobs.find(job => job.id === id); const job = { id, industry:$('#jobIndustryInput').value, name:$('#jobNameInput').value.trim(), jd:$('#jobJdInput').value.trim(), keywords:parseKeywords($('#jobKeywordsInput').value), rules:$('#jobRulesInput').value.trim(), status:old?.status === 'closed' ? 'closed' : 'active', createdAt:old?.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString() }; if (!job.name || !job.jd) return toast('请填写岗位名称和JD'); app.jobs = [job,...app.jobs.filter(item => item.id !== id)]; persistJobs(job); $('#jobDialog').close(); renderJobs(); toast(old ? '岗位已更新' : '岗位已创建');
}

async function parseResume(file) {
  if (!file) return; if (file.size > 10_000_000) return toast('文件不能超过10MB'); const extension = file.name.split('.').pop().toLowerCase(); $('#resumeStatus').className = 'file-status'; $('#resumeStatus').textContent = `正在解析 ${file.name}…`;
  try { let result; if (STATIC_DEMO && ['txt','md'].includes(extension)) { const text = await file.text(); result = { text, metadata:{ fileName:file.name, extension:extension.toUpperCase(), characters:text.length } }; } else if (STATIC_DEMO) throw new Error('在线演示版PDF/DOCX解析需要后端服务'); else { const response = await authenticatedFetch(apiUrl(`/api/parse-resume?name=${encodeURIComponent(file.name)}`), { method:'POST', body:file }); result = await response.json(); if (!response.ok) throw new Error(result.error || '解析失败'); } $('#candidateResumeInput').value = result.text; app.resumeMeta = result.metadata; app.resumeFile = file; if (!$('#candidateNameInput').value && result.metadata.candidateName) $('#candidateNameInput').value = result.metadata.candidateName; $('#resumeStatus').textContent = `${file.name} · 已提取 ${result.metadata.characters || result.text.length} 字`; } catch (error) { $('#resumeStatus').textContent = error.message; toast(error.message); }
}

async function generate(payload) {
  if (STATIC_DEMO) return localGenerate(payload);
  const response = await authenticatedFetch(apiUrl('/api/generate'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'AI服务调用失败'); return data.result;
}

async function persistOriginalResume(candidateId, file, metadata = {}) {
  const clean = { ...metadata }; delete clean.originalFile;
  if (!file || !cloudbaseClient || !REMOTE_BACKEND) return { ...clean, originalFileName: file?.name || clean.fileName, originalMimeType: file?.type || '', originalFileSize: file?.size || 0 };
  const safeName = file.name.replace(/[^\w.-]+/g, '_');
  const result = await cloudbaseClient.uploadFile({ cloudPath: `acecall/resumes/${candidateId}/${Date.now()}-${safeName}`, filePath: file });
  return { ...clean, originalFileId: result.fileID, originalFileName: file.name, originalMimeType: file.type || '', originalFileSize: file.size || 0 };
}

async function resolveResumePreview(item) {
  const fileId = item.resumeMeta?.originalFileId;
  if (!fileId || !cloudbaseClient) return '';
  const result = await cloudbaseClient.getTempFileURL({ fileList: [{ fileID: fileId, maxAge: 1800 }] });
  const tempUrl = result.fileList?.[0]?.tempFileURL || result.fileList?.[0]?.download_url || '';
  if (!tempUrl) return '';
  // CloudBase/COS may mark a stored PDF as an attachment. Loading that URL
  // directly in an iframe makes Chrome download it instead of displaying it.
  // Reading the signed URL into a Blob gives the browser an inline PDF URL and
  // preserves the original document layout without creating another download.
  if (item.resumeMeta?.originalMimeType === 'application/pdf') {
    try {
      const response = await fetch(tempUrl, { credentials: 'omit' });
      if (response.ok) {
        const blob = await response.blob();
        return URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      }
    } catch (error) {
      console.warn('PDF inline preview unavailable, using original URL', error);
    }
  }
  return tempUrl;
}

function localGenerate(payload) {
  if (payload.action === 'match') return localMatch(payload);
  if (payload.action === 'prepare') { const terms = [...new Set([...(payload.keywords || []),'证券','交易','产品','研发','风险','管理'])].filter(term => payload.resume.includes(term)); return { summary:{ headline:`${payload.candidateName}具备与${payload.roleName}相关的经历，核心职责和项目结果需要电话核实。`,experience:'简历信息已完成结构化，具体年限以原始简历为准。',relevantBackground:terms.length ? `相关关键词：${terms.join('、')}` : '相关经验需要电话补充。' }, matches:(terms.length?terms:['相关经验']).map(term=>({requirement:term,evidence:`简历提及“${term}”`,confidence:'中'})), risks:[{risk:'个人职责边界待确认',evidence:'简历描述无法区分参与和主导'},{risk:'项目结果待量化',evidence:'缺少上线效果或业务指标'}], questions:defaultQuestions() }; }
  if (payload.action === 'summarize') { const lines=payload.transcript.split(/[。！？\n]/).map(v=>v.trim()).filter(v=>v.length>8); return { overview:`已识别${lines.length}条候选人陈述。`,confirmed:lines.slice(0,4).map(v=>({item:'候选人陈述',evidence:v})),missing:[{item:'量化业务结果',evidence:'未识别到明确数据'}],contradicted:[],keyFacts:{location:readField(payload.transcript,'地点'),expectedSalary:readField(payload.transcript,'期望薪资'),availability:readField(payload.transcript,'到岗'),nonCompete:readField(payload.transcript,'竞业')},followUps:['补充项目结果和个人职责边界'] }; }
  return { basicInfo:payload.communicationSummary.keyFacts || {}, capabilities:(payload.preparation.matches || []).map(point=>({item:point.requirement,evidence:point.evidence,assessment:'部分匹配'})), risks:(payload.communicationSummary.missing || []).map(point=>point.item), conclusion:'部分匹配', conclusionReason:'候选人具备相关经历，但项目结果与职责边界仍需业务面试进一步验证。', recommendationReason:'候选人具备岗位相关经历，且沟通中体现出一定匹配基础；但项目结果和职责边界仍需业务面试进一步确认。', nextStep:'推荐业务面试', followUps:payload.communicationSummary.followUps || [] };
}

function localMatch(payload) {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const ranked = jobs.map(job => { const terms = findSharedTerms(`${job.name} ${job.jd}`, payload.resume, job.keywords); const required = (job.keywords || []).length; const score = Math.min(99, Math.round((terms.length / Math.max(required, 4)) * 70 + (payload.resume.includes(job.industry || '') ? 15 : 0) + (terms.length ? 10 : 0))); return { job, score, terms }; }).sort((a, b) => b.score - a.score);
  const first = ranked[0]; if (!first) return { status: '待分配', score: 0, confidence: '低', alternativeJobs: [], risks: [{ risk: '岗位库为空', evidence: '暂无可匹配岗位' }] };
  return { jobId: first.job.id, score: first.score, confidence: first.score >= 75 ? '高' : first.score >= 50 ? '中' : '低', status: first.score >= 50 ? '已分配' : '待分配', dimensions: [{ item: '核心关键词', score: first.score, evidence: first.terms.join('、') || '未识别共同关键词' }], alternativeJobs: ranked.slice(1, 3).map(item => ({ name: item.job.name, score: item.score, reason: item.terms.join('、') || '共同信息较少' })), risks: first.score < 50 ? [{ risk: '岗位匹配度较低', evidence: '简历与岗位共同关键词有限' }] : [] };
}

function defaultQuestions(){return [['基本条件','请确认目前地点、期望工作地点、薪资和到岗时间。','确认基础可行性','必问'],['求职动机','为什么在这个时间点考虑新的机会？','判断动机与岗位内容是否一致','必问'],['核心项目','请选择最相关的项目，说明背景、职责和结果。','核实经历真实性','必问'],['职责边界','哪些决策由你直接负责？哪些工作是参与完成？','区分参与和主导','必问'],['项目结果','项目是否上线，有哪些可量化结果？','验证交付质量','必问'],['专业能力','你负责过哪些业务模块，如何与业务和研发协作？','验证岗位专业能力','建议问'],['风险核验','过去几次工作变动的主要原因分别是什么？','识别稳定性风险','风险追问'],['合规','是否存在竞业限制或其他入职约束？','识别入职风险','必问']].map(([category,question,reason,priority])=>({category,question,reason,priority,source:'初筛准备'}));}

function needsAssignmentReview(item) { return Boolean(item.matching?.assignmentReview || !item.jobId || item.matching?.status === '待分配'); }
function statusOf(item) { if (item.report?.reviewConfirmed) return '已完成'; if (item.report || item.communicationSummary) return '待确认'; if (item.preparation) return '待电话'; return '待分析'; }
function displayStatus(item) { if (item.report?.reviewConfirmed) return ({'推荐业务面试':'推荐面试','补充电话沟通':'补充沟通','暂不推进':'暂不推进'}[item.report.finalDecision] || item.report.finalDecision || '已完成'); return statusOf(item); }
function finalAction(item) { return item.report?.finalDecision || item.report?.nextStep || ''; }
function nextAction(item) { const status=statusOf(item); return status==='待分析'?'生成电话准备':status==='待电话'?'开始初筛':status==='待确认'?'查看结果':'查看记录'; }
function nextGuidance(item) { const status=statusOf(item); return status==='待电话'?'按初筛准备中的重点问题完成电话沟通。':status==='待确认'?'核对AI整理的事实与结论，确认最终动作。':'查看完整初筛记录和人工确认结果。'; }
function statusClass(status){return ['待确认','补充沟通'].includes(status)?'warn':['暂不推进','待分析'].includes(status)?'neutral':'';}
function normalizedMatchScore(match = {}, resume = '', job = {}) { const explicit = Number(match.score ?? match.matchScore ?? match.matchingScore ?? match.dimensions?.[0]?.score); if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, Math.round(explicit))); const terms = [...new Set([job.name, ...(job.keywords || [])].filter(Boolean))]; const hits = terms.filter(term => String(resume).toLowerCase().includes(String(term).toLowerCase())).length; return terms.length ? Math.min(100, Math.round((hits / terms.length) * 100)) : 0; }
function scoreValue(item){const value=Number(item.matching?.score);if(Number.isFinite(value))return Math.max(0,Math.min(100,Math.round(value)));const job=app.jobs.find(candidateJob=>candidateJob.id===item.jobId)||{};return normalizedMatchScore({},item.resume,job);}
function scoreLabel(item){const value=scoreValue(item);return value==='—'?'<span class="score muted">—</span>':`<strong class="score">${value}分</strong>`;}
function currentCandidate(){return app.cases.find(item=>item.id===app.candidateId);}
function readStore(key){try{return JSON.parse(localStorage.getItem(key)||'[]');}catch{return [];}}
function persistCases(candidate){localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));$('#candidateNavCount').textContent=app.cases.length;if(REMOTE_BACKEND&&candidate)saveRemote(`/api/candidates/${candidate.id}`,candidate);}
function persistJobs(job){localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));if(REMOTE_BACKEND&&job)saveRemote(`/api/jobs/${job.id}`,job);}
function parseKeywords(value=''){return [...new Set(value.split(/[、,，;；\n]/).map(v=>v.trim()).filter(Boolean))];}
function seedJobs(){if(app.jobs.length)return;const job={id:crypto.randomUUID(),industry:'金融',name:'场外期权产品经理',jd:'负责场外期权RFQ、交易簿记和生命周期管理产品规划，推动交易、风控和研发团队协作上线。',keywords:['场外期权','RFQ','交易簿记','生命周期管理'],rules:'重点核实个人职责、项目上线结果、业务规模和团队分工。',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};app.jobs=[job];persistJobs(job);}
function resumeHint(item){const meta=item.resumeMeta||{};const facts=[meta.age?`${meta.age}岁`:'',meta.experienceYears?`${meta.experienceYears}年经验`:''].filter(Boolean);return facts.join(' · ')||meta.fileName||'简历已录入';}
function formatDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':`${date.getMonth()+1}月${date.getDate()}日`;}
function byUpdated(a,b){return new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt);}
function infoLabel(key){return({currentCompanyRole:'当前公司及职位',location:'当前地点',currentSalary:'当前薪资',expectedSalary:'期望薪资',availability:'到岗时间',motivation:'求职动机',nonCompete:'竞业限制'}[key]||key);}
function readField(text,label){return text.match(new RegExp(`${label}[：:为是]?([^，。；;\\n]{2,24})`))?.[1]?.trim()||'待确认';}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));}
function apiUrl(path){return `${API_BASE}${path}`;}
async function saveRemote(path,payload){try{const response=await authenticatedFetch(apiUrl(path),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json().catch(()=>({}));if(!response.ok){const detail=result.error||({401:'登录已过期，请重新登录',403:'当前账号没有当前工作区的写入权限',404:'CloudBase接口不存在',500:'CloudBase服务内部错误'}[response.status]||`请求失败（${response.status}）`);throw new Error(detail);}return result;}catch(error){console.error(error);toast(`已保存在本机，云端未同步：${error.message||'未知错误'}`);return null;}}
async function hydrateState(){if(!REMOTE_BACKEND)return;try{let response=await authenticatedFetch(apiUrl('/api/state'));if(!response.ok)throw new Error('CloudBase数据读取失败');let remote=await response.json();if((remote.jobs||[]).length||(remote.cases||[]).length||(remote.rules||[]).length){app.jobs=remote.jobs||[];app.cases=remote.cases||[];teamRules=(remote.rules||[]).map(item=>item.content).filter(Boolean);localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));localStorage.setItem(RULES_KEY,JSON.stringify(teamRules));await migrateStoredResumesOnce();response=await authenticatedFetch(apiUrl('/api/state'));if(response.ok){remote=await response.json();app.jobs=remote.jobs||app.jobs;app.cases=remote.cases||app.cases;teamRules=(remote.rules||[]).map(item=>item.content).filter(Boolean);localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));localStorage.setItem(RULES_KEY,JSON.stringify(teamRules));}return;}for(const job of app.jobs)await saveRemote(`/api/jobs/${job.id}`,job);for(const candidate of app.cases)await saveRemote(`/api/candidates/${candidate.id}`,candidate);for(const content of teamRules)await saveRemote(`/api/rules/${crypto.randomUUID()}`,{content,version:1});}catch(error){console.error(error);toast('CloudBase暂不可用，已使用本机数据');}}
async function migrateStoredResumesOnce(){if(!FORCE_MIGRATION&&localStorage.getItem('acecall-resume-migration-v1'))return;try{const response=await authenticatedFetch(apiUrl('/api/migrate-resumes'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('存量简历迁移失败');const result=await response.json();localStorage.setItem('acecall-resume-migration-v1',JSON.stringify({migrated:result.migrated||0,failed:result.failed?.length||0,at:new Date().toISOString()}));if(result.migrated)toast(`已重新整理 ${result.migrated} 份存量简历`);}catch(error){console.error(error);toast('存量简历迁移未完成，请稍后重试');}}
async function checkService(){if(STATIC_DEMO){$('#serviceStatus').innerHTML='<i></i>在线演示';return;}try{const response=await authenticatedFetch(apiUrl('/api/health'));const data=await response.json();if(!response.ok)throw new Error(data.error||'服务离线');$('#serviceStatus').innerHTML=`<i></i>${data.mode==='ai'?'DeepSeek AI · CloudBase':'CloudBase演示模式'}`;}catch{$('#serviceStatus').textContent='服务离线';}}
async function authenticatedFetch(url, options = {}) {
  // The login screen is controlled by initializeAuth/signIn only. A rejected
  // business request (for example a missing workspace membership) must not
  // flash the login screen after a successful sign-in.
  if (!cloudbaseAuth) throw new Error('登录已过期，请重新登录');
  const request = async token => { const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${token}`); return fetch(url, { ...options, headers }); };
  let sessionResult = await cloudbaseAuth.getSession();
  let token = sessionResult.data?.session?.access_token;
  if (!token) {
    const refreshed = await cloudbaseAuth.refreshSession().catch(() => null);
    token = refreshed?.data?.session?.access_token;
  }
  if (!token) throw new Error('登录已过期，请重新登录');
  let response = await request(token);
  if (response.status === 401) {
    const refreshed = await cloudbaseAuth.refreshSession().catch(() => null);
    const freshToken = refreshed?.data?.session?.access_token;
    if (freshToken) response = await request(freshToken);
    else throw new Error('登录已过期，请重新登录');
  }
  return response;
}
let toastTimer;function toast(message){const element=$('#toast');element.textContent=message;element.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>element.classList.remove('show'),2600);}
async function hydrateWorkspace(){if(!REMOTE_BACKEND)return;try{let response=await authenticatedFetch(apiUrl('/api/workspace'));if(response.status===403){response=await authenticatedFetch(apiUrl('/api/workspace/bootstrap'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#loginUsername')?.value||''})});}if(!response.ok)throw new Error('工作区初始化失败');app.workspace=await response.json();updateUserHeader();}catch(error){console.error(error);toast(error.message||'工作区读取失败');}}
function updateUserHeader(){const workspace=app.workspace||{};const member=workspace.currentMember||{};const company=workspace.workspace?.name||'公司主体';const username=member.username||member.displayName||$('#loginUsername')?.value||member.uid||'当前账号';const companyEl=$('#companyNameDisplay');const userEl=$('#userNameDisplay');if(companyEl)companyEl.textContent=company;if(userEl)userEl.textContent=username;const avatar=$('#logoutButton');if(avatar)avatar.textContent=String(username).slice(0,2).toUpperCase();}
