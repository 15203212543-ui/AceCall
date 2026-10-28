const test = require('node:test');
const assert = require('node:assert/strict');
const {
  upcomingInterviewPath,
  buildReminderMessage,
  buildReminderRecords,
  mergeReminderLedger,
  locateResume,
  prepareTenantInterviewReminders
} = require('./interview-reminder');

const now = new Date('2026-10-28T06:00:00.000Z');
const phone = '13800001111';

function interview(overrides = {}) {
  return {
    id: 'iv-phone',
    interviewType: 3,
    startTime: '2026-10-28T08:00:00.000Z',
    status: '未结束',
    jobName: '交易产品经理',
    roundName: '业务面试',
    applicationId: 'app-1',
    candidates: [{ name: '林晓', phone, applicationId: 'app-1' }],
    interviewers: [{ name: '魏欣欣', email: 'wei@example.com', phone: '13900002222' }],
    ...overrides
  };
}

const confirmedCandidate = {
  id: 'cand-1',
  candidateName: '林晓',
  roleName: '交易产品经理',
  reviewConfirmed: true,
  mokaSync: { status: '已同步', applicationId: 'app-1' },
  report: {
    reviewConfirmed: true,
    conclusionReason: '有5年合规经验，目前年薪40万。合同审核经验完整。',
    followUps: ['核对券商业务经验是否足以转岗', '确认薪资结构是否含年终']
  },
  communicationSummary: { keyFacts: { location: '上海', currentSalary: '年薪40万', expectedSalary: '45万' } },
  resumeMeta: { originalFileId: 'cloud://resume', originalFileName: '林晓.pdf', originalFileSize: 2048 }
};

test('upcoming interviews are read forward, not from the history window', () => {
  const path = upcomingInterviewPath('/api-platform/v1/interviews', now);
  const query = new URL(path, 'https://api.example').searchParams;
  const start = Date.parse(query.get('startDate'));
  const end = Date.parse(query.get('endDate'));
  assert.equal(start, now.getTime());
  assert.equal(end - start, 48 * 60 * 60 * 1000);
});

test('phone, video, and onsite reminders keep only the contact fields for that form', () => {
  const phoneMessage = buildReminderMessage({
    candidateName: '林晓', jobName: '交易产品经理', round: '业务面试', form: 'phone', formLabel: '电话面试',
    startedAt: '2026-10-28T08:00:00.000Z', candidatePhone: phone, meetingUrl: 'https://meet.example/secret', location: '上海'
  }, confirmedCandidate);
  assert.match(phoneMessage, new RegExp(phone));
  assert.equal(phoneMessage.includes('meet.example'), false);
  assert.equal(phoneMessage.includes('年薪'), false);
  assert.equal(phoneMessage.includes('45万'), false);
  assert.match(phoneMessage, /合同审核经验完整/);
  assert.match(phoneMessage, /核对券商业务经验是否足以转岗/);
  assert.equal(phoneMessage.includes('确认薪资结构'), false);
  assert.match(phoneMessage, /林晓\.pdf/);

  const videoMessage = buildReminderMessage({
    candidateName: '林晓', jobName: '交易产品经理', round: '业务面试', form: 'video', formLabel: '视频面试',
    startedAt: '2026-10-28T08:00:00.000Z', meetingUrl: 'https://meet.example/room', meetingCode: ''
  }, {});
  assert.match(videoMessage, /https:\/\/meet\.example\/room/);
  assert.match(videoMessage, /会议号：Moka 未提供/);
  assert.equal(videoMessage.includes('人选电话'), false);
  assert.match(videoMessage, /尚无已确认的初筛备注/);

  const onsiteMessage = buildReminderMessage({
    candidateName: '林晓', jobName: '交易产品经理', round: '初试', form: 'onsite', formLabel: '现场面试',
    startedAt: '2026-10-28T08:00:00.000Z', location: ''
  }, {});
  assert.match(onsiteMessage, /面试地点：Moka 未提供/);
  assert.match(onsiteMessage, /2026-10-28 16:00/);
});

