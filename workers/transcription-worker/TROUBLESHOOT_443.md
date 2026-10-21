# 网关 443 故障处置

前端所有接口返回 `443 (Unknown)`，响应体为空。本文是完整的处置步骤。

---

## 这不是后端故障

443 不是标准 HTTP 状态码，浏览器会显示成 `status of 443 (Unknown)`，极容易被误判成「服务挂了」。
实际含义是 **CloudBase HTTP 网关拒绝了请求携带的凭据**。

响应特征（可用来确认）：

```
HTTP/1.1 443 Unknown
content-length: 0                        ← 响应体完全为空
server: tcbgw
x-cloudbase-upstream-status-code: 443
```

对照其他两种失败：

| 状态码 | 响应体 | 含义 |
|---|---|---|
| 401 | `{"code":"MISSING_CREDENTIALS"}` | 完全没带凭据 |
| 401 | `{"code":"INVALID_CREDENTIALS"}` | 凭据格式非法 |
| **443** | **空** | 凭据格式合法，但**网关不接受这个身份** |

---

## 第一步：确认前端代码版本（最容易忽略）

**先看报错里的 `?v=` 是否等于最新 commit sha。**

```bash
git rev-parse HEAD
curl -s https://15203212543-ui.github.io/AceCall/ | grep -oE 'app-v2\.js\?v=[a-z0-9]*'
```

两个值必须一致。不一致就是**浏览器或 CDN 缓存了旧文件**，此时后面所有排查都是白费：

- `index.html` 和 `app-v2.js` 都是 `Cache-Control: max-age=600`
- 若 `index.html` 里的版本号是写死的 sha（而不是 `__ACE_CALL_BUILD__` 占位符），
  CI 的 `sed` 会空转，版本号永远不变 → 浏览器永远拿缓存
- 处理：确认 `public/index.html` 里是 `?v=__ACE_CALL_BUILD__`，然后 **Ctrl+Shift+R** 硬刷新

---

## 第二步：判断是匿名身份还是真实身份被拒

在浏览器 Console 里执行（页面已加载后）：

```js
const s = await window.cloudbaseAuth?.getSession?.();
const t = s?.data?.session?.access_token;
if (!t) { console.log('没有 session'); }
else {
  const p = JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
  console.log('scope =', p.scope, '| sub =', p.sub, '| email =', p.email || '(无)');
  console.log('过期时间 =', new Date(p.exp * 1000).toLocaleString());
}
```

判读：

| 输出 | 结论 | 处理 |
|---|---|---|
| `scope = anonymous` / `sub = anon` | **匿名身份**，网关必然拒绝 | 退出登录，用邮箱密码重新登录 |
| `sub = <真实 uid>`、有 email | 真实身份 | 看是否已过期 → 走第四步 |
| `过期时间` 早于当前时间 | token 过期 | 重新登录 |
| 没有 session | 未登录 | 登录 |

> 匿名会话的来源：`cloudbase.init({ accessKey: publishableKey })` 里的 `publishableKey`
> 本身就是匿名凭据（JWT `scope: anonymous`）。登录态丢失后 SDK 会自动生成匿名会话，
> 于是所有请求都带匿名 token → 全站 443。

复现命令（不用浏览器也能证明这一点）：

```bash
KEY=$(curl -s https://15203212543-ui.github.io/AceCall/config.js | grep -o "publishableKey: '[^']*'" | sed "s/publishableKey: '//;s/'$//")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" \
  "https://yuxiaomiaochongwu-d2dsk55ef4b392-1382810550.ap-shanghai.app.tcloudbase.com/acecall-api-v2/api/health"
# 输出 443
```

---

## 第三步（根治）：关闭网关的身份认证

如果重新登录后仍 443，或希望彻底摆脱这个坑，**关掉 `acecall-api-v2` 路由的网关身份认证**。

### 为什么这样是安全的

云函数自己会校验 token，不依赖网关。`readGatewayUser()` 有完整的三级兜底：

