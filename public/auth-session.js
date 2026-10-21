// 判断浏览器里的 CloudBase 会话是不是匿名身份。
// publishable key 会让 SDK 自动得到 scope=anonymous、sub=anon 的令牌，
// 网关会直接拒绝这种令牌。这里只看声明，不校验签名。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AceCallAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function decodeJwtPayload(token) {
    try {
      const part = String(token || '').split('.')[1];
      if (!part) return null;
      const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      return JSON.parse(decodeURIComponent(escape(atob(padded))));
    } catch {
      return null;
    }
  }

  function claimsLookAnonymous(value) {
    if (!value || typeof value !== 'object') return false;
    const scope = String(value.scope || '').toLowerCase();
    if (scope === 'anonymous') return true;
    if (value.is_anonymous === true || value.isAnonymous === true) return true;
    const sub = String(value.sub || '').toLowerCase();
    const email = String(value.email || '').trim();
    return sub === 'anon' && !email;
  }

  function isAnonymousAccessToken(token) {
    return claimsLookAnonymous(decodeJwtPayload(token));
  }

  function isAnonymousSession(session) {
    if (!session || typeof session !== 'object') return false;
    const user = session.user || {};
    const metadata = user.user_metadata || {};
    if (claimsLookAnonymous(user) || claimsLookAnonymous(metadata)) return true;
    if (session.access_token) return isAnonymousAccessToken(session.access_token);
    return false;
  }

  return { decodeJwtPayload, isAnonymousAccessToken, isAnonymousSession };
});
