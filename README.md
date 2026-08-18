# AceCall

在线演示：<https://15203212543-ui.github.io/AceCall/>

AceCall 是面向金融招聘团队的 AI 电话初筛工作台。当前 MVP 聚焦可人工使用的工作流，不包含自动拨号或自动淘汰：

1. 输入岗位 JD、候选人简历和岗位规则。
2. 生成带证据、置信度和核验优先级的初筛方案及个性化问题。
3. 粘贴电话转写，对照初筛问题生成沟通总结。
4. 综合初筛方案与沟通总结，处理矛盾并生成审核建议。
5. 招聘人员核对、确认并导出结果。

## CloudBase 后端

AceCall 已接入 CloudBase 开发环境 `yuxiaomiaochongwu-d2dsk55ef4b392`，通过命名空间与原项目隔离：

- `acecall_jobs`：岗位资产、JD、关键词和初筛规则。
- `acecall_candidates`：候选人基本信息及简历解析结果。
- `acecall_screenings`：初筛方案、电话转写、沟通总结和审核报告。
- `acecall_audit_logs`：岗位及候选人数据修改记录。
- `acecall-api`：私有 HTTP 云函数，负责数据访问、简历解析和 DeepSeek 调用。

所有集合均为仅管理端访问，函数只允许已登录且非匿名用户调用。浏览器通过受保护的 CloudBase HTTP 网关访问后端，统一携带当前用户会话令牌；登录后系统优先读取 CloudBase，若远端为空则顺序迁移现有本地岗位和候选人数据。

客户端后端地址配置在 `public/config.js`：

```js
window.ACECALL_CONFIG = {
  apiBaseUrl: 'https://<cloudbase-http-domain>/acecall-api',
  cloudbase: {
    env: '<cloudbase-env-id>',
    region: 'ap-shanghai',
    publishableKey: '<browser-safe-publishable-key>'
  }
};
```

`Publishable Key` 可公开用于初始化浏览器 SDK，不具备管理权限。`CLOUDBASE_APIKEY` 和 `DEEPSEEK_API_KEY` 仍只能保存在云函数环境变量中。

函数配置位于 `cloudbaserc.json`，代码位于 `cloudfunctions/acecall-api/`。`CLOUDBASE_APIKEY`、`DEEPSEEK_API_KEY` 等密钥只允许通过函数环境变量注入，不得提交到 Git。AceCall 专用 CloudBase API Key 到期时间为 `2026-11-16`，到期前需要轮换并更新函数配置。

CloudBase 环境 ID 不可修改；环境别名可以修改，但当前环境仍承载原宠物项目，不建议将环境别名改为 AceCall。

## 第一阶段页面

- **工作台**：展示待电话、待确认、补充沟通和已推荐候选人。
- **候选人**：按岗位和状态管理候选人，直接显示下一步动作。
- **候选人详情**：通过概览、电话初筛、简历、历史记录四个页签完成工作。
- **岗位**：集中维护可复用的 JD、关键词和初筛规则。
- **设置**：展示 AI 服务模式及人工决策边界。

添加候选人后，系统自动生成电话准备；招聘人员完成电话记录后，一次生成沟通总结和综合结果，不再要求用户手动操作多层 AI 生成步骤。

## 推荐使用方式

AceCall 以“岗位资产”作为工作流入口：首次招聘某个岗位时，在左侧岗位资产库中选择行业并录入岗位名称、JD、关键词和初筛规则；后续同岗位候选人只需选择已保存岗位并输入简历。岗位更新只影响之后的新案例，历史案例始终保存当时使用的 JD、关键词和规则快照，便于复盘和审计。

建议由岗位招聘负责人维护岗位资产，普通招聘人员负责复用和提交改进建议。关键词用于聚焦简历匹配与问题生成，不应被当作自动淘汰规则。

候选人简历支持 PDF、DOCX、TXT 和 MD 文件，最大 10MB。系统在本地服务中提取文字并识别姓名、电话、邮箱、工作年限和学历等基础字段，提取文本始终允许招聘人员校对。扫描版 PDF 暂不包含 OCR，需要先转换为可检索文本。

## 本地运行

需要 Node.js 18 或更高版本。首次运行需要安装 PDF 和 DOCX 解析依赖：

```bash
npm install
cp .env.example .env
npm start
```

打开 `http://127.0.0.1:4173`。未设置 `OPENAI_API_KEY` 时，系统自动使用本地演示引擎，适合流程验证。

正式在线版需要先使用 CloudBase 用户名和密码登录。测试账号由 CloudBase 控制台的身份认证用户管理创建和激活，不在代码或 Git 中保存密码。

如需启用模型，在 `.env` 中配置：

```env
DEEPSEEK_API_KEY=your_key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/chat/completions
```

服务端优先使用DeepSeek；未配置DeepSeek时才检查OpenAI配置：

```env
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-5.6-terra
```

API Key 仅由 Node 服务读取，不会发送到浏览器。模型输出只作为辅助材料，所有推荐结论必须由招聘人员确认。

ChatGPT订阅和Codex会话不能直接作为AceCall的后端接口。正式接入需要单独的OpenAI API Key及API计费账户；Codex用于持续开发代码，AceCall通过服务端Responses API调用模型。

正式试点建议启用大模型。个性化问题生成、语义总结、前后矛盾识别及跨材料综合需要语义推理；本地演示模式只用于流程演示、界面验收和服务降级，不应用于正式候选人判断。

## 验证

```bash
npm test
```

## 当前边界

- 支持可检索文本型 PDF、DOCX、TXT 和 MD；扫描版 PDF 的 OCR 与录音转写留作下一阶段。
- 岗位、候选人和初筛结果已接入 CloudBase；浏览器 `localStorage` 仅作为离线副本和首次迁移来源。
- 不根据性别、婚育、年龄、籍贯等非岗位因素评分或淘汰。
- 正式试点前需完成录音告知、数据保存期限、删除机制与模型数据政策评审。
