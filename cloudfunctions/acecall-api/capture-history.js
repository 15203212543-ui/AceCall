function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function actorFromMember(member = {}, uid = '') {
  const email = normalizeEmail(member.email) || normalizeEmail(member.username);
  const username = String(member.username || '').trim();
  const name = String(member.displayName || (email ? email.split('@')[0] : username)).replace(/\s+/g, ' ').trim().slice(0, 80);
  return { uid: String(uid || member.uid || ''), name, email };
}

function hasResume(record) {
  if (!record || typeof record !== 'object') return false;
  return Boolean(record.resumeMeta?.originalFileId || record.resumeMeta?.fileName || String(record.resume || '').trim());
}

function rememberCapture(existing, incoming, actor, now) {
  const previous = existing?.capturedBy;
  if (previous && (previous.uid || previous.name || previous.email)) {
    return {
      capturedBy: {
        uid: String(previous.uid || ''),
        name: String(previous.name || '').slice(0, 80),
        email: normalizeEmail(previous.email)
      },
      capturedAt: existing.capturedAt || existing.createdAt || now
    };
  }
  if (hasResume(existing) || !hasResume(incoming)) return { capturedBy: null, capturedAt: '' };
  return {
    capturedBy: {
      uid: String(actor?.uid || ''),
      name: String(actor?.name || '').slice(0, 80),
      email: normalizeEmail(actor?.email)
    },
    capturedAt: now
  };
}

function attributeMokaOperator(result, actor, operatorEmail) {
  if (!result) return result;
  if (result.status === '草稿' || result.status === '未配置') return result;
  return {
    ...result,
    operatorName: String(actor?.name || '').slice(0, 80),
    operatorEmail: normalizeEmail(operatorEmail),
    operatorUid: String(actor?.uid || '')
  };
}

module.exports = { actorFromMember, rememberCapture, attributeMokaOperator, hasResume };
