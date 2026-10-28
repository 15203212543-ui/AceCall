import { CLASSIFICATIONS } from './interview-questions.mjs?v=__ACE_CALL_BUILD__';

const runtime = {};

export function attachInterviewerRuntime(next) {
  Object.assign(runtime, next);
}

const app = new Proxy({}, {
  get(_target, key) { return runtime.app[key]; },
  set(_target, key, value) { runtime.app[key] = value; return true; }
});
const $ = (selector) => runtime.query(selector);
const escapeHtml = (...args) => runtime.escapeHtml(...args);
const formatDate = (...args) => runtime.formatDate(...args);
const generate = (...args) => runtime.generate(...args);
const authenticatedFetch = (...args) => runtime.authenticatedFetch(...args);
const apiUrl = (...args) => runtime.apiUrl(...args);
const cloudError = (...args) => runtime.cloudError(...args);
const mergeRecords = (...args) => runtime.mergeRecords(...args);
const persistHydratedState = (...args) => runtime.persistHydratedState(...args);
function renderIntelligence() { return runtime.renderIntelligence(); }

export { renderInterviewers, renderInterviewerFollowups, loadMokaInterviews, loadInterviewerLibrary, loadTranscriptImports, clearDeferredCaches, noteDeferredTenant };

let mokaRefreshInFlight = null;
let interviewerLibraryInFlight = null;
let transcriptImportsInFlight = null;
let deferredTenantId = '';
const DEFERRED_TTL_MS = 12 * 60 * 60 * 1000;

function tenantKey() {
  return String(app.workspace?.workspace?.id || app.workspace?.workspace?.tenantId || '').trim();
}

function deferredStorageKey(kind) {
  return `acecall-deferred-v1:${tenantKey()}:${kind}`;
}

function readDeferred(kind) {
  const tenantId = tenantKey();
  if (!tenantId) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(deferredStorageKey(kind)) || 'null');
    const savedAt = Date.parse(parsed?.savedAt || '');
    if (!parsed || parsed.tenantId !== tenantId || !Number.isFinite(savedAt)) return null;
    if (Date.now() - savedAt > DEFERRED_TTL_MS) return null;
    return parsed;
  } catch { return null; }
}

function writeDeferred(kind, payload) {
  const tenantId = tenantKey();
  if (!tenantId) return;
  try { localStorage.setItem(deferredStorageKey(kind), JSON.stringify({ ...payload, tenantId, savedAt: new Date().toISOString() })); }
  catch (error) { console.warn('[AceCall deferred cache]', error); }
}

function clearDeferredCaches() {
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && key.startsWith('acecall-deferred-v1:')) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
  app.mokaInterviews = [];
  app.mokaInterviewStatus = { configured: false, loading: false };
  app.interviewerLibrary = [];
  app.transcriptImports = [];
  deferredTenantId = '';
}

