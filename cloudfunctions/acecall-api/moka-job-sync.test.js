const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOpenMokaJob, mokaSyncDue, planMokaJobSync } = require('./moka-job-sync');

test('open Moka jobs keep the manager and assistant emails', () => {
  const job = normalizeOpenMokaJob({
    id: 'job-1',
    title: '行情产品经理',
    mjCode: 'MJ001',
    description: '负责行情产品',
    jobManager: { email: 'Lead@Example.com' },
    jobAssistants: [{ email: 'helper@example.com' }, { name: '无邮箱' }]
  });
  assert.deepEqual(job.emails, ['lead@example.com', 'helper@example.com']);
  assert.equal(job.code, 'MJ001');
  assert.equal(job.description, '负责行情产品');
});

test('a matching open job is created once and an existing link is updated without replacing its JD', () => {
  const plan = planMokaJobSync({
    email: 'lead@example.com',
    catalogComplete: true,
    openJobs: [
      { id: 'moka-new', name: '行情产品经理', code: 'MJ100', emails: ['lead@example.com'], description: '新职位说明' },
      { id: 'moka-old', name: '人力管培', code: 'MJ759', emails: ['lead@example.com'], description: '不要覆盖' },
      { id: 'moka-other', name: '别人的岗位', code: 'MJ200', emails: ['other@example.com'], description: '其他人' }
    ],
    localJobs: [
      { id: 'local-old', name: '人力管培旧名', mokaJobId: 'moka-old', mokaJobCode: 'MJ000', jd: '团队已写的说明', status: 'active' },
      { id: 'manual', name: '内部岗位', status: 'active' }
    ]
  });
  assert.equal(plan.matched, 2);
  assert.deepEqual(plan.creates.map(job => job.name), ['行情产品经理']);
  assert.deepEqual(plan.updates, [{ id: 'local-old', patch: { name: '人力管培', mokaJobCode: 'MJ759' } }]);
  assert.deepEqual(plan.closes, []);
});

test('jobs missing from a complete open catalog are closed, and an incomplete catalog is not', () => {
  const localJobs = [{ id: 'linked', name: '结算专员', mokaJobId: 'moka-closed', status: 'active' }];
  const openJobs = [{ id: 'moka-open', name: '仍开放', emails: ['lead@example.com'] }];
  assert.deepEqual(planMokaJobSync({ localJobs, openJobs, email: 'lead@example.com', catalogComplete: true }).closes, [{ id: 'linked', name: '结算专员' }]);
  assert.deepEqual(planMokaJobSync({ localJobs, openJobs, email: 'lead@example.com', catalogComplete: false }).closes, []);
});

test('a stopped job is reopened when Moka lists it again', () => {
  const plan = planMokaJobSync({
    email: 'lead@example.com',
    catalogComplete: true,
    openJobs: [{ id: 'aabbccdd-eeff-0011-2233-445566778899', name: '券商测试工程师', code: 'MJ714', emails: ['lead@example.com'], description: '说明' }],
    localJobs: [{ id: 'local', name: '券商测试工程师', mokaJobId: 'aabbccddeeff00112233445566778899', status: 'closed', jd: '' }]
  });
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates[0].patch.status, 'active');
  assert.equal(plan.updates[0].patch.jd, '说明');
});

test('the automatic check is due after 24 hours', () => {
  const now = Date.parse('2026-10-30T02:00:00.000Z');
  assert.equal(mokaSyncDue('', now), true);
  assert.equal(mokaSyncDue('2026-10-30T01:00:00.000Z', now), false);
  assert.equal(mokaSyncDue('2026-10-29T02:00:00.000Z', now), true);
});
