const test = require('node:test');
const assert = require('node:assert/strict');

test('recording clock and dock follow the active call', async () => {
  const { formatRecordingClock, recordingDockVisible, recordingOnCallPage, recordingStatusLabel } = await import('../public/recording-session.mjs');
  const startedAt = '2026-10-27T02:00:00.000Z';
  const now = Date.parse('2026-10-27T02:01:05.000Z');
  assert.equal(formatRecordingClock(startedAt, now), '00:01:05');
  assert.equal(formatRecordingClock(startedAt, Date.parse('2026-10-27T03:01:01.000Z')), '01:01:01');
  assert.equal(formatRecordingClock(''), '00:00:00');

  const session = { candidateId: 'c1', phase: 'recording', startedAt };
  const onCall = { view: 'candidate', candidateId: 'c1', detailTab: 'call' };
  assert.equal(recordingOnCallPage(session, onCall), true);
  assert.equal(recordingDockVisible(session, onCall), false);
  assert.equal(recordingDockVisible(session, { view: 'candidate', candidateId: 'c1', detailTab: 'resume' }), true);
  assert.equal(recordingDockVisible(session, { view: 'candidates', candidateId: 'c1', detailTab: 'call' }), true);
  assert.equal(recordingDockVisible(session, { view: 'candidate', candidateId: 'c2', detailTab: 'call' }), true);
  assert.equal(recordingDockVisible(null, onCall), false);
  assert.equal(recordingStatusLabel(session, now), '正在录音 · 00:01:05');
  assert.equal(recordingStatusLabel({ ...session, phase: 'stopping', message: '正在上传录音 40%' }, now), '正在上传录音 40%');
  assert.equal(recordingStatusLabel({ ...session, phase: 'transcribing' }, now), '已停止，转写中');
  assert.equal(recordingStatusLabel({ ...session, phase: 'failed', message: '录音失败' }, now), '录音失败');
});
