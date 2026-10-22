# 共享文件改动规则

本仓库的 `public/` 下有几个人同时在改的文件。为防止「本地旧副本覆盖别人刚写的代码」，
项目加了两道门禁。本文说明它们的确切行为，以及绕不过去时必须怎么做。

---

## 第一道：main 是受保护分支

**不能直接 `git push origin main`**，会得到：

```
! [remote rejected] main -> main (protected branch hook declined)
```

所有改动必须走分支 + Pull Request。这是 2026-10-22 起的新约束，之前直推 main 会成功。

---

## 第二道：PR 上的覆盖检查

工作流：`.github/workflows/protect-shared-edits.yml`，只对 `pull_request → main` 触发。
实现在 `scripts/protect-shared-edits.js`，测试在 `test/protect-shared-edits.test.js`。

### 受监控的文件

```
public/app-v2.js
public/styles-v2.css
public/index.html
public/interviewer-page.js
public/interviewer.css
public/auth-session.js
```

改其他文件（含 `cloudfunctions/`、`workers/`、`scripts/`）不受此检查约束。

### 判定规则一：删掉别人最近的代码 ≥ 80 行

- 统计本次 diff 里**被删除**的行，必须是该文件该行在 `base` 上由**别人**写的
- 「别人」= 不是本次 PR（`base..head` 之间提交的作者）也不是触发者
- 只统计最近 **21 天**内的行（`RECENT_DAYS = 21`）
- 只统计长度 ≥ 15 字符的行（`MIN_LINE_LENGTH = 15`），空行和短括号不计
- 阈值 **80 行**（`THRESHOLD = 80`）
- 跨文件移动不算删除：先按规范化文本做多重集抵消（`droppedLines`），
  把一段代码整体挪到另一个文件不会误判

≥ 80 行就失败，并打印「哪个文件 · 哪个作者 · 多少行」。

### 判定规则二：接线被破坏（与行数无关，0 行也拦）

`wiringProblems()` 检查三件事，任何一条不满足都直接失败：

1. `index.html` 必须加载 `./interviewer.css?v=__ACE_CALL_BUILD__`
2. `index.html` 里 `styles-v2.css` 和 `app-v2.js` 的版本必须是占位符
   `?v=__ACE_CALL_BUILD__`，**不能写成固定的 sha**
3. `app-v2.js` 必须从独立文件加载面试官分析：
   `from './interviewer-page.js?v=__ACE_CALL_BUILD__'`

第 2 条尤其重要。版本占位符是缓存失效的唯一手段，写死 sha 会让 CI 的 `sed` 空转，
所有前端改动都因浏览器缓存（`max-age=600`）而不生效。

### 逃生口：写明「版式调整」

如果确实是确认过的大改版，需要在 PR 标题、PR 说明、或提交信息里包含
**「版式调整」** 这四个字，脚本会跳过规则一（行数检查），但**规则二仍然生效**。

```bash
git commit -m "重排面试官分析页，版式调整"
```

注意 `hasOverride()` 是全文包含匹配，随手写进说明里也会触发，不要滥用在普通改动上。

---

## 本地自查（推 PR 前跑一遍）

```bash
BASE_SHA=$(git rev-parse origin/main) \
HEAD_SHA=$(git rev-parse HEAD) \
ACTOR="你的 GitHub 用户名" \
PR_TITLE="提交标题" \
node scripts/protect-shared-edits.js
```

通过时输出：

```
覆盖检查通过。别人最近的代码被删除 N 行，未达到 80 行。
```

---

## 已知缺口（这份规则拦不住的）

1. **没有测试门禁。** CI 里只有 `protect-shared-edits.js` 和 Pages 部署，**不跑 `node --test`**。
   2026-10-22 的 PR #1 就带着一个失败的测试合进了 main
   （`the page blocks anonymous sessions before calling the workspace API`），
   说明「结构没被覆盖」不等于「功能没被改坏」。合入前请自己跑 `node --test`。
2. **`public/config.js` 不在监控列表里。** 它决定 `apiBaseUrl` 指向哪条 API 路由，
   改错了会全站失败，但删除它的行不计入 80 行统计。同时它的版本号曾长期写死为
   `?v=ca6d5d55`（正好是改坏路由那次提交），改了内容也不会让缓存失效。
3. **规则二不检查 `auth-session.js` 是否被真正引用。** PR #1 建了这个文件并写了测试，
   但 `index.html` 没加载它、`app-v2.js` 也没引用，等于死代码。
4. **规则一只看「删除」，不看「语义倒退」。** 把一行复杂的校验换成一行简化版
   （删 1 行加 1 行）不会触发任何检查。

## 建议补的一条 CI 步骤

把测试加进 PR 门禁，可以直接堵住缺口 1：

```yaml
      - name: Install dependencies
        run: |
          npm install
          npm install --prefix cloudfunctions/acecall-api
      - name: Run tests
        run: node --test
```