function noteDeferredTenant() {
  const next = tenantKey();
  if (deferredTenantId && next && deferredTenantId !== next) clearDeferredCaches();
  if (next) deferredTenantId = next;
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
  const trendMax = Math.max(1, ...monthRows.map(row => row.count));
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
  const lastSyncNote = status.fetchedAt ? `，上次同步 ${formatDate(status.fetchedAt)}` : '';
  const dataNote = `${status.loading ? '正在读取 Moka 面试数据' : status.error ? `Moka 读取失败：${status.error}${lastSyncNote}` : status.configured ? `${lookbackNote}Moka 只读数据 · 按 13 个目标岗位名称筛选${status.fromCache ? lastSyncNote : ''}` : 'Moka 接口待配置 · 当前仅展示 AceCall 已标记面试官的数据'}${jobSyncNote} · CloudBase 网关：${diagnostics.error || diagnostics.gateway || '未检查'}${status.warnings?.length ? ` · ${status.warnings.join('；')}` : ''}`;
  const diagnosticRow = (label, value, tone = '') => `<div class="connection-diagnostic-row"><span>${escapeHtml(label)}</span><b class="${tone}">${escapeHtml(value || '未检查')}</b></div>`;
  const selectOptions = (values, value, empty) => `<option value="">${empty}</option>${values.map(item => `<option value="${escapeHtml(item)}"${item === value ? ' selected' : ''}>${escapeHtml(item)}</option>`).join('')}`;
  root.innerHTML = `<div class="page research-page interviewer-analysis-page"><div class="page-title"><div><span class="eyebrow">INTERVIEWER ANALYTICS</span><h1>面试官分析</h1><p>以面试官为主语，查看面试工作量、判断结果和提问方式。</p></div><button class="secondary" type="button" data-refresh-interviewer>刷新 Moka 数据</button></div><div class="interviewer-scope"><div><span>当前面试官</span><strong>${escapeHtml(selected || '尚未识别')}</strong></div><p>${dataNote}</p><span class="data-status">不等同于岗位招聘大盘</span></div><div class="interviewer-filters"><select id="interviewerFilter">${selectOptions(interviewers, selected, '全部面试官')}</select><select id="interviewerJobFilter">${selectOptions(jobs, filters.job, '全部岗位')}</select><select id="interviewerRoundFilter">${selectOptions(rounds, filters.round, '全部面试环节')}</select><select id="interviewerPeriodFilter"><option value=""${!filters.period ? ' selected' : ''}>全部时间</option><option value="30"${filters.period === '30' ? ' selected' : ''}>近 30 天</option><option value="90"${filters.period === '90' ? ' selected' : ''}>近 90 天</option><option value="365"${filters.period === '365' ? ' selected' : ''}>近一年</option></select></div><div class="metrics research-metrics interviewer-metrics"><div class="metric"><b>${outcomes.completed || '—'}</b><span>已完成面试</span><small>${selected || '选择面试官'}参与的记录</small></div><div class="metric"><b>${outcomes.passed || '—'}</b><span>面试通过</span><small>明确通过结论</small></div><div class="metric"><b>${outcomes.rejected || '—'}</b><span>面试淘汰</span><small>明确淘汰/不通过结论</small></div><div class="metric"><b>${outcomes.pending || '—'}</b><span>待评价</span><small>尚未形成结果</small></div><div class="metric"><b>${(outcomes.completed || 0) < 5 ? '样本不足' : pct(outcomes.passed, outcomes.completed)}</b><span>面试通过率</span><small>${(outcomes.completed || 0) < 5 ? '少于 5 场不展示比率' : `${outcomes.passed} 人通过`}</small></div><div class="metric"><b>${(outcomes.completed || 0) < 5 ? '样本不足' : pct(outcomes.evaluated, outcomes.completed)}</b><span>评价完成率</span><small>${(outcomes.completed || 0) < 5 ? '少于 5 场不展示比率' : '有明确结论的面试'}</small></div></div><section class="surface interviewer-trend-panel"><div class="surface-head"><div><h2>面试量趋势</h2><p class="surface-subtitle">只统计当前面试官的已完成面试</p></div><span>最近 6 个月</span></div><div class="surface-body interviewer-trend">${monthRows.map(row => `<div><b>${row.count}</b><span class="trend-plot"><i style="height:${row.count ? Math.max(14, Math.round(row.count / trendMax * 132)) : 0}px"></i></span><span>${escapeHtml(row.month)}</span></div>`).join('') || '<div class="empty">暂无带日期的 Moka 面试记录。</div>'}</div></section>
  </div>`;
  root.querySelector('.interviewer-metrics')?.insertAdjacentHTML('afterend', `<section class="surface interviewer-server-analysis"><div class="surface-head"><div><h2>云端结构化分析</h2><p class="surface-subtitle">由 AceCall 云函数基于 Moka 转写统一计算，便于后续月度复盘</p></div><span>${serverAnalytics.interviewer ? '已生成' : '等待数据'}</span></div><div class="server-analysis-grid"><div><b>${(serverAnalytics.sampleLimited || (serverAnalytics.interviewer?.completed || 0) < 5) ? '样本不足' : (serverAnalytics.interviewer?.score ?? '—')}</b><span>面试表现分</span><small>少于 5 场只保留客观数量</small></div><div><b>${(serverAnalytics.sampleLimited || (serverAnalytics.interviewer?.completed || 0) < 5) ? (serverAnalytics.questions?.length || 0) : `${serverAnalytics.dimensions?.questionCoverage ?? '—'}%`}</b><span>问题覆盖</span><small>${serverAnalytics.questions?.length || 0} 条问题句</small></div><div><b>${(serverAnalytics.sampleLimited || (serverAnalytics.interviewer?.completed || 0) < 5) ? (serverAnalytics.followUpSignals || 0) : `${serverAnalytics.dimensions?.followUpDepth ?? '—'}%`}</b><span>追问深度</span><small>${serverAnalytics.followUpSignals || 0} 个追问信号</small></div><div><b>${(serverAnalytics.sampleLimited || (serverAnalytics.interviewer?.completed || 0) < 5) ? (serverAnalytics.interviewer?.completed || 0) : `${serverAnalytics.interviewer?.evaluationRate ?? '—'}%`}</b><span>评价完成</span><small>${serverAnalytics.interviewer?.evaluated || 0} / ${serverAnalytics.interviewer?.completed || 0} 场</small></div></div><div class="recommendation-list server-analysis-recommendations">${((serverAnalytics.sampleLimited || (serverAnalytics.interviewer?.completed || 0) < 5) ? [] : (serverAnalytics.recommendations || ['同步 Moka 后生成面试官改进建议。'])).map(item => `<p><b>建议：</b>${escapeHtml(item)}</p>`).join('')}</div><div class="research-tags server-analysis-topics">${(serverAnalytics.topics || []).map(item => `<span class="research-tag blue">${escapeHtml(item.name)} · ${item.mentions}</span>`).join('') || '<span class="muted-text">暂无可识别主题</span>'}</div></section>`);
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
  root.querySelector('[data-refresh-interviewer]')?.addEventListener('click', async event => { event.currentTarget.disabled = true; await loadMokaInterviews({ force: true }); await loadInterviewerLibrary({ force: true }); await loadTranscriptImports({ force: true }); if (runtime.loadAnalysisTexts) await runtime.loadAnalysisTexts(true); renderInterviewers(); renderInterviewerFollowups(); });
}

