export function formatRecordingClock(startedAt, now = Date.now()) {
  const started = Date.parse(startedAt || '');
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const hours = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function recordingOnCallPage(session, view = {}) {
  return Boolean(session && view.view === 'candidate' && view.candidateId === session.candidateId && view.detailTab === 'call');
}

export function recordingDockVisible(session, view = {}) {
  return Boolean(session && !recordingOnCallPage(session, view));
}

export function recordingStatusLabel(session, now = Date.now()) {
  if (!session) return '';
  const clock = formatRecordingClock(session.startedAt, now);
  if (session.phase === 'recording') return `正在录音 · ${clock}`;
  if (session.phase === 'stopping') return session.message || `正在停止 · ${clock}`;
  if (session.phase === 'transcribing') return '已停止，转写中';
  return session.message || '录音失败';
}
