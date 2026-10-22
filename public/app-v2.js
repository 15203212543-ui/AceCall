import cloudbase from 'https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@3.10.1/+esm';

const CASES_KEY = 'acecall-cases-v1';
const JOBS_KEY = 'acecall-jobs-v1';
const RULES_KEY = 'acecall-team-rules-v1';
const INTERNAL_TEST_COMPANY = 'AceCall招聘团队';
const LOCAL_MIGRATION_KEY_PREFIX = 'acecall-local-migration-v2:';
const REMEMBERED_ACCOUNT_KEY = 'acecall-remembered-account-v1';
const WORKSPACE_NAME_KEY = 'acecall-workspace-name-v1';
const API_BASE = String(window.ACECALL_CONFIG?.apiBaseUrl || '').replace(/\/$/, '');
const REMOTE_BACKEND = Boolean(API_BASE);
const STATIC_DEMO = (location.protocol === 'file:' || location.hostname.endsWith('.github.io')) && !REMOTE_BACKEND;
const FORCE_MIGRATION = new URLSearchParams(location.search).has('migrate');
const CLOUD_CONFIG = window.ACECALL_CONFIG?.cloudbase || {};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const initialLocalState = { cases: readStore(CASES_KEY), jobs: readStore(JOBS_KEY), rules: readStore(RULES_KEY) };
const INTELLIGENCE_LEXICON = {
  industry: ['证券', '基金', '银行', '保险', '信托', '资管', '私募', '金融科技', '互联网', '企业服务', 'SaaS', '消费', '制造', '医疗', '教育'],
  product: ['场外期权', 'RFQ', '交易系统', '风控系统', '清算系统', '估值系统', '订单管理', '投研平台', '数据服务', '招聘系统', 'CRM', 'SaaS平台'],
  business: ['机构业务', '资产管理', '做市', '自营交易', '量化交易', '风险管理', '合规', '清算', '产品研发', '销售获客', '客户成功', '招聘运营'],
  city: ['北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '苏州', '香港']
};
const app = { cases: REMOTE_BACKEND ? [] : initialLocalState.cases, jobs: REMOTE_BACKEND ? [] : initialLocalState.jobs, view: 'dashboard', candidateId: null, detailTab: 'overview', resumeMeta: null, resumeFile: null, workspace: null, authUser: null, legacyLocalState: REMOTE_BACKEND ? null : initialLocalState, remoteState: null, mokaInterviews: [], mokaInterviewStatus: { configured: false, loading: false }, intelligenceReviewed: {}, intelligenceView: 'company', intelligenceSelected: '', intelligenceQuery: '', intelligenceSource: '', intelligenceIndustry: '' };
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
let recordingDraft = { candidateId: null, file: null, url: '', source: '', taskId: '', recordingId: '', uploaded: false };
const RECORDING_CHUNK_SIZE = 8 * 1024 * 1024;
const RECORDING_MAX_BYTES = 500 * 1024 * 1024;
const RESUME_MAX_BYTES = 50 * 1024 * 1024;
const DESKTOP_AGENT_URL = 'http://127.0.0.1:17890';
let desktopAgentAvailable = false;
let mokaRefreshInFlight = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!await initializeAuth()) return;
  bindShell();
  updateUserHeader();
  await hydrateWorkspace();
  await hydrateState();
  seedJobs();
  await checkService();
  navigate(location.hash.replace('#', '') || 'dashboard');
});

let shellBound = false;
let activeNavKey = null;
function bindShell() {
  if (shellBound) return;
  shellBound = true;
  $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => {
    if (button.classList.contains('nav-subitem')) {
      activeNavKey = button.dataset.navKey || null;
    } else {
      activeNavKey = null;
    }
    navigate(button.dataset.view);
  }));
  $$('[data-nav-toggle]').forEach(button => button.addEventListener('click', () => toggleNavGroup(button.dataset.navToggle)));
  $$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $('#candidateForm').addEventListener('submit', createCandidate);
  $('#jobForm').addEventListener('submit', saveJob);
  $('#resumeUploadButton').addEventListener('click', () => $('#resumeFileInput').click());
  $('#resumeFileInput').addEventListener('change', event => parseResume(event.target.files?.[0]));
  window.addEventListener('hashchange', () => navigate(location.hash.replace('#', '') || 'dashboard', false));
  bindAccountMenu();
  bindGlobalCandidateSearch();
  $('#applyJobRuleLibrary').addEventListener('click', applySelectedTeamRule);
  $('#saveJobRuleLibrary').addEventListener('click', saveCurrentRuleToLibrary);
}

function toggleNavGroup(groupName) {
  const toggle = $(`[data-nav-toggle="${groupName}"]`);
  const submenu = $(`[data-nav-submenu="${groupName}"]`);
  if (!toggle || !submenu) return;
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  submenu.hidden = expanded;
  submenu.classList.toggle('is-open', !expanded);
}

function bindGlobalCandidateSearch() {
  const input = $('#globalCandidateSearch');
  const wrap = $('#globalSearchWrap');
  const results = $('#globalSearchResults');
  if (!input || !wrap || !results) return;
  const close = () => { results.hidden = true; };
  const searchableText = item => [
    item.candidateName,
    item.roleName,
    item.resume,
    item.resumeMeta?.fileName,
    item.resumeMeta?.email,
    item.resumeMeta?.phone,
    item.resumeMeta?.currentCompany,
    item.resumeMeta?.location
  ].filter(Boolean).join(' ').toLowerCase();
  const renderResults = () => {
    const query = input.value.trim().toLowerCase();
    if (!query) return close();
    const matches = app.cases.filter(item => searchableText(item).includes(query)).slice(0, 8);
    results.innerHTML = matches.length
      ? matches.map(item => `<button class="global-search-result" type="button" data-global-candidate="${escapeHtml(item.id)}"><span class="global-result-avatar">${escapeHtml((item.candidateName || '候').slice(0, 1))}</span><span><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.roleName || item.resumeMeta?.email || '候选人档案')}</small></span></button>`).join('')
      : '<div class="global-search-empty">没有找到匹配的候选人</div>';
    results.hidden = false;
  };
  input.addEventListener('input', renderResults);
  input.addEventListener('focus', renderResults);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); input.blur(); }
    if (event.key === 'Enter') {
      const first = results.querySelector('[data-global-candidate]');
      if (first) { openCandidate(first.dataset.globalCandidate); close(); input.value = ''; }
    }
  });
  results.addEventListener('click', event => {
    const result = event.target.closest('[data-global-candidate]');
    if (!result) return;
    openCandidate(result.dataset.globalCandidate);
    close();
    input.value = '';
  });
  document.addEventListener('click', event => { if (!wrap.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'm') {
      event.preventDefault(); input.focus(); input.select();
    }
  });
}

function bindAccountMenu() {
  const menus = [];
  const bindFloatingMenu = (wrapSelector, buttonSelector, menuSelector) => {
    const wrap = $(wrapSelector); const button = $(buttonSelector); const menu = $(menuSelector);
    if (!wrap || !button || !menu) return null;
    let closeTimer = null;
    const close = () => { clearTimeout(closeTimer); menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const open = () => { clearTimeout(closeTimer); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); };
    const scheduleClose = () => { clearTimeout(closeTimer); closeTimer = setTimeout(close, 220); };
    button.addEventListener('click', event => { event.stopPropagation(); menu.hidden ? open() : close(); });
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', scheduleClose);
    menu.addEventListener('mouseenter', open);
    menu.addEventListener('mouseleave', scheduleClose);
    menu.addEventListener('click', event => event.stopPropagation());
    menus.push(close);
    return { close };
  };
  const account = bindFloatingMenu('#accountMenuWrap', '#accountMenuButton', '#accountMenu');
  const company = bindFloatingMenu('#companyMenuWrap', '#companyMenuButton', '#companyMenu');
  bindFloatingMenu('#notificationMenuWrap', '#notificationButton', '#notificationMenu');
  document.addEventListener('click', () => menus.forEach(close => close()));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') menus.forEach(close => close()); });
  account?.close();
  $('#profileMenuButton')?.addEventListener('click', () => { account?.close(); navigate('settings'); });
  $('#changePasswordMenuButton')?.addEventListener('click', () => {
    account?.close();
    $('#loginScreen').classList.remove('hidden');
    setAuthMode('reset');
    const email = $('#accountMenuEmail')?.textContent.trim();
    if (email && email.includes('@')) $('#loginUsername').value = email;
  });
  $('#menuLogoutButton')?.addEventListener('click', () => { account?.close(); signOut(); });
  $('#companySettingsButton')?.addEventListener('click', () => { company?.close(); navigate('settings'); });
}

async function initializeAuth() {
  $('#loginForm').addEventListener('submit', handleAuthSubmit);
  $('#authSwitch').addEventListener('click', toggleAuthMode);
  $('#forgotPasswordSwitch').addEventListener('click', startPasswordReset);
  $('#passwordLoginTab').addEventListener('click', () => setLoginMethod('password'));
  $('#emailLoginTab').addEventListener('click', () => setLoginMethod('email'));
  const rememberedAccount = localStorage.getItem(REMEMBERED_ACCOUNT_KEY) || '';
  if (rememberedAccount) {
    $('#loginUsername').value = rememberedAccount;
    $('#rememberAccount').checked = true;
  }
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
  captureAuthUser(data.session, rememberedAccount);
  await syncDesktopSession(data.session.access_token);
  $('#loginScreen').classList.add('hidden');
  return true;
}

function captureAuthUser(sessionOrUser, fallbackUsername = '') {
  const user = sessionOrUser?.user || sessionOrUser || {};
  const metadata = user.user_metadata || {};
  const previous = app.authUser || {};
  const fallback = String(fallbackUsername || '').trim();
  const email = String(user.email || previous.email || (fallback.includes('@') ? fallback : '')).trim();
  const username = String(metadata.username || user.username || previous.username || fallback || email).trim();
  const displayName = String(metadata.name || metadata.nickName || user.name || previous.displayName || (email ? email.split('@')[0] : username)).trim();
  const uid = String(user.id || user.uid || metadata.uid || previous.uid || '').trim();
  app.authUser = { email, username, displayName, uid };
  updateUserHeader();
}

let authMode = 'login';
let loginMethod = 'password';
let registerVerification = null;
let loginVerification = null;
let resetVerification = null;

function setAuthMode(mode) {
  authMode = mode;
  const registering = authMode === 'register';
  const resetting = authMode === 'reset';
  $('#authTitle').textContent = registering ? '欢迎回来' : resetting ? '重设登录密码' : '欢迎回来';
  $('#authSubtitle').textContent = registering ? '' : resetting ? '通过邮箱验证后设置新的登录密码' : '登录后继续管理岗位、候选人与面试进展';
  $('#authSubtitle').classList.toggle('hidden', registering);
  $('#loginButton').textContent = registering ? '创建并继续' : resetting ? '发送验证码' : '登录工作台';
  $('#authSwitchPrompt').textContent = registering || resetting ? '已有账号？' : '还没有账号？';
  $('#authSwitch').textContent = registering || resetting ? '返回登录' : '立即注册';
  $('#authMethodTabs').classList.toggle('hidden', registering || resetting);
  $('#loginOptions').classList.toggle('hidden', registering || resetting);
  $('#registerCompanyField').classList.toggle('hidden', !registering);
  $('#usernameLabel').textContent = registering || resetting ? '邮箱' : '邮箱 / 账号';
  $('#loginUsername').placeholder = registering || resetting ? '请输入邮箱' : '请输入邮箱或账号';
  $('#passwordField').classList.toggle('hidden', resetting && !resetVerification);
  $('#passwordLabel').textContent = resetting ? '新密码' : '密码';
  $('#confirmPasswordField').classList.toggle('hidden', !registering);
  $('#verificationCodeField').classList.add('hidden');
  $('#verificationCode').required = false;
  registerVerification = null;
  loginVerification = null;
  resetVerification = null;
  $('#loginPassword').required = registering;
  $('#confirmPassword').required = registering;
  if (!registering && !resetting) setLoginMethod('password', false);
  showLoginMessage(registering ? '设置密码后获取验证码，验证成功即可创建个人账号' : resetting ? '输入注册邮箱，接收验证码后设置新密码' : '账号数据仅属于当前账号', false);
}

function setLoginMethod(method, updateMessage = true) {
  if (authMode !== 'login') return;
  loginMethod = method === 'email' ? 'email' : 'password';
  loginVerification = null;
  const emailLogin = loginMethod === 'email';
  $('#passwordLoginTab').classList.toggle('active', !emailLogin);
  $('#emailLoginTab').classList.toggle('active', emailLogin);
  $('#passwordLoginTab').setAttribute('aria-selected', String(!emailLogin));
  $('#emailLoginTab').setAttribute('aria-selected', String(emailLogin));
  $('#usernameLabel').textContent = emailLogin ? '邮箱' : '邮箱 / 账号';
  $('#loginUsername').placeholder = emailLogin ? '请输入邮箱' : '请输入邮箱或账号';
  $('#passwordField').classList.toggle('hidden', emailLogin);
  $('#loginPassword').required = !emailLogin;
  $('#verificationCodeField').classList.add('hidden');
  $('#verificationCode').required = false;
  $('#verificationCode').value = '';
  $('#loginButton').textContent = emailLogin ? '获取邮箱验证码' : '登录工作台';
  if (updateMessage) showLoginMessage(emailLogin ? '验证码将发送至你的注册邮箱' : '账号数据仅属于当前账号', false);
}

function toggleAuthMode() {
  setAuthMode(authMode === 'login' ? 'register' : 'login');
}

function startPasswordReset() {
  setAuthMode('reset');
}

function authErrorMessage(value, fallback) {
  const source = value?.error ?? value;
  if (typeof source === 'string') return source;
  const message = source?.message || source?.error_description || source?.msg || value?.message;
  const code = source?.code || value?.code;
  if (message && code && !String(message).includes(String(code))) return `${code}: ${message}`;
  return message || code || fallback;
}

async function handleAuthSubmit(event) {
  if (authMode === 'register') return register(event);
  if (authMode === 'reset') return resetPassword(event);
  return signIn(event);
}

async function register(event) {
  event.preventDefault();
  const username = $('#loginUsername').value.trim();
  const companyName = $('#registerCompanyName').value.trim();
  const password = $('#loginPassword').value;
  const button = $('#loginButton');
  if (companyName !== INTERNAL_TEST_COMPANY) return showLoginMessage('请填写企业名称，如有问题请联系工作人员');
  if (registerVerification) {
    const code = $('#verificationCode').value.trim();
    if (!code) return showLoginMessage('请输入邮箱收到的验证码');
    button.disabled = true; button.textContent = '正在验证'; showLoginMessage('正在验证邮箱', false);
    try {
      const result = await registerVerification({ token: code });
      if (result?.error) throw new Error(authErrorMessage(result, '邮箱验证失败'));
      registerVerification = null;
      captureAuthUser(result?.data?.session, username);
      await enterWorkspace(username, companyName);
    } catch (error) {
      showLoginMessage(authErrorMessage(error, '邮箱验证失败'));
    button.disabled = false; button.textContent = '验证并进入';
    }
    return;
  }
  if (!username || !/^\S+@\S+\.\S+$/.test(username)) return showLoginMessage('请输入有效的邮箱地址');
  if (password.length < 8) return showLoginMessage('密码至少需要 8 位');
  if (password !== $('#confirmPassword').value) return showLoginMessage('两次输入的密码不一致');
  button.disabled = true; button.textContent = '正在注册'; showLoginMessage('正在创建个人账号', false);
  try {
    const result = await cloudbaseAuth.signUp({
      email: username,
      password
    });
    if (result?.error) throw new Error(authErrorMessage(result, '验证码发送失败'));
    if (result?.data?.session) {
      captureAuthUser(result.data.session, username);
      await enterWorkspace(username, companyName);
      return;
    }
    if (!result?.data?.verifyOtp) throw new Error('验证码接口返回异常，请检查 CloudBase 邮箱登录配置');
    registerVerification = result.data.verifyOtp;
    $('#verificationCodeField').classList.remove('hidden');
    $('#verificationCode').required = true;
    $('#loginButton').textContent = '验证并进入';
    showLoginMessage('验证码已发送到你的邮箱，请查收后输入；验证成功后自动创建账号', false);
    button.disabled = false;
  } catch (error) {
    showLoginMessage(authErrorMessage(error, '注册失败'));
    button.disabled = false; button.textContent = '注册并进入';
  }
}

async function resetPassword(event) {
  event.preventDefault();
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  const button = $('#loginButton');
  if (resetVerification) {
    const code = $('#verificationCode').value.trim();
    if (!code) return showLoginMessage('请输入邮箱收到的验证码');
    if (password.length < 8) return showLoginMessage('新密码至少需要 8 位');
    if (password !== $('#confirmPassword').value) return showLoginMessage('两次输入的新密码不一致');
    button.disabled = true; button.textContent = '正在保存'; showLoginMessage('正在重设密码', false);
    try {
      const result = await resetVerification({ nonce: code, password });
      if (result?.error) throw new Error(authErrorMessage(result, '密码重设失败'));
      setAuthMode('login');
      $('#loginUsername').value = username;
      $('#loginPassword').value = '';
      $('#confirmPassword').value = '';
      $('#verificationCode').value = '';
      showLoginMessage('密码已重设，请使用新密码登录', false);
    } catch (error) {
      showLoginMessage(authErrorMessage(error, '密码重设失败'));
      button.disabled = false; button.textContent = '保存新密码';
    }
    return;
  }
  if (!username || !/^\S+@\S+\.\S+$/.test(username)) return showLoginMessage('请输入有效的邮箱地址');
  button.disabled = true; button.textContent = '正在发送'; showLoginMessage('正在发送重设密码验证码', false);
  try {
    const result = await cloudbaseAuth.resetPasswordForEmail(username);
    if (result?.error) throw new Error(authErrorMessage(result, '验证码发送失败'));
    if (!result?.data?.updateUser) throw new Error('重设密码接口返回异常，请检查 CloudBase 邮箱配置');
    resetVerification = result.data.updateUser;
    $('#passwordField').classList.remove('hidden');
    $('#confirmPasswordField').classList.remove('hidden');
    $('#verificationCodeField').classList.remove('hidden');
    $('#verificationCode').required = true;
    $('#loginPassword').required = true;
    $('#confirmPassword').required = true;
    $('#loginButton').textContent = '保存新密码';
    showLoginMessage('验证码已发送到你的邮箱，请输入验证码和新密码', false);
    button.disabled = false;
  } catch (error) {
    showLoginMessage(authErrorMessage(error, '验证码发送失败'));
    button.disabled = false; button.textContent = '发送验证码';
  }
}

async function signIn(event) {
  event.preventDefault();
  const button = $('#loginButton');
  const username = $('#loginUsername').value.trim();
  if (loginMethod === 'email' && !loginVerification) {
    if (!username || !/^\S+@\S+\.\S+$/.test(username)) return showLoginMessage('请输入有效的邮箱地址');
    button.disabled = true; button.textContent = '正在发送'; showLoginMessage('正在发送邮箱验证码', false);
    try {
      const result = await cloudbaseAuth.signInWithOtp({
        email: username,
        options: { shouldCreateUser: false }
      });
      if (result?.error) throw new Error(authErrorMessage(result, '验证码发送失败'));
      if (!result?.data?.verifyOtp) throw new Error('验证码接口返回异常，请检查 CloudBase 邮箱登录配置');
      loginVerification = result.data.verifyOtp;
      $('#verificationCodeField').classList.remove('hidden');
      $('#verificationCode').required = true;
      button.disabled = false; button.textContent = '验证并登录';
      showLoginMessage('验证码已发送到你的邮箱，请查收后输入', false);
    } catch (error) {
      showLoginMessage(authErrorMessage(error, '验证码发送失败'));
      button.disabled = false; button.textContent = '获取邮箱验证码';
    }
    return;
  }
  if (loginVerification) {
    const code = $('#verificationCode').value.trim();
    if (!code) return showLoginMessage('请输入邮箱收到的验证码');
    button.disabled = true; button.textContent = '正在验证'; showLoginMessage('正在验证邮箱', false);
    try {
      const result = await loginVerification({ token: code });
      if (result?.error) throw new Error(authErrorMessage(result, '邮箱验证失败'));
      loginVerification = null;
      captureAuthUser(result?.data?.session, username);
      persistRememberedAccount(username);
      await enterWorkspace(username);
    } catch (error) {
      showLoginMessage(authErrorMessage(error, '邮箱验证失败'));
      button.disabled = false; button.textContent = '验证并进入';
    }
    return;
  }
  button.disabled = true; button.textContent = '正在登录'; showLoginMessage('正在验证账号', false);
  try {
    let result = await cloudbaseAuth.signInWithPassword({ username, password: $('#loginPassword').value });
    if (result.error && /refresh token/i.test(result.error.message || '')) {
      await cloudbaseAuth.signOut().catch(() => {});
      result = await cloudbaseAuth.signInWithPassword({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value });
    }
    const { data, error } = result;
    if (error && (error.code === 'password_not_set' || /password.?not.?set/i.test(error.message || ''))) {
      const otpResult = await cloudbaseAuth.signInWithOtp({
        email: username,
        options: { shouldCreateUser: false }
      });
      if (otpResult?.error) throw new Error(authErrorMessage(otpResult, '验证码发送失败'));
      if (!otpResult?.data?.verifyOtp) throw new Error('验证码接口返回异常，请检查 CloudBase 邮箱登录配置');
      loginVerification = otpResult.data.verifyOtp;
      $('#verificationCodeField').classList.remove('hidden');
      $('#verificationCode').required = true;
      button.disabled = false; button.textContent = '验证并进入';
      showLoginMessage('该账号未设置密码，验证码已发送到邮箱', false);
      return;
    }
    if (error || !data?.session) throw new Error(error?.message || '账号或密码错误');
    captureAuthUser(data.session, username);
    await syncDesktopSession(data.session.access_token);
    persistRememberedAccount(username);
    await enterWorkspace($('#loginUsername').value.trim());
  } catch (error) {
    showLoginMessage(authErrorMessage(error, '登录失败'));
    button.disabled = false; button.textContent = '登录工作台';
  }
}

