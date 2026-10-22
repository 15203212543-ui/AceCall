// node-sdk 的 ICloudBaseConfig 没有 accessKey 字段，只有 secretId / secretKey。
// 云函数里写 accessKey 能用，是因为它跑在 CloudBase 内部、SDK 会自动读取平台
// 注入的临时凭证；worker 是外部进程，必须显式给密钥，否则每条数据库请求都会抛
// 「missing secretId or secretKey of tencent cloud」。
//
// 这组测试锁住两件事：
//   1. 缺密钥时报错要明确指出该配哪个变量，不能让人去看 SDK 的原始报错
//   2. 配了密钥要真的传给 init，而不是继续传那个没人读的 accessKey
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8');

test('worker no longer passes the unsupported accessKey option to the SDK', () => {
  assert.doesNotMatch(source, /accessKey\s*:/, 'node-sdk 不认 accessKey，传了也不会生效');
  assert.match(source, /secretId/, '必须把 secretId 传给 SDK');
  assert.match(source, /secretKey/, '必须把 secretKey 传给 SDK');
});

test('worker accepts both explicit and Tencent Cloud standard credential names', () => {
  assert.match(source, /CLOUDBASE_SECRET_ID/, '应支持明确命名的 CLOUDBASE_SECRET_ID');
  assert.match(source, /CLOUDBASE_SECRET_KEY/);
  assert.match(source, /TENCENTCLOUD_SECRETID/, '应兼容腾讯云官方环境变量名');
  assert.match(source, /TENCENTCLOUD_SECRETKEY/);
});

test('missing credentials produce an actionable message', () => {
  assert.match(source, /assertCloudbaseCredentials/, '缺少密钥时必须在发起请求前就拦住');
  const blocked = source.match(/缺少 CloudBase 密钥[\s\S]{0,200}/);
  assert.ok(blocked, '错误信息要说明缺什么');
  assert.match(blocked[0], /CLOUDBASE_SECRET_ID/, '错误信息要直接点出变量名');
  assert.match(blocked[0], /不是 CloudBase 的 API Key/, '要明确排除容易混淆的 API Key');
});

test('session token is optional and forwarded when present', () => {
  assert.match(source, /sessionToken/, '临时凭证场景需要 sessionToken');
  assert.match(source, /if\s*\(sessionToken\)/, 'sessionToken 应是可选项');
});

test('database and storage share one cached app instance', () => {
  assert.match(source, /function cloudbaseApp\(\)/, '应统一走 cloudbaseApp()，避免重复 init');
  assert.match(source, /if\s*\(!app\)/, '实例要缓存，不能每次请求重新鉴权');
});
