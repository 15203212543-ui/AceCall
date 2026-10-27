const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const tcb = require('@cloudbase/node-sdk');
const { chooseOperatorEmail, createMokaClient, mokaConnectionStatus, screeningFingerprint, screeningWritePlan, syncScreeningComment } = require('./moka-client');
const { applyScreeningProfile, dedupeStoredJobs } = require('./screening-jobs');
const { selectMokaFeedbacks, summarizeMokaFeedback } = require('./moka-feedback');
const { isTranscriptFileName, mergeTranscriptMetadata } = require('./transcript-match');
const { prepareDocumentVersions } = require('./document-text');
const { resolveJobAssignment, draftJobProfile, confirmJobProfile, evaluateJobMatches } = require('./job-assignment');
const { proposeNameCandidates, chooseDisplayedName, extractProfileFields } = require('./resume-profile');
const { buildCallQuestions } = require('./call-preparation');
const { extractTranscriptFindings, checkCallSummary, checkSynthesis, protectInterviewerReview, applyTeamVisibility } = require('./transcript-analysis');
const { classifyInterviewQuestions, analyzeInterviewQuestions } = require('./interview-question-analysis');
const { buildAiTaskRecord } = require('./ai-task');
const { internalCluesFromFacts, rubricFromCorrections } = require('./industry-signals');
const { consumeRateLimit, redactSecrets, assertSameTenant } = require('./request-guard');
const { presentCandidateForState, presentCaseSummary, buildLegacyDocument } = require('./candidate-documents');
const { originalResumeCloudPath, originalResumeMeta, retainOriginalResume } = require('./resume-original');
const {
  normalizeResumeText,
  parseResumeBasics,
  extractCandidateName,
  extractContextualCandidateName,
  extractLabeledCandidateName,
  extractNameFromFileName,
  chooseCandidateName
} = require('./resume-text');
const { classifyTranscription, presentTranscriptionStatus } = require('./transcription-route');
const factCenter = require('./fact-center');

const PORT = 9000;
const COLLECTIONS = {
  tenants: 'acecall_tenants',
  members: 'acecall_members',
  jobs: 'acecall_jobs',
  candidates: 'acecall_candidates',
  screenings: 'acecall_screenings',
  audit: 'acecall_audit_logs',
  rules: 'acecall_team_rules',
  transcriptionTasks: 'acecall_transcription_tasks',
  interviewers: 'acecall_interviewers',
  documents: factCenter.COLLECTIONS.documents,
  facts: factCenter.COLLECTIONS.facts,
  jobProfiles: factCenter.COLLECTIONS.jobProfiles,
  aiTasks: factCenter.COLLECTIONS.aiTasks
};
let cloudbaseApp;

function getDatabase() {
  if (!process.env.TCB_ENV) throw serviceError('CloudBase environment is not configured', 503);
  if (!cloudbaseApp) {
    cloudbaseApp = tcb.init({
      env: process.env.TCB_ENV,
      accessKey: process.env.CLOUDBASE_APIKEY || undefined
    });
  }
  return cloudbaseApp.database();
}

function getCloudbaseApp() {
  getDatabase();
  return cloudbaseApp;
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || '';
  setCors(response, origin);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || '/', 'http://localhost');
    // With gateway path transmission enabled, HTTP functions receive the
    // route prefix (for example /acecall-api/api/health). Normalize it so the
    // same function works with both gateway routing modes.
    for (const prefix of ['/acecall-api-v2', '/acecall-api']) {
      while (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        url.pathname = url.pathname.slice(prefix.length) || '/';
      }
    }
    // Some gateway revisions strip the function prefix and the API prefix
    // independently. Normalize only the known public routes so a gateway
    // rewrite cannot turn a valid request into a misleading 404.
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    const declaredRoute = String(url.searchParams.get('__acecall_route') || '').trim();
    if (url.pathname === '/' && declaredRoute.startsWith('/api/')) {
      url.pathname = declaredRoute.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    }
    if (url.pathname === '/') {
      const forwardedPath = ['x-original-uri', 'x-original-url', 'x-forwarded-uri', 'x-cloudbase-path', 'x-tcb-path', 'x-gateway-path']
        .map(name => String(request.headers?.[name] || '').trim())
        .find(value => value.startsWith('/'));
      if (forwardedPath) {
        try { url.pathname = new URL(forwardedPath, 'http://localhost').pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/'; } catch {}
      }
    }
    const legacyRoute = {
      '/health': '/api/health',
      '/workspace': '/api/workspace',
      '/state': '/api/state',
      '/integrations/moka/status': '/api/integrations/moka/status',
      '/integrations/moka/interviews': '/api/integrations/moka/interviews'
    }[url.pathname];
    if (legacyRoute) url.pathname = legacyRoute;
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        service: 'acecall-api',
        storage: process.env.TCB_ENV ? 'cloudbase' : 'unconfigured',
        mode: process.env.DEEPSEEK_API_KEY ? 'ai' : 'demo',
        provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'demo',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/debug/status') {
      const identity = await readGatewayUser(request);
      const moka = mokaConnectionStatus();
      return sendJson(response, 200, {
        ok: true,
        service: 'acecall-api',
        route: 'reachable',
        pathNormalized: true,
        authContextDetected: Boolean(identity.uid && !identity.isAnonymous),
        authContextAnonymous: Boolean(identity.isAnonymous),
        cloudbaseConfigured: Boolean(process.env.TCB_ENV),
        mokaConfigured: Boolean(moka.configured),
        mokaBaseUrlConfigured: Boolean(moka.baseUrl),
        mokaInterviewsPath: moka.interviewsPath,
        timestamp: new Date().toISOString()
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/integrations/moka/status') {
      const context = await getRequestContext(request);
      return sendJson(response, 200, {
        ok: true,
        provider: 'moka',
        tenantId: context.tenantId,
        status: mokaConnectionStatus(),
        dataAccess: 'append_comment_only'
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/integrations/moka/interviews') {
      return sendJson(response, 200, await loadMokaInterviews(await getRequestContext(request)));
    }
    if (request.method === 'POST' && url.pathname === '/api/workspace/bootstrap') return sendJson(response, 200, await bootstrapWorkspace(await readJson(request), request));
    if (request.method === 'GET' && url.pathname === '/api/workspace') return sendJson(response, 200, await workspaceSummary(await getRequestContext(request)));
    if (request.method === 'PUT' && url.pathname === '/api/workspace') return sendJson(response, 200, await updateWorkspace(await getRequestContext(request), await readJson(request)));
    if (request.method === 'GET' && url.pathname === '/api/members') return sendJson(response, 200, await listMembers(await getRequestContext(request)));
    if (request.method === 'POST' && url.pathname === '/api/members/invite') return sendJson(response, 200, await inviteMember(await getRequestContext(request), await readJson(request)));
    if (request.method === 'PUT' && url.pathname.startsWith('/api/members/')) {
      const id = validateId(url.pathname.slice('/api/members/'.length));
      return sendJson(response, 200, await updateMember(await getRequestContext(request), id, await readJson(request)));
    }
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, await loadState(await getRequestContext(request)));
    if (request.method === 'GET' && url.pathname === '/api/screenings/texts') return sendJson(response, 200, await loadScreeningTexts(await getRequestContext(request)));
    if (request.method === 'GET' && url.pathname.match(/^\/api\/candidates\/[^/]+\/screening$/)) {
      const id = validateId(url.pathname.split('/')[3]);
      return sendJson(response, 200, await loadCandidateScreening(await getRequestContext(request), id));
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/jobs/')) {
      const id = validateId(url.pathname.slice('/api/jobs/'.length));
      const job = await readJson(request);
      await saveJob(await getRequestContext(request), id, job);
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/candidates/')) {
      const id = validateId(url.pathname.slice('/api/candidates/'.length));
      const candidate = await readJson(request);
      const saved = await saveCandidate(await getRequestContext(request), id, candidate);
      return sendJson(response, 200, saved);
    }
    if (request.method === 'POST' && url.pathname === '/api/migrate-resumes') {
      return sendJson(response, 200, await migrateStoredResumes(await getRequestContext(request)));
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/rules/')) {
      const context = await getRequestContext(request);
      const id = validateId(url.pathname.slice('/api/rules/'.length)); const rule = await readJson(request); const now = new Date().toISOString();
      await assertWritableRecord(COLLECTIONS.rules, id, context.tenantId);
      await getDatabase().collection(COLLECTIONS.rules).doc(id).set({ id, tenantId: context.tenantId, createdBy: context.uid, updatedBy: context.uid, content: String(rule.content || '').slice(0, 1000), version: Number(rule.version || 1), status: 'active', updatedAt: now, createdAt: rule.createdAt || now });
      await audit(context, 'rule.upsert', id, { contentLength: String(rule.content || '').length });
      return sendJson(response, 200, { ok: true, id });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/documents/')) {
      const id = validateId(decodeURIComponent(url.pathname.slice('/api/documents/'.length)));
      return sendJson(response, 200, await loadDocumentText(await getRequestContext(request), id));
    }
    if (request.method === 'POST' && url.pathname === '/api/interview-questions/reviews') {
      const context = await getRequestContext(request);
      const body = await readJson(request);
      const classification = String(body.classification || '');
      if (!['communication_check', 'condition_check', 'job_question', 'needs_context'].includes(classification)) throw serviceError('无效分类', 400);
      const review = { questionId: String(body.questionId || '').slice(0, 80), classification, conditionType: body.conditionType || null, previousClassification: String(body.previousClassification || '').slice(0, 40), version: Number(body.version || 1), rawText: String(body.rawText || '').slice(0, 80), at: new Date().toISOString() };
      await audit(context, 'interview-question.review', review.questionId || 'question', review);
      return sendJson(response, 200, { ok: true, review });
    }
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      const context = await guardAiRoute(request, '/api/generate');
      const payload = await readJson(request);
      validatePayload(payload);
      const startedAt = Date.now();
      try {
        if (payload.action === 'classify-interview-questions') {
          const result = await analyzeInterviewQuestions(payload, process.env.DEEPSEEK_API_KEY ? completeQuestionAi : null);
          await rememberAiTask(context, buildAiTaskRecord({ action: payload.action, payload, result, startedAt }));
          return sendJson(response, 200, { result, mode: process.env.DEEPSEEK_API_KEY ? 'ai' : 'demo', provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'demo' });
        }
        const generated = process.env.DEEPSEEK_API_KEY ? await generateWithDeepSeek(payload) : generateDemo(payload);
        const result = finalizeGeneratedResult(payload, generated);
        await rememberAiTask(context, buildAiTaskRecord({ action: payload.action, payload, result, startedAt }));
        return sendJson(response, 200, { result, mode: process.env.DEEPSEEK_API_KEY ? 'ai' : 'demo', provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'demo' });
      } catch (error) {
        await rememberAiTask(context, buildAiTaskRecord({ action: payload.action, payload, startedAt, error }));
        throw error;
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/parse-resume') {
      const context = await guardAiRoute(request, '/api/parse-resume');
      const fileName = url.searchParams.get('name') || 'resume';
      const buffer = await readBuffer(request, 50 * 1024 * 1024);
      const parsed = await parseResumeFile(fileName, buffer);
      parsed.metadata = { ...parsed.metadata, ...(await storeOriginalResume(context, fileName, buffer)) };
      return sendJson(response, 200, parsed);
    }
    if (request.method === 'POST' && url.pathname === '/api/transcribe') {
      const context = await guardAiRoute(request, '/api/transcribe');
      const fileName = url.searchParams.get('name') || 'recording.m4a';
      const durationSeconds = Number(url.searchParams.get('duration') || 0);
      const buffer = await readBuffer(request, 60_000_000);
      const route = classifyTranscription({ bytes: buffer.length, durationSeconds });
      if (!route.useShortApi) {
        await audit(context, 'transcription.redirect', fileName, { reason: 'short-api-limit', bytes: buffer.length, durationSeconds });
        return sendJson(response, 202, { ...route, useChunkUpload: true, publicStatus: 'queued' });
      }
      return sendJson(response, 200, await transcribeWithBaidu(fileName, buffer));
    }
    if (request.method === 'POST' && url.pathname === '/api/recordings/init') {
      return sendJson(response, 200, await initRecording(await getRequestContext(request), await readJson(request)));
    }
    if (request.method === 'POST' && url.pathname.match(/^\/api\/recordings\/[^/]+\/parts\/upload$/)) {
      const id = validateId(url.pathname.split('/')[3]);
      const index = Math.max(0, Number(url.searchParams.get('index') || 0));
      const final = url.searchParams.get('final') === '1' || url.searchParams.get('final') === 'true';
      return sendJson(response, 200, await uploadRecordingPart(await getRequestContext(request), id, index, final, await readBuffer(request, 8 * 1024 * 1024)));
    }
    if (request.method === 'POST' && url.pathname.match(/^\/api\/recordings\/[^/]+\/parts\/complete$/)) {
      const id = validateId(url.pathname.split('/')[3]);
      return sendJson(response, 200, await completeRecordingPart(await getRequestContext(request), id, await readJson(request)));
    }
    if (request.method === 'POST' && url.pathname === '/api/transcription-tasks') {
      return sendJson(response, 200, await createTranscriptionTask(await getRequestContext(request), await readJson(request)));
    }
    if (request.method === 'POST' && url.pathname === '/api/transcript-imports') {
      return sendJson(response, 200, await importTranscript(await getRequestContext(request), await readJson(request)));
    }
    if (request.method === 'GET' && url.pathname === '/api/transcript-imports') {
      return sendJson(response, 200, await listTranscriptImports(await getRequestContext(request)));
    }
    if (request.method === 'GET' && url.pathname === '/api/interviewers') {
      return sendJson(response, 200, await listInterviewers(await getRequestContext(request)));
    }
    if (request.method === 'POST' && url.pathname === '/api/interviewers') {
      const context = await getRequestContext(request);
      const input = await readJson(request);
      return sendJson(response, 200, await rememberInterviewers(context, input.names || input.name, input.source || 'manual'));
    }
    if (request.method === 'GET' && url.pathname.match(/^\/api\/transcription-tasks\/[^/]+$/)) {
      const id = validateId(url.pathname.split('/')[3]);
      return sendJson(response, 200, await getTranscriptionTask(await getRequestContext(request), id));
    }
    if (request.method === 'POST' && url.pathname.match(/^\/api\/transcription-tasks\/[^/]+\/analyze$/)) {
      const id = validateId(url.pathname.split('/')[3]);
      return sendJson(response, 200, await analyzeTranscriptionTask(await getRequestContext(request), id, await readJson(request)));
    }
    // 路由没匹配时把实际收到的路径带回去。网关是否透传子路径会随路由配置变化，
    // 曾经因为 /acecall-api 路由不透传子路径，前端所有接口一起 404 却看不出原因。
    console.error(JSON.stringify({
      level: 'warn',
      message: 'route unmatched',
      method: request.method,
      rawUrl: request.url,
      normalizedPath: url.pathname,
      originalPath: request.originalUrl || ''
    }));
    return sendJson(response, 404, {
      error: 'Not found',
      route: 'unmatched',
      method: request.method,
      path: url.pathname
    });
  } catch (error) {
    // `code` is what makes CloudBase SDK failures diagnosable: an INVALID_PARAM
    // ("不能更新_id的值") carries no statusCode, so without it the client only
    // ever sees a generic 500 and the real cause stays buried in the logs.
    console.error(JSON.stringify({
      level: 'error',
      message: redactSecrets(error.message),
      code: error.code || '',
      statusCode: error.statusCode || 500,
      stack: String(error.stack || '').split('\n').slice(0, 4).join(' | ')
    }));
    const statusCode = error.statusCode || 500;
    // Service errors are deliberately phrased without credentials; returning them
    // lets the client distinguish Baidu auth/format failures from CloudBase faults.
    const expose = Boolean(error.statusCode && error.message);
    return sendJson(response, statusCode, { error: expose ? redactSecrets(error.message) : '服务暂时不可用，请稍后重试。', code: error.code || '' });
  }
});

