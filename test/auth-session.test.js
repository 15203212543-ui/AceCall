const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isAnonymousAccessToken, isAnonymousSession } = require('../public/auth-session.js');

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `e30.${body}.sig`;
}

const anonymousPublishableToken = jwt({
  iss: 'https://example.ap-shanghai.tcb-api.tencentcloudapi.com',
  scope: 'anonymous',
  sub: 'anon',
  name: 'Anonymous'
});

test('treats a publishable-key token as anonymous', () => {
  assert.equal(isAnonymousAccessToken(anonymousPublishableToken), true);
  assert.equal(isAnonymousSession({ access_token: anonymousPublishableToken, user: { email: 'person@example.com' } }), true);
});

test('treats a subject of anon without an email as anonymous', () => {
  assert.equal(isAnonymousAccessToken(jwt({ sub: 'anon' })), true);
  assert.equal(isAnonymousSession({ user: { sub: 'anon' } }), true);
  assert.equal(isAnonymousSession({ user: { isAnonymous: true, email: 'person@example.com' } }), true);
});

test('accepts a real user token that has an email and a non-anonymous subject', () => {
  const token = jwt({ sub: '2112437098387611648', email: 'person@example.com', scope: 'authenticated' });
  assert.equal(isAnonymousAccessToken(token), false);
  assert.equal(isAnonymousSession({
    access_token: token,
    user: { id: '2112437098387611648', email: 'person@example.com', sub: '2112437098387611648' }
  }), false);
  assert.equal(isAnonymousAccessToken(''), false);
  assert.equal(isAnonymousAccessToken('not-a-jwt'), false);
  assert.equal(isAnonymousSession(null), false);
});

test('the page blocks anonymous sessions before calling the workspace API', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app-v2.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(app, /isAnonymousSession\(data\.session\)/);
  assert.match(app, /beginRealSession\(/);
  assert.match(app, /isAnonymousAccessToken\(token\)/);
  assert.match(app, /if \(workspaceReady === false\) return/);
  assert.match(app, /error\.authRequired/);
  assert.doesNotMatch(app, /工作区初始化失败/);
  const authScript = html.indexOf('./auth-session.js?v=__ACE_CALL_BUILD__');
  const appScript = html.indexOf('./app-v2.js?v=__ACE_CALL_BUILD__');
  assert.ok(authScript > 0 && appScript > authScript, 'auth-session.js 必须先于 app-v2.js 加载，并继续使用构建版本号');
});