async function syncDesktopSession(token) {
  if (!token) return false;
  try {
    const response = await fetch(`${DESKTOP_AGENT_URL}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, apiBase: API_BASE }), signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

function persistRememberedAccount(username) {
  if ($('#rememberAccount').checked) localStorage.setItem(REMEMBERED_ACCOUNT_KEY, username);
  else localStorage.removeItem(REMEMBERED_ACCOUNT_KEY);
}

async function enterWorkspace(username = '', companyName = '') {
  bindShell();
  $('#loginScreen').classList.add('hidden');
  captureAuthUser(null, username);
  await hydrateWorkspace(username, companyName);
  await hydrateState();
  seedJobs();
  await checkService();
  navigate(location.hash.replace('#', '') || 'dashboard');
}

async function signOut() {
  await cloudbaseAuth?.signOut();
  await syncDesktopSession('');
  location.reload();
}

function showLoginMessage(message, isError = true) {
  $('#loginMessage').textContent = message;
  $('#loginMessage').classList.toggle('error', isError);
}

function navigate(view, updateHash = true) {
  if (!['dashboard', 'inbox', 'candidates', 'jobs', 'talentOrganization', 'talentMarket', 'recruitmentAnalysis', 'insights', 'interviewers', 'intelligence', 'connections', 'settings', 'candidate'].includes(view)) view = 'dashboard';
  app.view = view;
  $$('.view').forEach(section => section.classList.remove('active'));
  $$('.nav-item[data-view]').forEach(button => {
    const isSubitem = button.classList.contains('nav-subitem');
    button.classList.toggle('active', isSubitem
      ? Boolean(activeNavKey && button.dataset.navKey === activeNavKey)
      : button.dataset.view === view || (view === 'candidate' && button.dataset.view === 'candidates'));
  });
  const target = view === 'candidate' ? $('#candidateDetailView') : $(`#${view}View`);
  target.classList.add('active');
  $('#breadcrumb').textContent = view === 'candidate' ? '候选人 / 初筛详情' : ({ dashboard: '招聘工作台', inbox: '简历中心', candidates: '候选人管理', jobs: '岗位管理', talentOrganization: '内部人才分析', talentMarket: '人才市场洞察', recruitmentAnalysis: '招聘分析', insights: '人才洞察', interviewers: '面试官分析', intelligence: '行业情报', connections: '数据连接', settings: '系统设置' }[view]);
  if (updateHash) history.replaceState(null, '', `#${view}`);
  renderCurrent();
}

function renderCurrent() {
  const candidateNavCount = $('#candidateNavCount');
  const resumeInboxCount = $('#resumeInboxCount');
  if (candidateNavCount) candidateNavCount.textContent = app.cases.length;
  if (resumeInboxCount) resumeInboxCount.textContent = app.cases.filter(item => item.ingestStatus === '解析中' || item.matching?.status === '待分配').length || '';
  if (app.view === 'dashboard') renderDashboard();
  if (app.view === 'inbox') renderInbox();
  if (app.view === 'candidates') renderCandidates();
  if (app.view === 'jobs') renderJobs();
  if (app.view === 'talentOrganization') renderInternalTalentAnalysis('#talentOrganizationView');
  if (app.view === 'talentMarket') renderTalentMarket();
  if (app.view === 'recruitmentAnalysis') renderRecruitmentAnalysis();
  if (app.view === 'insights') renderInsights('#insightsView');
  if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
  if (app.view === 'intelligence') renderIntelligence();
  if (app.view === 'connections') renderConnections();
  if (app.view === 'settings') renderSettings();
  if (app.view === 'candidate') renderCandidateDetail();
}

function analysisDecisionCounts(items) { const counts = new Map(); items.forEach(item => { const decision = finalAction(item) || '未决策'; counts.set(decision, (counts.get(decision) || 0) + 1); }); return [...counts.entries()].sort((a, b) => b[1] - a[1]); }
function insightBar(label, value, total, tone = '') { const percent = total ? Math.round(value / total * 100) : 0; return `<div class="insight-bar-row"><div><span>${escapeHtml(label)}</span><b>${value} 人 · ${percent}%</b></div><div class="insight-bar"><i class="${tone}" style="width:${percent}%"></i></div></div>`; }
function outcomeSignals(item) {
  const source = item.mokaData || item.recruitmentOutcome || item.outcome || {};
  const interview = String(item.interviewOutcome || source.interviewOutcome || source.interviewStatus || '').toLowerCase();
  const offer = String(item.offerOutcome || source.offerOutcome || source.offerStatus || '').toLowerCase();
  const hired = item.hired === true || source.hired === true || ['已入职', '入职', 'hired', 'joined'].includes(offer);
  const interviewPassed = item.interviewPassed === true || source.interviewPassed === true || /通过|pass|passed|通过面试/.test(interview);
  const interviewFailed = item.interviewPassed === false || source.interviewPassed === false || /未通过|不通过|reject|failed|fail/.test(interview);
  const offerDeclined = item.offerDeclined === true || source.offerDeclined === true || /拒绝|拒offer|declined|rejected|放弃/.test(offer);
  const offerAccepted = item.offerAccepted === true || source.offerAccepted === true || hired || /接受|accept|accepted/.test(offer);
  const offerSent = item.offerSent === true || source.offerSent === true || offerAccepted || offerDeclined || /offer已发|sent|已发放/.test(offer);
  return { interviewPassed, interviewFailed, offerSent, offerDeclined, offerAccepted, hired, declineReason: item.offerDeclineReason || source.offerDeclineReason || source.declineReason || '' };
}
function outcomeBreakdown(items) { const signals = items.map(outcomeSignals); return { interviewPassed: signals.filter(item => item.interviewPassed).length, interviewFailed: signals.filter(item => item.interviewFailed).length, interviewUnknown: signals.filter(item => !item.interviewPassed && !item.interviewFailed).length, offerSent: signals.filter(item => item.offerSent).length, offerDeclined: signals.filter(item => item.offerDeclined).length, offerAccepted: signals.filter(item => item.offerAccepted).length, hired: signals.filter(item => item.hired).length, declineReasons: signals.map(item => item.declineReason).filter(Boolean) }; }
function jobAnalyticsValue(job, field, fallback) { const value = String(job?.[field] || '').trim(); return value || fallback; }
function jobRecruitmentAnalytics(filters = {}) {
  const periodDays = Number(filters.period || 0); const cutoff = periodDays ? Date.now() - periodDays * 86400000 : 0;
  const jobs = app.jobs.filter(job => {
    const category = jobAnalyticsValue(job, 'category', '未分类'); const location = jobAnalyticsValue(job, 'location', '未设置地点'); const updated = Date.parse(job.updatedAt || job.createdAt || '') || 0;
    return (!filters.category || category === filters.category) && (!filters.industry || jobAnalyticsValue(job, 'industry', '未设置行业') === filters.industry) && (!filters.location || location === filters.location) && (!filters.status || (job.status || 'active') === filters.status) && (!cutoff || updated >= cutoff);
  });
  const jobIds = new Set(jobs.map(job => job.id)); const candidates = app.cases.filter(item => jobIds.has(item.jobId)); const outcomes = outcomeBreakdown(candidates); const recommended = candidates.filter(item => finalAction(item) === '推荐业务面试').length; const highMatch = candidates.filter(item => scoreValue(item) >= 80).length;
  const rows = jobs.map(job => { const items = candidates.filter(item => item.jobId === job.id); const result = outcomeBreakdown(items); const scores = items.map(scoreValue).filter(value => value > 0); return { job, items, candidates: items.length, averageScore: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0, interviewPassed: result.interviewPassed, offerAccepted: result.offerAccepted, hired: result.hired, recommended: items.filter(item => finalAction(item) === '推荐业务面试').length }; }).sort((a, b) => b.candidates - a.candidates || b.averageScore - a.averageScore);
  const groupBy = (field, fallback) => [...new Set(jobs.map(job => jobAnalyticsValue(job, field, fallback)))].map(label => { const groupJobs = jobs.filter(job => jobAnalyticsValue(job, field, fallback) === label); const groupIds = new Set(groupJobs.map(job => job.id)); const groupCandidates = candidates.filter(item => groupIds.has(item.jobId)); const groupOutcomes = outcomeBreakdown(groupCandidates); return { label, jobs: groupJobs.length, candidates: groupCandidates.length, passed: groupOutcomes.interviewPassed, offers: groupOutcomes.offerSent, accepted: groupOutcomes.offerAccepted, averageScore: (() => { const scores = groupCandidates.map(scoreValue).filter(value => value > 0); return scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0; })() }; }).sort((a, b) => b.candidates - a.candidates);
  return { jobs, candidates, outcomes, recommended, highMatch, rows, byCategory: groupBy('category', '未分类'), byLocation: groupBy('location', '未设置地点') };
}
function renderJobAnalytics(rootSelector = '#recruitmentAnalysisView') {
  const root = $(rootSelector); if (!root) return;
  const existing = root.querySelector('[data-job-analytics]'); if (existing) existing.remove();
  const categories = [...new Set(app.jobs.map(job => jobAnalyticsValue(job, 'category', '未分类')))]; const industries = [...new Set(app.jobs.map(job => jobAnalyticsValue(job, 'industry', '未设置行业')))]; const locations = [...new Set(app.jobs.map(job => jobAnalyticsValue(job, 'location', '未设置地点')))];
  const storedFilters = app.jobAnalyticsFilters || {}; const filters = { category: storedFilters.category || '', industry: storedFilters.industry || '', location: storedFilters.location || '', status: storedFilters.status || '', period: storedFilters.period || '' }; const analytics = jobRecruitmentAnalytics(filters); const total = analytics.candidates.length; const outcomes = analytics.outcomes; const rate = (value, denominator) => denominator ? `${Math.round(value / denominator * 100)}%` : '—';
  const options = (values, selected, placeholder) => `<option value="">${placeholder}</option>${values.map(value => `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')}`;
  const panel = document.createElement('section'); panel.className = 'surface job-analytics-panel'; panel.dataset.jobAnalytics = 'true'; panel.innerHTML = `<div class="surface-head"><div><h2>岗位招聘分析</h2><p class="surface-subtitle">按职位类别、行业、地点和岗位状态查看招聘投入与结果转化</p></div><span>${analytics.jobs.length} 个岗位 · ${total} 位候选人</span></div><div class="job-analytics-filters"><select id="jobAnalyticsCategory">${options(categories, filters.category, '全部职位类别')}</select><select id="jobAnalyticsIndustry">${options(industries, filters.industry, '全部行业')}</select><select id="jobAnalyticsLocation">${options(locations, filters.location, '全部地点')}</select><select id="jobAnalyticsStatus"><option value="">全部岗位状态</option><option value="active"${filters.status === 'active' ? ' selected' : ''}>在招岗位</option><option value="closed"${filters.status === 'closed' ? ' selected' : ''}>已关闭岗位</option></select><select id="jobAnalyticsPeriod"><option value="">全部时间</option><option value="30"${filters.period === '30' ? ' selected' : ''}>近 30 天</option><option value="90"${filters.period === '90' ? ' selected' : ''}>近 90 天</option><option value="365"${filters.period === '365' ? ' selected' : ''}>近一年</option></select></div><div class="job-analytics-kpis"><div class="metric"><b>${analytics.jobs.length}</b><span>岗位数</span><small>${filters.status ? (filters.status === 'active' ? '在招' : '已关闭') : '全部状态'}</small></div><div class="metric"><b>${total}</b><span>候选人数</span><small>包含已淘汰人选</small></div><div class="metric"><b>${rate(outcomes.interviewPassed, total)}</b><span>面试通过率</span><small>${outcomes.interviewPassed} 人通过</small></div><div class="metric"><b>${rate(outcomes.offerAccepted, outcomes.offerSent)}</b><span>Offer 接受率</span><small>${outcomes.offerAccepted} / ${outcomes.offerSent} 人</small></div><div class="metric"><b>${outcomes.hired}</b><span>已入职</span><small>招聘结果沉淀</small></div></div><div class="job-analytics-grid"><div><h3>岗位招聘表现</h3><div class="table-wrap job-analytics-table"><table><thead><tr><th>岗位</th><th>类别 / 地点</th><th>候选人</th><th>平均匹配度</th><th>面试通过</th><th>Offer 接受</th></tr></thead><tbody>${analytics.rows.slice(0, 12).map(row => `<tr><td><strong>${escapeHtml(row.job.name || '未命名岗位')}</strong><small>${row.job.status === 'closed' ? '已关闭' : '在招'}</small></td><td>${escapeHtml(jobAnalyticsValue(row.job, 'category', '未分类'))}<br><small>${escapeHtml(jobAnalyticsValue(row.job, 'location', '未设置地点'))}</small></td><td>${row.candidates}</td><td>${row.averageScore ? `${row.averageScore} 分` : '—'}</td><td>${row.interviewPassed} <small>${rate(row.interviewPassed, row.candidates)}</small></td><td>${row.offerAccepted} <small>${rate(row.offerAccepted, row.offerSent)}</small></td></tr>`).join('') || '<tr><td colspan="6" class="empty">当前筛选条件下暂无岗位数据。</td></tr>'}</tbody></table></div></div><div class="job-analytics-breakdown"><h3>职位类别对比</h3>${analytics.byCategory.map(group => `<div class="analytics-rank-row"><span>${escapeHtml(group.label)}</span><b>${group.candidates} 人</b><small>通过 ${rate(group.passed, group.candidates)} · 平均 ${group.averageScore || '—'} 分</small></div>`).join('') || '<div class="empty">建立岗位后自动形成类别对比。</div>'}<h3>招聘漏斗</h3>${insightBar('推荐业务面试', analytics.recommended, total, 'blue')}${insightBar('面试通过', outcomes.interviewPassed, total, 'green')}${insightBar('Offer 发放', outcomes.offerSent, total, 'copper')}${insightBar('已入职', outcomes.hired, total, 'green')}</div></div>`;
  const anchor = root.querySelector('.research-banner'); anchor?.after(panel); ['jobAnalyticsCategory', 'jobAnalyticsIndustry', 'jobAnalyticsLocation', 'jobAnalyticsStatus', 'jobAnalyticsPeriod'].forEach(id => { const element = $(`#${id}`); element?.addEventListener('change', () => { app.jobAnalyticsFilters = { category: $('#jobAnalyticsCategory')?.value || '', industry: $('#jobAnalyticsIndustry')?.value || '', location: $('#jobAnalyticsLocation')?.value || '', status: $('#jobAnalyticsStatus')?.value || '', period: $('#jobAnalyticsPeriod')?.value || '' }; renderRecruitmentAnalysis(); }); });
}
function renderInsights(rootSelector = '#talentOrganizationView') {
  const root = $(rootSelector); if (!root) return;
  const empty = (text) => `<div class="talent-empty"><strong>暂无员工数据</strong><span>${text}</span></div>`;
  root.innerHTML = `<div class="page research-page internal-talent-page"><div class="page-title"><div><span class="eyebrow">INTERNAL TALENT</span><h1>内部人才分析</h1><p>基于员工花名册、绩效和流动记录，查看团队结构、能力配置与人才风险。</p></div><button class="secondary" data-talent-connect>接入员工数据</button></div><div class="talent-filters"><select aria-label="部门"><option>全部部门</option></select><select aria-label="岗位"><option>全部岗位</option></select><select aria-label="职级"><option>全部职级</option></select><select aria-label="时间范围"><option>近 12 个月</option></select><span class="data-status">数据源：未接入</span></div><div class="research-banner"><div><span>员工数据状态</span><strong>待接入</strong></div><p>接入员工花名册或 HRIS 后，系统将按部门、岗位、职级、绩效、司龄和离职记录生成分析。</p><span class="data-status">不使用候选人数据</span></div><div class="research-metrics talent-metrics"><div class="metric"><b>—</b><span>员工总数</span><small>需接入员工花名册</small></div><div class="metric"><b>—</b><span>部门数量</span><small>组织结构</small></div><div class="metric"><b>—</b><span>高绩效员工</span><small>绩效数据</small></div><div class="metric"><b>—</b><span>近 12 月离职</span><small>流动记录</small></div><div class="metric"><b>—</b><span>关键岗位空缺</span><small>编制数据</small></div></div><div class="research-grid internal-talent-grid"><section class="surface"><div class="surface-head"><div><h2>人员结构</h2><p class="surface-subtitle">部门、岗位、职级与司龄分布</p></div><span>结构概览</span></div><div class="surface-body">${empty('接入员工花名册后查看部门人数、岗位层级和司龄结构。')}</div></section><section class="surface"><div class="surface-head"><div><h2>能力与绩效</h2><p class="surface-subtitle">绩效表现与岗位能力配置</p></div><span>能力概览</span></div><div class="surface-body">${empty('接入绩效和能力字段后查看高绩效员工、能力缺口与关键人才。')}</div></section></div><section class="surface internal-talent-section"><div class="surface-head"><div><h2>组织配置</h2><p class="surface-subtitle">编制、人员负荷与关键岗位配置</p></div><span>组织效率</span></div><div class="surface-body">${empty('接入部门编制和岗位信息后查看团队负荷、梯队和关键岗位空缺。')}</div></section><div class="research-grid internal-talent-grid"><section class="surface"><div class="surface-head"><div><h2>流动与风险</h2><p class="surface-subtitle">离职、转岗与人员稳定性</p></div><span>风险监测</span></div><div class="surface-body">${empty('接入入离职与转岗记录后查看流动趋势和高风险岗位。')}</div></section><section class="surface"><div class="surface-head"><div><h2>发展与继任</h2><p class="surface-subtitle">晋升、高潜与关键岗位继任</p></div><span>人才发展</span></div><div class="surface-body">${empty('接入绩效、晋升和继任数据后查看高潜员工与发展路径。')}</div></section></div><section class="surface connector-note"><div class="surface-head"><div><h2>数据接入要求</h2><p class="surface-subtitle">完成配置后开始生成内部人才分析</p></div><span class="readonly-badge">待配置</span></div><div class="surface-body checklist"><label><input type="checkbox" disabled> 员工花名册或 HRIS 数据</label><label><input type="checkbox" disabled> 部门、岗位、职级与在职状态</label><label><input type="checkbox" disabled> 绩效、能力、司龄与流动记录</label><label><input type="checkbox" disabled> 数据权限范围与更新周期</label></div></section></div>`;
  root.innerHTML = root.innerHTML.replaceAll('員工', '员工');
  root.querySelector('[data-talent-connect]')?.addEventListener('click', () => toast('请前往“数据连接”配置员工花名册或 HRIS 数据'));
}
function renderInternalTalentAnalysis(rootSelector = '#talentOrganizationView') {
  const root = $(rootSelector); if (!root) return;
  const empty = (text) => `<div class="talent-empty"><strong>暂无员工数据</strong><span>${text}</span></div>`;
  root.innerHTML = `<div class="page research-page internal-talent-page"><div class="page-title"><div><span class="eyebrow">INTERNAL TALENT</span><h1>内部人才分析</h1><p>从人才总量、结构、表现、能力和流动风险，了解现有团队并明确下一步行动。</p></div><button class="secondary" data-talent-connect>接入员工数据</button></div><div class="talent-filters"><select aria-label="部门"><option>全部部门</option></select><select aria-label="团队"><option>全部团队</option></select><select aria-label="地区"><option>全部地区</option></select><select aria-label="岗位"><option>全部岗位</option></select><select aria-label="工作年限"><option>全部工作年限</option><option>1 年以内</option><option>1-3 年</option><option>3-5 年</option><option>5 年以上</option></select><select aria-label="学历"><option>全部学历</option><option>博士</option><option>硕士</option><option>本科</option><option>大专及以下</option></select><select aria-label="员工状态"><option>全部员工状态</option><option>在职</option><option>试用期</option><option>已离职</option></select><span class="data-status">数据源：未接入</span></div><p class="talent-filter-note">按组织、岗位、工作年限、学历和员工状态筛选，查看对应人员结构。</p><div class="research-banner"><div><span>员工数据状态</span><strong>待接入</strong></div><p>接入员工花名册、HRIS、绩效和流动记录后，以下指标与人员明细将按筛选条件生成。</p><span class="data-status">不使用候选人数据</span></div><section class="talent-overview"><div class="section-kicker">人才总览</div><div class="research-metrics talent-metrics talent-overview-metrics"><div class="metric"><b>—</b><span>人才总量</span><small>较上月 —</small></div><div class="metric"><b>—</b><span>核心人才</span><small>占比 —</small></div><div class="metric"><b>—</b><span>高潜人才</span><small>新增 — 人</small></div><div class="metric"><b>—</b><span>关键岗位覆盖率</span><small>继任数据</small></div><div class="metric"><b>—</b><span>人才流失率</span><small>流动记录</small></div><div class="metric"><b>—</b><span>高风险人才</span><small>需要重点关注</small></div></div></section><section class="surface internal-talent-section"><div class="surface-head"><div><h2>人才结构分析</h2><p class="surface-subtitle">按组织和人员维度查看团队组成</p></div><button class="link-action" data-talent-employees>查看员工明细</button></div><div class="surface-body talent-structure-body"><div class="talent-chip-list"><span>部门</span><span>团队</span><span>地区</span><span>职级</span><span>岗位</span><span>工作年限</span><span>年龄段</span><span>学历</span></div>${empty('接入员工花名册后查看各维度人数、占比及对应人员。')}</div></section><div class="research-grid internal-talent-grid"><section class="surface"><div class="surface-head"><div><h2>人才表现与发展</h2><p class="surface-subtitle">绩效、潜力、贡献与发展准备度</p></div><span>绩效与发展</span></div><div class="surface-body">${empty('接入绩效、能力和晋升记录后查看高绩效、高潜及晋升候选人。')}</div></section><section class="surface"><div class="surface-head"><div><h2>能力与人才缺口</h2><p class="surface-subtitle">能力标签、岗位要求与团队缺口</p></div><span>能力地图</span></div><div class="surface-body">${empty('接入能力标签和岗位要求后查看核心能力排名、能力缺口和人才缺口。')}</div></section></div><section class="surface internal-talent-section"><div class="surface-head"><div><h2>人才流动与风险</h2><p class="surface-subtitle">入职、晋升、转岗、离职和风险变化</p></div><span>流动监测</span></div><div class="surface-body talent-flow-body"><div class="talent-flow-labels"><span>入职</span><span>晋升</span><span>转岗</span><span>离职</span></div>${empty('接入入离职、转岗和绩效记录后查看趋势及重点关注人员。')}</div></section><section class="surface internal-talent-section"><div class="surface-head"><div><h2>人才决策建议</h2><p class="surface-subtitle">基于数据明确下一步行动</p></div><span>待生成</span></div><div class="surface-body talent-decision-list"><div class="talent-decision-row"><b>培养</b><span>识别能力缺口，形成培训或辅导计划</span><i>待接入数据</i></div><div class="talent-decision-row"><b>晋升</b><span>识别已达到岗位要求的员工</span><i>待接入数据</i></div><div class="talent-decision-row"><b>转岗 / 内部推荐</b><span>匹配员工能力与内部岗位机会</span><i>待接入数据</i></div><div class="talent-decision-row"><b>外部招聘</b><span>确认内部无法满足的岗位与能力缺口</span><i>待接入数据</i></div></div></section><section class="surface internal-talent-section"><div class="surface-head"><div><h2>员工明细</h2><p class="surface-subtitle">按上方筛选条件查看对应人员</p></div><button class="link-action" data-talent-employees>查看员工明细</button></div><div class="surface-body">${empty('接入员工数据后显示姓名、部门、岗位、员工状态和最近一次绩效记录。')}</div></section><section class="surface connector-note"><div class="surface-head"><div><h2>数据接入要求</h2><p class="surface-subtitle">完成配置后开始生成内部人才分析</p></div><span class="readonly-badge">待配置</span></div><div class="surface-body checklist"><label><input type="checkbox" disabled> 员工花名册或 HRIS 数据</label><label><input type="checkbox" disabled> 部门、团队、地区、岗位与员工状态</label><label><input type="checkbox" disabled> 绩效、能力、司龄与流动记录</label><label><input type="checkbox" disabled> 数据权限范围与更新周期</label></div></section></div>`;
  root.innerHTML = root.innerHTML.replaceAll('員工', '员工');
  const structureSection = [...root.querySelectorAll('.surface')].find(section => section.querySelector('h2')?.textContent === '人才结构分析');
  const structureBody = structureSection?.querySelector('.surface-body');
  const talentFilters = root.querySelector('.talent-filters');
  const talentFilterNote = root.querySelector('.talent-filter-note');
  if (structureBody && talentFilters) {
    structureBody.prepend(talentFilters);
    if (talentFilterNote) structureBody.insertBefore(talentFilterNote, talentFilters.nextSibling);
  }
  root.querySelector('.talent-chip-list')?.remove();
  [...root.querySelectorAll('.surface')].find(section => section.querySelector('.surface-head h2')?.textContent === '人才表现与发展')?.remove();
  const abilitySection = [...root.querySelectorAll('.surface')].find(section => section.querySelector('.surface-head h2')?.textContent === '能力与人才缺口');
  if (abilitySection) {
    abilitySection.parentElement?.classList.add('single-panel-grid');
    abilitySection.querySelector('.surface-head h2').textContent = '能力与用人标准';
    abilitySection.querySelector('.surface-subtitle').textContent = '能力标签、团队优势、能力缺口与人才缺口';
    abilitySection.querySelector('.surface-body').innerHTML = `<div class="talent-ability-grid"><div class="talent-ability-item"><h3>能力标签</h3>${empty('接入员工能力标签后查看团队核心技能分布。')}</div><div class="talent-ability-item"><h3>当前优势</h3>${empty('根据现有员工能力和岗位覆盖情况总结团队优势。')}</div><div class="talent-ability-item"><h3>能力缺口</h3>${empty('对照岗位能力要求识别团队缺少的关键能力。')}</div><div class="talent-ability-item"><h3>人才缺口</h3>${empty('结合岗位编制和能力标准识别需要补充的人才类型。')}</div><div class="talent-ability-item"><h3>用人标准</h3>${empty('根据岗位要求和团队能力沉淀统一的能力标准。')}</div></div>`;
  }
  const flowSection = [...root.querySelectorAll('.surface')].find(section => section.querySelector('.surface-head h2')?.textContent === '人才流动与风险');
  if (flowSection) {
    flowSection.querySelector('.surface-subtitle').textContent = '入职、晋升、转岗、离职与招聘平台活跃情况';
    flowSection.querySelector('.surface-body').insertAdjacentHTML('beforeend', '<div class="talent-platform-row"><b>招聘平台活跃情况</b><span>仅分析公开资料或经授权的数据</span><i>待接入</i></div>');
  }
  [...root.querySelectorAll('.surface')].filter(section => ['人才决策建议', '员工明细'].includes(section.querySelector('.surface-head h2')?.textContent)).forEach(section => section.remove());
  root.querySelectorAll('[data-talent-employees]').forEach(button => button.remove());
  root.querySelector('[data-talent-connect]')?.addEventListener('click', () => toast('请前往“数据连接”配置员工花名册或 HRIS 数据'));
  root.querySelector('[data-talent-employees]')?.addEventListener('click', () => toast('接入员工数据后可查看对应人员明细'));
}
function renderRecruitmentAnalysis() {
  const root = $('#recruitmentAnalysisView');
  if (!root) return;
  root.innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">RECRUITMENT ANALYTICS</span><h1>招聘分析</h1><p>按岗位、职位类别、行业和地点查看招聘投入、候选人转化与录用结果。</p></div></div><div class="research-banner"><div><span>分析范围</span><strong>${app.jobs.length}<small> 个岗位</small></strong></div><p>把岗位推进、候选人匹配、面试通过和 Offer 结果放在同一张招聘分析视图中。</p><span class="data-status">实时基于 AceCall 数据</span></div></div>`;
  renderJobAnalytics('#recruitmentAnalysisView');
}
function renderTalentMarket() {
  const root = $('#talentMarketView');
  if (!root) return;
  const profiles = app.cases.map(inferTalentProfile);
  const roles = [...new Set(app.cases.map(item => String(item.roleName || '').trim()).filter(Boolean))].map(role => ({ label: role, count: app.cases.filter(item => String(item.roleName || '').trim() === role).length })).sort((a, b) => b.count - a.count).slice(0, 8);
  const companies = [...new Set(app.cases.flatMap(item => String(item.resume || '').match(/[\u4e00-\u9fa5A-Za-z]{2,16}(?:证券|银行|科技|集团|互联网|教育|传媒|视频|信息)/g) || []))].slice(0, 8);
  const keywords = [...new Set(app.jobs.flatMap(job => job.keywords || []))].slice(0, 12);
  const total = app.cases.length;
  const knownCompetitor = profiles.filter(item => item.competitor === true).length;
  const knownSchool = profiles.filter(item => item.school === true).length;
  const empty = (text) => `<div class="market-empty"><strong>暂无市场数据</strong><span>${text}</span></div>`;
  const roleRows = roles.map(role => `<div><span>${escapeHtml(role.label)}</span><b>${role.count}</b><i style="width:${total ? Math.round(role.count / total * 100) : 0}%"></i></div>`).join('');
  const marketCandidateRows = app.cases.slice(0, 8).map(item => { const job = app.jobs.find(entry => entry.id === item.jobId); return `<tr><td><strong>${escapeHtml(item.candidateName || '未命名人才')}</strong><small>${escapeHtml(item.email || '—')}</small></td><td>${escapeHtml(item.roleName || job?.name || '—')}</td><td>${escapeHtml(item.location || job?.location || '—')}</td><td>${escapeHtml(item.company || item.currentCompany || '—')}</td><td>${item.score ? `${item.score} 分` : '—'}</td></tr>`; }).join('');
  root.innerHTML = `<div class="page research-page talent-market-page"><div class="page-title"><div><span class="eyebrow">TALENT MARKET</span><h1>人才市场洞察</h1><p>分析外部人才供给、能力结构和竞品人才分布，支持目标人才发现。</p></div><span class="readonly-badge">外部市场视角</span></div><div class="market-filters"><select aria-label="目标职能"><option>全部职能</option></select><select aria-label="目标城市"><option>全部城市</option></select><select aria-label="目标行业"><option>全部行业</option></select><select aria-label="工作年限"><option>全部工作年限</option></select><select aria-label="分析周期"><option>近 12 个月</option></select><span class="data-status">数据源：待接入外部人才数据</span></div><section class="market-section market-overview"><div class="section-kicker">01 人才市场概览</div><div class="market-metrics"><div class="metric"><b>${total || '—'}</b><span>人才总量</span><small>已接入市场样本</small></div><div class="metric"><b>—</b><span>可触达人才量</span><small>需接入授权数据源</small></div><div class="metric"><b>—</b><span>高匹配人才量</span><small>基于岗位标准计算</small></div><div class="metric"><b>—</b><span>人才活跃度</span><small>需接入活跃信号</small></div><div class="metric"><b>—</b><span>市场趋势</span><small>需持续采集数据</small></div></div></section><section class="surface market-section market-structure"><div class="surface-head"><div><span class="section-kicker">02 人才结构分析</span><h2>人才结构分析</h2><p class="surface-subtitle">按职能、城市、行业、年限、职级和技能查看外部人才分布</p></div><span>结构对比</span></div><div class="surface-body"><div class="market-dimension-list"><span>职能分布</span><span>城市分布</span><span>行业分布</span><span>工作年限</span><span>职级分布</span><span>技能分布</span></div><div class="market-structure-content">${roleRows ? `<div class="decision-list">${roleRows}</div>` : empty('接入外部人才样本后生成结构分布。')}<div class="market-source-note">可按上方筛选条件查看对应人才样本和来源。</div></div></div></section><section class="market-section"><div class="section-kicker">03 人才能力洞察</div><div class="market-grid-three"><section class="surface"><div class="surface-head"><div><h2>核心技能</h2><p class="surface-subtitle">市场中出现频率较高的技能</p></div></div><div class="surface-body market-tags">${keywords.length ? keywords.slice(0, 8).map(keyword => `<span class="research-tag blue">${escapeHtml(keyword)}</span>`).join('') : empty('接入简历技能字段后生成核心技能。')}</div></section><section class="surface"><div class="surface-head"><div><h2>技能组合</h2><p class="surface-subtitle">常见的复合能力组合</p></div></div><div class="surface-body">${empty('接入技能标签后识别复合能力组合。')}</div></section><section class="surface"><div class="surface-head"><div><h2>稀缺技能与能力缺口</h2><p class="surface-subtitle">市场供给与岗位需求的差异</p></div></div><div class="surface-body">${empty('接入岗位要求和市场技能数据后识别稀缺能力。')}</div></section></div></section><section class="market-section"><div class="section-kicker">04 外部人才发现</div><div class="surface market-discovery"><div class="surface-head"><div><h2>外部人才搜索</h2><p class="surface-subtitle">按岗位、公司、城市发现目标人才</p></div><button class="secondary" data-market-connect>配置外部数据源</button></div><div class="surface-body"><div class="discovery-filters"><span>目标岗位</span><span>目标公司</span><span>目标城市</span><span>优质人才</span><span>与人才库去重</span></div>${empty('接入合规的外部人才数据源后，可搜索目标人才并加入人才库。')}</div></div></section><section class="market-section"><div class="section-kicker">05 竞品人才洞察</div><div class="market-grid-two"><section class="surface"><div class="surface-head"><div><h2>竞品公司人才分布</h2><p class="surface-subtitle">公司、岗位和城市的人才规模对比</p></div></div><div class="surface-body">${companies.length ? companies.map(company => `<div class="market-company-row"><span>${escapeHtml(company)}</span><b>—</b></div>`).join('') : empty('接入合规的竞品人才数据后查看聚合分布。')}</div></section><section class="surface"><div class="surface-head"><div><h2>人才流动与重点发现</h2><p class="surface-subtitle">同岗位人才能力结构和流动趋势</p></div></div><div class="surface-body">${empty('系统仅展示公开或已授权的数据，不默认展示个人隐私信息。')}</div></section></div></section><section class="surface connector-note"><div class="surface-head"><div><h2>数据范围说明</h2><p class="surface-subtitle">外部人才发现需要连接合规、授权的数据源</p></div><span class="readonly-badge">待配置</span></div><div class="surface-body checklist"><label><input type="checkbox" disabled> 已授权的招聘平台或人才数据库</label><label><input type="checkbox" disabled> 公开可用的人才信息</label><label><input type="checkbox" disabled> 与现有人才库的去重规则</label><label><input type="checkbox" disabled> 数据使用权限和更新周期</label></div></section></div>`;
  let structureSection = root.querySelector('.market-structure');
  if (structureSection) {
    const wrapper = document.createElement('section');
    wrapper.className = 'market-section market-structure-wrap';
    const title = document.createElement('div');
    title.className = 'section-kicker';
    title.textContent = '02 人才结构分析';
    wrapper.append(title);
    structureSection.parentNode.insertBefore(wrapper, structureSection);
    wrapper.append(structureSection);
    structureSection.classList.remove('market-section');
    structureSection.querySelector('.surface-head .section-kicker')?.remove();
  }
  const structureBody = structureSection?.querySelector('.surface-body');
  const marketFilters = root.querySelector('.market-filters');
  if (structureBody && marketFilters) structureBody.prepend(marketFilters);
  root.querySelector('.market-filters .data-status')?.remove();
  root.querySelector('.market-source-note')?.remove();
  root.querySelector('.market-structure-content')?.classList.add('market-structure-single-column');
  root.querySelectorAll('.market-section').forEach(section => { if (section.querySelector('.section-kicker')?.textContent.includes('03 人才能力洞察')) section.remove(); });
  if (structureBody) structureBody.insertAdjacentHTML('beforeend', `<section class="market-candidate-list"><div class="candidate-list-head"><div><h3>人才明细</h3><p>根据上方筛选条件查看具体人才</p></div><span>${total ? `${total} 人` : '待接入'}</span></div><div class="table-wrap"><table><thead><tr><th>人才</th><th>目标岗位</th><th>城市</th><th>当前公司</th><th>匹配度</th></tr></thead><tbody>${marketCandidateRows || `<tr><td colspan="5">${empty('接入外部人才数据后，在这里查看具体人选及其来源。')}</td></tr>`}</tbody></table></div></section>`);
  const candidateList = structureBody?.querySelector('.market-candidate-list');
  const dimensionList = structureBody?.querySelector('.market-dimension-list');
  const structureContent = structureBody?.querySelector('.market-structure-content');
  if (candidateList && dimensionList && structureContent) {
    candidateList.after(dimensionList);
    dimensionList.after(structureContent);
  }
  root.querySelector('[data-market-connect]')?.addEventListener('click', () => toast('请前往“数据连接”配置合规的外部人才数据源'));
}
function renderInterviewersLegacy() { const withCalls = app.cases.filter(item => item.communicationSummary || item.report || item.transcript); const questions = withCalls.flatMap(item => item.preparation?.questions || []).map(question => typeof question === 'string' ? question : question.question).filter(Boolean); const reportText = withCalls.map(item => `${item.communicationSummary || ''} ${item.report?.recommendationReason || ''}`).join(' '); const followUp = (reportText.match(/追问|核实|确认|风险/g) || []).length; const coverage = withCalls.length ? Math.min(100, Math.round((questions.length / withCalls.length) * 10)) : 0; const interviewerScore = withCalls.length ? Math.min(100, 55 + Math.round(coverage * .25) + Math.min(20, followUp * 2)) : 0; $('#interviewersView').innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">INTERVIEWER REVIEW</span><h1>面试官分析</h1><p>把电话记录和面试总结转化为面试质量反馈，帮助团队持续统一提问和判断标准。</p></div><span class="readonly-badge">分析预览</span></div><div class="research-banner interviewer-banner"><div><span>综合表现分</span><strong>${interviewerScore}<small>/100</small></strong></div><p>${withCalls.length ? `基于 ${withCalls.length} 份已完成沟通记录，当前评分反映问题覆盖、追问深度和记录完整度。` : '尚无完成沟通记录，完成电话沟通后自动生成面试官分析。'}</p><span class="data-status">不作为自动淘汰依据</span></div><div class="research-grid"><section class="surface"><div class="surface-head"><div><h2>面试表现维度</h2><p class="surface-subtitle">月度评价的基础指标</p></div></div><div class="surface-body insight-bars">${insightBar('问题覆盖度', coverage, 100, 'blue')}${insightBar('追问深度', Math.min(100, followUp * 8), 100, 'copper')}${insightBar('记录完整度', withCalls.length ? Math.min(100, Math.round(withCalls.filter(item => item.communicationSummary).length / withCalls.length * 100)) : 0, 100, 'green')}</div></section><section class="surface"><div class="surface-head"><div><h2>建议动作</h2><p class="surface-subtitle">从数据中生成的可执行反馈</p></div></div><div class="surface-body recommendation-list"><p><b>保持：</b>${questions.length ? '继续使用结构化问题，并为每个岗位保留关键核验项。' : '完成首批沟通记录后开始形成个性化建议。'}</p><p><b>加强：</b>${followUp ? '保持对职责边界、项目结果和风险点的连续追问。' : '增加对项目结果、职责边界和离职动机的二次追问。'}</p><p><b>复盘：</b>每月以真实录用结果校准面试标准，避免只看主观印象。</p></div></section></div></div>`; }
function renderInterviewersOld() {
  const withCalls = app.cases.filter(item => item.communicationSummary || item.report || item.transcript);
  const progressed = app.cases.filter(item => ['推荐业务面试', '通过', '已录用'].includes(finalAction(item))).length;
  const rejected = app.cases.filter(item => ['淘汰', '不推荐'].includes(finalAction(item))).length;
  const keywords = ['项目结果', '职责边界', '业务规模', '团队协作', '离职动机'];
  const preferenceStrength = withCalls.length ? Math.min(100, Math.round((progressed / withCalls.length) * 100)) : 0;
  $('#interviewersView').innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">INTERVIEWER PREFERENCE</span><h1>面试官偏好分析</h1><p>根据历史筛选、面试转写和最终结果，总结不同面试官在同岗位或同部门下的真实判断标准。</p></div><span class="readonly-badge">基于历史行为</span></div><div class="research-banner interviewer-banner"><div><span>可分析记录</span><strong>${withCalls.length}<small> 份</small></strong></div><p>${withCalls.length ? `已从 ${withCalls.length} 份沟通记录中提取偏好信号，系统会持续用最终结果校准规则。` : '完成简历筛选和面试记录后，系统会自动形成面试官偏好。'}</p><span class="data-status">不直接替代人工判断</span></div><div class="metrics research-metrics"><div class="metric"><b>${preferenceStrength}%</b><span>偏好稳定度</span><small>基于推进结果</small></div><div class="metric"><b>${progressed}</b><span>推进人选</span><small>进入下一阶段</small></div><div class="metric"><b>${rejected}</b><span>未推进人选</span><small>用于反推风险信号</small></div><div class="metric"><b>${keywords.length}</b><span>高频关注点</span><small>从提问与规则提取</small></div></div><div class="research-grid"><section class="surface"><div class="surface-head"><div><h2>个人筛选偏好</h2><p class="surface-subtitle">系统从历史行为中提取的可解释信号</p></div><span>待确认</span></div><div class="surface-body decision-list">${keywords.map((keyword, index) => `<div><span>${keyword}</span><b>${index < 3 ? '高' : '中'}</b><i style="width:${index < 3 ? 82 - index * 9 : 48}%"></i></div>`).join('')}</div></section><section class="surface"><div class="surface-head"><div><h2>适用范围</h2><p class="surface-subtitle">规则可以按岗位、部门和负责人分别沉淀</p></div></div><div class="surface-body recommendation-list"><p><b>同岗位：</b>识别同一岗位下稳定出现的通过与淘汰标准。</p><p><b>同部门：</b>合并部门内多位面试官的共同偏好。</p><p><b>同负责人：</b>为同一招聘负责人生成可复用的筛选策略。</p><p><b>下一步：</b>确认规则后，可进入筛选规则管理配置“建议直通”或“人工复核”。</p></div></section></div></div>`;
}
function renderInterviewersLegacyCurrent() {
  const records = app.cases.filter(item => item.transcript || item.communicationSummary || item.report);
  const transcripts = app.cases.filter(item => item.transcript);
  const progressed = app.cases.filter(item => ['推荐业务面试', '通过', '已录用'].includes(finalAction(item))).length;
  const followUps = records.reduce((sum, item) => sum + ((`${item.transcript || ''} ${item.communicationSummary || ''}`.match(/追问|核实|确认|风险/g) || []).length), 0);
  const rules = teamRules.length ? teamRules : ['核实候选人个人职责边界与主导程度', '确认核心项目是否上线及可量化结果', '补充业务规模、协作对象和团队分工'];
  const rows = [
    ['项目结果', '高', '面试中重点核实项目是否上线及结果是否可量化'],
    ['个人职责', '高', '区分主导、参与和协作角色'],
    ['业务规模', '中', '确认业务体量、协作范围和团队分工'],
    ['履历风险', '中', '关注时间线缺口、短期任职和职责描述模糊']
  ];
  $('#interviewersView').innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">INTERVIEW ANALYSIS</span><h1>面试官分析</h1><p>统一查看面试官筛选偏好、筛选规则和面试转写复盘结果。</p></div><span class="readonly-badge">数据分析</span></div><div class="research-banner interviewer-banner"><div><span>面试记录</span><strong>${records.length}<small> 份</small></strong></div><p>分析范围：当前工作区内的岗位、候选人、面试记录和结果数据。</p><span class="data-status">${transcripts.length} 份含转写</span></div><div class="metrics research-metrics"><div class="metric"><b>${progressed}</b><span>推进人选</span><small>已进入下一阶段</small></div><div class="metric"><b>${followUps}</b><span>追问信号</span><small>核实与风险关注</small></div><div class="metric"><b>${transcripts.length}</b><span>转写记录</span><small>可用于复盘</small></div><div class="metric"><b>${rules.length}</b><span>筛选规则</span><small>当前工作区</small></div></div><section class="surface"><div class="surface-head"><div><h2>面试官筛选偏好</h2><p class="surface-subtitle">按岗位、部门和负责人沉淀的判断维度</p></div><span>偏好维度</span></div><div class="surface-body decision-list">${rows.map(([label, level, detail], index) => `<div><span><b>${label}</b><small style="display:block;margin-top:4px;color:var(--muted)">${detail}</small></span><b>${level}</b><i style="width:${82 - index * 10}%"></i></div>`).join('')}</div></section><div class="research-grid"><section class="surface"><div class="surface-head"><div><h2>筛选规则</h2><p class="surface-subtitle">硬性条件、加分项与风险信号</p></div><span>${rules.length} 条</span></div><div class="surface-body decision-list">${rules.slice(0, 8).map((rule, index) => `<div><span>${escapeHtml(rule)}</span><b>v${index + 1}</b><i style="width:${Math.max(36, 92 - index * 7)}%"></i></div>`).join('')}</div></section><section class="surface"><div class="surface-head"><div><h2>面试转写复盘</h2><p class="surface-subtitle">提问重点、追问深度与结果关联</p></div><span>${transcripts.length ? '已接入' : '暂无转写'}</span></div><div class="surface-body recommendation-list"><p><b>已抓取转写：</b>${transcripts.length} 份</p><p><b>追问信号：</b>${followUps} 条</p><p><b>记录完整：</b>${records.filter(item => item.communicationSummary && item.report).length} 份</p><p><b>复盘用途：</b>统一同岗位面试问题，验证问题与通过、Offer、入职结果的关联。</p></div></section></div><section class="surface"><div class="surface-head"><div><h2>自动筛选策略</h2><p class="surface-subtitle">符合规则的人选进入建议直通，否则进入人工复核</p></div><span class="readonly-badge">默认人工复核</span></div><div class="surface-body checklist"><label><input type="checkbox" disabled> 满足岗位硬性条件</label><label><input type="checkbox" disabled> 命中面试官偏好维度</label><label><input type="checkbox" disabled> 无高风险信号</label><label><input type="checkbox" disabled> 保留规则版本与命中记录</label></div></section></div>`;
}

function interviewerNameOf(item = {}) {
  const value = item.interviewer || item.interviewerName || item.interview?.interviewer || item.interviewRecord?.interviewer || item.interviewers || '';
  return Array.isArray(value) ? String(value[0] || '') : String(value || '').trim();
}
function interviewerRecords(filters = {}) {
  const moka = app.mokaInterviews.map(item => ({ ...item, source: 'moka', transcriptStatus: item.transcriptStatus || (item.transcript ? 'completed' : 'missing'), transcriptCharacters: Number(item.transcriptCharacters || item.transcript?.length || 0) }));
  const local = app.cases.map(item => ({
    id: item.id, source: 'acecall', candidateName: item.candidateName || '',
    jobName: item.roleName || app.jobs.find(job => job.id === item.jobId)?.name || '未分配岗位',
    jobCategory: app.jobs.find(job => job.id === item.jobId)?.category || '', location: app.jobs.find(job => job.id === item.jobId)?.location || '',
    interviewer: interviewerNameOf(item), round: item.interviewRound || item.interview?.round || item.interviewRecord?.round || '',
    outcome: item.interviewOutcome || item.outcome?.interviewOutcome || item.outcome || '', outcomeStatus: item.outcomeStatus || '', completed: Boolean(item.interviewOutcome || item.interviewPassed !== undefined || item.interviewRejected !== undefined || item.communicationSummary || item.report || item.transcript), interviewPassed: item.interviewPassed === true, interviewRejected: item.interviewRejected === true || item.interviewFailed === true,
    offerAccepted: item.offerAccepted === true, hired: item.hired === true, durationMinutes: Number(item.interviewDuration || item.callDuration || 0) || 0,
    startedAt: item.interviewAt || item.updatedAt || item.createdAt || '', transcript: item.transcript || '', transcriptStatus: item.transcript ? 'completed' : 'missing', transcriptCharacters: item.transcript?.length || 0
  })).filter(item => item.interviewer);
  const records = [...moka, ...local].filter(item => {
    const date = Date.parse(item.startedAt || '') || 0; const days = Number(filters.period || 0); const cutoff = days ? Date.now() - days * 86400000 : 0;
    return (filters.includeIncomplete === true || item.completed !== false) && (!filters.interviewer || item.interviewer === filters.interviewer) && (!filters.job || item.jobName === filters.job) && (!filters.round || item.round === filters.round) && (!cutoff || date >= cutoff);
  });
  return records;
}
function sameInterviewPerson(left, right) {
  const a = String(left || '').replace(/\s+/g, '').toLowerCase();
  const b = String(right || '').replace(/\s+/g, '').toLowerCase();
  return a.length >= 2 && b.length >= 2 && (a === b || a.includes(b) || b.includes(a));
}
function matchImportedTranscript(task, interviews) {
  const hint = task.metadata || {};
  const hintTime = Date.parse(hint.interviewAt || '') || 0;
  const scored = interviews.filter(item => item.source !== 'acecall-local').map(item => {
    const nameMatched = sameInterviewPerson(hint.candidateName, item.candidateName);
    const jobMatched = hint.jobName && item.jobName && (String(item.jobName).includes(hint.jobName) || String(hint.jobName).includes(item.jobName));
    const interviewerMatched = sameInterviewPerson(hint.interviewer, item.interviewer);
    const time = Date.parse(item.startedAt || '') || 0;
    const gap = hintTime && time ? Math.abs(hintTime - time) : 0;
    const timeScore = hintTime && time ? (gap <= 36 * 60 * 60 * 1000 ? 6 : gap <= 7 * 86400000 ? 2 : -4) : 0;
    return { item, score: (nameMatched ? 10 : 0) + (jobMatched ? 4 : 0) + (interviewerMatched ? 4 : 0) + timeScore, time, nameMatched };
  }).filter(entry => entry.nameMatched && entry.score >= 10);
  scored.sort((left, right) => right.score - left.score || (hintTime ? Math.abs((Date.parse(left.item.startedAt || '') || 0) - hintTime) - Math.abs((Date.parse(right.item.startedAt || '') || 0) - hintTime) : right.time - left.time));
  return scored[0]?.item || null;
}
function attachTranscriptImports(interviews, imports) {
  const base = (interviews || []).filter(item => item.source !== 'acecall-local').map(item => ({ ...item }));
  const unmatched = [];
  for (const task of imports || []) {
    const text = String(task.result?.text || '').trim();
    if (!text) continue;
    const hint = task.metadata || {};
    const match = matchImportedTranscript(task, base);
    if (!match) {
      unmatched.push({ id: `local_${task.id}`, source: 'acecall-local', candidateName: hint.candidateName || '', jobName: hint.jobName || '', interviewer: hint.interviewer || '', round: hint.round || '', transcript: text, transcriptStatus: 'completed', transcriptCharacters: text.length, startedAt: hint.interviewAt || task.createdAt || '', fileName: task.fileName, transcriptSource: 'local-moka-download', completed: Boolean(hint.interviewer), outcome: '', interviewPassed: null, interviewRejected: null });
      continue;
    }
    if (!match.transcript || String(match.transcript).length < text.length) {
      match.transcript = text;
      match.transcriptStatus = 'completed';
      match.transcriptCharacters = text.length;
      match.transcriptSource = 'local-moka-download';
      match.transcriptFileName = task.fileName || '';
    }
  }
  return [...base, ...unmatched];
}
function syncInterviewTranscripts() {
  app.mokaInterviews = attachTranscriptImports(app.mokaInterviews, app.transcriptImports);
}
function sameInterviewJob(left, right) {
  const a = String(left || '').replace(/\s+/g, '');
  const b = String(right || '').replace(/\s+/g, '');
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}
function captureMatchesFilters(item, filters = {}) {
  const days = Number(filters.period || 0);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const date = Date.parse(item.startedAt || '') || 0;
  const interviewerOk = !filters.interviewer || sameInterviewPerson(item.interviewer, filters.interviewer);
  const jobOk = !filters.job || sameInterviewJob(item.jobName, filters.job);
  const roundOk = !filters.round || item.round === filters.round;
  const timeOk = !cutoff || date >= cutoff;
  return interviewerOk && jobOk && roundOk && timeOk;
}
function transcriptCaptureEntries(filters = {}) {
  const interviews = app.mokaInterviews.filter(item => item.source !== 'acecall-local');
  return (app.transcriptImports || []).map(task => {
    const text = String(task.result?.text || '').trim();
    const hint = task.metadata || {};
    const match = matchImportedTranscript(task, interviews);
    return {
      id: task.id,
      fileName: task.fileName || hint.fileName || '转写文件',
      capturedAt: task.createdAt || task.updatedAt || '',
      candidateName: match?.candidateName || hint.candidateName || '',
      jobName: match?.jobName || hint.jobName || '',
      hrName: hint.hrName || '',
      interviewer: match?.interviewer || hint.interviewer || '',
      startedAt: match?.startedAt || hint.interviewAt || '',
      round: match?.round || hint.round || '',
      text,
      matched: Boolean(match)
    };
  }).filter(item => item.text && captureMatchesFilters(item, filters)).sort((left, right) => (Date.parse(right.capturedAt || '') || 0) - (Date.parse(left.capturedAt || '') || 0));
}
function interviewResultLabel(item = {}) {
  const schedule = String(item.scheduleStatus || '');
  if (item.interviewPassed === true && item.interviewRejected === true) return '结果冲突';
  if (item.interviewPassed === true) return '通过';
  if (item.interviewRejected === true) return '淘汰';
  if (String(item.outcome || '').includes('待定')) return '待定';
  if (/取消/.test(schedule)) return '已取消';
  if (/未结束|未进行/.test(schedule) || item.completed === false) return '未完成';
  return item.feedback ? '未给结论' : '未评价';
}
function interviewResultClass(label) {
  if (label === '通过') return 'quality quality-good';
  if (label === '淘汰') return 'quality quality-error';
  if (label === '待定' || label === '结果冲突') return 'quality quality-warn';
  return 'quality';
}
function renderInterviewers() {
  const root = $('#interviewersView'); if (!root) return;
  const stored = app.interviewerFilters || {};
  const sourceRecords = [...app.mokaInterviews, ...app.cases.map(item => ({ interviewer: interviewerNameOf(item) }))].filter(item => item.interviewer);
  const capturePool = transcriptCaptureEntries({});
  const interviewers = [...new Set([...sourceRecords.map(item => item.interviewer), ...capturePool.map(item => item.interviewer)].filter(Boolean))];
  const selected = stored.interviewer || '';
  const filters = { interviewer: selected, job: stored.job || '', round: stored.round || '', period: stored.period || '' };
  const allRecords = interviewerRecords({ ...filters, interviewer: '' });
  const records = interviewerRecords(filters);
  const captureForOptions = capturePool.filter(item => !selected || sameInterviewPerson(item.interviewer, selected));
  const jobs = [...new Set([...allRecords.filter(item => !selected || item.interviewer === selected).map(item => item.jobName), ...captureForOptions.map(item => item.jobName)].filter(Boolean))];
  const rounds = [...new Set([...allRecords.filter(item => !selected || item.interviewer === selected).map(item => item.round), ...captureForOptions.map(item => item.round)].filter(Boolean))];
  const outcomes = records.reduce((result, item) => { result.completed += 1; result.passed += item.interviewPassed === true ? 1 : 0; result.rejected += item.interviewRejected === true || item.interviewFailed === true ? 1 : 0; result.pending += item.interviewPassed !== true && item.interviewRejected !== true && item.interviewFailed !== true ? 1 : 0; result.offers += item.offerAccepted || item.hired ? 1 : 0; result.hired += item.hired ? 1 : 0; result.duration += item.durationMinutes || 0; result.evaluated += item.outcome || item.interviewPassed !== null || item.interviewRejected !== null || item.hired ? 1 : 0; return result; }, { completed: 0, passed: 0, rejected: 0, pending: 0, offers: 0, hired: 0, duration: 0, evaluated: 0 });
  const pct = (value, denominator) => denominator ? `${Math.round(value / denominator * 100)}%` : '—';
  const rate = (value, denominator) => denominator ? Math.round(value / denominator * 100) : 0;
  const monthRows = [...new Set(records.map(item => String(item.startedAt || '').slice(0, 7)).filter(value => /^\d{4}-\d{2}$/.test(value)))].sort().slice(-6).map(month => ({ month, count: records.filter(item => String(item.startedAt || '').startsWith(month)).length }));
  const transcriptCoverage = records.length ? rate(records.filter(item => item.transcript).length, records.length) : 0;
  const pendingTranscript = records.filter(item => !item.transcript).length;
  const questionCount = records.reduce((sum, item) => sum + String(item.transcript || '').split(/\n+/).filter(line => /[？?]$/.test(line.trim())).length, 0);
  const followUpSignals = records.reduce((sum, item) => sum + (String(item.transcript || '').match(/为什么|如何|具体|负责|结果|核实|确认|追问/g) || []).length, 0);
  const status = app.mokaInterviewStatus;
  const serverAnalytics = app.mokaAnalytics || {};
  const diagnostics = app.connectionDiagnostics || {};
  const jobSyncCount = status.mokaJobStats?.matched ?? status.mokaJobStats?.fallbackMatched;
  const jobSyncNote = Number.isFinite(jobSyncCount) ? ` · 目标岗位 ${jobSyncCount} 个` : '';
  const lookbackNote = status.filters?.lookbackDays ? `近 ${status.filters.lookbackDays} 天 · ` : '';
  const dataNote = `${status.loading ? '正在读取 Moka 面试数据' : status.error ? `Moka 读取失败：${status.error}` : status.configured ? `${lookbackNote}Moka 只读数据 · 按 13 个目标岗位名称筛选` : 'Moka 接口待配置 · 当前仅展示 AceCall 已标记面试官的数据'}${jobSyncNote} · CloudBase 网关：${diagnostics.error || diagnostics.gateway || '未检查'}${status.warnings?.length ? ` · ${status.warnings.join('；')}` : ''}`;
  const diagnosticRow = (label, value, tone = '') => `<div class="connection-diagnostic-row"><span>${escapeHtml(label)}</span><b class="${tone}">${escapeHtml(value || '未检查')}</b></div>`;
  const selectOptions = (values, value, empty) => `<option value="">${empty}</option>${values.map(item => `<option value="${escapeHtml(item)}"${item === value ? ' selected' : ''}>${escapeHtml(item)}</option>`).join('')}`;
  root.innerHTML = `<div class="page research-page interviewer-analysis-page"><div class="page-title"><div><span class="eyebrow">INTERVIEWER ANALYTICS</span><h1>面试官分析</h1><p>以面试官为主语，查看面试工作量、判断结果和提问方式。</p></div><button class="secondary" type="button" data-refresh-interviewer>刷新 Moka 数据</button></div><div class="interviewer-scope"><div><span>当前面试官</span><strong>${escapeHtml(selected || '尚未识别')}</strong></div><p>${dataNote}</p><span class="data-status">不等同于岗位招聘大盘</span></div><div class="interviewer-filters"><select id="interviewerFilter">${selectOptions(interviewers, selected, '全部面试官')}</select><select id="interviewerJobFilter">${selectOptions(jobs, filters.job, '全部岗位')}</select><select id="interviewerRoundFilter">${selectOptions(rounds, filters.round, '全部面试环节')}</select><select id="interviewerPeriodFilter"><option value=""${!filters.period ? ' selected' : ''}>全部时间</option><option value="30"${filters.period === '30' ? ' selected' : ''}>近 30 天</option><option value="90"${filters.period === '90' ? ' selected' : ''}>近 90 天</option><option value="365"${filters.period === '365' ? ' selected' : ''}>近一年</option></select></div><div class="metrics research-metrics interviewer-metrics"><div class="metric"><b>${outcomes.completed || '—'}</b><span>已完成面试</span><small>${selected || '选择面试官'}参与的记录</small></div><div class="metric"><b>${outcomes.passed || '—'}</b><span>面试通过</span><small>明确通过结论</small></div><div class="metric"><b>${outcomes.rejected || '—'}</b><span>面试淘汰</span><small>明确淘汰/不通过结论</small></div><div class="metric"><b>${outcomes.pending || '—'}</b><span>待评价</span><small>尚未形成结果</small></div><div class="metric"><b>${pct(outcomes.passed, outcomes.completed)}</b><span>面试通过率</span><small>${outcomes.passed} 人通过</small></div><div class="metric"><b>${pct(outcomes.evaluated, outcomes.completed)}</b><span>评价完成率</span><small>有明确结论的面试</small></div></div><section class="surface interviewer-trend-panel"><div class="surface-head"><div><h2>面试量趋势</h2><p class="surface-subtitle">只统计当前面试官的已完成面试</p></div><span>最近 6 个月</span></div><div class="surface-body interviewer-trend">${monthRows.map(row => `<div><span>${escapeHtml(row.month)}</span><i style="height:${Math.max(8, row.count * 16)}px"></i><b>${row.count}</b></div>`).join('') || '<div class="empty">暂无带日期的 Moka 面试记录。</div>'}</div></section>
  </div>`;
  root.querySelector('.interviewer-metrics')?.insertAdjacentHTML('afterend', `<section class="surface interviewer-server-analysis"><div class="surface-head"><div><h2>云端结构化分析</h2><p class="surface-subtitle">由 AceCall 云函数基于 Moka 转写统一计算，便于后续月度复盘</p></div><span>${serverAnalytics.interviewer ? '已生成' : '等待数据'}</span></div><div class="server-analysis-grid"><div><b>${serverAnalytics.interviewer?.score ?? '—'}</b><span>面试表现分</span><small>问题覆盖、追问深度、记录完整度</small></div><div><b>${serverAnalytics.dimensions?.questionCoverage ?? '—'}%</b><span>问题覆盖</span><small>${serverAnalytics.questions?.length || 0} 条问题句</small></div><div><b>${serverAnalytics.dimensions?.followUpDepth ?? '—'}%</b><span>追问深度</span><small>${serverAnalytics.followUpSignals || 0} 个追问信号</small></div><div><b>${serverAnalytics.interviewer?.evaluationRate ?? '—'}%</b><span>评价完成</span><small>${serverAnalytics.interviewer?.evaluated || 0} / ${serverAnalytics.interviewer?.completed || 0} 场</small></div></div><div class="recommendation-list server-analysis-recommendations">${(serverAnalytics.recommendations || ['同步 Moka 后生成面试官改进建议。']).map(item => `<p><b>建议：</b>${escapeHtml(item)}</p>`).join('')}</div><div class="research-tags server-analysis-topics">${(serverAnalytics.topics || []).map(item => `<span class="research-tag blue">${escapeHtml(item.name)} · ${item.mentions}</span>`).join('') || '<span class="muted-text">暂无可识别主题</span>'}</div></section>`);
  root.querySelector('.interviewer-server-analysis')?.insertAdjacentHTML('afterend', `<section class="surface interviewer-data-quality"><div class="surface-head"><div><h2>分析数据质量</h2><p class="surface-subtitle">先区分已完成分析与等待转写，避免把缺失数据当成面试官表现</p></div><span>${records.length ? `${transcriptCoverage}% 已有转写` : '暂无记录'}</span></div><div class="interviewer-quality-grid"><div><b>${records.filter(item => item.source === 'moka').length}</b><span>Moka 面试</span><small>只读来源 · 已抓取 ${status.totalFetched || 0} 条</small></div><div><b>${records.filter(item => item.source === 'acecall').length}</b><span>AceCall 沟通</span><small>本地记录</small></div><div><b>${questionCount || '—'}</b><span>可识别问题</span><small>以问号结尾的句子</small></div><div><b>${followUpSignals || '—'}</b><span>追问信号</span><small>项目、职责与风险核验</small></div><div><b>${pendingTranscript || '—'}</b><span>待处理转写</span><small>${pendingTranscript ? '需要先获取转写' : '当前无缺口'}${status.warnings?.length ? ` · ${status.warnings.length} 项来源提醒` : ''}</small></div></div></section>`);
    const detailRecords = interviewerRecords({ ...filters, includeIncomplete: true }).slice().sort((a, b) => (Date.parse(b.startedAt || '') || 0) - (Date.parse(a.startedAt || '') || 0));
  const feedbackCount = detailRecords.filter(item => String(item.feedback || '').trim()).length;
  const resultCounts = detailRecords.reduce((result, item) => { const label = interviewResultLabel(item); result[label] = (result[label] || 0) + 1; return result; }, {});
  const recordPageSize = 3;
  const recordPageCount = Math.max(1, Math.ceil(detailRecords.length / recordPageSize));
  const recordPage = Math.min(Math.max(1, Number(app.interviewerRecordPage || 1)), recordPageCount);
  app.interviewerRecordPage = recordPage;
  const pageRecords = detailRecords.slice((recordPage - 1) * recordPageSize, recordPage * recordPageSize);
  const pageStart = detailRecords.length ? (recordPage - 1) * recordPageSize + 1 : 0;
  const pageEnd = detailRecords.length ? pageStart + pageRecords.length - 1 : 0;
  const detailRows = pageRecords.map(item => {
    const label = interviewResultLabel(item);
    const feedback = String(item.feedback || '').trim();
    const transcript = String(item.transcript || '').trim();
    return `<tr><td><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.scheduleStatus || (item.completed === false ? '未完成' : '已结束'))}</small></td><td>${escapeHtml(item.jobName || '未识别岗位')}</td><td>${escapeHtml(item.interviewer || '未识别')}</td><td>${escapeHtml(item.round || '—')}</td><td>${escapeHtml(formatDate(item.startedAt))}</td><td><span class="${interviewResultClass(label)}">${escapeHtml(label)}</span></td><td><div class="interview-feedback-cell">${feedback ? escapeHtml(feedback) : '暂无评价'}</div></td><td><div class="interview-feedback-cell">${transcript ? escapeHtml(transcript) : '未抓到转写'}</div></td></tr>`;
  }).join('');
  const transcriptCount = detailRecords.filter(item => String(item.transcript || '').trim()).length;
  const captureEntries = transcriptCaptureEntries(filters);
  const capturePageSize = 3;
  const capturePageCount = Math.max(1, Math.ceil(captureEntries.length / capturePageSize));
  const capturePage = Math.min(Math.max(1, Number(app.transcriptCapturePage || 1)), capturePageCount);
  app.transcriptCapturePage = capturePage;
  const captureVisible = captureEntries.slice((capturePage - 1) * capturePageSize, capturePage * capturePageSize);
  const captureStart = captureEntries.length ? (capturePage - 1) * capturePageSize + 1 : 0;
  const captureEnd = captureEntries.length ? captureStart + captureVisible.length - 1 : 0;
  const captureRows = captureVisible.map(item => `<tr><td><strong>${escapeHtml(item.fileName)}</strong><small>${escapeHtml([formatDate(item.capturedAt), item.hrName ? `安排人 ${item.hrName}` : ''].filter(Boolean).join(' · '))}</small></td><td><span class="${item.matched ? 'quality quality-good' : 'quality quality-warn'}">${item.matched ? '已匹配' : '未匹配'}</span></td><td>${escapeHtml(item.candidateName || '未识别')}</td><td>${escapeHtml(item.interviewer || '未识别')}</td><td>${escapeHtml(item.jobName || '未识别')}</td><td>${escapeHtml(item.round || '—')}</td><td>${escapeHtml(formatInterviewMoment(item.startedAt))}</td><td><div class="interview-feedback-cell">${escapeHtml(item.text)}</div></td></tr>`).join('');
  const capturePager = captureEntries.length > capturePageSize ? `<div class="interview-record-pager"><button type="button" data-capture-page="prev"${capturePage <= 1 ? ' disabled' : ''}>上一页</button><label>第 <select data-capture-page-select>${Array.from({ length: capturePageCount }, (_, index) => `<option value="${index + 1}"${index + 1 === capturePage ? ' selected' : ''}>${index + 1}</option>`).join('')}</select> / ${capturePageCount} 页</label><span>${captureStart}–${captureEnd} / ${captureEntries.length} 份</span><button type="button" data-capture-page="next"${capturePage >= capturePageCount ? ' disabled' : ''}>下一页</button></div>` : '';
  const recordPager = detailRecords.length > recordPageSize ? `<div class="interview-record-pager"><button type="button" data-interview-page="prev"${recordPage <= 1 ? ' disabled' : ''}>上一页</button><label>第 <select data-interview-page-select>${Array.from({ length: recordPageCount }, (_, index) => `<option value="${index + 1}"${index + 1 === recordPage ? ' selected' : ''}>${index + 1}</option>`).join('')}</select> / ${recordPageCount} 页</label><span>${pageStart}–${pageEnd} / ${detailRecords.length} 场</span><button type="button" data-interview-page="next"${recordPage >= recordPageCount ? ' disabled' : ''}>下一页</button></div>` : '';
  root.querySelector('.interviewer-data-quality')?.insertAdjacentHTML('afterend', `<section class="surface transcript-capture-list"><div class="surface-head"><div><h2>转写抓取记录</h2><p class="surface-subtitle">跟随上方的面试官、岗位、环节和时间筛选。每页 3 份，其余分页查看。${captureEntries.filter(item => item.matched).length} 份已匹配，${captureEntries.filter(item => !item.matched).length} 份未匹配。</p></div><span>${captureEntries.length ? `${captureStart}–${captureEnd} / ${captureEntries.length} 份` : '0 份'}</span></div><div class="surface-body table-wrap"><table><thead><tr><th>文件</th><th>抓取状态</th><th>候选人</th><th>面试官</th><th>岗位</th><th>环节</th><th>面试时间</th><th>转写正文</th></tr></thead><tbody>${captureRows || `<tr><td colspan="8"><div class="empty">${filters.interviewer || filters.job || filters.round || filters.period ? '当前筛选条件下没有转写记录。' : '还没有抓到转写文件。助手导入新文件后，点刷新 Moka 数据即可在这里确认。'}</div></td></tr>`}</tbody></table></div>${capturePager}</section><section class="surface interview-record-list"><div class="surface-head"><div><h2>面试记录、结果与评价</h2><p class="surface-subtitle">通过 ${resultCounts['通过'] || 0} · 淘汰 ${resultCounts['淘汰'] || 0} · 待定 ${resultCounts['待定'] || 0} · 有评价 ${feedbackCount} · 有转写 ${transcriptCount}</p></div><span>${detailRecords.length ? `${pageStart}–${pageEnd} / ${detailRecords.length} 场` : '0 场'}</span></div><div class="surface-body table-wrap"><table><thead><tr><th>候选人</th><th>岗位</th><th>面试官</th><th>环节</th><th>时间</th><th>面试结果</th><th>面试反馈</th><th>转写内容</th></tr></thead><tbody>${detailRows || `<tr><td colspan="8"><div class="empty">近 ${status.filters?.lookbackDays || 60} 天还没有匹配到目标岗位的面试记录。</div></td></tr>`}</tbody></table></div>${recordPager}</section>`);
  const keepRecordScroll = () => { const top = window.scrollY; renderInterviewers(); renderInterviewerFollowups(); window.scrollTo(0, top); };
  root.querySelector('[data-capture-page="prev"]')?.addEventListener('click', () => { app.transcriptCapturePage = Math.max(1, capturePage - 1); keepRecordScroll(); });
  root.querySelector('[data-capture-page="next"]')?.addEventListener('click', () => { app.transcriptCapturePage = Math.min(capturePageCount, capturePage + 1); keepRecordScroll(); });
  root.querySelector('[data-capture-page-select]')?.addEventListener('change', event => { app.transcriptCapturePage = Number(event.target.value) || 1; keepRecordScroll(); });
  root.querySelector('[data-interview-page="prev"]')?.addEventListener('click', () => { app.interviewerRecordPage = Math.max(1, recordPage - 1); keepRecordScroll(); });
  root.querySelector('[data-interview-page="next"]')?.addEventListener('click', () => { app.interviewerRecordPage = Math.min(recordPageCount, recordPage + 1); keepRecordScroll(); });
  root.querySelector('[data-interview-page-select]')?.addEventListener('change', event => { app.interviewerRecordPage = Number(event.target.value) || 1; keepRecordScroll(); });
  ['interviewerFilter', 'interviewerJobFilter', 'interviewerRoundFilter', 'interviewerPeriodFilter'].forEach(id => { $(`#${id}`)?.addEventListener('change', () => { app.interviewerFilters = { interviewer: $('#interviewerFilter')?.value || '', job: $('#interviewerJobFilter')?.value || '', round: $('#interviewerRoundFilter')?.value || '', period: $('#interviewerPeriodFilter')?.value || '' }; app.interviewerRecordPage = 1; app.transcriptCapturePage = 1; renderInterviewers(); renderInterviewerFollowups(); }); });
  root.querySelector('[data-refresh-interviewer]')?.addEventListener('click', async event => { event.currentTarget.disabled = true; await loadMokaInterviews({ force: true }); await loadInterviewerLibrary(); await loadTranscriptImports(); renderInterviewers(); renderInterviewerFollowups(); });
}

function interviewerInsightSessions() {
  const filters = app.interviewerFilters || {};
  const captured = transcriptCaptureEntries(filters).slice(0, 6).map(item => ({
    candidateName: item.candidateName || '',
    jobName: item.jobName || '',
    interviewer: item.interviewer || '',
    round: item.round || '',
    startedAt: item.startedAt || '',
    text: String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  })).filter(item => item.text.length >= 40);
  if (captured.length) return captured;
  return interviewerRecords(filters).filter(item => String(item.transcript || '').trim().length >= 40).slice(0, 6).map(item => ({
    candidateName: item.candidateName || '',
    jobName: item.jobName || '',
    interviewer: item.interviewer || '',
    round: item.round || '',
    startedAt: item.startedAt || '',
    text: String(item.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  }));
}
function interviewerInsightKey(sessions) {
  const filters = app.interviewerFilters || {};
  return JSON.stringify({ interviewer: filters.interviewer || '', job: filters.job || '', round: filters.round || '', period: filters.period || '', sessions: sessions.map(item => [item.candidateName, item.jobName, item.interviewer, item.startedAt, item.text.length, item.text.slice(0, 24)]) });
}
function interviewerInsightHtml(result = {}) {
  const questions = (result.questions || []).map(item => String(item || '').trim()).filter(Boolean);
  const themes = (result.themes || []).map(item => `<p><b>${escapeHtml(item.name || '主题')}：</b>${escapeHtml(item.detail || '')}</p>`).join('');
  const questionList = questions.length ? `<div class="interviewer-question-list">${questions.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '<p>转写里没有提炼出可复用的问句。</p>';
  if (!result.summary && !questions.length && !themes) return '<p>这次没有形成可展示的分析。</p>';
  return `<p><b>提问偏好：</b>${escapeHtml(result.summary || '暂无总结')}</p><p><b>高频问题：</b></p>${questionList}${themes}<p><b>追问方式：</b>${escapeHtml(result.followUpStyle || '暂无')}</p>`;
}
function renderInterviewerFollowups() {
  const root = $('#interviewersView'); const page = root?.querySelector('.interviewer-analysis-page'); if (!page) return;
  const selected = app.interviewerFilters?.interviewer || '';
  const filters = app.interviewerFilters || {};
  const records = interviewerRecords({ ...filters, interviewer: selected });
  const transcripts = records.map(item => String(item.transcript || '')).filter(Boolean);
  const questionLines = transcripts.flatMap(text => text.split(/\n+/).map(line => line.trim()).filter(line => /[？?]$/.test(line) && line.length >= 6));
  const followUpCount = transcripts.reduce((sum, text) => sum + (text.match(/为什么|如何|具体|负责|结果|核实|确认|追问/g) || []).length, 0);
  const coverage = transcripts.length ? Math.min(100, Math.round(questionLines.length / transcripts.length * 12)) : 0;
  const completeness = records.length ? Math.round(records.filter(item => item.outcome || item.interviewPassed || item.hired).length / records.length * 100) : 0;
  const depth = transcripts.length ? Math.min(100, Math.round(followUpCount / transcripts.length * 8)) : 0;
  const sessions = interviewerInsightSessions();
  const insightKey = interviewerInsightKey(sessions);
  const cached = app.interviewerInsight?.key === insightKey ? app.interviewerInsight.result : null;
  const insightHtml = cached ? interviewerInsightHtml(cached) : (sessions.length ? '<p>正在根据当前筛选的转写分析提问偏好…</p>' : '<p>当前筛选下还没有可分析的转写。</p>');
  const score = records.length ? Math.round(coverage * .35 + depth * .35 + completeness * .3) : 0;
  const interviewerNames = [...new Set(interviewerRecords({}).map(item => item.interviewer).filter(Boolean))];
  const comparison = interviewerNames.map(name => { const items = interviewerRecords({ interviewer: name }); const passed = items.filter(item => item.interviewPassed).length; const hired = items.filter(item => item.hired).length; return { name, count: items.length, passed, hired, passRate: items.length ? Math.round(passed / items.length * 100) : 0 }; }).sort((a, b) => b.count - a.count);
  const comparePageSize = 5;
  const comparePageCount = Math.max(1, Math.ceil(comparison.length / comparePageSize));
  const comparePage = Math.min(Math.max(1, Number(app.interviewerComparePage || 1)), comparePageCount);
  app.interviewerComparePage = comparePage;
  const compareVisible = comparison.slice((comparePage - 1) * comparePageSize, comparePage * comparePageSize);
  const compareStart = comparison.length ? (comparePage - 1) * comparePageSize + 1 : 0;
  const compareEnd = comparison.length ? compareStart + compareVisible.length - 1 : 0;
  const comparePager = comparison.length > comparePageSize ? `<div class="interview-record-pager"><button type="button" data-compare-page="prev"${comparePage <= 1 ? ' disabled' : ''}>上一页</button><label>第 <select data-compare-page-select>${Array.from({ length: comparePageCount }, (_, index) => `<option value="${index + 1}"${index + 1 === comparePage ? ' selected' : ''}>${index + 1}</option>`).join('')}</select> / ${comparePageCount} 页</label><span>${compareStart}–${compareEnd} / ${comparison.length} 位</span><button type="button" data-compare-page="next"${comparePage >= comparePageCount ? ' disabled' : ''}>下一页</button></div>` : '';
  const section = document.createElement('section'); section.className = 'interviewer-followups'; section.innerHTML = `<div class="research-grid interviewer-analysis-grid"><section class="surface"><div class="surface-head"><div><h2>面试问题与偏好</h2><p class="surface-subtitle">按上方筛选提炼可复用的短问句。转写原文在页面底部的抓取记录里，这里不再重复</p></div><span>${sessions.length} 份转写</span></div><div class="surface-body recommendation-list interviewer-insight" data-interviewer-insight>${insightHtml}</div></section><section class="surface"><div class="surface-head"><div><h2>面试官阶段评分</h2><p class="surface-subtitle">第三阶段：只评价面试过程质量，不替代录用决定</p></div><span class="interviewer-score-badge">${score || '—'}${score ? '/100' : ''}</span></div><div class="surface-body interviewer-score-grid"><div><span>问题覆盖</span><b>${coverage || '—'}</b></div><div><span>追问深度</span><b>${depth || '—'}</b></div><div><span>结论完整</span><b>${completeness || '—'}</b></div></div></section></div><section class="surface interviewer-team-compare"><div class="surface-head"><div><h2>团队面试官对比</h2><p class="surface-subtitle">每页 5 位，其余分页查看</p></div><span>${comparison.length ? `${compareStart}–${compareEnd} / ${comparison.length} 位` : '0 位'}</span></div><div class="surface-body table-wrap"><table><thead><tr><th>面试官</th><th>已完成面试</th><th>通过率</th><th>最终入职</th><th>相对当前</th></tr></thead><tbody>${compareVisible.map(row => `<tr class="${row.name === selected ? 'current-interviewer-row' : ''}"><td><strong>${escapeHtml(row.name)}</strong>${row.name === selected ? '<small>当前查看</small>' : ''}</td><td>${row.count}</td><td>${row.count ? `${row.passRate}%` : '—'}</td><td>${row.hired}</td><td>${selected && row.name !== selected ? (row.passRate > (comparison.find(item => item.name === selected)?.passRate || 0) ? '通过率较高' : row.passRate < (comparison.find(item => item.name === selected)?.passRate || 0) ? '通过率较低' : '接近') : '—'}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">接入更多面试官数据后展示团队对比。</div></td></tr>'}</tbody></table></div>${comparePager}</section>`;
  page.append(section);
  const captureList = page.querySelector('.transcript-capture-list');
  const recordList = page.querySelector('.interview-record-list');
  if (captureList) page.append(captureList);
  if (recordList) page.append(recordList);
  const keepCompareScroll = () => { const top = window.scrollY; renderInterviewers(); renderInterviewerFollowups(); window.scrollTo(0, top); };
  section.querySelector('[data-compare-page="prev"]')?.addEventListener('click', () => { app.interviewerComparePage = Math.max(1, comparePage - 1); keepCompareScroll(); });
  section.querySelector('[data-compare-page="next"]')?.addEventListener('click', () => { app.interviewerComparePage = Math.min(comparePageCount, comparePage + 1); keepCompareScroll(); });
  section.querySelector('[data-compare-page-select]')?.addEventListener('change', event => { app.interviewerComparePage = Number(event.target.value) || 1; keepCompareScroll(); });
  if (!cached && sessions.length && app.interviewerInsightLoading !== insightKey) {
    app.interviewerInsightLoading = insightKey;
    generate({ action: 'review-interviewer', interviewer: selected, job: filters.job || '', round: filters.round || '', sessions }).then(result => {
      if (interviewerInsightKey(interviewerInsightSessions()) !== insightKey) return;
      app.interviewerInsight = { key: insightKey, result };
      const box = document.querySelector('[data-interviewer-insight]');
      if (box) box.innerHTML = interviewerInsightHtml(result);
    }).catch(error => {
      if (interviewerInsightKey(interviewerInsightSessions()) !== insightKey) return;
      const box = document.querySelector('[data-interviewer-insight]');
      if (box) box.innerHTML = `<p>分析没有完成：${escapeHtml(error.message || 'AI 服务暂时不可用')}</p>`;
    }).finally(() => { if (app.interviewerInsightLoading === insightKey) app.interviewerInsightLoading = ''; });
  }
}

function renderScreeningRules() {
  const root = $('#screeningRulesView');
  const rules = teamRules.length ? teamRules : ['核实候选人个人职责边界与主导程度', '确认核心项目是否上线及可量化结果', '补充业务规模、协作对象和团队分工'];
  const autoMode = Boolean(app.screeningAutoMode);
  root.innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">SCREENING RULES</span><h1>筛选规则管理</h1><p>管理面试官、岗位、部门和负责人共同使用的筛选规则，并控制是否允许建议直通面试。</p></div><span class="readonly-badge">版本化管理</span></div><div class="research-banner"><div><span>当前规则</span><strong>${rules.length}<small> 条</small></strong></div><p>规则由历史筛选行为和面试转写总结生成，发布前需要招聘负责人确认。</p><span class="data-status">默认人工复核</span></div><section class="surface"><div class="surface-head"><div><h2>直通面试策略</h2><p class="surface-subtitle">符合稳定规则的人选可以减少重复初筛，但不自动淘汰候选人。</p></div><label class="setting-row"><span>允许建议直通</span><input type="checkbox" id="screeningAutoMode" ${autoMode ? 'checked' : ''}></label></div><div class="surface-body recommendation-list"><p><b>建议直通：</b>硬性条件满足、偏好条件达到阈值，且没有高风险信号。</p><p><b>人工复核：</b>存在履历缺口、职责不清或规则置信度不足时暂停自动推进。</p><p><b>操作留痕：</b>记录使用的规则版本、命中条件、风险信号和最终面试结果。</p></div></section><div class="research-grid"><section class="surface"><div class="surface-head"><div><h2>硬性条件</h2><p class="surface-subtitle">不满足时进入人工复核</p></div></div><div class="surface-body checklist"><label><input type="checkbox" checked disabled> 岗位关键经历或必要技能</label><label><input type="checkbox" checked disabled> 工作地点与到岗条件</label><label><input type="checkbox" checked disabled> 必要年限或职级范围</label></div></section><section class="surface"><div class="surface-head"><div><h2>加分与风险信号</h2><p class="surface-subtitle">用于解释匹配分和复核原因</p></div></div><div class="surface-body research-tags"><span class="research-tag blue">竞品经历</span><span class="research-tag blue">量化项目结果</span><span class="research-tag">频繁短期任职</span><span class="research-tag">职责描述模糊</span></div></section></div><section class="surface"><div class="surface-head"><div><h2>团队规则库</h2><p class="surface-subtitle">当前岗位和团队可复用的规则</p></div><span>${rules.length} 条</span></div><div class="surface-body decision-list">${rules.slice(0, 12).map((rule, index) => `<div><span>${escapeHtml(rule)}</span><b>v${index + 1}</b><i style="width:${Math.max(28, 92 - index * 5)}%"></i></div>`).join('')}</div></section></div>`;
  $('#screeningAutoMode')?.addEventListener('change', event => { app.screeningAutoMode = event.target.checked; toast(event.target.checked ? '已开启建议直通，仍保留人工复核' : '已恢复人工复核模式'); });
}
function renderTranscriptReview() {
  const records = app.cases.filter(item => item.transcript || item.communicationSummary || item.report);
  const transcripts = app.cases.filter(item => item.transcript);
  const followUps = records.reduce((sum, item) => sum + ((`${item.transcript || ''} ${item.communicationSummary || ''}`.match(/追问|核实|确认|风险/g) || []).length), 0);
  const complete = records.filter(item => item.communicationSummary && item.report).length;
  $('#transcriptReviewView').innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">INTERVIEW TRANSCRIPT REVIEW</span><h1>面试转写复盘</h1><p>抓取并分析面试转写，提取面试官提问重点、追问深度与候选人回答中的决策信号。</p></div><span class="readonly-badge">合规留痕</span></div><div class="research-banner"><div><span>已分析记录</span><strong>${records.length}<small> 份</small></strong></div><p>录音或转写需要在取得候选人告知同意后进入分析，系统保留原始记录、总结和最终结果的关联。</p><span class="data-status">${transcripts.length ? `${transcripts.length} 份含转写` : '等待转写数据'}</span></div><div class="metrics research-metrics"><div class="metric"><b>${transcripts.length}</b><span>已抓取转写</span><small>原始文本</small></div><div class="metric"><b>${followUps}</b><span>追问信号</span><small>核实与风险词</small></div><div class="metric"><b>${complete}</b><span>完整复盘</span><small>总结与结果齐全</small></div><div class="metric"><b>${records.length ? Math.round(complete / records.length * 100) : 0}%</b><span>记录完整度</span><small>可用于规则学习</small></div></div><div class="research-grid"><section class="surface"><div class="surface-head"><div><h2>高频面试关注点</h2><p class="surface-subtitle">从准备问题、转写和总结中归纳</p></div></div><div class="surface-body research-tags"><span class="research-tag blue">项目结果</span><span class="research-tag blue">个人职责</span><span class="research-tag blue">业务规模</span><span class="research-tag">离职动机</span><span class="research-tag">风险核实</span></div></section><section class="surface"><div class="surface-head"><div><h2>复盘建议</h2><p class="surface-subtitle">帮助团队校准面试标准</p></div></div><div class="surface-body recommendation-list"><p><b>统一：</b>将同岗位高频问题沉淀为结构化面试清单。</p><p><b>追踪：</b>关联面试通过、Offer 和入职结果，验证问题的预测价值。</p><p><b>保护：</b>转写分析仅用于招聘质量复盘，不直接作为自动淘汰依据。</p></div></section></div></div>`;
}
 function renderIntelligenceResearchPage() {
   const topic = app.intelligenceTopic || '';
   const records = intelligenceRecords({ source: app.intelligenceSource });
   const sourceSummary = intelligenceSourceSummary();
   const companies = intelligenceRecords({ source: app.intelligenceSource });
   const industries = intelligenceDimensionRecords('industry', records, { source: app.intelligenceSource });
   const products = intelligenceDimensionRecords('product', records, { source: app.intelligenceSource });
   const businesses = intelligenceDimensionRecords('business', records, { source: app.intelligenceSource });
   const totalObjects = new Set([...companies.map(item => item.key), ...industries.map(item => item.key), ...products.map(item => item.key), ...businesses.map(item => item.key)]).size;
   const topicConfig = {
     industry: { title: '行业趋势', desc: '技术方向、岗位要求与行业变化', data: industries, label: '行业' },
     company: { title: '公司动态', desc: '企业变化、组织调整与招聘需求', data: companies, label: '公司' },
     talent: { title: '人才趋势', desc: '热门技能、经验要求与人才供需', data: [...products, ...businesses], label: '人才主题' },
     all: { title: '全部线索', desc: '搜索、筛选和追溯全部来源', data: [...companies, ...industries, ...products, ...businesses], label: '线索' }
   };
   const current = topicConfig[topic];
   const insightRows = [
     industries[0] ? { type: '行业趋势', title: `${industries[0].name}相关岗位关注度上升`, source: industries[0].sources?.join(' / ') || '招聘材料', status: '待核实', evidence: industries[0].evidence } : null,
     companies[0] ? { type: '公司动态', title: `${companies[0].name}出现人才经历信号`, source: companies[0].sources?.join(' / ') || '候选人简历', status: '待核实', evidence: companies[0].evidence } : null,
     products[0] ? { type: '人才趋势', title: `${products[0].name}成为候选人能力关键词`, source: products[0].sources?.join(' / ') || '面试转写', status: '待核实', evidence: products[0].evidence } : null
   ].filter(Boolean);
   const insightMarkup = insightRows.length ? insightRows.slice(0, 3).map(row => `<article class="intelligence-insight-row"><div class="intelligence-insight-top"><span class="intelligence-topic-pill">${escapeHtml(row.type)}</span><strong>${escapeHtml(row.title)}</strong><span class="intelligence-insight-status">${row.status}</span></div><p>${escapeHtml(row.evidence || '已从招聘材料中识别，等待原文核实。')}</p><small>来源：${escapeHtml(row.source)}</small></article>`).join('') : '<div class="intelligence-home-empty">暂无可展示的近期洞察。完成简历解析或转写同步后，这里会显示有证据的摘要。</div>';
   const topicCards = [['industry','⌁','行业趋势','技术方向、岗位要求、行业变化'],['company','▥','公司动态','企业变化、组织调整、招聘需求'],['talent','♧','人才趋势','热门技能、经验要求、人才供需'],['all','⌕','全部线索','线索搜索、筛选及来源追溯']];
   const detailRows = current ? current.data.slice(0, 60).map(item => `<button type="button" class="intelligence-detail-row" data-intelligence-object="${escapeHtml(item.key)}"><span><strong>${escapeHtml(item.name)}</strong><small>${item.count || 1} 条材料 · ${(item.sources || []).join(' / ') || '来源待确认'}</small></span><b>${escapeHtml(item.confidence || '中')}</b></button>`).join('') : '';
   const industrySignalRows = industries.slice(0, 4).map(item => `<article class="intelligence-insight-row"><div class="intelligence-insight-top"><span class="intelligence-topic-pill">行业信号</span><strong>${escapeHtml(item.name)}相关要求出现</strong><span class="intelligence-insight-status">待核证</span></div><p>${escapeHtml(item.evidence || `在 ${item.count} 条招聘材料中出现`)}</p><small>来源：${escapeHtml((item.sources || []).join(' / ') || '招聘材料')} · ${item.count} 条材料</small></article>`).join('');
   const industryCards = industries.slice(0, 12).map(item => `<button type="button" class="intelligence-industry-card" data-intelligence-object="${escapeHtml(item.key)}"><span>${escapeHtml(item.name)}</span><strong>${item.count}</strong><small>条材料命中 · ${(item.sources || []).join(' / ') || '来源待确认'}</small></button>`).join('');
   const selectedIndustryObject = app.intelligenceIndustryDetail ? industries.find(item => item.key === app.intelligenceIndustryDetail) : null;
   const selectedIndustryName = selectedIndustryObject?.name || '';
   const industrySourceIds = selectedIndustryName ? intelligenceSourceRecords().filter(source => !app.intelligenceSource || source.sourceType === app.intelligenceSource).map((source, index) => ({ source, id: source.id || source._id || `${source.sourceType}-${index}` })).filter(({ source }) => `${source.transcript || ''}\n${source.resume || ''}\n${source.communicationSummary?.overview || ''}`.toLowerCase().includes(selectedIndustryName.toLowerCase())).map(item => item.id) : [];
   const industrySourceSet = new Set(industrySourceIds);
   const scopedIndustrySources = intelligenceSourceRecords().filter(source => !app.intelligenceSource || source.sourceType === app.intelligenceSource);
   const relatedInSameEvidence = (item) => selectedIndustryName && (item.recordKeys || []).some(key => {
     if (!industrySourceSet.has(key)) return false;
     const source = scopedIndustrySources.find((candidate, index) => (candidate.id || candidate._id || `${candidate.sourceType}-${index}`) === key);
     if (!source) return false;
     const text = `${source.transcript || ''}\n${source.resume || ''}\n${source.communicationSummary?.overview || ''}`;
     const lower = text.toLowerCase(); const industryIndex = lower.indexOf(selectedIndustryName.toLowerCase()); const itemIndex = lower.indexOf(String(item.name || '').toLowerCase());
     return industryIndex >= 0 && itemIndex >= 0 && Math.abs(industryIndex - itemIndex) <= 320;
   });
   // Company history belongs to the same candidate record, so resume companies
   // remain visible even when the company name is not repeated in the transcript.
   const relatedCompanies = selectedIndustryName ? companies.filter(item => (item.recordKeys || []).some(key => industrySourceSet.has(key))).slice(0, 8) : [];
   const relatedProducts = selectedIndustryName ? products.filter(relatedInSameEvidence).slice(0, 8) : [];
   const relatedBusinesses = selectedIndustryName ? businesses.filter(relatedInSameEvidence).slice(0, 8) : [];
   const selectedSourceDetail = selectedIndustryObject?.sourceDetails?.[0];
   const selectedSourceLabel = selectedSourceDetail ? `${selectedSourceDetail.candidateName || '未命名候选人'}${selectedSourceDetail.interviewer ? ` · 面试官：${selectedSourceDetail.interviewer}` : ''}${selectedSourceDetail.startedAt ? ` · ${formatDate(selectedSourceDetail.startedAt)}` : ''}` : '正式面试转写';
   const selectedIndustryDetail = selectedIndustryObject ? `<section class="surface intelligence-selected-industry"><div class="surface-head"><div><h2>${escapeHtml(selectedIndustryName)}</h2><p class="surface-subtitle">当前行业的真实材料详情 · ${selectedIndustryObject.count} 条材料命中</p></div><button class="link-action" type="button" data-intelligence-industry-close>收起详情</button></div><div class="surface-body"><div class="intelligence-selected-evidence"><span>行业证据</span><p>${escapeHtml(selectedIndustryObject.evidence || '当前材料中已命中该行业词，暂无可展示的完整句子。')}</p><small>来源：${escapeHtml((selectedIndustryObject.sources || []).join(' / ') || '招聘材料')}</small></div><div class="intelligence-related-grid"><div><strong>关联公司</strong>${relatedCompanies.map(item => `<button type="button" data-intelligence-related-company="${escapeHtml(item.key)}"><span>${escapeHtml(item.name)}</span><small>${item.count} 条材料</small></button>`).join('') || '<em>暂无明确关联公司</em>'}</div><div><strong>关联产品 / 业务</strong>${[...relatedProducts, ...relatedBusinesses].map(item => `<span>${escapeHtml(item.name)} <small>${item.count} 条</small></span>`).join('') || '<em>暂无明确关联产品或业务</em>'}</div></div></div></section>` : '';
   const industryDetail = `<div class="intelligence-industry-page"><div class="intelligence-industry-metrics"><div><span>涉及行业</span><strong>${industries.length}</strong><small>来源数据</small></div><div><span>趋势信号</span><strong>${industries.reduce((sum, item) => sum + item.count, 0)}</strong><small>命中材料</small></div><div><span>待核实信号</span><strong>${industries.length}</strong><small>需要人工确认</small></div></div><section class="surface intelligence-recent"><div class="surface-head"><div><h2>近期趋势信号</h2><p class="surface-subtitle">从真实简历、电话沟通和正式面试转写中提取</p></div><button class="link-action" type="button" data-intelligence-home>返回首页 →</button></div><div class="surface-body">${industrySignalRows || '<div class="intelligence-home-empty">暂无行业信号，请先同步转写或导入简历。</div>'}</div></section><section class="surface intelligence-topics"><div class="surface-head"><div><h2>按行业查看</h2><p class="surface-subtitle">以下行业来自真实材料命中，不是预设行业清单</p></div></div><div class="intelligence-industry-grid">${industryCards || '<div class="intelligence-home-empty">当前没有可匹配的行业。</div>'}</div></section>${selectedIndustryDetail}</div>`;
   const companyQuery = String(app.intelligenceQuery || '').trim().toLowerCase();
   const filteredCompanyRecords = companies.filter(item => !companyQuery || `${item.name} ${(item.industries || []).join(' ')} ${(item.products || []).join(' ')} ${(item.businesses || []).join(' ')}`.toLowerCase().includes(companyQuery));
   const companyFilters = [...new Set(companies.flatMap(item => [...(item.industries || []), ...(item.products || [])]))].slice(0, 8);
   const companyListRows = filteredCompanyRecords.slice(0, 50).map((item, index) => `<button type="button" class="intelligence-company-card ${index === 0 ? 'active' : ''}" data-intelligence-company="${escapeHtml(item.key)}"><span class="intelligence-company-mark">▥</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml([...(item.industries || []), ...(item.businesses || [])].slice(0, 3).join(' · ') || '来自招聘材料的公司经历')}</small><i>${item.count} 条材料 · ${(item.sources || []).join(' / ') || '来源待确认'}</i></span><b>›</b></button>`).join('');
   const companyDynamics = filteredCompanyRecords.slice(0, 4).map(item => `<article class="intelligence-company-dynamic"><span class="intelligence-dynamic-icon">⌁</span><div><strong>${escapeHtml(item.name)}相关招聘信号</strong><p>${escapeHtml(item.evidence || '已在招聘材料中识别到该公司信息，等待进一步核实。')}</p><small>来源：${escapeHtml((item.sources || []).join(' / ') || '招聘材料')} · ${item.count} 条材料</small></div></article>`).join('');
   const companyDetail = `<div class="intelligence-company-page"><div class="intelligence-company-toolbar"><input id="intelligenceCompanySearch" type="search" value="${escapeHtml(app.intelligenceQuery || '')}" placeholder="搜索公司名称、品牌或产品"><button type="button" data-intelligence-company-clear>＋</button></div><div class="intelligence-company-filter-row"><button class="active" type="button" data-company-filter="">全部公司</button>${companyFilters.map(filter => `<button type="button" data-company-filter="${escapeHtml(filter)}">${escapeHtml(filter)}</button>`).join('')}</div><section class="surface intelligence-company-list-surface"><div class="surface-head"><div><h2>企业列表</h2><p class="surface-subtitle">只展示在真实招聘材料中出现的公司</p></div><button class="link-action" type="button" data-intelligence-home>返回首页 →</button></div><div class="surface-body intelligence-company-list">${companyListRows || '<div class="intelligence-home-empty">当前没有识别到公司名称。</div>'}</div></section><section class="surface intelligence-company-dynamics"><div class="surface-head"><div><h2>近期公司动态</h2><p class="surface-subtitle">由公司相关材料证据整理，不补写外部新闻</p></div></div><div class="surface-body">${companyDynamics || '<div class="intelligence-home-empty">暂无公司动态信号。</div>'}</div></section></div>`;
   const root = $('#intelligenceView');
   if (current) {
     root.innerHTML = `<div class="page research-page intelligence-research-page"><div class="page-title"><div><button class="intelligence-back" type="button" data-intelligence-home>← 行业情报</button><h1>${current.title}</h1><p>${current.desc}</p></div><select id="intelligenceTopicSource"><option value="">全部来源</option><option>正式面试转写</option><option>电话沟通转写</option><option>候选人简历</option></select></div>${topic === 'industry' ? industryDetail : topic === 'company' ? companyDetail : `<div class="intelligence-detail-layout"><section class="surface"><div class="surface-head"><div><h2>${current.label}线索</h2><p class="surface-subtitle">${current.data.length} 个对象，点击查看来源和证据</p></div></div><div class="surface-body intelligence-detail-list">${detailRows || '<div class="intelligence-home-empty">当前主题暂无线索。</div>'}</div></section><section class="surface intelligence-topic-explainer"><div class="surface-head"><div><h2>这个主题怎么看</h2><p class="surface-subtitle">只展示有来源的招聘材料</p></div></div><div class="surface-body"><p>${topic === 'talent' ? '人才趋势由产品、业务等能力词汇组成，用于观察岗位技能和候选人经验分布。' : '全部线索汇总公司、行业、产品和业务对象，可通过关键词追溯原文。'}</p><div class="intelligence-source-mini"><b>${sourceSummary.total}</b><span>份材料已纳入分析</span></div></div></section></div>`}</div>`;
     const evidenceLabel = $('#intelligenceView .intelligence-selected-evidence span'); if (evidenceLabel) evidenceLabel.textContent = '面试转写要点（原文整理）';
     const evidenceSource = $('#intelligenceView .intelligence-selected-evidence small'); if (evidenceSource && selectedSourceDetail) evidenceSource.textContent = `来源：正式面试转写 · ${selectedSourceLabel}`;
     const source = $('#intelligenceTopicSource'); if (source) { source.value = app.intelligenceSource || ''; source.addEventListener('change', event => { app.intelligenceSource = event.target.value; source.value = app.intelligenceSource || ''; renderIntelligence(); }); }
     $('#intelligenceView [data-intelligence-home]')?.addEventListener('click', () => { app.intelligenceTopic = ''; renderIntelligence(); });
     $$('#intelligenceView [data-intelligence-object]').forEach(button => button.addEventListener('click', () => { app.intelligenceSelected = button.dataset.intelligenceObject; if (topic === 'industry') { app.intelligenceIndustryDetail = button.dataset.intelligenceObject; renderIntelligence(); } else toast('已选中线索，可在对象详情中查看原文证据'); }));
     $('#intelligenceCompanySearch')?.addEventListener('input', event => { app.intelligenceQuery = event.target.value; renderIntelligence(); });
     $('#intelligenceView [data-intelligence-company-clear]')?.addEventListener('click', () => { app.intelligenceQuery = ''; renderIntelligence(); });
     $$('#intelligenceView [data-company-filter]').forEach(button => button.addEventListener('click', () => { app.intelligenceQuery = button.dataset.companyFilter || ''; renderIntelligence(); }));
     $$('#intelligenceView [data-intelligence-related-company]').forEach(button => button.addEventListener('click', () => toast('已选中关联公司，可继续查看其来源证据')));
     $('#intelligenceView [data-intelligence-industry-close]')?.addEventListener('click', () => { app.intelligenceIndustryDetail = ''; renderIntelligence(); });
     return;
   }
   root.innerHTML = `<div class="page research-page intelligence-research-page"><div class="page-title"><div><span class="eyebrow">MARKET INTELLIGENCE</span><h1>行业情报</h1><p>从招聘沟通中发现行业、公司与人才市场变化</p></div><select id="intelligenceHomePeriod"><option>近 30 天</option><option>近 90 天</option><option>全部时间</option></select></div><div class="intelligence-home-metrics"><div class="intelligence-home-metric"><span>新增洞察线索</span><strong>${insightRows.length || 0}</strong><small>近期新增的有效信息</small></div><div class="intelligence-home-metric"><span>涉及公司</span><strong>${companies.length}</strong><small>已关联的公司主体</small></div></div><section class="surface intelligence-recent"><div class="surface-head"><div><h2>近期重点发现</h2><p class="surface-subtitle">从招聘沟通中提炼的近期有效信号</p></div><button class="link-action" type="button" data-intelligence-topic="all">查看全部 →</button></div><div class="surface-body">${insightMarkup}</div></section><section class="surface intelligence-topics"><div class="surface-head"><div><h2>按主题查看</h2><p class="surface-subtitle">选择一个主题进入详细线索页</p></div></div><div class="intelligence-topic-grid">${topicCards.map(([key,icon,title,desc]) => `<button type="button" class="intelligence-topic-card" data-intelligence-topic="${key}"><span class="intelligence-topic-icon">${icon}</span><strong>${title}</strong><small>${desc}</small></button>`).join('')}</div></section><div class="intelligence-home-footnote">数据范围：${sourceSummary.resume} 份简历 · ${sourceSummary.phone} 份电话沟通转写 · ${sourceSummary.moka} 份正式面试转写</div></div>`;
   $$('#intelligenceView [data-intelligence-topic]').forEach(button => button.addEventListener('click', () => { app.intelligenceTopic = button.dataset.intelligenceTopic; renderIntelligence(); }));
 }

 function renderIntelligence() {
   return renderIntelligenceResearchPage();
   /* legacy intelligence layout retained below for data compatibility */
   const records = intelligenceRecords({ source: app.intelligenceSource });
   const companies = records.filter(item => item.name).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
   const view = app.intelligenceView || 'company';
   const query = String(app.intelligenceQuery || '').trim().toLowerCase();
   const objects = view === 'company' ? companies : intelligenceDimensionRecords(view, records, { source: app.intelligenceSource });
   const industryObjects = intelligenceDimensionRecords('industry', records, { source: app.intelligenceSource });
   const selectedIndustry = app.intelligenceIndustry && industryObjects.some(item => item.key === app.intelligenceIndustry) ? app.intelligenceIndustry : '';
   const filteredCompanies = objects.filter(item => (!selectedIndustry || view !== 'company' || (item.industries || []).some(industry => industry.toLowerCase() === selectedIndustry)) && (!query || `${item.name} ${item.summary} ${item.evidence}`.toLowerCase().includes(query)));
   const selectedKey = app.intelligenceSelected && filteredCompanies.some(item => item.key === app.intelligenceSelected) ? app.intelligenceSelected : (filteredCompanies[0]?.key || '');
   const selected = filteredCompanies.find(item => item.key === selectedKey) || filteredCompanies[0];
   const themes = [...new Set(app.jobs.flatMap(job => job.keywords || []))].slice(0, 12);
   const transcriptCount = intelligenceSourceRecords().filter(item => String(item.transcript || '').trim()).length;
   const pendingCount = filteredCompanies.filter(item => (app.intelligenceReviewed[item.key] || 'pending') === 'pending').length;
   const sourceSummary = intelligenceSourceSummary();
   const sourceCards = `<section class="intelligence-source-cards"><div class="intelligence-source-card"><span>正式面试转写</span><strong>${sourceSummary.moka}</strong><small>与“面试官分析”使用同一批已同步的面试转写</small></div><div class="intelligence-source-card"><span>来源范围</span><strong>${sourceSummary.total}</strong><small>只有包含实际转写文本的面试记录才参与识别</small></div><div class="intelligence-source-card"><span>识别原则</span><strong>可追溯</strong><small>每条行业线索都保留候选人、面试官和原文证据</small></div></section>`;
   const industryPicker = view === 'company' ? `<div class="intelligence-industry-picker"><div><strong>先选行业</strong><small>公司列表只显示该行业下的公司</small></div><button type="button" class="${!selectedIndustry ? 'active' : ''}" data-intelligence-industry="">全部行业</button>${industryObjects.map(item => `<button type="button" class="${selectedIndustry === item.key ? 'active' : ''}" data-intelligence-industry="${escapeHtml(item.key)}">${escapeHtml(item.name)} <b>${item.count}</b></button>`).join('')}</div>` : '';
   const companyRows = filteredCompanies.map(item => `<button class="intelligence-list-item ${selected?.key === item.key ? 'active' : ''}" type="button" data-intelligence-select="${escapeHtml(item.key)}"><span><strong>${escapeHtml(item.name)}</strong><small>${item.count} 条线索 · ${item.transcripts} 场面试 · ${(item.sources || []).join(' / ') || '来源待确认'}</small></span><b>${escapeHtml(item.confidence)}</b></button>`).join('');
   const emptyText = `<div class="intelligence-empty"><strong>当前没有可确认的${tabsLabel(view)}数据</strong><span>已读取 ${sourceSummary.total} 条招聘材料，但当前维度没有命中设定词或结构化字段。请先完成简历解析、电话转写或 Moka 面试转写同步。</span><small>本页不会把猜测内容当成情报展示。</small></div>`;
   const detail = selected ? `<div class="intelligence-detail-head"><div><span class="eyebrow">${view.toUpperCase()} · 研究对象</span><h2>${escapeHtml(selected.name)}</h2></div><span class="intelligence-status ${(app.intelligenceReviewed[selected.key] || 'pending') === 'confirmed' ? 'confirmed' : ''}">${(app.intelligenceReviewed[selected.key] || 'pending') === 'confirmed' ? '已确认' : '待确认'}</span></div><p class="intelligence-summary">${escapeHtml(selected.summary || '已从招聘材料中识别到该对象，业务信息待补充。')}</p><div class="intelligence-detail-grid"><div><span>命中材料</span><b>${selected.count}</b></div><div><span>关联面试</span><b>${selected.transcripts}</b></div><div><span>来源类型</span><b>${escapeHtml((selected.sources || []).join(' / ') || '待确认')}</b></div></div><div class="intelligence-detail-section"><strong>为什么会出现在这里</strong><p>${view === 'company' ? '公司名称来自简历工作经历中的公司字段或带任职时间的工作经历行。' : `材料中命中了“${escapeHtml(selected.name)}”这一受控词。`}</p></div><div class="intelligence-evidence"><strong>原文证据</strong><span>${escapeHtml(selected.evidence || '暂无可展示的原文片段')}</span></div><div class="intelligence-row-actions"><button class="primary" type="button" data-intelligence-review="${escapeHtml(selected.key)}">${(app.intelligenceReviewed[selected.key] || 'pending') === 'confirmed' ? '标记待确认' : '确认线索'}</button><button class="link-action" type="button" data-intelligence-detail="${escapeHtml(selected.key)}">查看关联面试 →</button></div>` : emptyText;
   const tabs = [['company','公司'],['industry','行业'],['product','产品'],['business','业务'],['city','城市']];
   $('#intelligenceView').innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">MARKET INTELLIGENCE</span><h1>行业情报</h1><p>从招聘材料中整理可核查的公司、行业、产品、业务和城市线索。</p></div><div class="page-title-actions"><button class="secondary" type="button" data-refresh-intelligence>重新整理</button><button class="secondary" type="button" data-export-intelligence>导出研究草稿</button></div></div><section class="intelligence-purpose"><div><strong>先看数据覆盖，再看研究对象</strong><span>本页不是自动生成报告，而是把候选人材料中的事实整理出来，供招聘人员核查、沉淀和复用。</span></div><div class="intelligence-flow"><span><b>1</b>读取材料</span><i>→</i><span><b>2</b>形成线索</span><i>→</i><span><b>3</b>人工确认</span></div></section>${sourceCards}<div class="intelligence-toolbar"><input id="intelligenceSearch" type="search" value="${escapeHtml(app.intelligenceQuery || '')}" placeholder="在当前视角搜索对象"><select id="intelligenceSource"><option value="">全部来源</option><option>正式面试转写</option><option>电话沟通转写</option><option>候选人简历</option></select><select id="intelligencePeriod"><option>全部时间</option><option>近 30 天</option><option>近 90 天</option></select><select id="intelligenceStatus"><option>全部状态</option><option>待确认</option><option>已确认</option></select></div><nav class="intelligence-tabs" aria-label="情报视角"><span class="intelligence-tabs-label">研究视角</span>${tabs.map(([key,label]) => `<button type="button" class="${view === key ? 'active' : ''}" data-intelligence-view="${key}">${label}</button>`).join('')}</nav>${industryPicker}<div class="research-banner"><div><span>待确认线索</span><strong>${pendingCount}<small> 条</small></strong></div><p>${view === 'company' ? (selectedIndustry ? `当前显示“${escapeHtml(industryObjects.find(item => item.key === selectedIndustry)?.name || '')}”行业下的公司。` : '先选择行业，再查看该行业对应的公司。') : `当前显示${tabsLabel(view)}线索，点击对象查看原文证据。`}</p><span class="data-status">已读取 ${sourceSummary.total} 条材料</span></div><section class="intelligence-workspace"><div class="surface intelligence-list-panel"><div class="surface-head"><div><h2>${tabsLabel(view)}对象</h2><p class="surface-subtitle">${filteredCompanies.length} 个对象 · 点击查看详情</p></div></div><div class="surface-body intelligence-list">${companyRows || emptyText}</div></div><div class="surface intelligence-detail-panel"><div class="surface-head"><div><h2>对象详情</h2><p class="surface-subtitle">显示来源、命中原因和原文证据</p></div></div><div class="surface-body">${detail}</div></div></section></div>`;
   const sourceSelect = $('#intelligenceSource');
   if (sourceSelect) sourceSelect.value = app.intelligenceSource || '';
   $('#intelligenceSearch')?.addEventListener('input', event => { app.intelligenceQuery = event.target.value; renderIntelligence(); });
   $('#intelligenceSource')?.addEventListener('change', event => { app.intelligenceSource = event.target.value; app.intelligenceSelected = ''; renderIntelligence(); });
   $$('#intelligenceView [data-intelligence-industry]').forEach(button => button.addEventListener('click', () => { app.intelligenceIndustry = button.dataset.intelligenceIndustry || ''; app.intelligenceSelected = ''; renderIntelligence(); }));
   $$('#intelligenceView [data-intelligence-select]').forEach(button => button.addEventListener('click', () => { app.intelligenceSelected = button.dataset.intelligenceSelect; renderIntelligence(); }));
   $$('#intelligenceView [data-intelligence-view]').forEach(button => button.addEventListener('click', () => { app.intelligenceView = button.dataset.intelligenceView; renderIntelligence(); }));
   $('#intelligenceView [data-refresh-intelligence]')?.addEventListener('click', () => { renderIntelligence(); toast('已重新整理面试与简历线索'); });
   $('#intelligenceView [data-export-intelligence]')?.addEventListener('click', () => toast('研究草稿已生成，导出功能将在确认线索后开放'));
   $$('#intelligenceView [data-intelligence-review]').forEach(button => button.addEventListener('click', () => { const key = button.dataset.intelligenceReview; app.intelligenceReviewed[key] = app.intelligenceReviewed[key] === 'confirmed' ? 'pending' : 'confirmed'; renderIntelligence(); }));
   $$('#intelligenceView [data-intelligence-detail]').forEach(button => button.addEventListener('click', () => toast('关联面试详情将在下一步展开')));
 }

 function intelligenceDimensionRecords(view, records, filters = {}) {
   const terms = INTELLIGENCE_LEXICON[view] || [];
   const groups = new Map();
   const source = intelligenceSourceRecords().filter(item => !filters.source || item.sourceType === filters.source);
   source.forEach((item, index) => {
     const text = `${item.transcript || ''}\n${item.communicationSummary?.overview || ''}\n${item.resume || ''}\n${item.jobName || ''} ${item.roleName || ''}`;
     const recordKey = item.id || item._id || `${item.sourceType}-${index}`;
     terms.filter(term => text.toLowerCase().includes(term.toLowerCase())).forEach(term => {
       const key = term.toLowerCase(); const existing = groups.get(key) || { key, name: term, count: 0, transcripts: 0, evidence: '', summary: '', confidence: '中', latest: '', sources: [], recordKeys: [], sourceDetails: [] };
       existing.count += 1; if (item.transcript || item.communicationSummary) existing.transcripts += 1;
       if (!existing.recordKeys.includes(recordKey)) existing.recordKeys.push(recordKey);
       if (!existing.sourceDetails.some(detail => detail.recordKey === recordKey)) existing.sourceDetails.push({ recordKey, candidateName: item.candidateName || '', interviewer: item.interviewer || '', startedAt: item.startedAt || '' });
       if (item.sourceType && !existing.sources.includes(item.sourceType)) existing.sources.push(item.sourceType);
       const snippets = text.split(/[。！？\n]/).map(value => value.trim()).filter(value => value.length > 8 && value.toLowerCase().includes(term.toLowerCase())).slice(0, 2);
       if (snippets.length) existing.evidence = [...new Set([...(existing.evidence ? existing.evidence.split('；') : []), ...snippets])].slice(0, 2).join('；');
       existing.summary = view === 'industry' ? `${term}相关业务线索` : view === 'product' ? `${term}相关产品线索` : view === 'business' ? `${term}相关业务活动` : `${term}相关地点线索`;
       existing.confidence = existing.evidence.length > 15 ? '高' : '中';
       existing.latest = item.interviewAt || item.startedAt || item.updatedAt || item.createdAt || existing.latest;
       groups.set(key, existing);
     });
   });
   return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
 }

 function tabsLabel(view = 'company') { return ({ company: '公司', industry: '行业', product: '产品', business: '业务', city: '城市' }[view] || '公司'); }
 function intelligenceSourceSummary() {
   const interviewTranscripts = intelligenceSourceRecords();
   const moka = interviewTranscripts.filter(item => item.sourceType === '正式面试转写').length;
   return { resume: 0, phone: 0, moka, total: interviewTranscripts.length };
 }

 function intelligenceRecords(filters = {}) {
    // Combine résumé, phone-screen, and formal interview evidence; source labels remain available for later filtering.
   const source = intelligenceSourceRecords();
   const groups = new Map();
   source.filter(item => !filters.source || item.sourceType === filters.source).forEach((item, index) => {
     const text = `${item.transcript || ''}\n${item.communicationSummary?.overview || ''}\n${item.resume || ''}`.replace(/\r/g, '');
     const recordKey = item.id || item._id || `${item.sourceType}-${index}`;
     const structuredCompanies = item.resumeMeta?.companies || item.companies || [];
     const structuredCompany = item.resumeMeta?.currentCompany || item.currentCompany || item.company || item.mokaData?.companyName || '';
     const resumeNames = [...structuredCompanies, ...extractResumeCompanyNames(item.resume || '')];
     const relatedIndustries = INTELLIGENCE_LEXICON.industry.filter(term => text.toLowerCase().includes(term.toLowerCase()));
     const explicitTextNames = item.resume ? [] : extractCompanyEntities(text);
     const names = [...new Set([structuredCompany, ...resumeNames, ...explicitTextNames].filter(Boolean))];
     names.forEach(rawName => {
       const name = normalizeCompanyName(rawName);
       if (!isReliableCompanyName(name)) return;
       const key = name.toLowerCase(); const existing = groups.get(key) || { key, name, count: 0, transcripts: 0, evidence: '', summary: '', confidence: '中', latest: '', sources: [], industries: [], products: [], businesses: [], recordKeys: [] };
       existing.count += 1; if (item.transcript) existing.transcripts += 1;
       if (!existing.recordKeys.includes(recordKey)) existing.recordKeys.push(recordKey);
       if (item.sourceType && !existing.sources.includes(item.sourceType)) existing.sources.push(item.sourceType);
       relatedIndustries.forEach(industry => { if (!existing.industries.includes(industry)) existing.industries.push(industry); });
       INTELLIGENCE_LEXICON.product.filter(term => text.toLowerCase().includes(term.toLowerCase())).forEach(product => { if (!existing.products.includes(product)) existing.products.push(product); });
       INTELLIGENCE_LEXICON.business.filter(term => text.toLowerCase().includes(term.toLowerCase())).forEach(business => { if (!existing.businesses.includes(business)) existing.businesses.push(business); });
       if (!existing.evidence) existing.evidence = text.split(/[。！？\n]/).map(value => value.trim()).find(value => value.includes(name)) || `简历工作经历中识别到：${name}`;
       existing.summary ||= `来自${item.sourceType || '招聘材料'}，待人工确认业务含义。`;
       existing.latest = item.interviewAt || item.startedAt || item.updatedAt || item.createdAt || existing.latest;
       if (existing.evidence.length > 15) existing.confidence = '高';
       groups.set(key, existing);
     });
   });
   return [...groups.values()];
 }

 function intelligenceSourceRecords() {
   // Keep the exact transcript records used by interviewer analysis, but do not
   // require the optional interviewer/date fields that can be absent in Moka exports.
   const moka = app.mokaInterviews.map((item, index) => ({ ...item, source: 'moka', recordKey: item.id || item._id || `moka-${index}` }));
   const local = app.cases.filter(item => String(item.transcript || '').trim()).map(item => ({ ...item, source: 'acecall', recordKey: item.id }));
   return [...moka, ...local].map(item => {
     const transcript = String(item.transcript || item.transcription || item.transcriptText || item.transcriptionText || item.transcriptContent || item.transcriptionContent || '').trim();
     if (!transcript) return null;
     const candidate = app.cases.find(record => (item.candidateId && record.id === item.candidateId) || (item.id && record.id === item.id) || (item.candidateName && record.candidateName && item.candidateName === record.candidateName));
     return { ...item, transcript, ...candidate ? { resume: candidate.resume || '', resumeMeta: candidate.resumeMeta || {}, currentCompany: candidate.currentCompany || candidate.resumeMeta?.currentCompany || '', companies: candidate.companies || candidate.resumeMeta?.companies || [], candidateId: candidate.id } : {}, sourceType: item.source === 'moka' ? '正式面试转写' : '面试转写' };
   }).filter(Boolean);
 }

 function extractCompanyEntities(text = '') {
   const result = new Set();
   const sentencePattern = /[^。！？\n]{0,60}(?:就职于|任职于|供职于|来自|曾在|上一家公司是|目前任职于|公司名称是|任职公司为)\s*([A-Za-z0-9\u4e00-\u9fff]{2,30}(?:公司|集团|科技|银行|证券|基金|保险|资本|传媒|教育|医疗|互联网|软件|股份|有限))[^。！？\n]{0,60}/g;
   for (const match of text.matchAll(sentencePattern)) result.add(match[1]);
   const workLinePattern = /(?:公司|企业|单位|雇主)\s*[：:]\s*([A-Za-z0-9\u4e00-\u9fff]{2,30}(?:公司|集团|科技|银行|证券|基金|保险|资本|传媒|教育|医疗|互联网|信息|软件|股份|有限))/g;
   for (const match of text.matchAll(workLinePattern)) result.add(match[1]);
   const standalonePattern = /(?<![\u4e00-\u9fffA-Za-z0-9])([A-Za-z][A-Za-z0-9 .&-]{1,36}(?:Inc\.?|Ltd\.?|Group|Capital|Bank|Securities|Technology))\b/gi;
   for (const match of text.matchAll(standalonePattern)) result.add(match[1].trim());
   return [...result].map(normalizeCompanyName).filter(isReliableCompanyName);
 }

 function normalizeCompanyName(value = '') {
   let name = String(value).replace(/^\s*\d{4}[./-]\d{1,2}(?:[./-]\d{1,2})?\s*/, '').replace(/^(?:目前|原|上一家|所在|目标)\s*/, '').trim();
   const suffix = name.search(/(?:有限公司|股份有限公司|集团|科技|证券|银行|基金|保险|资本|传媒|教育|医疗|软件|Inc\.?|Ltd\.?|Group|Capital|Bank|Securities|Technology)/i);
   if (suffix >= 0) name = name.slice(0, suffix + (name.slice(suffix).match(/^(?:股份有限公司|有限公司|集团|科技|证券|银行|基金|保险|资本|传媒|教育|医疗|软件|Inc\.?|Ltd\.?|Group|Capital|Bank|Securities|Technology)/i)?.[0].length || 0));
   return name.replace(/[\s,，。；;：:、|｜·•]+$/g, '').trim();
 }

 function extractResumeCompanyNames(text = '') {
   const lines = String(text).split(/\n+/).map(line => line.trim()).filter(Boolean);
   const start = lines.findIndex(line => /^(?:工作经历|工作经验|职业经历|任职经历|工作背景)/i.test(line.replace(/[：: ].*$/, '')));
   if (start < 0) return [];
   const end = lines.findIndex((line, index) => index > start && /^(?:教育经历|教育背景|项目经历|专业技能|自我评价|证书|荣誉)/i.test(line.replace(/[：: ].*$/, '')));
   const section = lines.slice(start + 1, end > start ? end : Math.min(lines.length, start + 40));
   const result = [];
   const datePattern = /(?:19|20)\d{2}[./年-]\s*\d{1,2}\s*(?:月)?\s*(?:[-至到]|年)?\s*(?:(?:19|20)\d{2}[./年-]\s*\d{1,2}\s*(?:月)?|至今|现在)?/i;
   section.forEach((line, index) => {
     const date = line.match(datePattern);
     if (!date) return;
     const left = line.slice(0, date.index).replace(/[|｜·•,，、:：]+$/g, '').trim();
     const previous = index > 0 ? section[index - 1].replace(datePattern, '').trim() : '';
     const candidate = normalizeCompanyName(left || previous);
     if (candidate && isReliableCompanyName(candidate) && !result.includes(candidate)) result.push(candidate);
   });
   return result.slice(0, 8);
 }

 function isReliableCompanyName(value = '') {
   const name = String(value).replace(/[\s,，。；;：:、]+$/g, '').trim();
   if (name.length < 3 || name.length > 36) return false;
   if (/\d{4}[./-]\d{1,2}|包含|涉及|功能|负责|参与|搭建|提升|实现|资深|软件开发|产品功能|项目经验|工作内容/.test(name)) return false;
   if (/^(个人信息|基本信息|教育背景|工作经历|项目经历|专业技能|自我评价|求职意向|联系方式|公司名称|所在公司|目标公司|任职公司|创业公司|这家公司|该公司|本公司|某公司)$/i.test(name)) return false;
   if (/^(信息|资料|经历|背景|情况|内容|岗位|职位|部门|业务|产品|行业)(?:公司|集团|科技|银行|证券|基金|保险|资本|传媒|教育|医疗|互联网|信息|软件|股份)$/.test(name)) return false;
   return /(?:公司|集团|科技|银行|证券|基金|保险|资本|传媒|教育|医疗|互联网|软件|股份|Inc\.?|Ltd\.?|Group|Capital|Bank|Securities|Technology)$/i.test(name);
 }
function renderConnections() { $('#connectionsView').innerHTML = `<div class="page research-page"><div class="page-title"><div><span class="eyebrow">DATA CONNECTIONS</span><h1>数据连接</h1><p>集中管理外部招聘系统的授权状态、同步范围和数据责任边界。</p></div></div><section class="connection-hero"><div class="connection-logo">M</div><div><span class="eyebrow">ATS CONNECTOR</span><h2>Moka 企业招聘系统</h2><p>读取岗位、候选人、面试安排和面试结果；AceCall 负责分析与回写备注。</p></div><span class="connection-status">未连接</span></section><div class="research-grid"><section class="surface"><div class="surface-head"><div><h2>接入范围</h2><p class="surface-subtitle">获得企业 API 后按需开启</p></div></div><div class="surface-body connector-list"><p><b>读取：</b>岗位信息、候选人简历、流程状态、面试安排、面试结果</p><p><b>分析：</b>录用偏好、筛选通过标准、面试官表现、行业线索</p><p><b>回写：</b>候选人备注、沟通总结、推荐理由、分析标签</p><p><b>不做：</b>不自动淘汰候选人，不覆盖 Moka 原始记录，不保存 Moka 登录密码</p></div></section><section class="surface"><div class="surface-head"><div><h2>授权准备清单</h2><p class="surface-subtitle">连接前由管理员确认</p></div></div><div class="surface-body checklist"><label><input type="checkbox" disabled> 企业 ID / 租户标识</label><label><input type="checkbox" disabled> API Client ID 与密钥</label><label><input type="checkbox" disabled> 允许读取的业务范围</label><label><input type="checkbox" disabled> 备注回写权限与审计要求</label></div></section></div><section class="surface connector-note"><div class="surface-head"><div><h2>当前开发状态</h2><p class="surface-subtitle">接口适配层已预留，等待真实凭证后联调</p></div><span class="readonly-badge">Moka API 待接入</span></div><div class="surface-body"><p class="muted-text">本页面不会发起 Moka 请求。拿到企业 API 后，将先在测试环境完成只读同步，再开启备注回写，并保留同步日志和失败重试队列。</p></div></section></div>`; }

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
    <div class="page-title dashboard-title"><div><span class="eyebrow">RECRUITING CONTROL ROOM</span><h1>今日招聘概览</h1><p>把岗位进度、候选人匹配和待办动作集中在一个工作面中。</p></div><div class="dashboard-actions"><select id="dashboardJobFilter"><option value="">全部活跃岗位</option>${activeJobs.map(job => `<option value="${job.id}">${escapeHtml(job.name)}</option>`).join('')}</select><button class="primary" data-add-candidate>＋ 添加候选人</button></div></div>
    <div class="dashboard-strip"><div class="dashboard-strip-label"><span>当前招聘面</span><b>${activeJobs.length} 个活跃岗位</b></div><div class="dashboard-strip-note">统计范围：全部候选人 · AI 仅提供辅助判断，岗位分配与录用结论由团队确认</div><button class="link-action" data-dashboard-refresh>刷新视图 ↻</button></div>
    <section class="dashboard-insight"><div class="insight-mark">✦</div><div><strong>AI 招聘助手</strong><p>${pendingCall + pendingReview ? `当前有 ${pendingCall + pendingReview} 项招聘动作值得优先处理，建议先完成待沟通和待确认候选人。` : '当前没有积压的招聘动作，可以继续导入候选人或完善岗位标准。'}</p></div><button class="link-action" data-dashboard-filter="${pendingCall ? 'call' : 'all'}">${pendingCall ? '查看待沟通' : '查看人才池'} →</button></section>
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
  $('#inboxView').innerHTML = `<div class="page"><div class="page-title"><div><h1>简历中心</h1><p>直接导入简历，系统会自动解析、匹配岗位并建立候选人档案。</p></div><div class="import-actions"><label class="primary upload-trigger"><span class="button-icon" aria-hidden="true">+</span><span>批量导入简历</span><input id="batchResumeInput" type="file" accept=".pdf,.doc,.docx,.txt,.md,.rtf" multiple hidden></label><label class="secondary upload-trigger"><span class="button-icon" aria-hidden="true">&#8943;</span><span>本次选择文件夹</span><input id="folderResumeInput" type="file" webkitdirectory directory multiple hidden></label></div></div><div class="metrics"><div class="metric"><b>${app.cases.length}</b><span>已建立档案</span></div><div class="metric"><b>${pending}</b><span>处理中</span></div><div class="metric"><b>${needsAssignment}</b><span>待分配岗位</span></div></div><div class="surface watch-panel"><div class="surface-head"><h2>页面文件监听</h2><span>${watchStatus}</span></div><div class="surface-body"><div class="watch-facts"><span>当前设备：<b>${policy.label}</b></span><span>扫描周期：<b>每 5 分钟</b></span><span>处理范围：<b>仅监听开始后新增文件</b></span></div><p class="muted-text">${policy.platform === 'mac' ? 'Mac 浏览器无法直接读取 Downloads 路径，请在系统选择器中授权 Downloads 文件夹。' : 'Windows 请选择需要持续读取的授权文件夹。'} 支持 PDF、DOC、DOCX、TXT、MD、RTF；页面关闭后监听会停止。</p><button class="secondary" id="watchFolderButton" type="button"><span class="button-icon" aria-hidden="true">${folderWatchTimer ? '&#9632;' : '&#9654;'}</span><span>${folderWatchTimer ? '停止页面监听' : watchLabel}</span></button>${folderWatchStartedAt ? `<small class="watch-started">监听开始：${formatDate(folderWatchStartedAt)}</small>` : ''}</div></div><div class="surface desktop-agent-panel"><div class="surface-head"><h2>桌面同步助手</h2><span>推荐</span></div><div class="surface-body"><p class="muted-text">安装桌面版后，可在页面关闭时继续监听文件，并从网页控制本机录音。首次录音时请允许麦克风权限。</p><div class="desktop-agent-actions"><a class="primary" href="downloads/AceCall-Sync-Mac.dmg" download><span class="button-icon" aria-hidden="true">&#8595;</span><span>下载 Mac 桌面版</span></a><a class="secondary" href="downloads/AceCall-Sync-Windows.zip" download><span class="button-icon" aria-hidden="true">&#8595;</span><span>下载 Windows 运行包</span></a></div><small class="watch-started">Mac：打开 DMG 后将 AceCall Sync 拖入“应用程序”；Windows 运行包需 Node.js 18+。</small></div></div><div class="surface"><div class="surface-head"><h2>导入说明</h2><span>自动筛选疑似简历</span></div><div class="surface-body"><p class="muted-text">系统会跳过临时下载文件、空文件和不具备简历特征的文档；无法判断的文件不会删除，可通过批量导入或手动粘贴处理。</p></div></div><div class="surface" style="margin-top:13px"><div class="surface-head"><h2>最近导入</h2><span>${app.cases.length} 位候选人</span></div><div class="table-wrap"><table><thead><tr><th>候选人</th><th>自动分配岗位</th><th>匹配度</th><th>解析状态</th><th>下一步</th></tr></thead><tbody>${app.cases.slice(0,12).map(item => `<tr><td><strong>${escapeHtml(item.candidateName || '未命名候选人')}</strong><small>${escapeHtml(item.resumeMeta?.fileName || '文本录入')}</small></td><td>${escapeHtml(item.roleName || '待分配')}</td><td>${scoreLabel(item)}</td><td>${escapeHtml(item.ingestStatus || '已入库')}${item.ingestStatus?.startsWith('解析失败') && importFileCache.has(item.ingestFileKey) ? ` <button class="link-action" data-retry-import="${item.id}">重试</button>` : ''}</td><td><button class="link-action" data-open-candidate="${item.id}">查看 →</button></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">还没有导入简历</div></td></tr>'}</tbody></table></div></div></div>`;
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
  $('#inboxView').innerHTML = `<div class="page resume-center-page"><div class="page-title"><div><span class="eyebrow">INGESTION & QUALITY</span><h1>简历中心</h1><p>管理文件进入 AceCall 的导入、解析、岗位分配和异常处理。</p></div><div class="import-actions"><label class="primary upload-trigger"><span class="button-icon" aria-hidden="true">+</span><span>批量导入简历</span><input id="batchResumeInput" type="file" accept=".pdf,.doc,.docx,.txt,.md,.rtf" multiple hidden></label><label class="secondary upload-trigger"><span class="button-icon" aria-hidden="true">&#8943;</span><span>选择文件夹</span><input id="folderResumeInput" type="file" webkitdirectory directory multiple hidden></label></div></div><div class="ingest-kpis"><button class="metric metric-action ${!inboxQueueFilter ? 'active' : ''}" data-inbox-filter="all" type="button"><b>${app.cases.length}</b><span>已建立档案</span><small>进入候选人池</small></button><button class="metric metric-action ${inboxQueueFilter === 'processing' ? 'active' : ''}" data-inbox-filter="processing" type="button"><b>${pending}</b><span>解析中</span><small>正在处理</small></button><button class="metric metric-action ${inboxQueueFilter === 'assignment' ? 'active' : ''}" data-inbox-filter="assignment" type="button"><b>${needsAssignment}</b><span>待岗位确认</span><small>无法高置信分配</small></button><button class="metric metric-action ${inboxQueueFilter === 'duplicate' ? 'active' : ''}" data-inbox-filter="duplicate" type="button"><b>${duplicate}</b><span>重复待确认</span><small>需要合并或更新</small></button><button class="metric metric-action ${inboxQueueFilter === 'failed' ? 'active' : ''}" data-inbox-filter="failed" type="button"><b>${failed}</b><span>解析异常</span><small>支持重试</small></button></div><div class="ingest-layout"><div class="ingest-main"><section class="surface ingest-queue"><div class="surface-head"><div><h2>文件处理队列</h2><p class="surface-subtitle">${filterLabel ? `当前筛选：${filterLabel}` : '这里处理文件，不在此管理电话和审核流程'}</p></div><span>${queue.length} 条记录</span></div><div class="table-wrap"><table><thead><tr><th>文件 / 候选人</th><th>岗位分配</th><th>解析质量</th><th>重复检查</th><th>来源</th><th>操作</th></tr></thead><tbody>${queue.map(resumeQueueRow).join('') || '<tr><td colspan="6"><div class="empty">当前状态下没有简历</div></td></tr>'}</tbody></table></div></section></div><aside class="ingest-aside"><section class="surface watch-panel"><div class="surface-head"><div><h2>文件来源</h2><p class="surface-subtitle">本机文件持续进入队列</p></div><span>${watchStatus}</span></div><div class="surface-body"><div class="watch-facts"><span>设备：<b>${policy.label}</b></span><span>扫描：<b>每 5 分钟</b></span></div><p class="muted-text">${policy.platform === 'mac' ? 'Mac 默认监听 Downloads，需在系统选择器中授权。' : 'Windows 请选择授权文件夹。'} 只处理监听启动后新增的简历文件。</p><button class="secondary" id="watchFolderButton" type="button"><span class="button-icon" aria-hidden="true">${folderWatchTimer ? '&#9632;' : '&#9654;'}</span><span>${folderWatchTimer ? '停止页面监听' : watchLabel}</span></button></div></section><section class="surface batch-surface"><div class="surface-head"><div><h2>导入批次</h2><p class="surface-subtitle">最近批次处理结果</p></div><span>${batches.length} 个</span></div><div class="surface-body">${batches.map(id => { const items = app.cases.filter(item => item.ingestBatchId === id); return `<div class="batch-row"><span>${formatDate(items[0]?.createdAt)} · ${items.length} 份</span><b>${items.filter(item => item.ingestStatus === '已入库').length} 成功</b></div>`; }).join('') || '<div class="empty">导入后显示批次结果</div>'}</div></section><section class="surface desktop-agent-panel"><div class="surface-head"><div><h2>桌面同步助手</h2><p class="surface-subtitle">页面关闭后继续监听</p></div><span>推荐</span></div><div class="surface-body"><p class="muted-text">安装桌面版后，可在页面关闭时继续监听文件，并从网页控制本机录音。首次录音时请允许麦克风权限。</p><div class="desktop-agent-actions"><a class="primary" href="downloads/AceCall-Sync-Mac.dmg" download>下载 Mac 桌面版</a><a class="secondary" href="downloads/AceCall-Sync-Windows.zip" download>下载 Windows 运行包</a></div><small class="watch-started">Mac：打开 DMG 后将 AceCall Sync 拖入“应用程序”；Windows 运行包需 Node.js 18+。</small></div></section></aside></div></div>`;
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
  return `<div class="call-grid"><div class="surface"><div class="surface-head"><h2>本次核验问题</h2><span>${questions.length} 项</span></div><div class="surface-body">${questions.length ? questions.map((question,index) => `<label class="question"><input type="checkbox" data-question="${index}"><span><b>${escapeHtml(question.question || question)}</b><small>${escapeHtml(question.reason || question.source || '初筛必问项')}</small></span></label>`).join('') : '<div class="empty">请先生成电话准备</div>'}</div></div><div class="surface"><div class="surface-head"><h2>电话记录</h2><span>保存原始事实</span></div><div class="surface-body"><div class="recording-tools"><div class="recording-actions"><button class="secondary" type="button" id="startRecording">开始录音</button><button class="secondary" type="button" id="stopRecording" disabled>停止录音</button><label class="secondary upload-trigger"><span>上传录音</span><input id="callAudioInput" type="file" accept="audio/*" hidden></label></div><small id="recordingStatus" class="muted-text">${escapeHtml(recordingLabel)}。录音前请先向候选人告知并取得同意。</small><audio id="callAudioPreview" controls class="audio-preview" ${draft?.url ? '' : 'hidden'} src="${draft?.url || ''}"></audio></div><textarea class="call-notes" id="callTranscript" placeholder="粘贴电话转写，或等待异步转写结果…">${escapeHtml(item.transcript || '')}</textarea><small class="muted-text">录音会按 8MB 分片上传，支持最长约 120 分钟；转写完成后自动写入电话记录。</small></div></div></div><div class="call-footer"><label style="display:flex;align-items:center;gap:7px"><input type="checkbox" id="consentConfirmed" ${item.consentConfirmed ? 'checked' : ''}> 已完成录音或转写告知</label><button class="primary" data-complete-call>完成电话并生成结果</button></div>`;
}

function resultTab(item) {
  const report = item.report || {}; const info = report.basicInfo || {};
  return `<div class="decision"><span class="tag">待人工确认</span><small>AI综合建议</small><h2>${escapeHtml(report.conclusion || '信息不足')}</h2><p>${escapeHtml(report.conclusionReason || '')}</p></div><div class="grid-2" style="margin-top:13px"><div class="surface"><div class="surface-head"><h2>结论依据</h2><span>${(report.capabilities || []).length} 项</span></div><div class="surface-body">${(report.capabilities || []).map(point => `<div class="evidence"><span class="tag">${escapeHtml(point.assessment || '待确认')}</span><strong>${escapeHtml(point.item || point)}</strong><p>${escapeHtml(point.evidence || '')}</p></div>`).join('') || '<div class="empty">暂无能力判断</div>'}${(report.risks || []).map(risk => `<div class="point risk"><strong>${escapeHtml(risk)}</strong></div>`).join('')}</div></div><div><div class="surface"><div class="surface-head"><h2>基础条件</h2></div><div class="surface-body">${Object.entries(info).map(([key,value]) => `<div class="fact"><span>${escapeHtml(infoLabel(key))}</span><b>${escapeHtml(value)}</b></div>`).join('') || '<div class="empty">待确认</div>'}</div></div><div class="review"><label>最终动作<select id="finalDecision">${['推荐业务面试','补充电话沟通','转入其他岗位','暂不推进','纳入人才库长期维护'].map(value => `<option ${value === (report.finalDecision || report.nextStep) ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label style="margin-top:10px">推荐理由<textarea id="recommendationReason" placeholder="AI根据简历与沟通事实生成，可人工修订">${escapeHtml(report.recommendationReason || '')}</textarea></label><label style="margin-top:10px">审核备注<textarea id="reviewNotes" placeholder="补充事实或后续安排">${escapeHtml(report.reviewNotes || '')}</textarea></label><label class="review-check"><input type="checkbox" id="reviewConfirmed" ${report.reviewConfirmed ? 'checked' : ''}> 我已核对材料并确认最终动作</label><button class="primary" style="width:100%" data-confirm-result>确认完成</button></div></div></div>`;
}

function resumeTab(item) { const meta=item.resumeMeta||{}; const original = meta.originalFileId; const preview = meta.originalTempUrl; const originalView = original ? (meta.originalMimeType === 'application/pdf' && preview ? `<div class="resume-original"><iframe title="原始PDF简历" src="${escapeHtml(preview)}"></iframe></div>` : `<div class="resume-original resume-original-file"><p>Word 原文件已保存，可按原格式打开查看。</p><button class="secondary" data-resume-download type="button">打开 / 下载原简历</button></div>`) : ''; return `<div class="surface"><div class="surface-head"><div><h2>候选人简历</h2><p class="surface-subtitle">${original ? '原始文件优先，解析文本用于搜索和AI分析' : '文本录入'}</p></div><span>${escapeHtml(meta.fileName || '文本录入')}</span></div><div class="surface-body"><div class="resume-basics"><div class="fact"><span>姓名</span><b>${escapeHtml(item.candidateName||'待确认')}</b></div><div class="fact"><span>年龄</span><b>${escapeHtml(meta.age?`${meta.age}岁`:'待确认')}</b></div><div class="fact"><span>手机</span><b>${escapeHtml(meta.phone||'待确认')}</b></div><div class="fact"><span>邮箱</span><b>${escapeHtml(meta.email||'待确认')}</b></div><div class="fact"><span>工作年限</span><b>${escapeHtml(meta.experienceYears?`${meta.experienceYears}年`:'待确认')}</b></div><div class="fact"><span>学历</span><b>${escapeHtml(meta.education||'待确认')}</b></div></div>${originalView}<details class="resume-text-fallback" ${original ? '' : 'open'}><summary>查看解析文本</summary><pre>${escapeHtml(item.resume || '暂无简历内容')}</pre></details></div></div>`; }
function historyTab(item) { const events = [['建立候选人档案',item.createdAt],item.preparation&&['AI完成电话准备',item.createdAt],item.communicationSummary&&['生成沟通总结',item.updatedAt],item.report&&['生成综合初筛结果',item.updatedAt],item.report?.reviewConfirmed&&['招聘人员确认结果',item.updatedAt]].filter(Boolean); return `<div class="surface"><div class="surface-head"><h2>处理记录</h2><span>保留人工与AI操作痕迹</span></div><div class="surface-body">${events.map(event => `<div class="fact"><span>${formatDate(event[1])}</span><b>${event[0]}</b></div>`).join('')}</div></div>`; }

function renderSettings() {
  const workspace = app.workspace || {}; const current = workspace.currentMember || {}; const members = workspace.members || [];
  const workspaceName = workspace.workspace?.name || localStorage.getItem(WORKSPACE_NAME_KEY) || 'AceCall 招聘团队';
  const canManage = !REMOTE_BACKEND || ['owner', 'admin'].includes(current.role);
  $('#settingsView').innerHTML = `<div class="page"><div class="page-title"><div><span class="eyebrow">WORKSPACE ADMIN</span><h1>企业与团队</h1><p>企业名称、成员权限和招聘数据都绑定在当前工作区。</p></div></div><div class="settings-grid"><div class="surface workspace-settings-card"><div class="surface-head"><div><h2>当前企业工作区</h2><p class="surface-subtitle">顶部企业名称会同步显示完整工作区信息</p></div><span>${escapeHtml(current.role || '成员')}</span></div><div class="surface-body"><label class="workspace-name-field"><span>企业名称</span><div class="field-inline"><input id="workspaceNameInput" value="${escapeHtml(workspaceName)}" maxlength="120"><button class="primary" id="saveWorkspaceNameButton" type="button" ${canManage ? '' : 'disabled'}>保存</button></div></label><div class="setting-row"><span>工作区 ID</span><b>${escapeHtml(workspace.workspace?.id || workspace.workspace?.tenantId || '—')}</b></div><div class="setting-row"><span>当前账号</span><b>${escapeHtml(current.displayName || current.username || current.uid || '—')}</b></div><div class="setting-row"><span>成员数量</span><b>${members.length} 人</b></div><p class="settings-help">同一企业下的岗位、候选人、规则和统计共享；不同企业使用独立工作区，数据互不可见。企业管理员负责邀请成员加入。</p></div></div><div class="surface"><div class="surface-head"><div><h2>团队成员</h2><p class="surface-subtitle">统一管理招聘人员的协作范围</p></div><span>共享工作区</span></div><div class="surface-body">${members.length ? members.map(member => `<div class="setting-row"><span><b>${escapeHtml(member.displayName || member.username || '未命名')}</b><small style="display:block;color:var(--muted)">${escapeHtml(member.username || member.uid || '')}</small></span><b>${escapeHtml(member.role || 'recruiter')}</b></div>`).join('') : '<div class="empty">暂无成员信息</div>'}${canManage ? '<p class="settings-help">新成员通过管理员邀请加入，首次登录后会自动进入当前企业工作区。</p>' : '<p class="settings-help">如需加入其他企业，请联系该企业管理员发送邀请。</p>'}</div></div><div class="surface"><div class="surface-head"><h2>AI与数据服务</h2><span>${STATIC_DEMO ? '演示模式' : REMOTE_BACKEND ? 'CloudBase模式' : '本地服务模式'}</span></div><div class="surface-body"><div class="setting-row"><span>AI服务</span><b>DeepSeek API</b></div><div class="setting-row"><span>数据存储</span><b>${REMOTE_BACKEND ? 'CloudBase文档数据库' : '浏览器本地存储'}</b></div><p class="settings-help">API Key仅保存在服务端环境变量中，不会写入浏览器。</p></div></div><div class="surface"><div class="surface-head"><h2>人工决策边界</h2></div><div class="surface-body"><div class="setting-row"><span>自动淘汰候选人</span><b>关闭</b></div><div class="setting-row"><span>敏感属性评分</span><b>禁止</b></div><div class="setting-row"><span>结果人工确认</span><b>必须</b></div></div></div></div></div>`;
  $('#saveWorkspaceNameButton')?.addEventListener('click', saveWorkspaceName);
  if (canManage) {
    $('#settingsView .settings-grid').insertAdjacentHTML('beforeend', '<div class="surface"><div class="surface-head"><div><h2>邀请团队成员</h2><p class="surface-subtitle">把成员加入当前企业工作区</p></div><span>管理员操作</span></div><div class="surface-body"><div class="toolbar"><input id="inviteMemberUid" placeholder="员工 UID"><select id="inviteMemberRole"><option value="recruiter">招聘人员</option><option value="admin">管理员</option><option value="viewer">只读成员</option></select><button class="primary" id="inviteMemberButton" type="button">邀请</button></div><small class="settings-help">员工首次登录后会自动加入当前企业；普通成员不能修改企业名称或邀请他人。</small></div></div>');
    $('#inviteMemberButton').addEventListener('click', inviteMember);
  }
}

async function saveWorkspaceName() {
  const input = $('#workspaceNameInput'); const name = input?.value.trim();
  if (!name) return toast('请输入企业名称');
  const button = $('#saveWorkspaceNameButton'); if (button) button.disabled = true;
  try {
    if (REMOTE_BACKEND) {
      const response = await authenticatedFetch(apiUrl('/api/workspace'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '企业名称保存失败');
      app.workspace = { ...(app.workspace || {}), workspace: { ...(app.workspace?.workspace || {}), name } };
    } else {
      localStorage.setItem(WORKSPACE_NAME_KEY, name);
      app.workspace = { ...(app.workspace || {}), workspace: { ...(app.workspace?.workspace || {}), name } };
    }
    updateUserHeader(); renderSettings(); toast('企业名称已更新');
  } catch (error) { toast(error.message || '企业名称保存失败'); if (button) button.disabled = false; }
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
    if (recordingDraft.candidateId === candidate.id && recordingDraft.file) {
      candidate.callRecording = recordingDraft.uploaded && recordingDraft.taskId
        ? { fileName: recordingDraft.file.name, mimeType: recordingDraft.file.type || 'audio/webm', size: recordingDraft.file.size, source: recordingDraft.source || 'upload', recordedAt: new Date().toISOString(), status: 'queued', transcriptionTaskId: recordingDraft.taskId }
        : await uploadCallRecording(candidate, recordingDraft.file);
    }
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
  if (file.size > RECORDING_MAX_BYTES) return toast('录音文件不能超过 500MB');
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const supportedAudio = ['mp3', 'wav', 'pcm', 'amr', 'm4a', 'webm'];
  if (file.type && !file.type.startsWith('audio/') && !supportedAudio.includes(extension)) return toast('请选择音频文件');
  if (recordingDraft.url) URL.revokeObjectURL(recordingDraft.url);
  recordingDraft = { candidateId: app.candidateId, file, url: URL.createObjectURL(file), source: 'upload', taskId: '', recordingId: '', uploaded: false };
  renderCandidateDetail();
  transcribeRecording(file);
}

async function transcribeRecording(file) {
  const status = $('#recordingStatus');
  if (!REMOTE_BACKEND) {
    if (status) status.textContent = `${file.name} · 已添加；登录在线版后可进行异步转写`;
    return toast('请登录在线版后上传录音进行异步转写');
  }
  try {
    if (!cloudbaseClient?.uploadFile) throw new Error('CloudBase存储未初始化，请重新登录后重试');
    if (file.size > RECORDING_MAX_BYTES) throw new Error('录音文件不能超过 500MB');
    if (status) status.textContent = `${file.name} · 正在创建录音任务…`;
    const initResponse = await authenticatedFetch(apiUrl('/api/recordings/init'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: app.candidateId, fileName: file.name, mimeType: file.type || 'audio/webm', size: file.size }) });
    const initData = await initResponse.json().catch(() => ({}));
    if (!initResponse.ok) throw new Error(initData.error || '录音任务创建失败');
    const { recordingId, taskId, storagePrefix, chunkSize = RECORDING_CHUNK_SIZE } = initData;
    recordingDraft.taskId = taskId; recordingDraft.recordingId = recordingId;
    for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index += 1) {
      if (recordingDraft.candidateId !== app.candidateId) return;
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size), file.type || 'application/octet-stream');
      const extension = file.name.split('.').pop()?.toLowerCase() || 'webm';
      const cloudPath = `${storagePrefix}/part-${String(index).padStart(5, '0')}.${extension}`;
      if (status) status.textContent = `${file.name} · 正在上传录音 ${Math.round(((offset + chunk.size) / file.size) * 100)}%`;
      const uploadedPart = await cloudbaseClient.uploadFile({ cloudPath, filePath: chunk });
      const partResponse = await authenticatedFetch(apiUrl(`/api/recordings/${recordingId}/parts/complete`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, path: cloudPath, fileId: uploadedPart.fileID || uploadedPart.fileId || '', size: chunk.size, final: offset + chunk.size >= file.size }) });
      const partData = await partResponse.json().catch(() => ({}));
      if (!partResponse.ok) throw new Error(partData.error || '录音分片登记失败');
    }
    const queueResponse = await authenticatedFetch(apiUrl('/api/transcription-tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordingId, taskId }) });
    const queueData = await queueResponse.json().catch(() => ({}));
    if (!queueResponse.ok) throw new Error(queueData.error || '录音转写排队失败');
    if (status) status.textContent = `${file.name} · 已上传，等待异步转写服务处理`;
    recordingDraft.uploaded = true;
    toast('录音已上传，已进入异步转写队列');
    pollTranscriptionTask(taskId, file.name);
  } catch (error) {
    if (status) status.textContent = `${file.name} · 自动转写失败：${error.message}`;
    toast(error.message || '自动转写失败，可手动粘贴转写内容');
  }
}

async function pollTranscriptionTask(taskId, fileName, attempts = 0) {
  if (!taskId || attempts > 100) return;
  await sleep(3000);
  if (recordingDraft.taskId !== taskId || recordingDraft.candidateId !== app.candidateId) return;
  try {
    const response = await authenticatedFetch(apiUrl(`/api/transcription-tasks/${taskId}`));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '转写任务查询失败');
    const task = data.task || {};
    const status = $('#recordingStatus');
    if (['created', 'uploading', 'uploaded', 'queued', 'converting', 'transcribing', 'merging'].includes(task.status)) {
      if (status) status.textContent = `${fileName} · ${task.status === 'queued' ? '排队等待转写服务' : `转写处理中（${task.status}）`}`;
      return pollTranscriptionTask(taskId, fileName, attempts + 1);
    }
    if (task.status === 'completed' && task.result?.text) {
      const transcript = $('#callTranscript');
      if (transcript && !transcript.value.trim()) transcript.value = task.result.text;
      if (status) status.textContent = `${fileName} · 已完成转写 ${task.result.characters || task.result.text.length} 字`;
      return toast('录音已自动转写到电话记录');
    }
    if (status) status.textContent = `${fileName} · 转写失败：${task.error || '请稍后重试'}`;
  } catch (error) {
    if (attempts < 3) return pollTranscriptionTask(taskId, fileName, attempts + 1);
    const status = $('#recordingStatus');
    if (status) status.textContent = `${fileName} · 转写状态查询失败：${error.message}`;
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
  try {
    const response = await fetch(`${DESKTOP_AGENT_URL}/status`, { signal: AbortSignal.timeout(900) });
    if (response.ok) {
      desktopAgentAvailable = true;
      const command = await fetch(`${DESKTOP_AGENT_URL}/recording/start`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      const result = await command.json().catch(() => ({}));
      if (!command.ok) throw new Error(result.error || '桌面助手无法开始录音');
      activeRecorder = 'desktop';
      recorderStopping = false;
      $('#startRecording').disabled = true; $('#stopRecording').disabled = false;
      $('#recordingStatus').textContent = '桌面助手正在后台录音，网页可安全切换或最小化。';
      return;
    }
  } catch { desktopAgentAvailable = false; }
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
  if (activeRecorder === 'desktop') return stopDesktopRecording();
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

async function stopDesktopRecording() {
  if (recorderStopping) return;
  recorderStopping = true;
  const start = $('#startRecording'); const stop = $('#stopRecording');
  if (start) start.disabled = true; if (stop) { stop.disabled = true; stop.textContent = '正在停止…'; }
  try {
    const response = await fetch(`${DESKTOP_AGENT_URL}/recording/stop`, { method: 'POST', signal: AbortSignal.timeout(12000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '桌面助手停止录音失败');
    const fileResponse = await fetch(`${DESKTOP_AGENT_URL}/recording/file`, { signal: AbortSignal.timeout(30000) });
    if (!fileResponse.ok) throw new Error('桌面助手录音文件读取失败');
    const blob = await fileResponse.blob();
    activeRecorder = null; recorderStopping = false;
    if (start) start.disabled = false; if (stop) { stop.disabled = true; stop.textContent = '停止录音'; }
    setRecordingFile(new File([blob], `call-${Date.now()}.webm`, { type: 'audio/webm' }));
  } catch (error) {
    activeRecorder = null; recorderStopping = false;
    if (start) start.disabled = false; if (stop) { stop.disabled = true; stop.textContent = '停止录音'; }
    $('#recordingStatus').textContent = `桌面助手录音失败：${error.message}`;
    toast(error.message || '桌面助手录音失败');
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
  const job = app.jobs.find(item => item.id === id); $('#jobForm').reset(); $('#jobDialogTitle').textContent = job ? '编辑岗位' : '新建岗位'; $('#jobIdInput').value = job?.id || ''; $('#jobIndustryInput').value = job?.industry || '金融'; $('#jobNameInput').value = job?.name || ''; $('#jobCategoryInput').value = job?.category || ''; $('#jobLocationInput').value = job?.location || ''; $('#jobDepartmentInput').value = job?.department || ''; $('#jobJdInput').value = job?.jd || ''; $('#jobKeywordsInput').value = (job?.keywords || []).join('、'); $('#jobRulesInput').value = `${job?.rules || ''}${pendingTeamRule ? `${job?.rules ? '\n' : ''}${pendingTeamRule}` : ''}`; pendingTeamRule = ''; populateRuleLibrary(); $('#jobDialog').showModal();
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
  event.preventDefault(); const id = $('#jobIdInput').value || crypto.randomUUID(); const old = app.jobs.find(job => job.id === id); const job = { id, industry:$('#jobIndustryInput').value, name:$('#jobNameInput').value.trim(), category:$('#jobCategoryInput').value.trim(), location:$('#jobLocationInput').value.trim(), department:$('#jobDepartmentInput').value.trim(), jd:$('#jobJdInput').value.trim(), keywords:parseKeywords($('#jobKeywordsInput').value), rules:$('#jobRulesInput').value.trim(), status:old?.status === 'closed' ? 'closed' : 'active', createdAt:old?.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString() }; if (!job.name || !job.jd) return toast('请填写岗位名称和JD'); app.jobs = [job,...app.jobs.filter(item => item.id !== id)]; persistJobs(job); $('#jobDialog').close(); renderJobs(); toast(old ? '岗位已更新' : '岗位已创建');
}

async function parseResume(file) {
  if (!file) return; if (file.size > RESUME_MAX_BYTES) return toast('简历文件不能超过50MB'); const extension = file.name.split('.').pop().toLowerCase(); $('#resumeStatus').className = 'file-status'; $('#resumeStatus').textContent = `正在解析 ${file.name}…`;
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
function persistCases(candidate){localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));const count=$('#candidateNavCount');if(count)count.textContent=app.cases.length;if(REMOTE_BACKEND&&candidate)saveRemote(`/api/candidates/${candidate.id}`,candidate);}
function persistJobs(job){localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));if(REMOTE_BACKEND&&job)saveRemote(`/api/jobs/${job.id}`,job);}
function parseKeywords(value=''){return [...new Set(value.split(/[、,，;；\n]/).map(v=>v.trim()).filter(Boolean))];}
function seedJobs(){if(REMOTE_BACKEND||app.jobs.length)return;const job={id:crypto.randomUUID(),industry:'金融',name:'场外期权产品经理',jd:'负责场外期权RFQ、交易簿记和生命周期管理产品规划，推动交易、风控和研发团队协作上线。',keywords:['场外期权','RFQ','交易簿记','生命周期管理'],rules:'重点核实个人职责、项目上线结果、业务规模和团队分工。',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};app.jobs=[job];persistJobs(job);}
function resumeHint(item){const meta=item.resumeMeta||{};const facts=[meta.age?`${meta.age}岁`:'',meta.experienceYears?`${meta.experienceYears}年经验`:''].filter(Boolean);return facts.join(' · ')||meta.fileName||'简历已录入';}
function formatDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':`${date.getMonth()+1}月${date.getDate()}日`;}
function byUpdated(a,b){return new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt);}
function infoLabel(key){return({currentCompanyRole:'当前公司及职位',location:'当前地点',currentSalary:'当前薪资',expectedSalary:'期望薪资',availability:'到岗时间',motivation:'求职动机',nonCompete:'竞业限制'}[key]||key);}
function readField(text,label){return text.match(new RegExp(`${label}[：:为是]?([^，。；;\\n]{2,24})`))?.[1]?.trim()||'待确认';}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));}
function apiUrl(path){return `${API_BASE}${path}`;}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cloudError(status, body = {}) {
  if (body.error) return body.error;
  return ({401:'登录凭证已失效，请重新登录',403:'当前账号没有工作区权限',404:'CloudBase接口不存在',408:'CloudBase请求超时',429:'CloudBase请求过于频繁，正在自动重试',443:'CloudBase网关或认证服务暂时不可用',500:'CloudBase云函数内部错误',502:'CloudBase网关暂时不可用',503:'CloudBase服务暂时不可用',504:'CloudBase响应超时'}[status] || `CloudBase请求失败（${status}）`);
}
async function saveRemote(path,payload,silent=false){try{const response=await authenticatedFetch(apiUrl(path),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(cloudError(response.status,result));return result;}catch(error){console.error(error);if(!silent)toast(`已保存在本机，云端未同步：${error.message||'未知错误'}`);return null;}}
async function hydrateState(){if(!REMOTE_BACKEND)return;try{let response=await authenticatedFetch(apiUrl('/api/state'));if(!response.ok){const body=await response.clone().json().catch(()=>({}));throw new Error(cloudError(response.status,body));}const remote=await response.json();app.remoteState={jobs:remote.jobs||[],cases:remote.cases||[],rules:remote.rules||[]};app.jobs=app.remoteState.jobs;app.cases=app.remoteState.cases;teamRules=app.remoteState.rules.map(item=>item.content).filter(Boolean);app.legacyLocalState=null;persistHydratedState();await migrateStoredResumesOnce();await loadMokaInterviews();await loadInterviewerLibrary();await loadTranscriptImports();}catch(error){console.error(error);const cachedCases=readStore(CASES_KEY);const cachedJobs=readStore(JOBS_KEY);const cachedRules=readStore(RULES_KEY);app.jobs=cachedJobs;app.cases=cachedCases;teamRules=cachedRules;app.remoteState={jobs:cachedJobs,cases:cachedCases,rules:cachedRules.map(content=>({content}))};toast(`CloudBase暂不可用，已保留本机缓存：${error.message||'服务请求失败'}`);}}
function currentWorkspaceId(){return String(app.workspace?.workspace?.id||app.workspace?.workspace?.tenantId||'').trim();}
function migrationStorageKey(){const tenantId=currentWorkspaceId();return tenantId?`${LOCAL_MIGRATION_KEY_PREFIX}${tenantId}`:'';}
function persistHydratedState(){localStorage.setItem(JOBS_KEY,JSON.stringify(app.jobs));localStorage.setItem(CASES_KEY,JSON.stringify(app.cases));localStorage.setItem(RULES_KEY,JSON.stringify(teamRules));}
function formatInterviewMoment(value){if(!value)return'—';const date=new Date(value);if(Number.isNaN(date.getTime()))return'—';const day=`${date.getMonth()+1}月${date.getDate()}日`;if(!String(value).includes('T'))return day;return `${day} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;}
async function loadMokaInterviews(options = {}) {
  if (!REMOTE_BACKEND) return;
  if (mokaRefreshInFlight) return mokaRefreshInFlight;
  const automatic = options.automatic === true;
  mokaRefreshInFlight = (async () => {
  app.mokaInterviewStatus = { configured: false, loading: true };
  try {
    const debugResponse = await authenticatedFetch(apiUrl('/api/debug/status'), { timeoutMs: 8000 });
    const debugData = await debugResponse.json().catch(() => ({}));
    app.connectionDiagnostics = { gateway: debugResponse.ok && debugData.route === 'reachable' ? '正常' : `HTTP ${debugResponse.status}`, checkedAt: debugData.timestamp || new Date().toISOString(), error: debugResponse.ok ? '' : cloudError(debugResponse.status, debugData) };
    const response = await authenticatedFetch(apiUrl('/api/integrations/moka/interviews'), { timeoutMs: 120000 });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(cloudError(response.status, data));
    app.mokaInterviews = Array.isArray(data.records) ? data.records : [];
    syncInterviewTranscripts();
    if (Array.isArray(data.syncedJobs) && data.syncedJobs.length) {
      app.jobs = mergeRecords(app.jobs, data.syncedJobs);
      try { persistHydratedState(); } catch (error) { console.warn('[AceCall jobs cache]', error); }
    }
    app.mokaAnalytics = data.analytics || null;
    app.mokaInterviewStatus = { configured: Boolean(data.configured), loading: false, fetchedAt: data.fetchedAt, totalFetched: data.totalFetched || 0, totalMatched: data.totalMatched || app.mokaInterviews.length, transcriptStats: data.transcriptStats || {}, warnings: data.warnings || [], projectScopeFallback: Boolean(data.projectScopeFallback), scopeDiagnostics: data.scopeDiagnostics || null, mokaJobStats: data.mokaJobStats || null, filters: data.filters || null, feedbackStats: data.feedbackStats || null, httpStatus: response.status, refreshMode: automatic ? 'automatic-12h' : 'manual' };
    if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
  } catch (error) {
    if (error.authRequired) return;
    console.warn('[AceCall Moka interviews]', error);
    app.mokaInterviewStatus = { ...app.mokaInterviewStatus, configured: Boolean(app.mokaInterviewStatus.configured), loading: false, error: error.message, httpStatus: error.status || 0 };
  }
  })();
  try { return await mokaRefreshInFlight; } finally { mokaRefreshInFlight = null; }
}
async function loadInterviewerLibrary() {
  if (!REMOTE_BACKEND) return;
  try {
    const response = await authenticatedFetch(apiUrl('/api/interviewers'));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(cloudError(response.status, data));
    app.interviewerLibrary = Array.isArray(data.records) ? data.records : [];
    if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
  } catch (error) { console.warn('[AceCall interviewers]', error); }
}
async function addInterviewerName(name) {
  const response = await authenticatedFetch(apiUrl('/api/interviewers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, source: 'manual' }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(cloudError(response.status, data));
  app.interviewerLibrary = Array.isArray(data.records) ? data.records : [];
  await loadTranscriptImports();
}
async function loadTranscriptImports() {
  if (!REMOTE_BACKEND) return;
  try {
    const response = await authenticatedFetch(apiUrl('/api/transcript-imports'));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(cloudError(response.status, data));
    app.transcriptImports = Array.isArray(data.records) ? data.records : [];
    syncInterviewTranscripts();
    if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
    if (app.view === 'intelligence') renderIntelligence();
  } catch (error) { console.warn('[AceCall transcript imports]', error); }
}

function recordTimestamp(record){const value=record?.updatedAt||record?.createdAt||0;const time=Date.parse(value);return Number.isFinite(time)?time:0;}
function mergeRecords(remoteRecords=[], localRecords=[]){const merged=new Map(remoteRecords.map(record=>[record.id||record._id,record]));for(const record of localRecords){const id=record.id||record._id;if(!id)continue;const existing=merged.get(id);if(!existing||recordTimestamp(record)>recordTimestamp(existing))merged.set(id,record);}return [...merged.values()];}
async function migrateLegacyLocalState(){const local=app.legacyLocalState||{jobs:[],cases:[],rules:[]};const remote=app.remoteState||{jobs:[],cases:[],rules:[]};let failed=0;for(const job of local.jobs.filter(item=>{const existing=remote.jobs.find(record=>(record.id||record._id)===(item.id||item._id));return !existing||recordTimestamp(item)>recordTimestamp(existing); })){if(!await saveRemote(`/api/jobs/${job.id}`,job,true))failed++;await sleep(120);}for(const candidate of local.cases.filter(item=>{const existing=remote.cases.find(record=>(record.id||record._id)===(item.id||item._id));return !existing||recordTimestamp(item)>recordTimestamp(existing); })){if(!await saveRemote(`/api/candidates/${candidate.id}`,candidate,true))failed++;await sleep(120);}const remoteRuleContents=new Set(remote.rules.map(item=>item.content).filter(Boolean));for(const content of local.rules.filter(item=>item&&!remoteRuleContents.has(item))){if(!await saveRemote(`/api/rules/${crypto.randomUUID()}`,{content,version:1},true))failed++;await sleep(120);}app.jobs=mergeRecords(remote.jobs,local.jobs);app.cases=mergeRecords(remote.cases,local.cases);teamRules=[...new Set([...remote.rules.map(item=>item.content).filter(Boolean),...local.rules.filter(Boolean)])];app.remoteState={jobs:app.jobs,cases:app.cases,rules:teamRules.map(content=>({content}))};persistHydratedState();if(!failed){const key=migrationStorageKey();if(key)localStorage.setItem(key,'completed');app.legacyLocalState=null;toast('本机旧数据已合并到当前工作区');}else toast(`部分本机数据同步失败，${failed} 条记录可稍后重试`);}
async function migrateStoredResumesOnce(){if(!FORCE_MIGRATION&&localStorage.getItem('acecall-resume-migration-v1'))return;try{const response=await authenticatedFetch(apiUrl('/api/migrate-resumes'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('存量简历迁移失败');const result=await response.json();localStorage.setItem('acecall-resume-migration-v1',JSON.stringify({migrated:result.migrated||0,failed:result.failed?.length||0,at:new Date().toISOString()}));if(result.migrated)toast(`已重新整理 ${result.migrated} 份存量简历`);}catch(error){console.error(error);toast('存量简历迁移未完成，请稍后重试');}}
async function checkService(){if(STATIC_DEMO){$('#serviceStatus').innerHTML='<i></i>在线演示';return;}try{const response=await authenticatedFetch(apiUrl('/api/health'));const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(cloudError(response.status,data));$('#serviceStatus').innerHTML=`<i></i>${data.mode==='ai'?'DeepSeek AI · CloudBase':'CloudBase演示模式'}`;}catch(error){console.warn('[AceCall service]',error);$('#serviceStatus').textContent=error.message||'服务状态未知';}}
async function authenticatedFetch(url, options = {}) {
  // The login screen is controlled by initializeAuth/signIn only. A rejected
  // business request (for example a missing workspace membership) must not
  // flash the login screen after a successful sign-in.
  if (!cloudbaseAuth) throw new Error('登录已过期，请重新登录');
  const request = async token => {
    const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${token}`); headers.set('X-AceCall-Token', `Bearer ${token}`);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
    try { return await fetch(url, { ...options, headers, signal: controller.signal }); }
    catch (error) { if (error.name === 'AbortError') throw new Error('CloudBase请求超时，请检查网络后重试'); throw new Error('CloudBase网络连接失败，请检查网络或跨域配置'); }
    finally { clearTimeout(timer); }
  };
  let sessionResult = await cloudbaseAuth.getSession();
  let token = sessionResult.data?.session?.access_token;
  if (!token) {
    const refreshed = await cloudbaseAuth.refreshSession().catch(() => null);
    token = refreshed?.data?.session?.access_token;
  }
  if (!token) throw new Error('登录已过期，请重新登录');
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { response = await request(token); } catch (error) { if (attempt === 2) throw error; await sleep(400 * 2 ** attempt); continue; }
    if (![429,502,503,504].includes(response.status) || attempt === 2) break;
    await sleep(500 * 2 ** attempt);
  }
  if (response.status === 401) {
    const refreshed = await cloudbaseAuth.refreshSession().catch(() => null);
    const freshToken = refreshed?.data?.session?.access_token;
    if (freshToken) response = await request(freshToken);
    else throw new Error('登录已过期，请重新登录');
  }
  return response;
}
let toastTimer;function toast(message){const element=$('#toast');element.textContent=message;element.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>element.classList.remove('show'),2600);}
async function hydrateWorkspace(username = '', companyName = ''){if(!REMOTE_BACKEND)return;try{let response=await authenticatedFetch(apiUrl('/api/workspace'));const account=username||app.authUser?.email||app.authUser?.username||$('#loginUsername')?.value||'';if(response.status===403){const requestedCompany=companyName||INTERNAL_TEST_COMPANY;response=await authenticatedFetch(apiUrl('/api/workspace/bootstrap'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:account,companyName:requestedCompany})});}if(!response.ok)throw new Error('工作区初始化失败');const workspace=await response.json();workspace.currentMember={...(app.authUser||{}),...(workspace.currentMember||{}),email:workspace.currentMember?.email||app.authUser?.email||''};app.workspace=workspace;updateUserHeader();}catch(error){console.error(error);toast(error.message||'工作区读取失败');}}
function updateUserHeader(){const workspace=app.workspace||{};const member=workspace.currentMember||{};const authUser=app.authUser||{};const company=workspace.workspace?.name||localStorage.getItem(WORKSPACE_NAME_KEY)||'AceCall 招聘团队';const email=member.email||authUser.email||'';const username=member.username||authUser.username||member.displayName||authUser.displayName||$('#loginUsername')?.value||member.uid||authUser.uid||'当前账号';const displayName=member.displayName||authUser.displayName||(email?email.split('@')[0]:username);const initials=String(displayName||username).slice(0,2).toUpperCase();const companyEl=$('#companyNameDisplay');const companyButton=$('#companyMenuButton');const companyMenuName=$('#companyMenuName');const companyMenuMeta=$('#companyMenuMeta');const userEl=$('#userNameDisplay');const avatar=$('#accountMenuButton');const menuAvatar=$('#accountMenuAvatar');const menuName=$('#accountMenuName');const menuEmail=$('#accountMenuEmail');if(companyEl)companyEl.textContent=company;if(companyButton){companyButton.title=company;companyButton.setAttribute('aria-label',`查看企业工作区：${company}`);}if(companyMenuName)companyMenuName.textContent=company;if(companyMenuMeta)companyMenuMeta.textContent=`${member.role||'成员'} · ${(workspace.members||[]).length||1} 位成员`;if(userEl)userEl.textContent=username;if(avatar)avatar.textContent=initials;if(menuAvatar)menuAvatar.textContent=initials;if(menuName)menuName.textContent=displayName;if(menuEmail)menuEmail.textContent=email||'未绑定邮箱';}