test('stored reminders omit candidate phone numbers and skip cancelled or past interviews', () => {
  const records = buildReminderRecords('tenant-1', [
    interview(),
    interview({ id: 'iv-cancel', status: '已取消', candidates: [{ name: '林晓', phone, applicationId: 'app-1' }] }),
    interview({ id: 'iv-past', startTime: '2026-10-28T05:00:00.000Z' }),
    interview({
      id: 'iv-video', interviewType: '视频面试', intervieweeVideoUrl: 'https://meet.example/room', meetingCode: '883344',
      candidates: [{ name: '周宁', applicationId: 'app-2' }],
      interviewers: [{ name: '李明', email: 'li@example.com' }, { name: '赵敏' }]
    })
  ], [confirmedCandidate], ['交易产品经理'], now);
  const stored = JSON.stringify(records);
  assert.equal(stored.includes(phone), false);
  assert.equal(stored.includes('13900002222'), false);
  assert.equal(records.some(item => item.interviewId === 'iv-cancel' || item.interviewId === 'iv-past'), false);
  const phoneRecord = records.find(item => item.interviewId === 'iv-phone');
  assert.equal(phoneRecord.status, '待发送');
  assert.equal(phoneRecord.timing, '提前1小时');
  assert.equal(phoneRecord.contact.phoneReady, true);
  assert.match(phoneRecord.messagePreview, /已包含人选电话/);
  assert.equal(phoneRecord.noteReady, true);
  assert.equal(phoneRecord.resume.attachable, true);
  const videoRecords = records.filter(item => item.interviewId === 'iv-video');
  assert.equal(videoRecords.length, 2);
  assert.equal(videoRecords.find(item => item.interviewerName === '赵敏').interviewerEmail, '');
});

test('a changed start time keeps the old reminder skipped and creates the new one', () => {
  const [original] = buildReminderRecords('tenant-1', [interview()], [confirmedCandidate], ['交易产品经理'], now);
  const moved = buildReminderRecords('tenant-1', [interview({ startTime: '2026-10-28T09:00:00.000Z' })], [confirmedCandidate], ['交易产品经理'], now);
  const merged = mergeReminderLedger([original], moved, now);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(item => item.id === original.id).status, '已跳过');
  assert.equal(merged.find(item => item.id === original.id).skipReason, '面试时间已变更');
  assert.equal(merged.find(item => item.id === moved[0].id).status, '待发送');
});

test('resume files are located without copying their contents', () => {
  assert.equal(locateResume(confirmedCandidate).attachable, true);
  assert.equal(locateResume({ resumeMeta: { originalFileId: 'cloud://big', originalFileName: '大.pdf', originalFileSize: 11 * 1024 * 1024 } }).attachable, false);
  assert.equal(locateResume({}).available, false);
  assert.equal(JSON.stringify(locateResume(confirmedCandidate)).includes('简历正文'), false);
});

test('prepare stores a pending ledger and does not call the history sync', async () => {
  const docs = new Map();
  const database = {
    collection() {
      return { doc(id) {
        return {
          async get() { return { data: docs.has(id) ? [docs.get(id)] : [] }; },
          async set(value) { docs.set(id, value); }
        };
      } };
    }
  };
  const requests = [];
  const client = {
    config: { baseUrl: 'https://api.example', apiKey: 'secret', interviewsPath: '/api-platform/v1/interviews', jobNames: ['交易产品经理'] },
    async request(path) {
      requests.push(path);
      return { ok: true, status: 200, body: { data: [interview(), { id: 'other', interviewType: 1, startTime: '2026-10-28T08:00:00.000Z', jobName: '厨师', status: '未结束', interviewers: [{ name: '王五' }] }] } };
    }
  };
  const prepared = await prepareTenantInterviewReminders({ database, tenantId: 'tenant_1', client, now, candidates: [confirmedCandidate] });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.saved, true);
  assert.equal(prepared.coverage.phone, 1);
  assert.equal(prepared.coverage.onsite, 0);
  assert.equal(prepared.items.length, 1);
  assert.equal(JSON.stringify(docs).includes(phone), false);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /startDate=2026-10-28T06/);
  const again = await prepareTenantInterviewReminders({ database, tenantId: 'tenant_1', client, now, candidates: [confirmedCandidate] });
  assert.equal(again.items.filter(item => item.status === '待发送').length, 1);
});
