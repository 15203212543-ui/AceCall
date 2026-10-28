const crypto = require('node:crypto');
const { buildScreeningNote, isSalaryText } = require('./moka-client');

const COLLECTION = 'acecall_interview_reminders';
const WINDOW_MS = 48 * 60 * 60 * 1000;
const LEAD_MS = 60 * 60 * 1000;
const FILE_ATTACH_LIMIT = 10 * 1024 * 1024;
const FORM_LABELS = {
  onsite: '现场面试',
  group: '集体面试',
  phone: '电话面试',
  video: '视频面试',
  queue: '叫号面试'
};

function reminderDocId(tenantId = '') {
  const tenant = String(tenantId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
  return `reminders_${tenant}`;
}

function upcomingWindow(now = new Date()) {
  const start = new Date(now);
  const end = new Date(start.getTime() + WINDOW_MS);
  return { start, end };
}

function upcomingInterviewPath(interviewsPath = '/api-platform/v1/interviews', now = new Date()) {
  const { start, end } = upcomingWindow(now);
  const base = String(interviewsPath || '/api-platform/v1/interviews');
  const join = base.includes('?') ? '&' : '?';
  return `${base}${join}startDate=${encodeURIComponent(start.toISOString())}&endDate=${encodeURIComponent(end.toISOString())}`;
}

function parseInstant(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function formatShanghai(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(iso));
  const read = type => parts.find(part => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === 'object') return [value];
  if (typeof value === 'string' && value.trim()) return [{ name: value.trim() }];
  return [];
}

function textAt(source, path) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') return '';
    current = current[key];
  }
  if (typeof current === 'string' || typeof current === 'number') return String(current).trim();
  return '';
}

function firstText(source, paths) {
  for (const path of paths) {
    const value = textAt(source, path);
    if (value) return value;
  }
  return '';
}

function formFromValue(value) {
  const code = String(value ?? '').trim();
  if (code === '1') return 'onsite';
  if (code === '2') return 'group';
  if (code === '3') return 'phone';
  if (code === '4') return 'video';
  if (code === '5') return 'queue';
  if (/电话|phone/i.test(code)) return 'phone';
  if (/视频|video/i.test(code)) return 'video';
  if (/现场|到场|onsite/i.test(code)) return 'onsite';
  if (/集体/.test(code)) return 'group';
  if (/叫号/.test(code)) return 'queue';
  return '';
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length >= 13 && digits.startsWith('86')) return digits.slice(-11);
  return /^1[3-9]\d{9}$/.test(digits) ? digits : '';
}

function officialHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function interviewSlots(record = {}) {
  const nested = [record.interviews, record.entities, record.raw?.interviews, record.raw?.entities, record.interviewDetail?.entities]
    .find(list => Array.isArray(list) && list.some(item => item && (item.startTime || item.startedAt || item.interviewTime)));
  if (!nested) return [record];
  return nested.map(slot => ({ ...record, ...slot, interviewType: slot.interviewType || slot.typeCode || record.interviewType || record.typeCode }));
}

function interviewForm(record = {}) {
  const values = [
    record.interviewType, record.typeCode, record.type, record.interview?.interviewType,
    ...asList(record.interviewers).map(item => item.interviewType || item.typeCode)
  ];
  for (const value of values) {
    const form = formFromValue(value);
    if (form) return form;
  }
  return '';
}

function candidatePhone(record = {}) {
  const pools = [
    ...asList(record.interviewee),
    ...asList(record.candidates),
    record.candidate,
    record.candidateBaseInfo
  ];
  for (const item of pools) {
    const phone = normalizePhone(item?.phone || item?.mobile || item?.candidatePhone);
    if (phone) return phone;
  }
  return normalizePhone(record.candidatePhone);
}

function meetingUrl(record = {}) {
  const values = [
    record.intervieweeVideoUrl, record.interviewerVideoUrl, record.interviewerUrl, record.videoUrl,
    record.meetingUrl, record.videoLink, record.interviewUrl, record.videoInterviewUrl
  ];
  for (const value of values) {
    const url = officialHttps(value);
    if (url && !/resume|OSSAccessKeyId/i.test(url)) return url;
  }
  return '';
}