function setCors(response, origin) {
  // The CloudBase HTTP gateway owns the origin response header. Setting it
  // here as well makes successful responses contain duplicate origins, which
  // browsers reject as an invalid CORS response.
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AceCall-Token');
}

function flattenMokaRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'items', 'results', 'interviews', 'records', 'list', 'jobList', 'jobs', 'positions', 'requisitions']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = flattenMokaRecords(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function mokaInterviewText(record = {}) {
  const known = [
    record.jobName, record.jobTitle, record.positionName, record.roleName, record.requisitionName,
    record.job?.name, record.job?.title, record.position?.name, record.position?.title, record.requisition?.name,
    record.interviewer, record.interviewerName,
    ...(Array.isArray(record.interviewers) ? record.interviewers.flatMap(item => [item, item?.name, item?.email]) : [record.interviewers]),
    record.interview?.interviewer, record.interview?.interviewerName, record.interview?.interviewers,
    record.stage, record.stageName, record.interviewStage, record.round, record.department,
    record.location, record.candidateName, record.candidate?.name
  ].flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);
  let serialized = '';
  try { serialized = JSON.stringify(record); } catch {}
  return `${known.join(' ')} ${serialized}`;
}

function collectMokaFeedbacks(record = {}) {
  const sources = [
    ['record.interviewers', record.interviewers],
    ['record.interview.interviewers', record.interview?.interviewers],
    ['record.interviewFeedbacks', record.interviewFeedbacks],
    ['record.interviewerFeedbacks', record.interviewerFeedbacks],
    ['record.feedbacks', record.feedbacks],
    ['record.interviewDetail.interviewerFeedbacks', record.interviewDetail?.interviewerFeedbacks],
    ['record.interviewDetail.entities.interviewerFeedbacks', record.interviewDetail?.entities],
    ['record.interviewDetail.feedbacks', record.interviewDetail?.feedbacks]
  ];
  const feedbacks = [];
  for (const [source, value] of sources) {
    if (source.endsWith('entities.interviewerFeedbacks') && Array.isArray(value)) {
      value.forEach(entity => (entity?.interviewerFeedbacks || []).forEach(feedback => feedbacks.push({ ...feedback, _source: source })));
    } else if (Array.isArray(value)) {
      value.forEach(item => { if (item && typeof item === 'object') feedbacks.push({ ...item, _source: source }); });
    } else if (value && typeof value === 'object') feedbacks.push({ ...value, _source: source });
  }
  return feedbacks;
}

function normalizeMokaOutcome(record = {}) {
  const feedbacks = collectMokaFeedbacks(record);
  return { ...summarizeMokaFeedback(record, feedbacks), feedbackSources: feedbacks.map(item => item._source).filter(Boolean) };
}

function normalizeMokaInterview(record = {}) {
  const interviewerList = Array.isArray(record.interviewers) ? record.interviewers : [];
  const interviewerEntry = interviewerList.find(item => item?.name === '魏欣欣' || item?.interviewerName === '魏欣欣') || interviewerList[0] || (record.interviewers && typeof record.interviewers === 'object' ? record.interviewers : {}) || {};
  const interviewer = record.interviewerName || record.interviewer || record.interview?.interviewerName || record.interview?.interviewer || interviewerEntry.name || interviewerEntry.interviewerName || interviewerEntry || '';
  const jobName = record.jobName || record.jobTitle || record.positionName || record.roleName || record.requisitionName || record.job?.name || record.job?.title || record.position?.name || record.position?.title || record.requisition?.name || '';
  const projectName = record.projectName || record.recruitmentProjectName || record.project?.name || record.recruitmentProject?.name || record.project?.title || record.recruitmentProject?.title || '';
  const projectCode = record.projectCode || record.recruitmentProjectCode || record.project?.code || record.recruitmentProject?.code || '';
  const outcomeData = normalizeMokaOutcome(record);
  const outcome = outcomeData.outcome;
  const duration = Number(record.durationMinutes || record.duration || 0) || 0;
  const transcript = extractMokaText(record);
  const recordingUrl = extractMokaUrl(record, ['recordingUrl', 'recordUrl', 'videoUrl', 'interviewRecordingUrl', 'recording', 'recordingFile', 'audioUrl', 'videoInterviewRecordingUrl', 'recordingDownloadUrl', 'downloadUrl', 'viewUrl']);
  const transcriptUrl = extractMokaUrl(record, ['transcriptUrl', 'transcriptionUrl', 'transcriptFileUrl', 'transcriptionFileUrl', 'interviewTranscriptUrl', 'transcriptDownloadUrl', 'transcriptionDownloadUrl']);
  const feedbackUrl = extractMokaUrl(record, ['interviewFeedbackUrl', 'feedbackUrl', 'feedbackFileUrl']);
  return {
    id: String(record.id || record.interviewId || record._id || crypto.randomUUID()),
    source: 'moka', candidateName: record.candidateName || record.candidate?.name || record.candidates?.[0]?.name || record.candidates?.[0]?.candidateName || '',
    jobName, jobCategory: record.jobCategory || record.category || '', location: record.location || '', projectName: String(projectName), projectCode: String(projectCode),
    interviewer: String(interviewer), round: record.interviewStage || record.stageName || record.stage || record.roundName || record.round || '',
    scheduleStatus: String(record.status || ''),
    outcome: String(outcome), outcomeStatus: outcomeData.outcomeStatus, outcomeConflict: outcomeData.outcomeConflict, completed: !/取消|未结束|未进行|scheduled|cancelled|canceled/i.test(String(record.status || '')), interviewPassed: outcomeData.interviewPassed, interviewRejected: outcomeData.interviewRejected,
    offerAccepted: record.offerAccepted === true || /接受|accept|accepted/i.test(String(record.offerStatus || record.offerOutcome || '')),
    hired: record.hired === true || /入职|hired|joined/i.test(String(record.hireStatus || record.outcome || '')),
    durationMinutes: duration, startedAt: record.startTime || record.startedAt || record.interviewTime || record.createdAt || '',
    transcript, transcriptCharacters: transcript.length, transcriptStatus: transcript ? 'completed' : (transcriptUrl || feedbackUrl || recordingUrl ? 'pending' : 'missing'), transcriptFetchedAt: transcript ? new Date().toISOString() : '', recordingUrl, transcriptUrl, feedbackUrl,
    transcriptSource: transcript ? 'moka-field' : (transcriptUrl ? 'moka-transcript-file' : (feedbackUrl ? 'moka-feedback-file' : (recordingUrl ? 'moka-recording' : ''))), feedback: outcomeData.feedback, feedbackTemplateResult: outcomeData.feedbackTemplateResult, feedbackSources: outcomeData.feedbackSources,
    jobId: String(record.jobId || record.job_id || record.positionId || record.position_id || record.requisitionId || record.requisition_id || record.job?.id || record.position?.id || record.requisition?.id || record.application?.jobId || record.application?.job_id || ''),
    applicationId: record.applicationId || record.candidates?.[0]?.applicationId || '', raw: record
  };
}

function mokaProjectText(record = {}) {
  const values = [
    record.projectName, record.projectCode, record.recruitmentProjectName, record.recruitmentProjectCode,
    record.project?.name, record.project?.code, record.project?.title,
    record.recruitmentProject?.name, record.recruitmentProject?.code, record.recruitmentProject?.title,
    record.application?.projectName, record.application?.projectCode, record.job?.projectName, record.job?.projectCode
  ];
  const projectValues = values.flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);
  // Moka payloads are not uniform across interview endpoints. Some tenants
  // nest the recruitment project several levels deep or use snake_case keys.
  // Collect only values attached to project/recruitment keys so candidate
  // notes or transcript text cannot accidentally match the project filter.
  const visit = (value, key = '', depth = 0) => {
    if (depth > 7 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      if (/(project|recruit|campaign|项目|招聘)/i.test(key)) projectValues.push(String(value));
      return;
    }
    if (Array.isArray(value)) return value.forEach(item => visit(item, key, depth + 1));
    if (typeof value !== 'object') return;
    Object.entries(value).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
  };
  visit(record);
  return [...new Set(projectValues.map(value => String(value).trim()).filter(Boolean))].join(' ');
}

function matchesMokaProject(record = {}, projectName = 'QS') {
  const expected = String(projectName || '').trim();
  if (!expected) return true;
  const text = mokaProjectText(record);
  if (!text) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, 'i').test(text);
}

function mokaRoleText(record = {}) {
  const values = [record.jobName, record.jobTitle, record.positionName, record.roleName, record.requisitionName, record.job?.name, record.job?.title, record.position?.name, record.position?.title, record.application?.jobName, record.application?.jobTitle, record.application?.positionName];
  return values.flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
}

function normalizeJobName(value = '') {
  return String(value || '').toLowerCase().replace(/[\s\-_/（）()【】[\]：:·,，、]/g, '');
}

function matchesMokaJobNames(record = {}, names = []) {
  const role = normalizeJobName(mokaRoleText(record));
  if (!role) return false;
  return names.some(name => {
    const target = normalizeJobName(name);
    if (!target) return false;
    if (role.includes(target)) return true;
    // A city suffix can differ between Moka's job title and the configured
    // title. Match the stable title prefix while retaining the full title in
    // the output for review.
    const base = target.replace(/长沙$|上海$|北京$|深圳$|广州$/, '');
    return base.length >= 4 && role.includes(base);
  });
}

function mokaBusinessText(record = {}) {
  const values = [];
  const visit = (value, key = '', depth = 0) => {
    if (depth > 7 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      if (/(department|dept|business|division|team|organization|org|path|group|project|事业部|业务线|业务部门|部门|团队|项目组|招聘组|职能)/i.test(key)) values.push(String(value));
      return;
    }
    if (Array.isArray(value)) return value.forEach(item => visit(item, key, depth + 1));
    if (typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => visit(child, key ? `${key}.${childKey}` : childKey, depth + 1));
  };
  visit(record);
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].join(' ');
}

function matchesBusinessScope(value = '', expected = 'QS') {
  const text = String(value || '').trim(); const target = String(expected || '').trim();
  if (!text || !target) return false;
  if (/^[A-Za-z0-9_-]+$/.test(target)) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, 'i').test(text);
  }
  return text.includes(target);
}

function normalizeJobProfile(job = {}) {
  const business = [job.department, job.business, job.businessLine, job.division, job.industry, job.category].filter(Boolean).join(' ');
  const aliases = Array.isArray(job.aliases) ? job.aliases : String(job.aliases || '').split(/[、,，\s/|]+/);
  const keywords = Array.isArray(job.keywords) ? job.keywords : String(job.keywords || '').split(/[、,，\s/|]+/);
  return { id: String(job.id || ''), mokaJobId: String(job.mokaJobId || job.externalId || job.sourceId || ''), name: String(job.name || ''), business, aliases: [...new Set([...aliases, ...keywords].map(item => String(item).trim()).filter(item => item.length >= 2))] };
}

function matchMokaToJobProfiles(record = {}, profiles = [], businessName = 'QS') {
  const roleText = mokaRoleText(record).toLowerCase();
  const recordJobId = String(record.jobId || record.positionId || record.requisitionId || '').trim();
  const businessText = mokaBusinessText(record).toLowerCase();
  const expectedBusiness = String(businessName || '').trim().toLowerCase();
  const scoped = profiles.filter(profile => matchesBusinessScope(`${profile.business} ${profile.name}`, expectedBusiness));
  // Do not infer a QS scope from a role name alone when no AceCall job has
  // explicitly declared QS as its business/department. This prevents a
  // same-named role from another business line entering the analysis.
  if (!scoped.length) return null;
  const candidates = scoped;
  const matches = candidates.map(profile => {
    const businessTerms = [expectedBusiness, ...String(profile.business || '').split(/[、,，\s/|]+/).filter(item => item.length >= 2)].filter(Boolean);
    const businessMatched = businessTerms.some(term => matchesBusinessScope(businessText, term));
    const roleTerms = [profile.name, ...profile.aliases].filter(item => item.length >= 2).map(item => item.toLowerCase());
    const roleMatched = roleTerms.some(term => roleText.includes(term));
    const idMatched = Boolean(recordJobId && (recordJobId === profile.id || recordJobId === profile.mokaJobId));
    const score = idMatched ? 5 : (businessMatched ? 2 : 0) + (roleMatched ? 2 : 0);
    return { profile, businessMatched, roleMatched, idMatched, score };
  }).filter(item => item.idMatched || (item.roleMatched && (!businessText || item.businessMatched))).sort((a, b) => b.score - a.score);
  return matches[0] || null;
}

async function loadAcecallJobProfiles(context) {
  try {
    const result = await getDatabase().collection(COLLECTIONS.jobs).where({ tenantId: context.tenantId }).limit(200).get();
    return (result.data || []).map(normalizeJobProfile).filter(profile => profile.name);
  } catch { return []; }
}

