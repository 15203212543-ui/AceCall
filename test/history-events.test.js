const test = require('node:test');
const assert = require('node:assert/strict');

test('history shows the capturing account, upload time, and Moka HR', async () => {
  const { historyEvents, captureSourceLabel } = await import('../public/history-events.mjs');
  const events = historyEvents({
    createdAt: '2026-10-27T01:00:00.000Z',
    updatedAt: '2026-10-27T03:00:00.000Z',
    resumeSummary: '简历摘要',
    ingestSource: 'folder-watch',
    capturedBy: { name: '演示HR', email: 'wei@example.com' },
    capturedAt: '2026-10-27T01:02:00.000Z',
    report: { reviewConfirmed: true },
    reviewConfirmed: true,
    mokaSync: { status: '已同步', operatorName: '演示HR', syncedAt: '2026-10-27T03:05:00.000Z' }
  });
  assert.equal(captureSourceLabel({ ingestSource: 'folder-watch' }), '文件夹监听');
  assert.equal(events[0].title, '简历抓取上传');
  assert.equal(events[0].at, '2026-10-27T01:02:00.000Z');
  assert.match(events[0].detail, /演示HR · 文件夹监听/);
  assert.equal(events.at(-1).title, '同步 Moka');
  assert.match(events.at(-1).detail, /演示HR · 已同步/);
  assert.equal(events.find(event => event.title === '招聘人员确认结果').detail, '演示HR');
});

test('older resumes stay unlabeled instead of borrowing the latest editor', async () => {
  const { historyEvents } = await import('../public/history-events.mjs');
  const events = historyEvents({ createdAt: '2026-01-01T00:00:00.000Z', resumeSummary: '旧简历', mokaSync: { status: '已同步' } });
  assert.match(events[0].detail, /账号未记录/);
  assert.match(events.at(-1).detail, /账号未记录 · 已同步/);
});