function meetingCode(record = {}) {
  const values = [record.meetingCode, record.meetingNo, record.meetingNumber, record.videoCode, record.interviewPassword, record.meetingPassword];
  const code = values.map(value => String(value || '').trim()).find(value => value && value.length <= 40 && !isSalaryText(value));
  return code || '';
}

function interviewLocation(record = {}) {
  const value = firstText(record, [
    ['locationAddress'],
    ['address', 'address'],
    ['address'],
    ['meetingRoomName'],
    ['roomName'],
    ['location']
  ]);
  if (!value || isSalaryText(value)) return '';
  if (value.startsWith('http') || value.includes('@')) return '';
  return value.slice(0, 160);
}

function interviewersOf(record = {}) {
  const structured = [
    ...asList(record.interviewers),
    ...asList(record.raw?.interviewers),
    ...asList(record.interviewer).filter(item => item.email || item.phone || item.mobile || item.id)
  ];
  const people = structured.length ? structured : asList(record.interviewerName || record.interviewer);
  const seen = new Set();
  const result = [];
  for (const person of people) {
    const name = String(person.name || person.interviewerName || '').trim();
    const email = String(person.email || '').trim().toLowerCase();
    const key = email || (name ? `name:${name}` : '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, email, hasPhone: Boolean(normalizePhone(person.phone || person.mobile)) });
  }
  return result;
}

function jobTitleOf(record = {}) {
  return firstText(record, [
    ['jobName'], ['jobTitle'], ['positionName'], ['roleName'],
    ['job', 'title'], ['job', 'jobTitle'], ['job', 'name'],
    ['interviewee', 'jobTitle']
  ]).slice(0, 80);
}

function cancelledInterview(record = {}) {
  if (record.valid === false) return true;
  const status = record.status ?? record.scheduleStatus ?? record.cancelReason;
  if (status === 3 || status === '3') return true;
  return /取消|cancel/i.test(String(status || ''));
}

function finishedInterview(record = {}) {
  const status = record.status ?? record.scheduleStatus;
  if (status === 2 || status === '2') return true;
  return /已结束/.test(String(status || ''));
}

function normalizeJobName(value = '') {
  return String(value || '').toLowerCase().replace(/[\s\-_/（）()【】[\]：:·,，、]/g, '');
}

function matchesJob(record, names = []) {
  if (!names.length) return true;
  const role = normalizeJobName(jobTitleOf(record));
  if (!role) return false;
  return names.some(name => {
    const target = normalizeJobName(name);
    if (!target) return false;
    if (role.includes(target) || target.includes(role)) return true;
    const base = target.replace(/长沙$|上海$|北京$|深圳$|广州$/, '');
    return base.length >= 4 && role.includes(base);
  });
}

function extractArrangement(record = {}) {
  const form = interviewForm(record);
  const startedAt = parseInstant(record.startTime || record.startedAt || record.interviewTime);
  return {
    interviewId: String(record.event_id || record.interviewId || record.groupInterviewId || record.id || record._id || ''),
    applicationId: String(record.applicationId || record.applicationIds?.[0] || record.candidates?.[0]?.applicationId || ''),
    candidateName: firstText(record, [['candidateName'], ['candidate', 'name'], ['interviewee', 'name'], ['candidates', 0, 'name'], ['interviewee', 0, 'name']]).slice(0, 40),
    jobName: jobTitleOf(record),
    round: firstText(record, [['roundName'], ['round'], ['interviewStage'], ['stageName']]).slice(0, 40),
    form,
    formLabel: FORM_LABELS[form] || '',
    startedAt,
    candidatePhone: form === 'phone' ? candidatePhone(record) : '',
    meetingUrl: form === 'video' ? meetingUrl(record) : '',
    meetingCode: form === 'video' ? meetingCode(record) : '',
    location: form === 'onsite' || form === 'group' || form === 'queue' ? interviewLocation(record) : '',
    interviewers: interviewersOf(record),
    cancelled: cancelledInterview(record),
    finished: finishedInterview(record)
  };
}

function arrangementsFromInterviews(records = [], jobNames = []) {
  return records.flatMap(record => interviewSlots(record))
    .filter(record => matchesJob(record, jobNames))
    .map(extractArrangement)
    .filter(item => item.interviewId && item.startedAt);
}

function reminderTiming(startedAt, now) {
  const start = Date.parse(startedAt);
  const current = now.getTime();
  if (!Number.isFinite(start) || start <= current) return null;
  if (start - current > WINDOW_MS) return null;
  const planned = start - LEAD_MS;
  if (planned > current) return { plannedSendAt: new Date(planned).toISOString(), timing: '提前1小时' };
  return { plannedSendAt: now.toISOString(), timing: '临近补发' };
}

function confirmedNote(candidate) {
  const confirmed = candidate?.report?.reviewConfirmed === true || candidate?.reviewConfirmed === true;
  return confirmed && candidate?.mokaSync?.status === '已同步';
}

function noteLines(candidate) {
  if (!confirmedNote(candidate)) {
    const experience = candidate?.resumeMeta?.experiences?.[0];
    const role = [experience?.company, experience?.title].filter(Boolean).join(' · ');
    const lines = ['尚无已确认的初筛备注。'];
    if (role && !isSalaryText(role)) lines.push(`当前职位：${role}`);
    return lines;
  }
  return buildScreeningNote(candidate).split('\n').map(line => line.trim()).filter(line => line && !isSalaryText(line));
}

function buildReminderMessage(arrangement, candidate = {}) {
  const lines = [
    '面试提醒',
    `候选人：${arrangement.candidateName || '未命名'}`,
    `岗位：${arrangement.jobName || candidate.roleName || '未分配'}`,
    `轮次：${arrangement.round || '未提供'}`,
    `时间：${formatShanghai(arrangement.startedAt)}`,
    `形式：${arrangement.formLabel || 'Moka 未提供'}`
  ];
  if (arrangement.form === 'phone') lines.push(`人选电话：${arrangement.candidatePhone || 'Moka 未提供'}`);
  if (arrangement.form === 'video') {
    lines.push(`会议链接：${arrangement.meetingUrl || 'Moka 未提供'}`);
    lines.push(`会议号：${arrangement.meetingCode || 'Moka 未提供'}`);
  }
  if (arrangement.form === 'onsite' || arrangement.form === 'group' || arrangement.form === 'queue') {
    lines.push(`面试地点：${arrangement.location || 'Moka 未提供'}`);
  }
  lines.push('', '人选基本情况：', ...noteLines(candidate));
  const resume = locateResume(candidate);
  if (resume.available) lines.push('', `简历：已定位${resume.fileName ? ` ${resume.fileName}` : ''}，${resume.attachable ? '可随提醒附上' : '发送时改用下载链接'}`);
  else lines.push('', '简历：暂未取到');
  return lines.join('\n');
}

function locateResume(candidate = {}) {
  const meta = candidate.resumeMeta || {};
  const fileId = String(meta.originalFileId || '');
  const fileName = String(meta.originalFileName || meta.fileName || '').slice(0, 180);
  const fileSize = Number(meta.originalFileSize || 0);
  if (fileId) {
    return { available: true, source: 'acecall', fileName, fileSize, attachable: fileSize > 0 && fileSize <= FILE_ATTACH_LIMIT, fileId };
  }
  return { available: false, source: '', fileName: '', fileSize: 0, attachable: false, fileId: '' };
}

function reminderIdentity(tenantId, arrangement, interviewer) {
  const interviewerKey = interviewer.email || `name:${interviewer.name}`;
  const id = `ir_${crypto.createHash('sha1').update(`${tenantId}|${arrangement.interviewId}|${interviewerKey}|${arrangement.startedAt}`).digest('hex').slice(0, 24)}`;
  return { id, interviewerKey };
}

function redactPhones(value) {
  return String(value || '').replace(/(?<!\d)(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)/g, '已包含人选电话');
}

function reminderRecord(tenantId, arrangement, interviewer, candidate, now) {
  const timing = reminderTiming(arrangement.startedAt, now);
  if (!timing || arrangement.cancelled || arrangement.finished) return null;
  const identity = reminderIdentity(tenantId, arrangement, interviewer);
  const resume = locateResume(candidate);
  const preview = redactPhones(buildReminderMessage(arrangement, candidate));
  return {
    ...identity,
    tenantId,
    interviewId: arrangement.interviewId,
    applicationId: arrangement.applicationId,
    candidateId: String(candidate?.id || ''),
    candidateName: arrangement.candidateName,
    jobName: arrangement.jobName,
    round: arrangement.round,
    form: arrangement.form,
    formLabel: arrangement.formLabel,
    startedAt: arrangement.startedAt,
    plannedSendAt: timing.plannedSendAt,
    timing: timing.timing,
    interviewerName: interviewer.name,
    interviewerEmail: interviewer.email,
    interviewerPhoneReady: interviewer.hasPhone,
    contact: {
      phoneReady: Boolean(arrangement.candidatePhone),
      meetingUrl: arrangement.meetingUrl,
      meetingCodeReady: Boolean(arrangement.meetingCode),
      location: arrangement.location
    },
    noteReady: confirmedNote(candidate),
    resume: { available: resume.available, source: resume.source, fileName: resume.fileName, fileSize: resume.fileSize, attachable: resume.attachable, fileId: resume.fileId },
    messagePreview: preview,
    status: '待发送',
    skipReason: ''
  };
}

function buildReminderRecords(tenantId, interviews, candidates, jobNames, now = new Date()) {
  const records = [];
  for (const arrangement of arrangementsFromInterviews(interviews, jobNames)) {
    const candidate = matchCandidate(candidates, arrangement) || {};
    for (const interviewer of arrangement.interviewers) {
      const record = reminderRecord(tenantId, arrangement, interviewer, candidate, now);
      if (record) records.push(record);
    }
  }
  return records;
}

function matchCandidate(candidates, arrangement) {
  const applicationId = String(arrangement.applicationId || '');
  if (applicationId) {
    const matched = candidates.find(item => String(item.mokaSync?.applicationId || '') === applicationId);
    if (matched) return matched;
  }
  const name = arrangement.candidateName;
  const named = candidates.filter(item => item.candidateName && item.candidateName === name);
  return named.length === 1 ? named[0] : null;
}

function coverageOf(interviews, jobNames) {
  const arrangements = arrangementsFromInterviews(interviews, jobNames);
  const count = form => arrangements.filter(item => item.form === form).length;
  return {
    upcoming: arrangements.length,
    phone: count('phone'),
    phoneMissingNumber: arrangements.filter(item => item.form === 'phone' && !item.candidatePhone).length,
    video: count('video'),
    videoMissingLink: arrangements.filter(item => item.form === 'video' && !item.meetingUrl).length,
    videoMissingCode: arrangements.filter(item => item.form === 'video' && !item.meetingCode).length,
    onsite: count('onsite'),
    onsiteMissingLocation: arrangements.filter(item => item.form === 'onsite' && !item.location).length,
    interviewerMissingEmail: arrangements.filter(item => item.interviewers.some(person => !person.email)).length
  };
}

function mergeReminderLedger(existing = [], desired = [], now = new Date()) {
  const window = upcomingWindow(now);
  const existingById = new Map(existing.map(item => [item.id, item]));
  const nextDesired = desired.map(item => {
    const previous = existingById.get(item.id);
    if (previous && (previous.status === '已发送' || previous.status === '已送达')) {
      return { ...item, status: previous.status, skipReason: previous.skipReason || '' };
    }
    return item;
  });
  const desiredIds = new Set(nextDesired.map(item => item.id));
  const desiredKeys = new Set(nextDesired.map(item => `${item.interviewId}|${item.interviewerKey}`));
  const desiredInterviews = new Set(nextDesired.map(item => item.interviewId));
  const kept = existing.map(item => {
    if (desiredIds.has(item.id) || item.status !== '待发送') return item;
    if (desiredKeys.has(`${item.interviewId}|${item.interviewerKey}`)) return { ...item, status: '已跳过', skipReason: '面试时间已变更' };
    const start = Date.parse(item.startedAt || '');
    if (Number.isFinite(start) && start >= window.start.getTime() && start <= window.end.getTime() && !desiredInterviews.has(item.interviewId)) {
      return { ...item, status: '已跳过', skipReason: '未出现在最新安排中' };
    }
    return item;
  }).filter(item => !desiredIds.has(item.id));
  return [...nextDesired, ...kept].sort((left, right) => (Date.parse(left.startedAt || '') || 0) - (Date.parse(right.startedAt || '') || 0));
}

function presentReminder(record = {}) {
  const copy = JSON.parse(JSON.stringify(record));
  copy.messagePreview = redactPhones(copy.messagePreview || '');
  delete copy._id;
  delete copy._openid;
  delete copy.candidatePhone;
  return copy;
}

function unwrapDocument(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function unwrapList(data) {
  const document = unwrapDocument(data);
  if (Array.isArray(data)) return data;
  if (Array.isArray(document)) return document;
  return [];
}

async function readLedger(database, tenantId) {
  if (!database) return [];
  try {
    const result = await database.collection(COLLECTION).doc(reminderDocId(tenantId)).get();
    const stored = unwrapDocument(result?.data);
    return Array.isArray(stored?.items) ? stored.items.map(presentReminder) : [];
  } catch {
    return [];
  }
}

async function writeLedger(database, tenantId, items) {
  if (!database) return false;
  try {
    const id = reminderDocId(tenantId);
    await database.collection(COLLECTION).doc(id).set({ id, tenantId, updatedAt: new Date().toISOString(), items: items.map(presentReminder) });
    return true;
  } catch {
    return false;
  }
}

async function readInterviewReminders({ database, tenantId }) {
  const items = await readLedger(database, tenantId);
  return { ok: true, items };
}

function flattenRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'items', 'interviews', 'records', 'list']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = flattenRecords(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

async function loadWorkspaceCandidates(database, tenantId) {
  if (!database) return { candidates: [], warning: '' };
  try {
    const [candidateResult, screeningResult] = await Promise.all([
      database.collection('acecall_candidates').where({ tenantId }).limit(500).get(),
      database.collection('acecall_screenings').where({ tenantId }).limit(500).get()
    ]);
    const screenings = new Map(unwrapList(screeningResult?.data).map(item => [String(item.id || item._id || ''), item]));
    const candidates = unwrapList(candidateResult?.data).map(candidate => {
      const screening = screenings.get(String(candidate.id || '')) || {};
      return {
        id: candidate.id,
        candidateName: candidate.candidateName || '',
        roleName: candidate.roleName || '',
        report: screening.report || candidate.report || null,
        communicationSummary: screening.communicationSummary || candidate.communicationSummary || null,
        resumeMeta: candidate.resumeMeta || {},
        mokaSync: candidate.mokaSync || null
      };
    });
    return { candidates, warning: '' };
  } catch {
    return { candidates: [], warning: '候选人备注暂时没有读到，提醒只保留面试安排。' };
  }
}

async function prepareTenantInterviewReminders({ database, tenantId, client, now = new Date(), candidates }) {
  const existing = await readLedger(database, tenantId);
  if (!client?.config?.baseUrl || !client?.config?.apiKey) {
    return { ok: true, configured: false, saved: false, prepared: false, items: existing, warning: 'Moka 尚未配置' };
  }
  let interviews = [];
  try {
    const response = await client.request(upcomingInterviewPath(client.config.interviewsPath, now));
    if (!response?.ok) {
      return { ok: true, configured: true, saved: false, prepared: false, items: existing, warning: `Moka 面试安排读取失败（${response?.status || 0}）` };
    }
    interviews = flattenRecords(response.body);
  } catch {
    return { ok: true, configured: true, saved: false, prepared: false, items: existing, warning: 'Moka 面试安排暂时没有读到' };
  }
  const loaded = candidates ? { candidates, warning: '' } : await loadWorkspaceCandidates(database, tenantId);
  const jobNames = client.config.jobNames || [];
  const desired = buildReminderRecords(tenantId, interviews, loaded.candidates, jobNames, now);
  const items = mergeReminderLedger(existing, desired, now).map(presentReminder);
  const saved = await writeLedger(database, tenantId, items);
  return {
    ok: true,
    configured: true,
    saved,
    prepared: true,
    items,
    coverage: coverageOf(interviews, jobNames),
    warning: [loaded.warning, saved ? '' : '待发送记录暂时没有写入'].filter(Boolean).join(' ')
  };
}

module.exports = {
  FILE_ATTACH_LIMIT,
  upcomingWindow,
  upcomingInterviewPath,
  extractArrangement,
  arrangementsFromInterviews,
  buildReminderMessage,
  buildReminderRecords,
  locateResume,
  mergeReminderLedger,
  presentReminder,
  coverageOf,
  readInterviewReminders,
  prepareTenantInterviewReminders
};