function interviewerTranscripts(filters = {}) {
  const captured = transcriptCaptureEntries(filters).map(item => ({
    id: item.id || '',
    candidateName: item.candidateName || '',
    jobName: item.jobName || '',
    interviewer: item.interviewer || '',
    round: item.round || '',
    startedAt: item.startedAt || '',
    text: String(item.text || '').replace(/[^\S\n]+/g, ' ').trim().slice(0, 4000)
  })).filter(item => item.text.length >= 40);
  if (captured.length) return captured;
  return interviewerRecords(filters).filter(item => String(item.transcript || '').trim().length >= 40).map(item => ({
    id: item.id || '',
    candidateName: item.candidateName || '',
    jobName: item.jobName || '',
    interviewer: item.interviewer || '',
    round: item.round || '',
    startedAt: item.startedAt || '',
    text: String(item.transcript || '').replace(/[^\S\n]+/g, ' ').trim().slice(0, 4000)
  }));
}
function interviewerInsightSessions() {
  return interviewerTranscripts(app.interviewerFilters || {}).slice(0, 6);
}
function questionJob(sessions) {
  const names = [...new Set(sessions.map(item => item.jobName).filter(Boolean))];
  if (names.length > 1) return { conflict: true, name: names.join('、'), jd: '' };
  const name = names[0] || app.interviewerFilters?.job || '';
  const job = (app.jobs || []).find(item => name && (item.name === name || name.includes(item.name) || String(item.name || '').includes(name)));
  if (!job) return name ? { unbound: true, name, jd: '' } : null;
  return { id: job.id, name: job.name, jd: job.jd || '', rules: job.rules || '', keywords: job.keywords || [], required: job.required || job.profile?.required || [], verify: job.verify || job.profile?.verify || [], location: job.location || '' };
}
function storedQuestionReviews() {
  try { return JSON.parse(localStorage.getItem('acecall-interview-question-reviews-v1') || '[]'); } catch { return []; }
}
function interviewerInsightKey(sessions) {
  const filters = app.interviewerFilters || {};
  const reviews = storedQuestionReviews().map(item => [item.questionId, item.classification, item.version]);
  return JSON.stringify({ interviewer: filters.interviewer || '', job: filters.job || '', round: filters.round || '', period: filters.period || '', reviews, sessions: sessions.map(item => [item.id, item.candidateName, item.jobName, item.interviewer, item.startedAt, item.text.length, item.text.slice(0, 24)]) });
}
function questionCard(result, item, extra = '') {
  const label = item.normalizedText || item.rawText;
  const sources = (item.sources || []).map(source => [source.candidateName, source.jobName, String(source.startedAt || '').slice(0, 10)].filter(Boolean).join(' · ')).filter(Boolean);
  const badge = result.sampleLimited && item.classificationSource !== 'human' ? '<em>未经 AI 归类</em>' : '';
  const sourceLine = sources.join('、') || '当前转写';
  return `<details class="question-card"><summary><span>${escapeHtml(label)}</span>${badge}</summary><div class="question-meta"><span>候选人 · ${escapeHtml(sourceLine)}</span><span>类型 · 专业岗位问题</span></div><p><b>原始转写：</b>${escapeHtml([item.rawText, ...(item.mergedRaw || [])].filter(Boolean).join(' / '))}</p><p><b>岗位准则：</b>${escapeHtml(item.jobCriteriaId || item.conditionLabel || '未关联具体准则')}</p><p><b>转写证据：</b>来自该场真实面试原句，未补写外部内容。</p>${extra}</details>`;
}
function isProfessionalQuestion(item = {}) {
  const text = String(item.normalizedText || item.rawText || '').replace(/\s+/g, '');
  if (!text || /自我介绍|介绍一下你自己|先介绍一下自己|能听见吗|听得到吗|现在方便吗/.test(text)) return false;
  if (!/[？?]|吗$|呢$|什么|怎么|如何|为什么|有没有|是否|能不能|可不可以/.test(text)) return false;
  return /下单|订单|委托|成交|交易|交易所|资金|冻结|解冻|持仓|结算|清算|风控|报价|询价|期权|衍生品|FIX|消息|开户|KYC|AML|行情|稳定性|性能|并发|延迟|故障|海外银行卡|银行卡|入金|出金|币种|富途|证券账户|交易账户|港股|美股|复投|资金账户|客户账户|托管|清算交收|岗位|工作|项目|职责|经验|负责/.test(text);
}
function questionAnalysisHtml(result = {}) {
  const items = result.items || [];
  const promoted = new Set();
  const jobQuestions = items.filter(item => {
    const accepted = item.classification === 'job_question' && (result.sampleLimited || item.confirmed);
    const recovered = !accepted && item.classification === 'needs_context' && isProfessionalQuestion(item);
    if (recovered) promoted.add(item.id);
    return accepted || recovered;
  }).sort((left, right) => (right.sources?.length || 0) - (left.sources?.length || 0));
  const conditions = items.filter(item => item.classification === 'condition_check');
  const needs = items.filter(item => !promoted.has(item.id) && (item.classification === 'needs_context' || (item.classification === 'job_question' && !result.sampleLimited && !item.confirmed)));
  const reviewButtons = item => `<div class="question-actions"><button type="button" data-review-question="${escapeHtml(item.id)}" data-review-class="job_question">归入岗位问题</button><button type="button" data-review-question="${escapeHtml(item.id)}" data-review-class="condition_check">归入条件核验</button><button type="button" data-review-question="${escapeHtml(item.id)}" data-review-class="needs_context">保留待判断</button></div>`;
  const visibleJobs = jobQuestions.slice(0, 5);
  const extraJobs = jobQuestions.slice(5);
  const jobBlock = jobQuestions.length ? `<section class="question-block professional-question-block"><div class="question-block-head"><div><h3>真实专业问题</h3><p>仅来自当前面试官的真实转写，已排除自我介绍、通话确认和候选人陈述</p></div><strong>${jobQuestions.length} 条</strong></div>${visibleJobs.map(item => questionCard(result, item)).join('')}${extraJobs.length ? `<details class="question-more"><summary>展开其余 ${extraJobs.length} 条真实问题</summary>${extraJobs.map(item => questionCard(result, item)).join('')}</details>` : ''}</section>` : '';
  const conditionGroups = new Map();
  conditions.forEach(item => {
    const label = item.conditionLabel || '条件';
    const link = item.linkStatus || '待关联';
    const key = `${label}|${link}`;
    const group = conditionGroups.get(key) || { label, link, items: [] };
    group.items.push(item);
    conditionGroups.set(key, group);
  });
  const conditionBlock = conditionGroups.size ? `<section class="question-block"><h3>条件核验</h3>${[...conditionGroups.values()].map(group => `<details class="question-card"><summary><span>${escapeHtml(group.label)} · ${escapeHtml(group.link)} · ${group.items.length} 次</span></summary>${group.items.map(item => `<p><b>原句：</b>${escapeHtml(item.rawText)}</p><p><b>场次：</b>${escapeHtml((item.sources || []).map(source => [source.candidateName, String(source.startedAt || '').slice(0, 10)].filter(Boolean).join(' ')).filter(Boolean).join('、') || '当前转写')}</p>`).join('')}</details>`).join('')}</section>` : '';
  const needsShown = needs.slice(0, 5);
  const needsBlock = needs.length ? `<details class="question-more"><summary>待判断 ${needs.length} 条</summary>${needsShown.map(item => questionCard(result, item, reviewButtons(item))).join('')}${needs.length > 5 ? `<p class="question-excluded">其余 ${needs.length - 5} 条未列出</p>` : ''}</details>` : '';
  const covered = result.allowPersonalReview ? (result.coverage?.required || []) : [];
  const asked = covered.filter(row => row.covered).map(row => row.item);
  const missing = covered.filter(row => !row.covered).map(row => row.item);
  const coverage = result.allowPersonalReview ? `<p>${escapeHtml(covered.length ? `岗位覆盖：${asked.length ? `已问到 ${asked.join('、')}` : '还没有问到配置的要求'}${missing.length ? `；未问到 ${missing.join('、')}` : ''}。` : '岗位没有配置可对照的关键词。')}${result.followUpStyle ? escapeHtml(result.followUpStyle) : ''}</p>` : '';
  const excluded = result.excludedCommunicationCount > 0 ? `<p class="question-excluded">已排除 ${result.excludedCommunicationCount} 条通话确认</p>` : '';
  return `${coverage}${jobBlock}${conditionBlock}${needsBlock}${excluded}` || '<p>当前转写里没有可展示的岗位问题。</p>';
}
function renderInterviewerFollowups() {
  const root = $('#interviewersView'); const page = root?.querySelector('.interviewer-analysis-page'); if (!page) return;
  const selected = app.interviewerFilters?.interviewer || '';
  const filters = app.interviewerFilters || {};
  const records = interviewerRecords({ ...filters, interviewer: selected });
  const allSessions = interviewerTranscripts(filters);
  const sessions = allSessions.slice(0, 6);
  const insightKey = interviewerInsightKey(allSessions);
  const cached = app.interviewerInsight?.key === insightKey ? app.interviewerInsight.result : null;
  const sampleLimited = allSessions.length < 5;
  const insightHtml = allSessions.length ? (cached ? questionAnalysisHtml(cached) : '<p>正在按岗位和 JD 归类问题…</p>') : '<p>当前筛选下还没有可分析的转写。</p>';
  const jobQuestionCount = cached ? (cached.items || []).filter(item => (item.classification === 'job_question' && (cached.sampleLimited || item.confirmed)) || (item.classification === 'needs_context' && isProfessionalQuestion(item))).length : null;
  const coveredCount = cached?.coverage?.required?.filter(item => item.covered).length;
  const requiredCount = cached?.coverage?.required?.length;
  const coverageLabel = sampleLimited ? (jobQuestionCount === null ? '—' : jobQuestionCount) : (requiredCount ? `${coveredCount}/${requiredCount}` : (jobQuestionCount === null ? '—' : jobQuestionCount));
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
  const professionalPending = cached ? (cached.items || []).filter(item => item.classification === 'needs_context' && isProfessionalQuestion(item)).length : 0;
  const pendingCount = cached ? Math.max(0, (cached.items || []).filter(item => item.classification === 'needs_context').length - professionalPending) : '—';
  const section = document.createElement('section'); section.className = 'interviewer-followups'; section.innerHTML = `<div class="research-grid interviewer-analysis-grid"><section class="surface"><div class="surface-head"><div><h2>面试问题与偏好</h2><p class="surface-subtitle">区分通话确认、条件核验和岗位问题。只有岗位问题进入高频列表</p></div><span>${allSessions.length} 份转写</span></div><div class="surface-body recommendation-list interviewer-insight" data-interviewer-insight>${insightHtml}</div></section><section class="surface"><div class="surface-head"><div><h2>面试官阶段评分</h2><p class="surface-subtitle">第三阶段：只评价面试过程质量，不替代录用决定</p></div><span class="interviewer-score-badge">${sampleLimited ? '样本不足' : '岗位口径'}</span></div><div class="surface-body interviewer-score-grid"><div><span>问题覆盖</span><b>${coverageLabel}</b></div><div><span>条件核验</span><b>${cached ? (cached.items || []).filter(item => item.classification === 'condition_check').length : '—'}</b></div><div><span>待判断</span><b>${pendingCount}</b></div></div></section></div><section class="surface interviewer-team-compare"><div class="surface-head"><div><h2>团队面试官对比</h2><p class="surface-subtitle">每页 5 位，其余分页查看</p></div><span>${comparison.length ? `${compareStart}–${compareEnd} / ${comparison.length} 位` : '0 位'}</span></div><div class="surface-body table-wrap"><table><thead><tr><th>面试官</th><th>已完成面试</th><th>通过率</th><th>最终入职</th><th>相对当前</th></tr></thead><tbody>${compareVisible.map(row => `<tr class="${row.name === selected ? 'current-interviewer-row' : ''}"><td><strong>${escapeHtml(row.name)}</strong>${row.name === selected ? '<small>当前查看</small>' : ''}</td><td>${row.count}</td><td>${row.count < 5 ? '样本不足' : (row.count ? `${row.passRate}%` : '—')}</td><td>${row.hired}</td><td>${row.count < 5 ? '—' : (selected && row.name !== selected ? (row.passRate > (comparison.find(item => item.name === selected)?.passRate || 0) ? '通过率较高' : row.passRate < (comparison.find(item => item.name === selected)?.passRate || 0) ? '通过率较低' : '接近') : '—')}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">接入更多面试官数据后展示团队对比。</div></td></tr>'}</tbody></table></div>${comparePager}</section>`;
  page.append(section);
  const captureList = page.querySelector('.transcript-capture-list');
  const recordList = page.querySelector('.interview-record-list');
  if (captureList) page.append(captureList);
  if (recordList) page.append(recordList);
  const keepCompareScroll = () => { const top = window.scrollY; renderInterviewers(); renderInterviewerFollowups(); window.scrollTo(0, top); };
  section.querySelector('[data-compare-page="prev"]')?.addEventListener('click', () => { app.interviewerComparePage = Math.max(1, comparePage - 1); keepCompareScroll(); });
  section.querySelector('[data-compare-page="next"]')?.addEventListener('click', () => { app.interviewerComparePage = Math.min(comparePageCount, comparePage + 1); keepCompareScroll(); });
  section.querySelector('[data-compare-page-select]')?.addEventListener('change', event => { app.interviewerComparePage = Number(event.target.value) || 1; keepCompareScroll(); });
  const bindReviews = rootNode => rootNode.querySelectorAll('[data-review-question]').forEach(button => button.addEventListener('click', () => submitQuestionReview(button.dataset.reviewQuestion, button.dataset.reviewClass)));
  bindReviews(section);
  if (!cached && allSessions.length && app.interviewerInsightLoading !== insightKey) {
    app.interviewerInsightLoading = insightKey;
    generate({ action: 'classify-interview-questions', interviewer: selected, sessionCount: allSessions.length, sessions, job: questionJob(allSessions), humanReviews: storedQuestionReviews() }).then(result => {
      if (interviewerInsightKey(interviewerTranscripts(app.interviewerFilters || {})) !== insightKey) return;
      app.interviewerInsight = { key: insightKey, result };
      renderInterviewers();
      renderInterviewerFollowups();
    }).catch(error => {
      if (interviewerInsightKey(interviewerTranscripts(app.interviewerFilters || {})) !== insightKey) return;
      const box = document.querySelector('[data-interviewer-insight]');
      if (box) box.innerHTML = `<p>问题归类没有完成：${escapeHtml(error.message || 'AI 服务暂时不可用')}</p>`;
    }).finally(() => { if (app.interviewerInsightLoading === insightKey) app.interviewerInsightLoading = ''; });
  }
}