function normalizeMokaJob(record = {}) {
  const valueText = value => typeof value === 'object' && value ? String(value.name || value.title || value.label || value.value || '') : String(value || '');
  const id = valueText(record.id || record.jobId || record.positionId || record.requisitionId || record.code).trim();
  const name = valueText(record.name || record.jobName || record.jobTitle || record.positionName || record.title).trim();
  const department = valueText(record.departmentName || record.department || record.deptName || record.organizationName || record.organizationPath || record.departmentPath || record.businessLine || record.business || record.businessGroup || record.division || record.team || record.groupName).trim();
  const jd = valueText(record.jd || record.jobDescription || record.description || record.responsibilities).trim();
  const keywords = [record.category, record.jobCategory, record.function, record.level, record.location].filter(Boolean).map(String);
  return { id, name, department, jd, keywords: [...new Set(keywords)], raw: record };
}

async function syncMokaJobs(context, client, targetNames, result) {
  const responses = [];
  for (const path of [client.config.jobsPath, client.config.requisitionsPath]) {
    try {
      const response = await client.request(path);
      if (response.ok) {
        const records = flattenMokaRecords(response.body);
        if (records.length) { responses.push(...records); break; }
      }
    } catch {}
  }
  if (!responses.length) {
    result.warnings.push('Moka 岗位接口未返回可用岗位列表；面试数据仍按已有 AceCall 岗位配置匹配。');
    return [];
  }
  const names = Array.isArray(targetNames) ? targetNames : [String(targetNames || '')];
  const jobs = responses.map(normalizeMokaJob).filter(job => job.id && job.name && matchesMokaJobNames({ jobName: job.name }, names));
  const db = getDatabase(); const synced = []; const now = new Date().toISOString();
  for (const job of jobs) {
    const id = `moka_${job.id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    const existing = await db.collection(COLLECTIONS.jobs).doc(id).get().catch(() => ({ data: null }));
    const current = existing.data || {};
    const stored = applyScreeningProfile({ ...current, id, tenantId: context.tenantId, source: current.source || 'moka', mokaJobId: job.id, name: current.name || job.name, department: current.department || job.department, jd: current.jd || job.jd, keywords: current.keywords?.length ? current.keywords : job.keywords, status: current.status || 'active', syncedFromMokaAt: now, createdAt: current.createdAt || now, updatedAt: now, updatedBy: context.uid, createdBy: current.createdBy || context.uid });
    await db.collection(COLLECTIONS.jobs).doc(id).set(persistable(stored));
    synced.push(cleanDocument(stored));
  }
  result.mokaJobStats = { fetched: responses.length, matched: jobs.length, synced: synced.length, jobs: names };
  return synced;
}

// Some Moka tenants expose interviews and applications but return an empty
// payload from the dedicated jobs endpoint. The interview rows still carry a
// canonical job id/name, so use them as a bounded fallback to keep AceCall's
// job directory in sync instead of silently dropping the job update.
async function syncMokaJobsFromRecords(context, records, targetNames, result) {
  const names = Array.isArray(targetNames) ? targetNames : [String(targetNames || '')];
  const uniqueNames = new Set();
  for (const record of records || []) {
    const raw = record?.raw && typeof record.raw === 'object' ? record.raw : record;
    if (!raw || !matchesMokaJobNames(raw, names)) continue;
    const normalized = normalizeMokaJob(raw);
    if (normalized.name) uniqueNames.add(normalized.name);
  }
  if (!uniqueNames.size) return [];
  // Interview refresh used to rewrite every historical Moka job, including the
  // full screening JD. Hundreds of sequential writes exceeded the function
  // timeout, so the interviewer page never received the interview records.
  // Job content is maintained separately and does not gate this analysis.
  result.mokaJobStats = {
    ...(result.mokaJobStats || {}),
    fallbackMatched: uniqueNames.size,
    fallbackSynced: 0,
    jobs: names
  };
  return [];
}

function mergeMokaApplication(record, application = {}) {
  if (!application || typeof application !== 'object') return record;
  const raw = { ...(record.raw || {}), application };
  const normalized = normalizeMokaInterview(raw);
  return {
    ...record,
    ...normalized,
    raw,
    applicationId: record.applicationId || application.id || application.applicationId || '',
    projectName: normalized.projectName || record.projectName || '',
    projectCode: normalized.projectCode || record.projectCode || ''
  };
}

async function fetchMokaApplications(records, client, result) {
  const unresolved = records.filter(record => !record.jobId && !mokaProjectText(record.raw || record) && !mokaRoleText(record.raw || record));
  const ids = [...new Set(unresolved.map(record => String(record.applicationId || '').trim()).filter(Boolean))];
  const configuredLimit = Number(process.env.MOKA_APPLICATION_LOOKUP_LIMIT || 480);
  const limit = Math.min(ids.length, Math.max(0, configuredLimit));
  if (!limit) return records;
  const byId = new Map();
  const deadline = Date.now() + Math.max(15000, Number(process.env.MOKA_APPLICATION_LOOKUP_BUDGET_MS || 65000));
  const fetchBatch = async batchIds => (await Promise.all(batchIds.map(async applicationId => {
    try {
      const response = await client.request(`${client.config.applicationsPath}/${encodeURIComponent(applicationId)}`);
      if (!response.ok) return null;
      const body = response.body && typeof response.body === 'object' ? response.body : {};
      const application = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
      return { applicationId, application };
    } catch { return null; }
  }))).filter(Boolean);
  // Moka application lookups are independent. Run a bounded number of
  // batches in parallel and stop before the HTTP function budget is consumed.
  for (let index = 0; index < limit && Date.now() < deadline; index += 48) {
    const batches = [];
    for (let offset = index; offset < Math.min(limit, index + 96); offset += 48) batches.push(fetchBatch(ids.slice(offset, offset + 48)));
    const results = await Promise.all(batches);
    results.flat().forEach(item => byId.set(item.applicationId, item.application));
  }
  if (ids.length > limit) result.warnings.push(`已读取 ${limit}/${ids.length} 个申请详情用于项目识别；可通过 MOKA_APPLICATION_LOOKUP_LIMIT 提高上限。`);
  if (Date.now() >= deadline && byId.size < limit) result.warnings.push(`Moka 申请补查达到 ${Math.round((deadline - (deadline - Math.max(15000, Number(process.env.MOKA_APPLICATION_LOOKUP_BUDGET_MS || 65000)))) / 1000)} 秒预算，已先返回已完成结果。`);
  return records.map(record => mergeMokaApplication(record, byId.get(String(record.applicationId || ''))));
}

async function fetchMokaInterviewDetails(record, client) {
  const id = record.id || record.raw?.id || record.raw?.interviewId;
  const applicationId = record.applicationId || record.raw?.applicationId;
  if (!id && !applicationId) return record;
  const payloads = [
    { interviewId: id, applicationId },
    { id, applicationId },
    { interviewIds: id ? [id] : [], applicationIds: applicationId ? [applicationId] : [] }
  ].filter(payload => Object.values(payload).some(value => value && (!Array.isArray(value) || value.length)));
  for (const payload of payloads) {
    for (const path of [client.config.interviewInformationPath, client.config.interviewInfosV3Path]) {
      try {
        const response = await client.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) continue;
        const body = response.body && typeof response.body === 'object' ? response.body : {};
        const detail = flattenMokaRecords(body)[0] || body.data || body.interview || body;
        if (detail && typeof detail === 'object') return keepInterviewResult(record, mergeMokaApplication(record, { interviewDetail: detail, ...detail }));
      } catch {}
    }
  }
  return record;
}

function mokaProjectFieldSamples(records = [], limit = 3) {
  return records.slice(0, limit).map(record => {
    const fields = [];
    const visit = (value, key = '', depth = 0) => {
      if (depth > 5 || value == null || fields.length >= 8) return;
      if (typeof value === 'string' || typeof value === 'number') {
        if (/(project|recruit|campaign|项目|招聘)/i.test(key)) fields.push(`${key}=${String(value).slice(0, 80)}`);
        return;
      }
      if (Array.isArray(value)) return value.forEach(item => visit(item, key, depth + 1));
      if (typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
    };
    visit(record);
    return fields;
  }).filter(fields => fields.length);
}

function extractMokaText(record = {}) {
  const keys = ['transcript', 'transcription', 'transcriptText', 'transcriptionText', 'transcriptContent', 'transcriptionContent', 'recordingTranscript', 'videoInterviewTranscript', 'captions', 'subtitle', 'subtitleText', 'interviewTranscript'];
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  for (const key of ['recording', 'transcriptionFile', 'transcriptFile', 'videoInterview', 'interviewRecording']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      const found = extractMokaText(nested);
      if (found) return found;
    }
  }
  const visit = (value, key = '', depth = 0) => {
    if (depth > 7 || value == null) return '';
    if (typeof value === 'string' && /(transcript|transcription|caption|subtitle|转写)/i.test(key) && value.trim().length > 20) return value.trim();
    if (Array.isArray(value)) { for (const item of value) { const found = visit(item, key, depth + 1); if (found) return found; } return ''; }
    if (typeof value === 'object') { for (const [childKey, child] of Object.entries(value)) { const found = visit(child, childKey, depth + 1); if (found) return found; } }
    return '';
  };
  const discovered = visit(record);
  if (discovered) return discovered;
  return '';
}

function extractMokaUrl(record = {}, keys = []) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && (isMokaPathLike(value) || /^https?:\/\//i.test(value))) return value;
    if (value && typeof value === 'object') {
      for (const nestedKey of ['url', 'downloadUrl', 'fileUrl', 'href', 'src']) {
        const nested = value[nestedKey];
        if (typeof nested === 'string' && (isMokaPathLike(nested) || /^https?:\/\//i.test(nested))) return nested;
      }
    }
  }
  for (const key of ['recording', 'recordingFile', 'transcriptionFile', 'transcriptFile', 'videoInterview', 'interviewRecording']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      const found = extractMokaUrl(nested, keys);
      if (found) return found;
    }
  }
  return '';
}

function isMokaPathLike(value = '') {
  return /^\/(?:api|api-platform|file|files|attachment|attachments|download|uploads?)\//i.test(String(value)) || /\.(?:txt|vtt|srt|json|pdf|docx?|mp3|m4a|wav|webm|mp4)(?:\?|$)/i.test(String(value));
}

function extractMokaAttachmentRefs(record = {}) {
  const refs = []; const seen = new Set();
  const attachmentKey = /(transcript|transcription|recording|record|audio|video|attachment|file|feedback|document)/i;
  const visit = (value, key = '', depth = 0) => {
    if (depth > 7 || value == null) return;
    if (typeof value === 'string') {
      const candidate = value.trim();
      if (attachmentKey.test(key) && (isMokaPathLike(candidate) || /^https?:\/\//i.test(candidate)) && !seen.has(candidate)) {
        seen.add(candidate); refs.push({ url: candidate, source: /transcript|transcription/i.test(key) ? 'transcript' : /feedback/i.test(key) ? 'feedback' : /record|audio|video/i.test(key) ? 'recording' : 'attachment' });
      }
      return;
    }
    if (Array.isArray(value)) return value.forEach(item => visit(item, key, depth + 1));
    if (typeof value !== 'object') return;
    Object.entries(value).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
  };
  visit(record);
  return refs;
}

function isAllowedMokaAttachment(url = '', client) {
  try {
    if (!/^https?:\/\//i.test(url)) return isMokaPathLike(url);
    const parsed = new URL(url); const hostname = parsed.hostname.toLowerCase();
    const baseHost = client?.config?.baseUrl ? new URL(client.config.baseUrl).hostname.toLowerCase() : '';
    const configuredHosts = String(process.env.MOKA_ATTACHMENT_HOSTS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    const signed = /(?:signature|x-amz-signature|token|expires|e=)/i.test(parsed.search);
    return hostname === 'mokahr.com' || hostname.endsWith('.mokahr.com') || hostname.endsWith('.mokahr.cn') || hostname === baseHost || configuredHosts.includes(hostname) || signed;
  } catch { return false; }
}

async function parseMokaAttachment(url, contentType = '', client) {
  if (!url || !isAllowedMokaAttachment(url, client)) return { text: '', status: 'blocked-url' };
  const response = await client.requestBinary(url);
  if (!response.ok) return { text: '', status: `download-${response.status}` };
  const buffer = response.buffer;
  if (buffer.length > 50 * 1024 * 1024) return { text: '', status: 'file-too-large' };
  const type = String(contentType || response.contentType || '').toLowerCase();
  const lower = url.toLowerCase().split('?')[0];
  try {
    if (type.includes('json') || lower.endsWith('.json')) {
      const parsed = JSON.parse(buffer.toString('utf8'));
      const text = extractMokaText(parsed);
      if (text) return { text: normalizeResumeText(text), status: 'parsed-json' };
      const ref = extractMokaAttachmentRefs(parsed)[0];
      return ref ? { text: '', status: 'redirect', redirectUrl: ref.url, redirectSource: ref.source } : { text: '', status: 'empty-json' };
    }
    if (type.includes('pdf') || lower.endsWith('.pdf')) return { text: normalizeResumeText((await require('pdf-parse')(buffer)).text), status: 'parsed-pdf' };
    if (type.includes('wordprocessingml') || lower.endsWith('.docx')) return { text: normalizeResumeText((await require('mammoth').extractRawText({ buffer })).value), status: 'parsed-docx' };
    if (type.startsWith('text/') || /\.(txt|vtt|srt|json|md)$/i.test(lower)) return { text: normalizeResumeText(buffer.toString('utf8')), status: 'parsed-text' };
    return { text: '', status: type.startsWith('audio/') || /\.(mp3|m4a|wav|webm|mp4)$/i.test(lower) ? 'audio-ready' : 'unsupported-format' };
  } catch (error) { return { text: '', status: `parse-failed:${error.message}` }; }
}

async function enrichMokaAttachment(record, client) {
  if (record.transcript) return { ...record, transcriptCharacters: record.transcript.length, transcriptStatus: 'completed' };
  const directCandidates = [
    [record.transcriptUrl, 'transcript'],
    [record.feedbackUrl, 'feedback'],
    [record.recordingUrl, 'recording']
  ].filter(([url]) => url);
  const discovered = extractMokaAttachmentRefs(record.raw || {}).map(item => [item.url, item.source]);
  const candidates = [...new Map([...directCandidates, ...discovered].map(item => [item[0], item])).values()];
  for (const [url, source] of candidates) {
    const parsed = await parseMokaAttachment(url, '', client);
    if (parsed.text) return { ...record, transcript: parsed.text, transcriptCharacters: parsed.text.length, transcriptSource: `${source}-${parsed.status}`, transcriptStatus: 'completed', transcriptFetchedAt: new Date().toISOString() };
    if (parsed.status === 'redirect' && parsed.redirectUrl && parsed.redirectUrl !== url) {
      const redirected = await parseMokaAttachment(parsed.redirectUrl, '', client);
      if (redirected.text) return { ...record, transcript: redirected.text, transcriptCharacters: redirected.text.length, transcriptSource: `${source}-${redirected.status}`, transcriptStatus: 'completed', transcriptFetchedAt: new Date().toISOString() };
    }
    if (source === 'recording' && parsed.status === 'audio-ready') return { ...record, transcriptStatus: 'audio-ready', transcriptError: 'Moka 返回录音文件，但未返回可直接解析的转写文本' };
    if (parsed.status !== 'blocked-url') return { ...record, transcriptStatus: parsed.status, transcriptError: `转写附件处理未完成：${parsed.status}` };
  }
  return { ...record, transcriptStatus: record.transcriptStatus || 'missing' };
}

function keepInterviewResult(record, merged) {
  const hasResult = Boolean(record.outcome || record.feedback || record.interviewPassed != null || record.interviewRejected != null);
  if (!hasResult) return { ...merged, scheduleStatus: record.scheduleStatus || merged.scheduleStatus || '', completed: record.completed === false ? false : merged.completed };
  return {
    ...merged,
    scheduleStatus: record.scheduleStatus || merged.scheduleStatus || '',
    completed: record.completed,
    outcome: record.outcome,
    outcomeStatus: record.outcomeStatus,
    interviewPassed: record.interviewPassed,
    interviewRejected: record.interviewRejected,
    outcomeConflict: record.outcomeConflict,
    feedback: record.feedback,
    feedbackTemplateResult: record.feedbackTemplateResult,
    feedbackSources: record.feedbackSources
  };
}

async function fetchMokaFeedbacks(client, fromTime, result) {
  const records = [];
  let nextPath = `/api-platform/v1/data/interviewer_feedbacks?fromTime=${encodeURIComponent(fromTime)}&limit=1000`;
  for (let page = 0; page < 3 && nextPath; page += 1) {
    const response = await client.request(nextPath);
    if (!response.ok) {
      result.warnings.push([401, 403].includes(response.status) ? `Moka 面试反馈授权不足（${response.status}）` : `面试反馈读取失败（${response.status}）`);
      break;
    }
    const body = response.body && typeof response.body === 'object' ? response.body : {};
    records.push(...flattenMokaRecords(body));
    const next = body.next || body.data?.next;
    if (body.hasNext === false || typeof next !== 'string' || /^https?:/i.test(next)) break;
    nextPath = next.startsWith('/') ? next : `/${next}`;
  }
  return records;
}

async function loadMokaInterviews(context) {
  const status = mokaConnectionStatus();
  const projectName = String(status.projectName || process.env.MOKA_PROJECT_NAME || 'QS').trim();
  const client = createMokaClient({ timeoutMs: Math.max(3000, Number(process.env.MOKA_REQUEST_TIMEOUT_MS || 8000)) });
  const targetJobs = client.config.jobNames;
  const result = { ok: true, source: 'moka', configured: status.configured, filters: { project: '', jobs: targetJobs, interviewer: 'all' }, records: [], fetchedAt: new Date().toISOString(), warnings: [] };
  if (!status.configured) return result;
  const syncedJobs = await syncMokaJobs(context, client, targetJobs, result);
  result.syncedJobs = syncedJobs;
  const startedAt = Date.now();
  const lookbackDays = Math.min(60, Math.max(1, Number(process.env.MOKA_INTERVIEWS_LOOKBACK_DAYS || 60)));
  result.filters.lookbackDays = lookbackDays;
  const end = new Date(); const start = new Date(end.getTime() - lookbackDays * 86400000); const records = [];
  const windows = [];
  for (let cursor = new Date(start); cursor < end; cursor = new Date(Math.min(end.getTime(), cursor.getTime() + 30 * 86400000))) {
    windows.push([cursor, new Date(Math.min(end.getTime(), cursor.getTime() + 30 * 86400000))]);
  }
  // Moka exposes date-range reads rather than a single project query. Keep a
  // small concurrency cap so a full-year refresh completes within the gateway
  // budget without creating a burst of requests against Moka.
  for (let index = 0; index < windows.length; index += 4) {
    const batch = await Promise.all(windows.slice(index, index + 4).map(async ([cursor, rangeEnd]) => {
      const path = `${client.config.interviewsPath}?startDate=${encodeURIComponent(cursor.toISOString())}&endDate=${encodeURIComponent(rangeEnd.toISOString())}`;
      const response = await client.request(path);
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw serviceError(`Moka API 鉴权失败（${response.status}），请检查 MOKA_API_KEY 和企业授权范围`, 502, { code: 'MOKA_AUTH_FAILED' });
        throw serviceError(`Moka 面试数据读取失败（${response.status}）`, 502, { code: 'MOKA_INTERVIEWS_FAILED' });
      }
      return flattenMokaRecords(response.body).map(normalizeMokaInterview);
    }));
    batch.flat().forEach(record => records.push(record));
  }
  // The interview list commonly omits recruitment project fields. Resolve the
  // application once before filtering so project scope is based on Moka's
  // canonical application object rather than an incomplete interview row.
  const recordsWithApplications = await fetchMokaApplications(records, client, result);
  const filtered = recordsWithApplications.filter(record => matchesMokaJobNames(record.raw || record, targetJobs));
  await syncMokaJobsFromRecords(context, recordsWithApplications, targetJobs, result);
  if (result.mokaJobStats?.fallbackMatched) {
    result.warnings = (result.warnings || []).filter(message => !String(message).startsWith('Moka 岗位接口未返回可用岗位列表'));
  }
  // Interviewer analysis is scoped by the explicit Moka job title allowlist.
  // AceCall job records and the unavailable Moka department field are not used.
  result.projectScopeFallback = false;
  result.scopeDiagnostics = {
    jobProfiles: 0,
    matched: filtered.length,
    fetched: records.length,
    targetJobs,
    matchedJobs: [...new Set(filtered.map(record => mokaRoleText(record.raw || record)).filter(Boolean))],
    roleSamples: [...new Set(recordsWithApplications.map(record => mokaRoleText(record.raw || record)).filter(Boolean))].slice(0, 20)
  };
  if (!filtered.length && records.length) result.warnings.push(`目标岗位匹配结果为 0：Moka 返回 ${records.length} 条面试，但没有记录的岗位名称命中配置的 13 个目标岗位。`);
  const feedbackRecords = await fetchMokaFeedbacks(client, start.toISOString(), result);
  const feedbackByApplication = new Map();
  for (const item of feedbackRecords) {
    const applicationId = String(item.applicationId || '');
    if (!applicationId) continue;
    const list = feedbackByApplication.get(applicationId) || [];
    list.push(item);
    feedbackByApplication.set(applicationId, list);
  }
  const scopedRecords = filtered;
  result.records = scopedRecords.map(record => {
    const applicationId = String(record.applicationId || record.raw?.candidates?.[0]?.applicationId || '');
    const feedbacks = selectMokaFeedbacks(record, feedbackByApplication.get(applicationId) || []);
    const outcomeData = normalizeMokaOutcome({ ...record.raw, ...record, interviewerFeedbacks: feedbacks });
    const first = feedbacks[0] || {};
    return { ...record, ...outcomeData, recordingUrl: record.recordingUrl || first.recordingUrl || first.recordUrl || '', feedbackUrl: record.feedbackUrl || first.interviewFeedbackUrl || '', transcriptUrl: record.transcriptUrl || first.transcriptUrl || first.transcriptionUrl || '' };
  });
  result.feedbackStats = { fetched: feedbackRecords.length, matched: result.records.filter(record => record.feedback || record.outcome).length };
  result.records.sort((left, right) => (Date.parse(right.startedAt || '') || 0) - (Date.parse(left.startedAt || '') || 0));
  const detailLimit = Math.min(result.records.length, Math.max(0, Number(process.env.MOKA_INTERVIEW_DETAIL_LOOKUP_LIMIT || 40)));
  let detailRead = 0;
  for (let index = 0; index < detailLimit; index += 4) {
    if (Date.now() - startedAt > 70000) break;
    const details = await Promise.all(result.records.slice(index, index + 4).map(record => fetchMokaInterviewDetails(record, client)));
    result.records.splice(index, details.length, ...details);
    detailRead += details.length;
  }
  if (detailRead && result.records.length > detailRead) result.warnings.push(`已读取前 ${detailRead} 场面试详情以查找录制/转写附件，面试结果和评价已全部返回。`);
  const attachmentBudget = Date.now() - startedAt > 80000 ? 0 : Math.min(detailRead, Math.max(0, Number(process.env.MOKA_TRANSCRIPT_LOOKUP_LIMIT || 20)));
  const attachmentLimit = Math.min(result.records.length, attachmentBudget);
  const enrichedRecords = result.records.slice(0, attachmentLimit).length
    ? await Promise.all(result.records.slice(0, attachmentLimit).map(record => enrichMokaAttachment(record, client)))
    : [];
  result.records = [...enrichedRecords, ...result.records.slice(attachmentLimit)];
  if (result.records.length > attachmentLimit && attachmentLimit > 0) result.warnings.push(`已读取前 ${attachmentLimit} 场面试的录音/转写附件，其余记录保留为待补抓。`);
  result.totalFetched = records.length; result.totalMatched = result.records.length;
  result.transcriptStats = result.records.reduce((stats, record) => { stats.total += 1; if (record.transcriptStatus === 'completed') stats.completed += 1; else if (record.transcriptStatus === 'pending' || record.transcriptStatus === 'audio-ready') stats.pending += 1; else stats.missing += 1; stats.characters += Number(record.transcriptCharacters || 0); return stats; }, { total: 0, completed: 0, pending: 0, missing: 0, characters: 0 });
  result.analytics = buildMokaAnalytics(result.records);
  try { await rememberInterviewers(context, result.records.map(record => record.interviewer), 'moka'); }
  catch { result.warnings.push('面试官库更新未完成，转写仍会按已记住的姓名匹配。'); }
  return result;
}

function buildMokaAnalytics(records = []) {
  const completed = records.filter(record => record.completed !== false);
  const transcripts = completed.map(record => String(record.transcript || '')).filter(Boolean);
  const questions = completed.flatMap(record => classifyInterviewQuestions({ sessions: [{ id: record.id || 'moka', text: record.transcript || '', interviewer: record.interviewer || '', candidateName: record.candidateName || '', jobName: record.jobName || '' }], sessionCount: 1 }).items.filter(item => item.classification === 'job_question' || item.classification === 'condition_check').map(item => item.normalizedText || item.rawText));
  const followUpTerms = ['为什么', '如何', '具体', '负责', '结果', '规模', '上线', '核实', '确认', '追问'];
  const followUpSignals = transcripts.reduce((sum, text) => sum + followUpTerms.reduce((count, term) => count + (text.match(new RegExp(term, 'g')) || []).length, 0), 0);
  const topicDefinitions = [
    ['项目结果', ['上线', '结果', '指标', '交付', '复盘']],
    ['个人职责', ['负责', '主导', '参与', '职责', '决策']],
    ['业务规模', ['规模', '客户', '收入', '交易量', '市场']],
    ['动机与稳定性', ['离职', '机会', '动机', '发展', '稳定']],
    ['团队协作', ['团队', '协作', '汇报', '跨部门', '管理']],
    ['风险核验', ['核实', '确认', '风险', '冲突', '竞业']]
  ];
  const topics = topicDefinitions.map(([name, terms]) => ({ name, mentions: terms.reduce((sum, term) => sum + transcripts.reduce((count, text) => count + (text.match(new RegExp(term, 'g')) || []).length, 0), 0), terms: terms.filter(term => transcripts.some(text => text.includes(term))) })).filter(topic => topic.mentions > 0).sort((a, b) => b.mentions - a.mentions);
  const evaluated = completed.filter(record => record.outcomeStatus === 'passed' || record.outcomeStatus === 'rejected' || record.outcome || record.hired).length;
  const passed = completed.filter(record => record.interviewPassed === true).length;
  const rejected = completed.filter(record => record.interviewRejected === true || record.interviewFailed === true).length;
  const offerAccepted = completed.filter(record => record.offerAccepted || record.hired).length;
  const hired = completed.filter(record => record.hired).length;
  const coverage = completed.length ? Math.min(100, Math.round(questions.length / completed.length * 12)) : 0;
  const depth = completed.length ? Math.min(100, Math.round(followUpSignals / completed.length * 8)) : 0;
  const completeness = completed.length ? Math.round(evaluated / completed.length * 100) : 0;
  const interviewerScore = completed.length ? Math.round(coverage * 0.35 + depth * 0.35 + completeness * 0.3) : 0;
  const recommendations = [];
  if (coverage < 60) recommendations.push('提高结构化问题覆盖，确保每场面试都核实项目结果、个人职责和业务规模。');
  if (depth < 60) recommendations.push('增加基于候选人回答的二次追问，避免停留在经历复述。');
  if (completeness < 80) recommendations.push('在面试结束后及时完成结论记录，并明确通过依据或待核验事项。');
  if (!recommendations.length) recommendations.push('保持当前结构化提问和事实核验方式，继续用入职结果校准判断标准。');
  const analytics = {
    scope: { project: String(process.env.MOKA_PROJECT_NAME || 'QS'), jobs: 'all', interviewer: 'all' },
    interviewer: { score: interviewerScore, completed: completed.length, passed, rejected, pending: Math.max(0, completed.length - passed - rejected), passRate: completed.length ? Math.round(passed / completed.length * 100) : 0, offerAccepted, hired, evaluated, evaluationRate: completed.length ? Math.round(evaluated / completed.length * 100) : 0 },
    dimensions: { questionCoverage: coverage, followUpDepth: depth, recordCompleteness: completeness },
    questions: questions.slice(0, 30),
    topics: topics.slice(0, 8),
    followUpSignals,
    recommendations,
    intelligence: buildIntelligenceAnalytics(records)
  };
  return applyTeamVisibility(analytics);
}

function buildIntelligenceAnalytics(records = []) {
  const texts = records.flatMap(record => [record.transcript, record.feedback, record.candidateName, record.jobName]).filter(Boolean).join('\n');
  const companies = [...new Set((texts.match(/[\u4e00-\u9fa5A-Za-z]{2,16}(?:证券|银行|科技|集团|互联网|传媒|信息|投资|资本)/g) || []))].slice(0, 20);
  const signalDefinitions = [
    ['业务方向', ['战略', '增长', '产品规划', '商业化', '客户', '市场', '业务']],
    ['组织与协作', ['组织架构', '汇报', '团队', '协作', '部门', '负责人', '管理']],
    ['竞品与行业', ['竞品', '竞争', '行业', '市场份额', '对标', '竞争对手', '同业']],
    ['人才与能力', ['招聘', '人才', '能力', '经验', '岗位', '专业']]
  ];
  const signals = signalDefinitions.map(([label, terms]) => ({ label, terms: terms.filter(term => texts.includes(term)), evidenceCount: terms.reduce((sum, term) => sum + (texts.match(new RegExp(term, 'g')) || []).length, 0) })).filter(item => item.evidenceCount > 0);
  const questions = records.flatMap(record => String(record.transcript || '').split(/\n+/).map(line => line.trim()).filter(line => /[？?]$/.test(line))).slice(0, 30);
  const confirmedFacts = records.flatMap(record => Array.isArray(record.confirmedFacts) ? record.confirmedFacts : []);
  return { companies, signals, questions, internalClues: internalCluesFromFacts(confirmedFacts), clueAudience: 'internal', rubric: rubricFromCorrections(records.flatMap(record => Array.isArray(record.judgmentCorrections) ? record.judgmentCorrections : [])), sourceRecords: records.filter(record => record.transcript || record.feedback).length, generatedAt: new Date().toISOString(), reviewStatus: '待人工确认' };
}

async function getRequestContext(request) {
  const user = getCloudbaseApp().auth().getUserInfo() || {};
  const gatewayUser = await readGatewayUser(request);
  const identity = gatewayUser.uid ? gatewayUser : { uid: user.uid || user.customUserId, isAnonymous: Boolean(user.isAnonymous) };
  const uid = identity.uid;
  if (!uid || identity.isAnonymous) throw serviceError('请先登录后使用业务功能', 401);
  const result = await getDatabase().collection(COLLECTIONS.members).where({ uid, status: 'active' }).limit(1).get();
  const member = result.data?.[0];
  if (!member?.tenantId) throw serviceError('当前账号尚未加入公司工作区，请联系管理员邀请', 403);
  return { uid, tenantId: member.tenantId, role: member.role || 'recruiter', member };
}

async function readGatewayUser(request) {
  const headers = request?.headers || {};
  // HTTP gateway versions differ in the identity header they forward. The
  // gateway-authenticated route overwrites these headers before invoking the
  // function, so accept the documented context forms plus the scalar UID
  // headers used by older gateway deployments.
  const raw = headers['x-cloudbase-context'] || headers['x-cloudbase-auth-context'] || headers['x-cloudbase-userinfo'] || headers['x-tcb-userinfo'];
  if (raw) {
    const candidates = [String(raw)];
    try { candidates.push(Buffer.from(String(raw), 'base64').toString('utf8')); } catch {}
    try { candidates.push(decodeURIComponent(String(raw))); } catch {}
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const info = findIdentity(parsed);
        if (info.uid) return info;
      } catch {}
    }
  }

  const scalarUid = headers['x-cloudbase-uid'] || headers['x-cloudbase-user-id'] || headers['x-tcb-uid'] || headers['x-user-id'];
  if (scalarUid && String(scalarUid).trim()) {
    return { uid: String(scalarUid).trim(), isAnonymous: false };
  }

  // CDN-backed or unauthenticated-gateway routes may forward the bearer token
  // without the gateway identity context. Ask CloudBase Auth to verify it.
  // /auth/v1/token/introspect is the endpoint that actually exists (verified:
  // returns {sub, scope}); /v1/auth/user answers 404 and only wastes a round trip,
  // so it stays last as a forward-compatibility fallback.
  const authorization = String(request?.headers?.authorization || request?.headers?.['x-acecall-token'] || '');
  if (!/^Bearer\s+\S+/i.test(authorization) || !process.env.TCB_ENV) return {};
  const endpoints = [
    `https://${process.env.TCB_ENV}.api.tcloudbasegateway.com/auth/v1/token/introspect`,
    `https://${process.env.TCB_ENV}.api.tcloudbasegateway.com/v1/auth/user`
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { method: 'GET', headers: { Authorization: authorization }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) continue;
      const info = await response.json();
      const identity = findIdentity(info);
      if (identity.uid) return identity;
    } catch {}
  }
  return {};
}

