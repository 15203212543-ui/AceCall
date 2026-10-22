# AceCall AI 基础能力重构：技术设计

## 1. 总体架构

```text
原始文件/录音
  -> 私有云存储与文档解析
  -> 原文 + 清洗文 + 行号/段落
  -> 规则抽取 + AI 语义归纳
  -> Schema 校验 + 程序化证据核验
  -> 人工确认/冲突裁决
  -> 岗位口径匹配
  -> 电话/面试问答与总结
  -> 审核草稿
  -> 人工确认后 Moka 幂等写入
```

流程层：文件解析、事实抽取、事实核验、业务分析、输出。

存储层：

- `document`：单份文件，原文/清洗文/解析元数据/文档提取候选。
- `profile`：候选人跨文档当前生效值、冲突和人工修正。
- `matching`：候选人 × 岗位的逐条判定和规则快照。

## 2. 数据模型

### `acecall_documents`

```js
{
  _id, tenantId, workspaceId, uploadedBy, retentionUntil,
  storageFileId, fileName, mimeType, size, sha256,
  rawText, cleanedText, parseStatus, parseVersion,
  pageOrLineMap, extractions: [], createdAt, updatedAt
}
```

PDF、Word、音频等二进制只存云存储；超长转写应拆到 `acecall_transcripts` 或分段文档，不把大文本无限塞进单个候选人文档。

### `acecall_candidate_facts`

```js
{
  _id, tenantId, workspaceId, candidateId,
  factType, layer: 'profile' | 'document' | 'matching', value,
  status: 'confirmed' | 'pending' | 'conflict' | 'rejected',
  confidence, confidenceBasis, extractedBy,
  evidences: [{
    documentId, sourceType, sourceRef, quote, quoteVersion,
    verified: 'exact' | 'fuzzy' | 'failed'
  }],
  conflicts: [], revisions: [], locked,
  confirmedBy, confirmedAt, version, createdBy, updatedBy,
  retentionUntil, createdAt, updatedAt
}
```

置信度由来源规则推导，不由模型自报：`explicit_field 0.95`、`exact_quote 0.90`、`moka_record 0.90`、`filename_pattern 0.70`、`layout_inference 0.60`、`context_inference 0.45`、`model_inference 0.40`、`ocr_text <=0.30 且 pending`。

### `acecall_job_profiles`

保存岗位规则版本：必备、加分、待核验、排除、同义词、行业词、关键词、人工规则。每次匹配保存规则快照。

### `acecall_ai_tasks`

保存任务状态、类型、输入哈希、Prompt 版本、模型、耗时、token、重试次数、错误和输出引用。Prompt 文件由 Git 管理，数据库只保存版本号。

### 后续集合

`acecall_matching_results`、`acecall_transcripts`、`acecall_interview_questions`、`acecall_review_decisions`、`acecall_industry_signals`。

所有核心集合带 `tenantId/workspaceId/createdBy/updatedBy/retentionUntil`。

## 3. 关键业务规则

### 姓名与基础字段

规则提取姓名候选、电话、邮箱、日期、学历、公司名和行号；模型只能在规则候选范围内排序和归纳。年龄不参与匹配和淘汰，除非原文明确出现且仅作合规字段。

### 岗位匹配决策表

```text
1. 命中排除条件 -> 无法匹配
2. 必备项全部 confirmed 命中 -> 自动匹配
3. 必备项 pending 超阈值 -> 待确认
4. 必备项未发现/冲突超阈值 -> 无法匹配或待确认
5. 多岗位同时通过 -> 多岗位候选
6. 加分项只用于排序展示，不决定淘汰
```

网页、桌面助手和批量导入必须调用同一份匹配函数；禁止 `jobs[0]` 兜底。

### 证据核验

先做归一化包含匹配，失败后做有限模糊匹配；仍失败则 `verified=failed`、事实 `pending`。不得再次调用模型做证据核验。

### 转写与长音频

复用现有分片上传协议。任务状态至少包括 `queued/running/succeeded/failed`，worker 引擎通过适配器替换，支持百度长音频、Whisper、FunASR。支持候选人、面试官 A/B、未识别说话人。

### Moka 备注

先生成 AceCall 内部草稿，人工确认后使用 `reviewDecisionId` 幂等写入；重复请求不能重复添加备注。

## 4. 权限与隐私

- 身份：`uid`。
- 租户：`tenantId`。
- 业务范围：资源归属、角色、岗位/工作区权限。
- 统一使用 `scopedDoc(collection, id, ctx)` 之类的数据访问助手，不在路由内分散实现。
- 跨租户资源统一返回 404。
- 限流按 `tenantId + route`。
- 桌面助手使用登录后短期会话令牌，优先存系统凭据库，不使用长期环境令牌作为正常路径。
- 录音保存告知、同意、操作人和时间；拒绝时允许手工记录。
- 每日清理任务先删云存储，再删除 PII 和正文；审计日志去标识化保留。支持 `legalHold`、`deletionRequested` 和重试。

## 5. 迁移策略

1. 新数据双写：文档进入 `acecall_documents`，候选人只引用 `documentId`，旧 `resume` 暂时兼容保留。
2. 历史回填：按批次将旧 `resume` 建为文档，标记 `legacy-migrated`。
3. 停止全量返回：列表只返回摘要和 documentId，详情按权限加载正文。
4. 验证无读取方依赖后，再清除旧候选人正文。

## 6. 测试策略

- 单元测试：姓名候选、文本归一化、证据核验、匹配决策、冲突合并、幂等写入。
- 集成测试：权限、租户隔离、分片上传、worker 状态轮询、Moka 草稿/写入。
- 回归测试：dev set 可调试，held-out 只在阶段验收运行。
- 安全测试：未登录、跨租户、角色越权、过期 token、重复提交、日志脱敏。