1. 读网关注入的 `x-cloudbase-context` 等 header
2. 读 `x-cloudbase-uid` 等标量 header
3. **自己拿 `Authorization` 头去问 CloudBase Auth**：
   `GET https://<envId>.api.tcloudbasegateway.com/auth/v1/token/introspect`

实测该端点可用，返回：

```json
{"token_type":"Bearer","client_id":"yuxiaomiaochongwu-d2dsk55ef4b392","sub":"anon","scope":"anonymous"}
```

而 `findIdentity()` 会把 `sub === 'anon'` 或 `scope` 含 `anonymous` 标记为 `isAnonymous: true`，
`getRequestContext()` 随即返回 **401「请先登录后使用业务功能」**。

所以关闭网关认证后：

| 请求情况 | 结果 |
|---|---|
| 不带 token | 401（`uid` 为空） |
| 匿名 token | 401（`isAnonymous` 为真） |
| 真实用户 token | ✅ 放行，`tenantId` 隔离照常生效 |

**鉴权没有变弱，只是从网关提前拦截改成了函数内部拦截。**

### 操作步骤

1. 打开 [云开发控制台](https://tcb.cloud.tencent.com/dev) → 选择环境 `yuxiaomiaochongwu-d2dsk55ef4b392`
2. 左侧「环境配置」→「HTTP 访问服务」（或「HTTP 网关」）
3. 找到 `acecall-api-v2` 这条路由
4. 关闭「**身份认证**」开关
5. 保存

关闭后验证：

```bash
B="https://yuxiaomiaochongwu-d2dsk55ef4b392-1382810550.ap-shanghai.app.tcloudbase.com"
KEY=$(curl -s https://15203212543-ui.github.io/AceCall/config.js | grep -o "publishableKey: '[^']*'" | sed "s/publishableKey: '//;s/'$//")

# 匿名 token：期望 401（不是 443）
curl -s -w "\n%{http_code}\n" -H "Authorization: Bearer $KEY" "$B/acecall-api-v2/api/health"
```

期望看到 `{"error":"请先登录后使用业务功能"}` + `401`。看到这个就说明网关不再拦、函数自己在管了。

> 注意：**不要关 `acecall-api` 那条路由的配置来"换路由"**。那条路由不透传子路径，
> 所有带 `/api/xxx` 的请求会在网关层直接 404。

---

## 第四步：如果真实身份仍被拒

说明 token 本身有问题，按顺序检查：

1. **环境 ID 一致性**：`public/config.js` 的 `env`、`apiBaseUrl` 里的环境、云函数部署的环境，
   三者必须都是同一环境。跨环境的 token 一定验不过。
2. **publishableKey 是否被轮换**：控制台 → 环境配置 → 登录授权 → Web 端密钥。
   重生成后要同步更新 `public/config.js`。
3. **网关的认证方式配置**：部分网关版本要求特定的头（如自定义 `X-AceCall-Token`）。
   前端已同时发 `Authorization` 和 `X-AceCall-Token`，两者都是 `Bearer <token>`。

如果以上都对，最实际的出路仍是**第三步**（关闭网关认证，交给函数校验）。

---

## 附：前端已做的防护

`public/app-v2.js`：

- `isAnonymousSession()` / `isAnonymousToken()`：解析 JWT 的 `scope`/`sub` 判断匿名
- `initializeAuth()`：识别到匿名会话不进入工作台，直接要求登录
- `authenticatedFetch()`：**发请求前**就拦截匿名 token，不再制造无意义的 443
- 443 分支：先 `refreshSession()` 重试一次，仍失败则提示重新登录，
  并在 Console 打印 token 的 `scope`/`sub`/`aud`/`iss`/`exp` 便于定位

> ⚠️ 这些改动都在 `app-v2.js`，而该文件会被同事整文件重写。若报错文案又变回
> 「CloudBase网关或认证服务暂时不可用」，说明防护被覆盖，需要重新补。