function findIdentity(value, depth = 0) {
  if (!value || depth > 4 || typeof value !== 'object') return {};
  const uid = value.uid || value.userId || value.user_id || value.sub || value.customUserId || value.openId || value.openid || '';
  if (uid) {
    const normalizedUid = String(uid);
    const scope = String(value.scope || value.user_type || value.userType || '').toLowerCase();
    return {
      uid: normalizedUid,
      isAnonymous: Boolean(
        value.isAnonymous || value.is_anonymous || value.anonymous ||
        scope.includes('anonymous') || normalizedUid === 'anon'
      )
    };
  }
  for (const child of Object.values(value)) {
    const found = findIdentity(child, depth + 1);
    if (found.uid) return found;
  }
  return {};
}

async function bootstrapWorkspace(input = {}, request) {
  const user = getCloudbaseApp().auth().getUserInfo() || {};
  const gatewayUser = await readGatewayUser(request);
  const identity = gatewayUser.uid ? gatewayUser : { uid: user.uid || user.customUserId, isAnonymous: Boolean(user.isAnonymous) };
  const uid = identity.uid;
  if (!uid || identity.isAnonymous) throw serviceError('请先登录后初始化工作区', 401);
  const db = getDatabase();
  const existing = await db.collection(COLLECTIONS.members).where({ uid }).limit(5).get();
  const existingMember = existing.data?.[0];
  if (existingMember?.tenantId) {
    if (existingMember.status === 'disabled') throw serviceError('当前账号已被禁用', 403);
    const member = existingMember.status === 'invited' ? { ...existingMember, status: 'active', updatedAt: new Date().toISOString() } : existingMember;
    if (member.status !== existingMember.status) await db.collection(COLLECTIONS.members).doc(existingMember._id || existingMember.id).set(persistable(member));
    return workspaceSummary({ uid, tenantId: member.tenantId, role: member.role || 'recruiter', member });
  }

  // Internal pilot rule: accounts registering with the exact shared company
  // name join the one existing active tenant instead of getting an empty
  // personal workspace. Other company names remain isolated and require an
  // administrator invitation.
  const requestedCompany = String(input.companyName || '').trim().slice(0, 120);
  if (requestedCompany === 'AceCall招聘团队') {
    const matchingTenants = await db.collection(COLLECTIONS.tenants)
      .where({ name: requestedCompany, status: 'active' })
      .limit(2)
      .get()
      .catch(() => ({ data: [] }));
    const sharedTenant = matchingTenants.data?.length === 1 ? matchingTenants.data[0] : null;
    if (sharedTenant?.id) {
      const now = new Date().toISOString();
      const memberId = `${sharedTenant.id}_${uid}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
      const member = { id: memberId, tenantId: sharedTenant.id, uid, username: String(input.username || '').slice(0, 120), displayName: String(input.displayName || input.username || '').slice(0, 80), role: 'recruiter', status: 'active', membershipSource: 'company_name_pilot', createdAt: now, updatedAt: now };
      await db.collection(COLLECTIONS.members).doc(memberId).set(member);
      return workspaceSummary({ uid, tenantId: sharedTenant.id, role: member.role, member });
    }
  }
  const tenantId = `tenant_${uid}`.slice(0, 80);
  const now = new Date().toISOString();
  const tenantName = String(input.companyName || '').trim().slice(0, 120) || '我的公司工作区';
  await db.collection(COLLECTIONS.tenants).doc(tenantId).set({ id: tenantId, name: tenantName, status: 'active', createdBy: uid, createdAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.members).doc(`${tenantId}_${uid}`.slice(0, 80)).set({ id: `${tenantId}_${uid}`.slice(0, 80), tenantId, uid, username: String(input.username || '').slice(0, 120), displayName: String(input.displayName || input.username || '').slice(0, 80), role: 'owner', status: 'active', createdAt: now, updatedAt: now });
  // Claim only legacy records that have no tenant yet. Existing company data
  // with a tenantId remains isolated and is never reassigned.
  await migrateLegacyTenantData({ tenantId, uid });
  return workspaceSummary({ uid, tenantId, role: 'owner' });
}

async function migrateLegacyTenantData(context) {
  const db = getDatabase();
  for (const collection of [COLLECTIONS.jobs, COLLECTIONS.candidates, COLLECTIONS.screenings, COLLECTIONS.rules]) {
    const result = await db.collection(collection).limit(500).get().catch(() => ({ data: [] }));
    for (const item of (result.data || []).filter(record => !record.tenantId)) {
      const id = item.id || item._id;
      if (!id) continue;
      const { _id, _openid, ...stored } = item;
      await db.collection(collection).doc(id).set(persistable({ ...stored, tenantId: context.tenantId, updatedBy: context.uid, createdBy: stored.createdBy || context.uid }));
    }
  }
}

async function workspaceSummary(context) {
  const db = getDatabase();
  const [tenantResult, memberResult] = await Promise.all([
    db.collection(COLLECTIONS.tenants).doc(context.tenantId).get(),
    db.collection(COLLECTIONS.members).where({ tenantId: context.tenantId, status: 'active' }).limit(200).get()
  ]);
  return { workspace: cleanDocument(tenantResult.data || { id: context.tenantId, name: '公司工作区', status: 'active' }), currentMember: cleanDocument(context.member || { uid: context.uid, tenantId: context.tenantId, role: context.role }), members: (memberResult.data || []).map(cleanDocument) };
}

async function updateWorkspace(context, input = {}) {
  requireRole(context, ['owner', 'admin']);
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw serviceError('请输入企业名称', 400);
  const db = getDatabase();
  const existing = await db.collection(COLLECTIONS.tenants).doc(context.tenantId).get();
  const now = new Date().toISOString();
  const tenant = existing.data || { id: context.tenantId, status: 'active', createdAt: now, createdBy: context.uid };
  await db.collection(COLLECTIONS.tenants).doc(context.tenantId).set(persistable({ ...tenant, id: context.tenantId, name, updatedAt: now, updatedBy: context.uid }));
  await audit(context, 'workspace.update', context.tenantId, { name });
  return { ok: true, workspace: cleanDocument({ ...tenant, id: context.tenantId, name, updatedAt: now, updatedBy: context.uid }) };
}

async function listMembers(context) {
  requireRole(context, ['owner', 'admin']);
  const result = await getDatabase().collection(COLLECTIONS.members).where({ tenantId: context.tenantId }).limit(200).get();
  return { members: (result.data || []).map(cleanDocument) };
}

async function inviteMember(context, input = {}) {
  requireRole(context, ['owner', 'admin']);
  const uid = String(input.uid || '').trim();
  if (!uid || uid.length < 4 || uid.length > 80) throw serviceError('请输入有效的员工 UID', 400);
  const db = getDatabase();
  const existing = await db.collection(COLLECTIONS.members).where({ tenantId: context.tenantId, uid }).limit(1).get();
  if (existing.data?.[0]) throw serviceError('该员工已经在当前工作区', 409);
  const id = `${context.tenantId}_${uid}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const now = new Date().toISOString();
  await db.collection(COLLECTIONS.members).doc(id).set({ id, tenantId: context.tenantId, uid, username: String(input.username || '').slice(0, 120), displayName: String(input.displayName || input.username || uid).slice(0, 80), role: ['admin', 'recruiter', 'viewer'].includes(input.role) ? input.role : 'recruiter', status: 'invited', createdAt: now, updatedAt: now, createdBy: context.uid, updatedBy: context.uid });
  await audit(context, 'member.invite', id, { invitedUid: uid });
  return { ok: true, id };
}

async function updateMember(context, id, input = {}) {
  requireRole(context, ['owner', 'admin']);
  const db = getDatabase();
  const found = await db.collection(COLLECTIONS.members).where({ tenantId: context.tenantId, id }).limit(1).get();
  if (!found.data?.[0]) throw serviceError('成员不存在或无权操作', 404);
  const member = found.data[0];
  const nextRole = ['owner', 'admin', 'recruiter', 'viewer'].includes(input.role) ? input.role : member.role;
  const status = ['active', 'invited', 'disabled'].includes(input.status) ? input.status : member.status;
  await db.collection(COLLECTIONS.members).doc(member._id || id).set(persistable({ ...member, role: nextRole, status, displayName: String(input.displayName || member.displayName || '').slice(0, 80), updatedAt: new Date().toISOString(), updatedBy: context.uid }));
  await audit(context, 'member.update', id, { role: nextRole, status });
  return { ok: true, id };
}

function requireRole(context, roles) { if (!roles.includes(context.role)) throw serviceError('当前账号没有管理权限', 403); }

async function guardAiRoute(request, route) {
  const context = await getRequestContext(request);
  consumeRateLimit({ tenantId: context.tenantId, route });
  await audit(context, 'ai.route', route, { route });
  return context;
}

async function loadDocumentText(context, id) {
  const db = getDatabase();
  if (id.startsWith('legacy_')) {
    const candidateId = id.slice('legacy_'.length);
    const result = await db.collection(COLLECTIONS.candidates).where({ id: candidateId, tenantId: context.tenantId }).limit(1).get();
    const candidate = result.data?.[0];
    if (!candidate?.resume) throw serviceError('Not found', 404);
    const versions = prepareDocumentVersions(candidate.resume, normalizeResumeText);
    return { id, candidateId, rawText: versions.rawText, cleanedText: versions.cleanedText, parseVersion: versions.parseVersion, lineMap: versions.lineMap };
  }
  const result = await db.collection(COLLECTIONS.documents).where({ id, tenantId: context.tenantId }).limit(1).get();
  const document = result.data?.[0];
  if (!document) throw serviceError('Not found', 404);
  return {
    id: document.id,
    candidateId: document.candidateId || '',
    rawText: document.rawText || '',
    cleanedText: document.cleanedText || '',
    parseVersion: document.parseVersion || '',
    lineMap: document.pageOrLineMap || []
  };
}

async function loadState(context) {
  const db = getDatabase();
  const [jobs, candidatesResult, screeningsResult, rulesResult] = await Promise.all([
    listTenantJobs(context.tenantId),
    db.collection(COLLECTIONS.candidates).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(500).get(),
    db.collection(COLLECTIONS.screenings).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(500).get(),
    db.collection(COLLECTIONS.rules).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(200).get()
  ]);
  const screenings = new Map();
  for (const item of screeningsResult.data || []) if (!screenings.has(item.candidateId)) screenings.set(item.candidateId, item);
  const cases = (candidatesResult.data || []).map(candidate => {
    const screening = screenings.get(candidate.id || candidate._id) || {};
    return cleanDocument(presentCaseSummary(candidate, screening));
  });
  return { jobs, cases, rules: (rulesResult.data || []).map(cleanDocument), workspace: { tenantId: context.tenantId, role: context.role } };
}

async function loadCandidateScreening(context, id) {
  const db = getDatabase();
  const candidateResult = await db.collection(COLLECTIONS.candidates).doc(id).get().catch(() => ({ data: null }));
  const candidate = candidateResult.data;
  if (!candidate) throw serviceError('Not found', 404);
  assertSameTenant(candidate, context);
  const screeningResult = await db.collection(COLLECTIONS.screenings).doc(id).get().catch(() => ({ data: null }));
  const screening = screeningResult.data || {};
  if (screening.tenantId) assertSameTenant(screening, context);
  return {
    id,
    preparation: screening.preparation || null,
    transcript: screening.transcript || '',
    communicationSummary: screening.communicationSummary || null,
    report: screening.report || null,
    consentConfirmed: Boolean(screening.consentConfirmed),
    callRecording: screening.callRecording || null
  };
}

async function loadScreeningTexts(context) {
  const result = await getDatabase().collection(COLLECTIONS.screenings).where({ tenantId: context.tenantId }).orderBy('updatedAt', 'desc').limit(500).get();
  const seen = new Set();
  const records = [];
  for (const item of result.data || []) {
    const candidateId = item.candidateId || item.id;
    if (!candidateId || seen.has(candidateId)) continue;
    seen.add(candidateId);
    records.push({
      candidateId,
      preparation: item.preparation || null,
      transcript: item.transcript || '',
      communicationSummary: item.communicationSummary || null,
      report: item.report || null
    });
  }
  return { records };
}

async function listTenantJobs(tenantId) {
  const db = getDatabase();
  const jobs = [];
  for (let skip = 0; skip < 2000; skip += 500) {
    let query = db.collection(COLLECTIONS.jobs).where({ tenantId });
    if (skip) query = query.skip(skip);
    const result = await query.limit(500).get();
    const batch = result.data || [];
    jobs.push(...batch);
    if (batch.length < 500) break;
  }
  return dedupeStoredJobs(jobs).map(cleanDocument);
}

async function saveJob(context, id, input) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const db = getDatabase();
  await assertWritableRecord(COLLECTIONS.jobs, id, context.tenantId);
  const now = new Date().toISOString();
  const job = pick(input, ['industry', 'name', 'category', 'location', 'department', 'business', 'businessLine', 'aliases', 'jd', 'keywords', 'rules', 'status', 'source', 'mokaJobId', 'syncedFromMokaAt', 'createdAt', 'updatedAt', 'profileHistory']);
  if (input.confirmProfile) {
    const confirmed = confirmJobProfile(draftJobProfile({ ...input, profile: input.profile }), context.uid, now);
    job.profile = confirmed;
    job.profileHistory = [...(Array.isArray(input.profileHistory) ? input.profileHistory : []), confirmed.snapshot].slice(-20);
  }
  job.id = id;
  job.tenantId = context.tenantId;
  job.createdBy = context.uid;
  job.updatedBy = context.uid;
  job.updatedAt = now;
  job.createdAt = job.createdAt || now;
  job.status = job.status || 'active';
  await db.collection(COLLECTIONS.jobs).doc(id).set(job);
  await audit(context, 'job.upsert', id, { name: job.name });
}

async function saveCandidate(context, id, input) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const db = getDatabase();
  const transcriptFileName = input.resumeMeta?.fileName || '';
  const transcriptText = String(input.resume || '').trim();
  if (isTranscriptFileName(transcriptFileName) && transcriptText) {
    const existingCandidate = await db.collection(COLLECTIONS.candidates).doc(id).get().catch(() => ({ data: null }));
    if (!existingCandidate.data) {
      const imported = await importTranscript(context, { fileName: transcriptFileName, text: transcriptText, size: transcriptText.length, metadata: { fileName: transcriptFileName, source: 'local-sync-agent' } });
      await audit(context, 'candidate.redirected-transcript', id, { fileName: transcriptFileName });
      return { ok: true, id, storedAs: 'transcript', taskId: imported.task?.id || '' };
    }
  }
  await assertWritableRecord(COLLECTIONS.candidates, id, context.tenantId);
  await assertWritableRecord(COLLECTIONS.screenings, id, context.tenantId);
  const now = new Date().toISOString();
  const candidate = pick(input, ['jobId', 'candidateName', 'roleName', 'jd', 'rules', 'keywords', 'resume', 'resumeMeta', 'matching', 'status', 'createdAt', 'updatedAt', 'ingestStatus', 'ingestBatchId', 'ingestSource', 'ingestFileKey', 'duplicateOf', 'talentProfile', 'interviewer', 'interviewerName', 'interviewers', 'interviewAt', 'interviewDuration', 'interviewOutcome', 'interviewPassed', 'interviewRound', 'offerOutcome', 'offerSent', 'offerAccepted', 'offerDeclined', 'offerDeclineReason', 'hired', 'hiredAt', 'recruitmentOutcome', 'assignmentSource', 'assignmentStatus', 'assignedAt', 'assignedBy']);
  candidate.id = id;
  candidate.tenantId = context.tenantId;
  candidate.createdBy = context.uid;
  candidate.updatedBy = context.uid;
  candidate.updatedAt = now;
  candidate.createdAt = candidate.createdAt || now;
  const screening = pick(input, ['preparation', 'transcript', 'consentConfirmed', 'callRecording', 'communicationSummary', 'report']);
  const existingScreening = await db.collection(COLLECTIONS.screenings).doc(id).get().catch(() => ({ data: null }));
  const previousScreening = existingScreening.data || {};
  if (previousScreening.tenantId) assertSameTenant(previousScreening, context);
  for (const key of ['preparation', 'transcript', 'consentConfirmed', 'callRecording', 'communicationSummary', 'report']) {
    if (screening[key] === undefined && previousScreening[key] !== undefined) screening[key] = previousScreening[key];
  }
  candidate.status = deriveStatus({ ...input, report: screening.report, communicationSummary: screening.communicationSummary, preparation: screening.preparation });
  screening.id = id;
  screening.tenantId = context.tenantId;
  screening.createdBy = context.uid;
  screening.updatedBy = context.uid;
  screening.candidateId = id;
  screening.jobId = input.jobId || '';
  screening.updatedAt = now;
  screening.createdAt = input.createdAt || now;
  const existingCandidate = await db.collection(COLLECTIONS.candidates).doc(id).get().catch(() => ({ data: null }));
  if (existingCandidate.data?.tenantId) assertSameTenant(existingCandidate.data, context);
  const retainedResume = retainOriginalResume(candidate.resumeMeta, existingCandidate.data?.resumeMeta);
  if (retainedResume) candidate.resumeMeta = retainedResume;
  const mokaSync = await resolveMokaSync(context, existingCandidate.data?.mokaSync, { ...candidate, ...screening, reviewConfirmed: screening.report?.reviewConfirmed === true });
  if (mokaSync) candidate.mokaSync = mokaSync;
  await Promise.all([
    db.collection(COLLECTIONS.candidates).doc(id).set(candidate),
    db.collection(COLLECTIONS.screenings).doc(id).set(screening)
  ]);
  await audit(context, 'candidate.upsert', id, { jobId: candidate.jobId, status: candidate.status, mokaSync: candidate.mokaSync?.status || '' });
  return { ok: true, id, mokaSync: candidate.mokaSync || null };
}