function submitQuestionReview(questionId, classification) {
  if (!CLASSIFICATIONS.includes(classification)) return;
  const current = app.interviewerInsight?.result?.items?.find(item => item.id === questionId);
  const reviews = storedQuestionReviews().filter(item => item.questionId !== questionId);
  const review = { questionId, classification, conditionType: classification === 'condition_check' ? (current?.conditionType || 'location') : null, previousClassification: current?.classification || '', rawText: current?.rawText || '', version: Number(current?.version || 1) + 1, at: new Date().toISOString() };
  reviews.push(review);
  localStorage.setItem('acecall-interview-question-reviews-v1', JSON.stringify(reviews.slice(-200)));
  app.interviewerInsight = null;
  renderInterviewers();
  renderInterviewerFollowups();
  const request = authenticatedFetch(apiUrl('/api/interview-questions/reviews'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review) });
  Promise.resolve(request).catch(error => console.warn('[AceCall question review]', error));
}

function formatInterviewMoment(value){if(!value)return'—';const date=new Date(value);if(Number.isNaN(date.getTime()))return'—';const day=`${date.getMonth()+1}月${date.getDate()}日`;if(!String(value).includes('T'))return day;return `${day} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;}
async function loadMokaInterviews(options = {}) {
  if (!runtime.remoteBackend) return;
  if (!options.force) {
    const cached = readDeferred('moka');
    if (cached) {
      app.mokaInterviews = Array.isArray(cached.records) ? cached.records : [];
      if (Array.isArray(cached.syncedJobs) && cached.syncedJobs.length) app.jobs = mergeRecords(app.jobs, cached.syncedJobs);
      app.mokaAnalytics = cached.analytics || app.mokaAnalytics || null;
      app.mokaInterviewStatus = { ...(cached.status || {}), loading: false, fromCache: true, error: '' };
      syncInterviewTranscripts();
      return;
    }
  }
  if (mokaRefreshInFlight) return mokaRefreshInFlight;
  const automatic = options.automatic === true;
  mokaRefreshInFlight = (async () => {
  const previousStatus = app.mokaInterviewStatus || {};
  app.mokaInterviewStatus = { ...previousStatus, loading: true, error: '' };
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
    app.mokaInterviewStatus = { configured: Boolean(data.configured), loading: false, fetchedAt: data.fetchedAt, totalFetched: data.totalFetched || 0, totalMatched: data.totalMatched || app.mokaInterviews.length, transcriptStats: data.transcriptStats || {}, warnings: data.warnings || [], projectScopeFallback: Boolean(data.projectScopeFallback), scopeDiagnostics: data.scopeDiagnostics || null, mokaJobStats: data.mokaJobStats || null, filters: data.filters || null, feedbackStats: data.feedbackStats || null, httpStatus: response.status, refreshMode: automatic ? 'automatic-12h' : 'manual', fromCache: false, error: '' };
    writeDeferred('moka', { records: app.mokaInterviews, syncedJobs: data.syncedJobs || [], analytics: app.mokaAnalytics, status: app.mokaInterviewStatus });
    if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
  } catch (error) {
    if (error.authRequired) return;
    console.warn('[AceCall Moka interviews]', error);
    app.mokaInterviewStatus = { ...previousStatus, ...app.mokaInterviewStatus, configured: Boolean(previousStatus.configured), loading: false, error: error.message, httpStatus: error.status || 0, fetchedAt: previousStatus.fetchedAt || '' };
    if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
  }
  })();
  try { return await mokaRefreshInFlight; } finally { mokaRefreshInFlight = null; }
}
async function loadInterviewerLibrary(options = {}) {
  if (!runtime.remoteBackend) return;
  if (!options.force) {
    const cached = readDeferred('interviewers');
    if (cached) { app.interviewerLibrary = Array.isArray(cached.records) ? cached.records : []; return; }
  }
  if (interviewerLibraryInFlight) return interviewerLibraryInFlight;
  interviewerLibraryInFlight = (async () => {
    try {
      const response = await authenticatedFetch(apiUrl('/api/interviewers'));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(cloudError(response.status, data));
      app.interviewerLibrary = Array.isArray(data.records) ? data.records : [];
      writeDeferred('interviewers', { records: app.interviewerLibrary });
      if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
    } catch (error) { console.warn('[AceCall interviewers]', error); }
  })();
  try { return await interviewerLibraryInFlight; } finally { interviewerLibraryInFlight = null; }
}
async function addInterviewerName(name) {
  const response = await authenticatedFetch(apiUrl('/api/interviewers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, source: 'manual' }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(cloudError(response.status, data));
  app.interviewerLibrary = Array.isArray(data.records) ? data.records : [];
  writeDeferred('interviewers', { records: app.interviewerLibrary });
  await loadTranscriptImports({ force: true });
}
async function loadTranscriptImports(options = {}) {
  if (!runtime.remoteBackend) return;
  if (!options.force) {
    const cached = readDeferred('transcripts');
    if (cached) {
      app.transcriptImports = Array.isArray(cached.records) ? cached.records : [];
      syncInterviewTranscripts();
      return;
    }
  }
  if (transcriptImportsInFlight) return transcriptImportsInFlight;
  transcriptImportsInFlight = (async () => {
    try {
      const response = await authenticatedFetch(apiUrl('/api/transcript-imports'));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(cloudError(response.status, data));
      app.transcriptImports = Array.isArray(data.records) ? data.records : [];
      writeDeferred('transcripts', { records: app.transcriptImports });
      syncInterviewTranscripts();
      if (app.view === 'interviewers') { renderInterviewers(); renderInterviewerFollowups(); }
      if (app.view === 'intelligence') renderIntelligence();
    } catch (error) { console.warn('[AceCall transcript imports]', error); }
  })();
  try { return await transcriptImportsInFlight; } finally { transcriptImportsInFlight = null; }
}