function hasScreeningResult(record) {
  const summary = record?.communicationSummary;
  const report = record?.report;
  return Boolean((summary && typeof summary === 'object' && Object.keys(summary).length) || (report && typeof report === 'object' && Object.keys(report).length));
}

async function downloadCloudFile(fileId) {
  const app = getCloudbaseApp();
  if (typeof app.downloadFile === 'function') {
    const downloaded = await app.downloadFile({ fileID: fileId });
    const content = downloaded?.fileContent || downloaded?.data;
    if (content) return Buffer.from(content);
  }
  if (typeof app.getTempFileURL !== 'function') throw new Error('云存储不可用');
  const listed = await app.getTempFileURL({ fileList: [fileId] });
  const url = listed?.fileList?.[0]?.tempFileURL || listed?.fileList?.[0]?.download_url || '';
  if (!url) throw new Error('简历原件下载失败');
  const response = await fetch(url);
  if (!response.ok) throw new Error('简历原件下载失败');
  return Buffer.from(await response.arrayBuffer());
}

async function resolveMokaSync(context, previousSync, record) {
  const previous = previousSync && typeof previousSync === 'object' ? previousSync : null;
  if (!hasScreeningResult(record)) return previous;
  const plan = screeningWritePlan(record, previous);
  if (plan.action === 'skip' || (plan.action === 'draft' && previous?.status === '已同步')) return previous;
  if (plan.action === 'draft') return { status: '草稿', fingerprint: plan.fingerprint, reviewDecisionId: plan.reviewDecisionId };
  const fingerprint = plan.fingerprint;
  if (previous?.status === '已同步' && previous.fingerprint === fingerprint) return previous;
  const operatorEmail = chooseOperatorEmail(context.member?.username, process.env.MOKA_OPERATOR_EMAIL);
  try {
    const jobResult = record.jobId ? await getDatabase().collection(COLLECTIONS.jobs).doc(record.jobId).get().catch(() => ({ data: null })) : { data: null };
    const job = jobResult.data && (!jobResult.data.tenantId || jobResult.data.tenantId === context.tenantId) ? jobResult.data : null;
    let resumeFile = null;
    const fileId = record.resumeMeta?.originalFileId;
    if (fileId) {
      try {
        const buffer = await downloadCloudFile(fileId);
        if (buffer?.length) resumeFile = { buffer, fileName: record.resumeMeta.originalFileName || record.resumeMeta.fileName || 'resume.pdf', mimeType: record.resumeMeta.originalMimeType || 'application/octet-stream' };
      } catch (error) {
        return { status: `简历原件读取失败：${String(error.message || '未知错误').slice(0, 80)}`, fingerprint, reviewDecisionId: plan.reviewDecisionId, syncedAt: new Date().toISOString() };
      }
    }
    const result = await syncScreeningComment(createMokaClient(), record, operatorEmail, previous, { mokaJobId: job?.mokaJobId || '', resumeFile });
    return { ...result, fingerprint, reviewDecisionId: plan.reviewDecisionId };
  } catch (error) {
    return { status: `Moka 同步失败：${String(error.message || '未知错误').slice(0, 120)}`, fingerprint, reviewDecisionId: plan.reviewDecisionId, syncedAt: new Date().toISOString() };
  }
}

async function assertWritableRecord(collection, id, tenantId) {
  const result = await getDatabase().collection(collection).doc(id).get().catch(() => ({ data: null }));
  const existing = result.data;
  assertSameTenant(existing, { tenantId });
}

async function migrateStoredResumes(context) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const db = getDatabase();
  const [candidateResult, jobResult] = await Promise.all([
    db.collection(COLLECTIONS.candidates).where({ tenantId: context.tenantId }).limit(500).get(),
    db.collection(COLLECTIONS.jobs).where({ tenantId: context.tenantId }).limit(100).get()
  ]);
  const jobs = jobResult.data || [];
  const migrated = []; const failed = [];
  for (const source of candidateResult.data || []) {
    const id = source.id || source._id; const originalText = String(source.resume || '').trim();
    if (!id || !originalText) { failed.push({ id, reason: '没有已保存的简历文本' }); continue; }
    try {
      const versions = prepareDocumentVersions(originalText, normalizeResumeText);
      const text = versions.cleanedText;
      const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
      const basics = parseResumeBasics(text);
      basics.candidateName = chooseCandidateName(extractLabeledCandidateName(lines), extractContextualCandidateName(lines), extractNameFromFileName(source.resumeMeta?.fileName || ''), basics.candidateName, source.candidateName);
      const knownJob = jobs.find(item => item.id === source.jobId) || jobs.find(item => item.name === source.roleName) || null;
      const decision = resolveJobAssignment({ jobs, match: { result: { ...(source.matching || {}), jobId: knownJob?.id || '', status: knownJob ? (source.matching?.status || '已分配') : '待分配' } } });
      const built = buildLegacyDocument({ ...source, id, tenantId: context.tenantId, resume: originalText }, raw => prepareDocumentVersions(raw, normalizeResumeText));
      await db.collection(COLLECTIONS.documents).doc(built.document.id).set(persistable(built.document));
      const now = new Date().toISOString();
      const { _id, _openid, ...stored } = source;
      await db.collection(COLLECTIONS.candidates).doc(id).set(persistable({
        ...stored,
        id,
        tenantId: context.tenantId,
        updatedBy: context.uid,
        resume: versions.rawText,
        documentId: built.document.id,
        resumeSummary: built.candidatePatch.resumeSummary,
        candidateName: basics.candidateName || source.candidateName || '',
        resumeMeta: { ...(source.resumeMeta || {}), ...basics, textNormalizedAt: now, parseVersion: versions.parseVersion },
        jobId: decision.assigned ? decision.job.id : '',
        matching: decision.matching,
        updatedAt: now
      }));
      migrated.push(id);
    } catch (error) { failed.push({ id, reason: error.message }); }
  }
  await audit(context, 'candidate.resume.migrate', 'all', { migrated: migrated.length, failed: failed.length });
  return { ok: true, migrated: migrated.length, failed };
}

async function audit(context, action, entityId, detail) {
  const db = getDatabase();
  await db.collection(COLLECTIONS.audit).add({ tenantId: context.tenantId, action, entityId, detail: factCenter.auditDetail(detail), actorUid: context.uid, actorRole: context.role, createdAt: new Date().toISOString() });
}

function taskId() {
  return `tr_${crypto.randomUUID()}`;
}

function taskDocument(context, input = {}, id, status = 'uploading') {
  const now = new Date().toISOString();
  const size = Math.max(0, Number(input.size || input.fileSize || 0));
  if (size > 500 * 1024 * 1024) throw serviceError('单次录音不能超过 500MB', 413);
  if (!String(input.fileName || '').trim()) throw serviceError('缺少录音文件名', 400);
  return {
    id,
    tenantId: context.tenantId,
    candidateId: String(input.candidateId || '').slice(0, 100),
    fileName: String(input.fileName).slice(0, 180),
    mimeType: String(input.mimeType || 'audio/webm').slice(0, 100),
    size,
    durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
    storagePrefix: `acecall/recordings/${context.tenantId}/${String(input.candidateId || 'unassigned')}/${id}`,
    engine: process.env.TRANSCRIPTION_PROVIDER || process.env.TRANSCRIPTION_ENGINE || 'baidu',
    status,
    parts: [],
    result: null,
    error: '',
    createdBy: context.uid,
    createdAt: now,
    updatedAt: now
  };
}

async function initRecording(context, input = {}) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const id = taskId();
  const task = taskDocument(context, input, id, 'uploading');
  if (!task.candidateId) throw serviceError('缺少候选人信息', 400);
  await getDatabase().collection(COLLECTIONS.transcriptionTasks).doc(id).set(task);
  await audit(context, 'recording.init', id, { candidateId: task.candidateId, size: task.size });
  return { ok: true, recordingId: id, taskId: id, storagePrefix: task.storagePrefix, chunkSize: 8 * 1024 * 1024, maxBytes: 500 * 1024 * 1024, status: task.status };
}

async function completeRecordingPart(context, id, input = {}) {
  const task = await findTask(context, id);
  const part = { index: Math.max(0, Number(input.index || 0)), path: String(input.path || '').slice(0, 300), fileId: String(input.fileId || '').slice(0, 500), size: Math.max(0, Number(input.size || 0)), uploadedAt: new Date().toISOString() };
  if (!part.path || part.path.indexOf(`${task.storagePrefix}/`) !== 0) throw serviceError('录音分片路径无效', 400);
  const parts = [...(task.parts || []).filter(item => item.index !== part.index), part].sort((a, b) => a.index - b.index);
  const patch = { parts, status: input.final ? 'uploaded' : 'uploading', updatedAt: new Date().toISOString() };
  await getDatabase().collection(COLLECTIONS.transcriptionTasks).doc(id).set(persistable({ ...task, ...patch }));
  return { ok: true, taskId: id, status: patch.status, partCount: parts.length };
}

async function uploadRecordingPart(context, id, index, final, buffer) {
  const task = await findTask(context, id);
  if (!buffer.length) throw serviceError('录音分片为空', 400);
  const extension = path.extname(task.fileName || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'webm';
  const cloudPath = `${task.storagePrefix}/part-${String(index).padStart(5, '0')}.${extension}`;
  const uploaded = await getCloudbaseApp().uploadFile({ cloudPath, fileContent: buffer });
  return completeRecordingPart(context, id, { index, path: cloudPath, fileId: uploaded.fileID || uploaded.fileId || '', size: buffer.length, final });
}

async function createTranscriptionTask(context, input = {}) {
  const task = await findTask(context, String(input.recordingId || input.taskId || ''));
  const status = task.parts?.length ? 'queued' : task.status;
  const updated = { ...task, status, queuedAt: status === 'queued' ? new Date().toISOString() : task.queuedAt, updatedAt: new Date().toISOString() };
  await getDatabase().collection(COLLECTIONS.transcriptionTasks).doc(task.id).set(persistable(updated));
  await audit(context, 'transcription.queue', task.id, { engine: updated.engine, partCount: updated.parts.length });
  return { ok: true, task: cleanDocument(updated), message: status === 'queued' ? '录音已进入异步转写队列，等待转写 worker 处理' : '录音尚未完成上传' };
}

async function getTranscriptionTask(context, id) {
  const task = cleanDocument(await findTask(context, id));
  return { ok: true, task: { ...task, publicStatus: presentTranscriptionStatus(task.status) } };
}

async function analyzeTranscriptionTask(context, id, input = {}) {
  const task = await findTask(context, id);
  const text = String(input.text || task.result?.text || '').trim();
  if (!text) throw serviceError('转写结果为空，暂时不能分析', 422);
  const result = { text, characters: text.length, completedAt: new Date().toISOString(), format: 'text' };
  await getDatabase().collection(COLLECTIONS.transcriptionTasks).doc(id).set(persistable({ ...task, status: 'completed', result, updatedAt: new Date().toISOString(), error: '' }));
  return { ok: true, taskId: id, status: 'completed', result };
}

async function importTranscript(context, input = {}) {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const text = String(input.text || '').trim();
  if (!text) throw serviceError('转写文件内容为空', 422);
  if (text.length > 2_000_000) throw serviceError('转写文本超过 200 万字限制', 413);
  const id = taskId();
  const now = new Date().toISOString();
  const library = await listInterviewerNames(context);
  const metadata = mergeTranscriptMetadata(sanitizeJson(input.metadata || {}), input.fileName, text, library);
  metadata.findings = extractTranscriptFindings(text, String(input.resume || ''));
  const result = { text, characters: text.length, completedAt: now, format: 'text', source: 'local-moka-download' };
  const task = {
    id, tenantId: context.tenantId, candidateId: String(input.candidateId || '').slice(0, 100),
    fileName: String(input.fileName || 'moka-transcript.txt').slice(0, 180),
    mimeType: String(input.mimeType || 'text/plain').slice(0, 100), size: Math.max(0, Number(input.size || 0)),
    engine: 'document-parser', status: 'completed', source: 'local-moka-download', metadata,
    result, parts: [], error: '', createdBy: context.uid, createdAt: now, updatedAt: now
  };
  await getDatabase().collection(COLLECTIONS.transcriptionTasks).doc(id).set(task);
  await audit(context, 'transcription.import', id, { fileName: task.fileName, characters: text.length });
  return { ok: true, task: cleanDocument(task) };
}

async function listTranscriptImports(context) {
  const library = await listInterviewerNames(context);
  const result = await getDatabase().collection(COLLECTIONS.transcriptionTasks).where({ tenantId: context.tenantId, source: 'local-moka-download' }).limit(200).get();
  return { ok: true, records: (result.data || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(task => { const clean = cleanDocument(task); return { ...clean, metadata: mergeTranscriptMetadata(clean.metadata || {}, clean.fileName, clean.result?.text || '', library) }; }) };
}

function interviewerRecordId(tenantId, name) {
  return `iv_${crypto.createHash('sha1').update(`${tenantId}\n${name}`).digest('hex').slice(0, 24)}`;
}

function cleanInterviewerName(value = '') {
  const name = String(value || '').trim();
  if (!/^[\u4e00-\u9fff]{2,8}$/.test(name) && !/^[A-Za-z][A-Za-z .'-]{1,40}$/.test(name)) return '';
  if (/面试官|候选人|发言人|说话人|未知|未识别/.test(name)) return '';
  return name;
}

async function listInterviewers(context) {
  try {
    const result = await getDatabase().collection(COLLECTIONS.interviewers).where({ tenantId: context.tenantId }).limit(200).get();
    const records = (result.data || []).map(cleanDocument).filter(item => item.name).sort((left, right) => String(left.name).localeCompare(String(right.name), 'zh'));
    return { ok: true, records };
  } catch {
    return { ok: true, records: [] };
  }
}

async function listInterviewerNames(context) {
  try { return (await listInterviewers(context)).records.map(item => item.name); }
  catch { return []; }
}

async function rememberInterviewers(context, names = [], source = 'moka') {
  requireRole(context, ['owner', 'admin', 'recruiter']);
  const incoming = (Array.isArray(names) ? names : [names]).map(cleanInterviewerName).filter(Boolean);
  const accepted = [...new Set(incoming)].slice(0, 40);
  if (!accepted.length) return listInterviewers(context);
  const db = getDatabase();
  let existing = { data: [] };
  try { existing = await db.collection(COLLECTIONS.interviewers).where({ tenantId: context.tenantId }).limit(200).get(); }
  catch { existing = { data: [] }; }
  const have = new Set((existing.data || []).map(item => item.name));
  const now = new Date().toISOString();
  const origin = source === 'manual' ? 'manual' : 'moka';
  for (const name of accepted) {
    if (have.has(name)) continue;
    const id = interviewerRecordId(context.tenantId, name);
    await db.collection(COLLECTIONS.interviewers).doc(id).set({ id, tenantId: context.tenantId, name, source: origin, createdAt: now, updatedAt: now, createdBy: context.uid });
    have.add(name);
  }
  return listInterviewers(context);
}

async function findTask(context, id) {
  if (!id || !/^[A-Za-z0-9_-]{3,100}$/.test(id)) throw serviceError('录音任务不存在', 404);
  const result = await getDatabase().collection(COLLECTIONS.transcriptionTasks).where({ id, tenantId: context.tenantId }).limit(1).get();
  const task = result.data?.[0];
  if (!task) throw serviceError('录音任务不存在或无权访问', 404);
  return task;
}

function deriveStatus(item) {
  if (item.report?.reviewConfirmed) return 'completed';
  if (item.report || item.communicationSummary) return 'pending_review';
  if (item.preparation) return 'pending_call';
  return 'pending_analysis';
}

function cleanDocument(document) {
  const result = { ...document };
  result.id = result.id || result._id;
  delete result._id;
  return result;
}

// CloudBase's document.set() rejects any payload containing `_id` with
// INVALID_PARAM ("不能更新_id的值"). Because that error carries no statusCode,
// the handler below would report a generic 500 "服务暂时不可用" and the real cause
// stayed invisible. Every write path that echoes back a record read from the
// database must strip the server-managed fields first.
function persistable(document) {
  const { _id, _openid, ...rest } = document || {};
  return rest;
}

function pick(source = {}, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, sanitizeJson(source[key])]));
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith('$') || key.includes('.')) continue;
    safe[key] = sanitizeJson(child);
  }
  return safe;
}

function validateId(value) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw serviceError('Invalid resource id', 400);
  return value;
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw serviceError('输入内容过大', 413);
  }
  try { return JSON.parse(body || '{}'); } catch { throw serviceError('请求格式无效', 400); }
}

async function readBuffer(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw serviceError(`文件不能超过 ${Math.floor(limit / 1024 / 1024)}MB`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function storeOriginalResume(context, fileName, buffer) {
  const cloudPath = originalResumeCloudPath(context.tenantId, fileName, Date.now(), crypto.randomBytes(4).toString('hex'));
  const uploaded = await getCloudbaseApp().uploadFile({ cloudPath, fileContent: buffer });
  const fileId = uploaded?.fileID || uploaded?.fileId || '';
  if (!fileId) throw serviceError('简历原件上传失败', 502);
  return originalResumeMeta(fileName, buffer, fileId);
}

async function parseResumeFile(fileName, buffer) {
  const extension = path.extname(fileName).toLowerCase();
  let text = '';
  if (['.txt', '.md'].includes(extension)) text = buffer.toString('utf8');
  else if (extension === '.docx') text = (await require('mammoth').extractRawText({ buffer })).value;
  else if (extension === '.pdf') text = (await require('pdf-parse')(buffer)).text;
  else throw serviceError('仅支持 PDF、DOCX、TXT 和 MD 文件', 415);
  const versions = prepareDocumentVersions(text, normalizeResumeText);
  text = versions.cleanedText;
  if (text.length < 20) throw serviceError('未提取到足够文字；如果是扫描版 PDF，请先进行 OCR', 422, { code: 'RESUME_TEXT_EMPTY', hint: '该文件可能是扫描件、图片型 PDF 或受保护文档' });
  const phone = (text.match(/(?<!\d)(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)/)?.[0] || '').replace(/[ -]/g, '');
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '').replace(/[，。；;）)]+$/, '');
  const experienceYears = text.match(/(\d{1,2})\s*年[^。\n]{0,16}(?:工作|从业|经验|经历)/)?.[1] || '';
  const age = text.match(/(?:年龄|Age)\s*[:：]?\s*(\d{2})(?:岁)?/i)?.[1] || text.match(/(?<!\d)(2[0-9]|3[0-9]|4[0-9])\s*岁/)?.[1] || '';
  const education = ['博士', '硕士', '本科', '大专'].find(level => text.includes(level)) || '';
  const resumeLines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const labeledName = extractLabeledCandidateName(resumeLines);
  const contextualName = extractContextualCandidateName(resumeLines);
  const fileNameName = extractNameFromFileName(fileName);
  const contentName = extractCandidateName(resumeLines);
  const nameCandidates = proposeNameCandidates({ labeled: labeledName, contextual: contextualName, fromFile: fileNameName, fromBody: contentName });
  const displayedName = chooseDisplayedName(nameCandidates);
  const candidateName = displayedName.candidateName || chooseCandidateName(labeledName, contextualName, fileNameName, contentName);
  const profile = extractProfileFields(text);
  return { text, document: versions, metadata: { fileName, extension: extension.slice(1).toUpperCase(), characters: text.length, candidateName, candidateNameSource: displayedName.candidateNameSource, candidateNameStatus: displayedName.candidateNameStatus, nameCandidates, phone: profile.phone, email: profile.email, age: profile.age?.value || '', ageUsedForMatch: false, experienceYears: profile.experienceYears, education: profile.education, school: profile.school, certificates: profile.certificates, experiences: profile.experiences, profileFields: profile.fields, parseVersion: versions.parseVersion, parseQuality: { level: text.length >= 300 ? 'good' : 'warn', label: text.length >= 300 ? '文本完整' : '文本较少', characters: text.length } } };
}

let baiduAccessToken = { value: '', expiresAt: 0 };

async function transcribeWithBaidu(fileName, buffer) {
  const apiKey = process.env.BAIDU_API_KEY;
  const secretKey = process.env.BAIDU_SECRET_KEY;
  if (!apiKey || !secretKey) throw serviceError('百度语音服务尚未配置，请联系管理员配置 BAIDU_API_KEY 和 BAIDU_SECRET_KEY', 503);
  if (!buffer.length) throw serviceError('录音文件为空', 400);
  // 百度短语音接口单次请求建议不超过 10 MB；更大的文件应先压缩或拆分。
  if (buffer.length > 10 * 1024 * 1024) throw serviceError('录音文件超过百度短语音接口的 10MB 限制，请压缩或拆分后重试', 413);
  const token = await getBaiduAccessToken(apiKey, secretKey);
  const extension = path.extname(fileName).toLowerCase().slice(1) || 'm4a';
  const supportedFormats = new Set(['mp3', 'wav', 'pcm', 'amr', 'm4a']);
  if (!supportedFormats.has(extension)) throw serviceError('百度短语音仅支持 MP3、WAV、PCM、AMR 和 M4A，请先转换录音格式', 415);
  const format = extension;
  const response = await fetch(`https://vop.baidu.com/server_api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, rate: 16000, channel: 1, cuid: 'acecall', token, speech: buffer.toString('base64'), len: buffer.length, dev_pid: 1537 })
  });
  if (!response.ok) throw serviceError(`百度语音服务请求失败（${response.status}）`, 502);
  const result = await response.json();
  if (result.err_no !== 0) {
    const detail = result.err_msg || `错误码 ${result.err_no}`;
    const hint = [3300, 3301, 3302, 3303].includes(Number(result.err_no)) ? '；请确认录音不超过 60 秒且为可解码的 MP3、WAV、AMR 或 M4A 文件' : '';
    throw serviceError(`百度语音识别失败：${detail}${hint}`, 422);
  }
  const text = Array.isArray(result.result) ? result.result.join(' ').trim() : String(result.result || '').trim();
  if (!text) throw serviceError('百度语音服务未返回有效文字', 422);
  return { text, provider: 'baidu', fileName, characters: text.length };
}

async function getBaiduAccessToken(apiKey, secretKey) {
  if (baiduAccessToken.value && baiduAccessToken.expiresAt > Date.now() + 60_000) return baiduAccessToken.value;
  const response = await fetch(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`, { method: 'POST' });
  if (!response.ok) throw serviceError(`百度语音授权失败（${response.status}）`, 502);
  const result = await response.json();
  if (!result.access_token) {
    const reason = result.error_description || result.error || '未返回 access_token';
    throw serviceError(`百度语音授权失败：${reason}。请在百度智能云控制台确认当前应用的 API Key、Secret Key 仍有效，并已开通语音识别服务`, 502);
  }
  baiduAccessToken = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 2592000) * 1000 };
  return baiduAccessToken.value;
}

function validatePayload(payload) {
  if (!['prepare', 'summarize', 'synthesize', 'match', 'review-interviewer', 'classify-interview-questions'].includes(payload.action)) throw serviceError('未知工作流步骤', 400);
  if (payload.action === 'classify-interview-questions') return;
  if (payload.action === 'match' && (!payload.resume?.trim() || !Array.isArray(payload.jobs))) throw serviceError('请提供简历和岗位列表', 400);
  if (payload.action === 'prepare' && (!payload.jd?.trim() || !payload.resume?.trim())) throw serviceError('请填写 JD 和候选人简历', 400);
  if (payload.action === 'summarize' && !payload.transcript?.trim()) throw serviceError('请填写电话转写内容', 400);
  if (payload.action === 'synthesize' && (!payload.preparation || !payload.communicationSummary)) throw serviceError('请先生成初筛方案和沟通总结', 400);
  if (payload.action === 'review-interviewer' && !compactInterviewerReview(payload).sessions.length) throw serviceError('没有可分析的面试转写', 400);
}

function compactInterviewerReview(payload = {}) {
  const sessions = (Array.isArray(payload.sessions) ? payload.sessions : []).slice(0, 6).map(item => ({
    candidateName: String(item.candidateName || '').slice(0, 40),
    jobName: String(item.jobName || '').slice(0, 80),
    interviewer: String(item.interviewer || payload.interviewer || '').slice(0, 40),
    round: String(item.round || '').slice(0, 40),
    startedAt: String(item.startedAt || '').slice(0, 40),
    text: String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  })).filter(item => item.text.length >= 40);
  return { interviewer: String(payload.interviewer || sessions[0]?.interviewer || '').slice(0, 40), job: String(payload.job || '').slice(0, 80), round: String(payload.round || '').slice(0, 40), sessions };
}

function refineInterviewQuestions(values = []) {
  const seen = new Set();
  const questions = [];
  for (const value of values) {
    const source = String(typeof value === 'string' ? value : value?.question || '').replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, ' ').replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ').replace(/^[\s]*[\u4e00-\u9fffA-Za-z0-9]{1,12}[：:]\s*/, '');
    for (let clause of source.split(/[？?]/)) {
      clause = (clause.split(/[。！\n]/).pop() || clause).replace(/^(?:嗯|啊|哎|哦|那个|就是|然后|好的|对|呀)+[，,\s]*/g, '').replace(/^[\u4e00-\u9fffA-Za-z0-9]{1,12}[：:]/, '').replace(/\s+/g, '').replace(/^[，,、：:]+|[。！？?]+$/g, '').trim();
      if (clause.length < 6 || clause.length > 28 || /[：:]|面试官|候选人|转写/.test(clause)) continue;
      const question = `${clause.replace(/[？?]+$/, '')}？`;
      if (seen.has(question)) continue;
      seen.add(question);
      questions.push(question);
      if (questions.length >= 6) return questions;
    }
  }
  return questions;
}

function normalizeInterviewerReview(value = {}) {
  const themes = (Array.isArray(value.themes) ? value.themes : []).slice(0, 6).map(item => (typeof item === 'string' ? { name: item.slice(0, 40), detail: '' } : { name: String(item.name || '').slice(0, 40), detail: String(item.detail || item.evidence || '').slice(0, 240) })).filter(item => item.name || item.detail);
  const questions = refineInterviewQuestions(value.questions);
  const sessions = (Array.isArray(value.sessions) ? value.sessions : []).slice(0, 6).map(item => ({ candidateName: String(item.candidateName || '').slice(0, 40), jobName: String(item.jobName || '').slice(0, 80), focus: String(item.focus || '').slice(0, 80), summary: String(item.summary || '').slice(0, 240) })).filter(item => item.summary || item.focus);
  return { summary: String(value.summary || '').slice(0, 400), themes, questions, followUpStyle: String(value.followUpStyle || '').slice(0, 300), sessions };
}

function buildModelPrompt(payload) {
  if (payload.action === 'review-interviewer') {
    return {
      instructions: '你是招聘面试质量分析助手。根据面试转写，总结面试官的提问重点和追问方式。只依据转写里出现过的问点，不编造没有问过的问题，不判断候选人是否录用，不推断性别、年龄、婚育、籍贯。输出严格 JSON，不含 Markdown。summary 为 80 到 180 字，概括提问偏好。themes 为 3 到 6 项，每项含 name、detail，detail 用一句话说明他如何追问。questions 为 4 到 6 条短问句：每条只留一个问点，6 到 28 个字，以问号结尾，写成可以放进面试题库的问题。去掉说话人姓名、时间、口头禅、候选人回答和前后铺垫。同一问点只保留一条。例如把「哎你在上一家具体是负责哪一块啊，结果怎么衡量呢」提炼成「你在上一家具体负责哪一块？」和「结果怎么衡量？」。不要粘贴转写原句。followUpStyle 为 60 到 120 字，说明追问是顺着回答展开还是按清单提问。不要输出分场转写或原文摘录。',
      input: JSON.stringify(compactInterviewerReview(payload))
    };
  }
  const schema = payload.action === 'prepare' ? prepareSchema() : payload.action === 'summarize' ? summarySchema() : payload.action === 'synthesize' ? synthesisSchema() : matchSchema();
  return {
    instructions: `你是金融与互联网行业的专业招聘电话初筛助手。只依据输入事实工作，不得推断性别、年龄、婚育、籍贯等非岗位因素。区分“材料陈述”“电话确认”“仍待核验”，未知信息写“待确认”。输出严格 JSON，不含 Markdown。每项判断必须附事实依据，不得自动淘汰，最终决策由招聘人员完成。${schema}`,
    input: JSON.stringify(payload)
  };
}

async function completeQuestionAi(prompt) {
  const apiResponse = await fetch(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', messages: [{ role: 'system', content: prompt.instructions }, { role: 'user', content: prompt.input }], response_format: { type: 'json_object' }, temperature: 0, stream: false })
  });
  if (!apiResponse.ok) throw new Error(`DeepSeek API error: ${apiResponse.status}`);
  const data = await apiResponse.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 未返回有效内容');
  return JSON.parse(content);
}

async function generateWithDeepSeek(payload) {
  const { instructions, input } = buildModelPrompt(payload);
  const apiResponse = await fetch(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature: 0.2, stream: false })
  });
  if (!apiResponse.ok) throw new Error(`DeepSeek API error: ${apiResponse.status}`);
  const data = await apiResponse.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 未返回有效内容');
  return JSON.parse(content);
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
  return '综合审核字段：basicInfo 对象；capabilities 数组，每项含 item、evidence、assessment（匹配/部分匹配/信息不足/不匹配）；evidence 字符串数组；conflicts 数组，每项含 topic、resumeClaim、callEvidence；risks 字符串数组；conclusion（明确匹配/部分匹配/信息不足/明确不匹配）；conclusionReason 字符串；recommendationReason 字符串，用2-4句话基于简历和沟通事实说明推进理由；nextStep（推荐业务面试/补充电话沟通/转入其他岗位/暂不推进/纳入人才库长期维护）；followUps 是给下一位面试官的重点关注，写 3 到 5 条，每条一句话，只写经验缺口、尚未确认的薪资到岗竞业、简历和口述的矛盾。不要重复结论说明。';
}

function finalizeGeneratedResult(payload, generated) {
  if (payload.action === 'match') {
    const decision = evaluateJobMatches({ resume: payload.resume, jobs: payload.jobs || [], conflicts: payload.conflicts || [] });
    return { ...generated, ...decision, jobId: decision.jobId, status: decision.status, score: decision.score };
  }
  if (payload.action === 'prepare') {
    const profile = draftJobProfile({ jd: payload.jd, rules: payload.rules, keywords: payload.keywords });
    const decision = evaluateJobMatches({ resume: payload.resume, jobs: [{ id: 'current', name: payload.roleName || '', status: 'active', jd: payload.jd, rules: payload.rules, keywords: payload.keywords }] });
    const questions = buildCallQuestions({ profile, items: decision.results?.[0]?.items || [], manual: payload.manualQuestions || [] });
    return questions.length ? { ...generated, questions } : generated;
  }
  if (payload.action === 'summarize') return checkCallSummary(generated, payload.transcript || '');
  if (payload.action === 'synthesize') return checkSynthesis(generated, `${payload.resume || ''}\n${payload.transcript || ''}`);
  if (payload.action === 'review-interviewer') return protectInterviewerReview(normalizeInterviewerReview(generated), (payload.sessions || []).length);
  return generated;
}

async function rememberAiTask(context, task) {
  try {
    await getDatabase().collection(COLLECTIONS.aiTasks).add({ ...task, tenantId: context.tenantId, createdBy: context.uid, createdAt: new Date().toISOString() });
  } catch {}
}

function generateDemo(payload) {
  if (payload.action === 'match') return generateDemoMatch(payload);
  if (payload.action === 'prepare') return { summary: { headline: `${payload.candidateName || '候选人'}正在评估${payload.roleName || '目标岗位'}`, experience: '演示模式不进行事实推断', relevantBackground: '请配置DeepSeek密钥启用语义分析', openFacts: '职责、项目结果和基本条件待确认' }, matches: [], risks: [{ risk: '当前为演示模式', evidence: '未配置DeepSeek密钥', impact: '结果不能用于招聘判断' }], verification: [], questions: defaultQuestions() };
  if (payload.action === 'summarize') return { overview: '演示模式仅保存电话文本。', confirmed: [], contradicted: [], missing: [], questionCoverage: { covered: 0, total: payload.preparation?.questions?.length || 0, unanswered: [] }, keyFacts: {}, candidateSignals: [], followUps: [] };
  if (payload.action === 'review-interviewer') return demoInterviewerReview(payload);
  return { basicInfo: {}, capabilities: [], evidence: [], conflicts: [], risks: ['当前为演示模式'], conclusion: '信息不足', conclusionReason: '未启用AI服务。', recommendationReason: '请启用AI服务后，根据已核实的简历与沟通事实补充推荐理由。', nextStep: '补充电话沟通', followUps: [] };
}

function demoInterviewerReview(payload) {
  const compact = compactInterviewerReview(payload);
  const interviewer = compact.interviewer || '面试官';
  const questions = compact.sessions.flatMap(item => String(item.text).split(/[？?]/).slice(0, -1).map(part => `${(part.split(/[。！\n]/).pop() || part).trim()}？`).filter(item => item !== '？'));
  return {
    summary: `${interviewer}当前有 ${compact.sessions.length} 场转写可分析。提问集中在职责边界、项目结果和事实核验。`,
    themes: [{ name: '职责与结果', detail: '先确认个人负责范围，再追问结果如何衡量。' }],
    questions: questions.length ? questions : ['请说明个人负责范围和项目结果。'],
    followUpStyle: '未启用 AI 时只按问句摘取。启用后会根据回答内容总结追问方式。',
    sessions: compact.sessions.map(item => ({ candidateName: item.candidateName, jobName: item.jobName, focus: '职责与结果', summary: `${item.candidateName || '这场面试'}的转写已纳入分析，提问集中在职责边界和结果核实。` }))
  };
}
function generateDemoMatch(payload) {
  const ranked = payload.jobs.map(job => { const terms = findSharedTerms(`${job.name} ${job.jd}`, payload.resume, job.keywords); const score = Math.min(99, Math.round((terms.length / Math.max((job.keywords || []).length, 4)) * 70 + (payload.resume.includes(job.industry || '') ? 15 : 0) + (terms.length ? 10 : 0))); return { job, score, terms }; }).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return { status: '待分配', score: 0, confidence: '低', alternativeJobs: [], risks: [{ risk: '岗位库为空', evidence: '暂无可匹配岗位' }] };
  return { jobId: first.job.id, score: first.score, confidence: first.score >= 75 ? '高' : first.score >= 50 ? '中' : '低', status: first.score >= 50 ? '已分配' : '待分配', dimensions: [{ item: '核心关键词', score: first.score, evidence: first.terms.join('、') || '未识别共同关键词' }], alternativeJobs: ranked.slice(1, 3).map(item => ({ name: item.job.name, score: item.score, reason: item.terms.join('、') || '共同信息较少' })), risks: first.score < 50 ? [{ risk: '岗位匹配度较低', evidence: '简历与岗位共同关键词有限' }] : [] };
}

function defaultQuestions() {
  return ['请介绍最相关的项目背景、个人职责和最终结果。', '哪些决策由你直接负责？', '项目是否上线，有哪些可量化结果？', '为什么现在考虑新的机会？', '请确认地点、薪资、到岗时间和竞业限制。'].map(question => ({ category: '重点核验', question, reason: '核实岗位相关事实', source: '通用' }));
}

function findSharedTerms(left = '', right = '', customTerms = []) {
  const terms = [...new Set(['证券', '场外期权', '衍生品', '交易', '产品', '研发', '量化', '风险', '管理', '金融科技', '询报价', '生命周期', ...customTerms])];
  return terms.filter(term => left.includes(term) && right.includes(term));
}

function serviceError(message, statusCode, details = {}) {
  return Object.assign(new Error(message), { statusCode, ...details });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`AceCall API listening on ${PORT}`));

module.exports = { server, validatePayload, deriveStatus, cleanDocument, sanitizeJson, normalizeInterviewerReview, generateDemo, persistable };
