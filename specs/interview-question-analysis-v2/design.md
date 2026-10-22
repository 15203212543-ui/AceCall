# 面试问题识别与面试官分析升级设计

## 1. 系统分层

```text
转写原文
  -> 说话人/段落切分
  -> 沟通确认规则过滤
  -> 条件核验规则识别
  -> 岗位问题候选识别
  -> AI 边界句归类
  -> 上下文合并与去重
  -> 岗位口径覆盖分析
  -> 页面展示与面试官分析
```

规则、模型和程序职责：

- 规则：过滤固定话术，识别条件关键词和明显问句，成本低且可测试。
- AI：处理上下文、语义和岗位关联的边界分类。
- 程序：枚举校验、原文证据校验、场次门槛、去重、状态流转。
- 人工：确认待判断句、调整岗位规则和最终使用结论。

## 2. 转写预处理

每个问题候选保存：

```js
{
  id,
  transcriptId,
  interviewerId,
  candidateId,
  jobId,
  rawText,
  normalizedText,
  speaker: 'interviewer' | 'candidate' | 'unknown',
  timestamp,
  contextBefore: [],
  contextAfter: [],
  sourceRef,
  classification,
  classificationSource: 'rule' | 'ai' | 'human',
  confidenceBasis,
  evidenceVerified,
  reviewStatus
}
```

不应只依赖“句末问号”。需要支持跨行问句、无问号口语问句、连续追问和问答段落。

## 3. 规则分类器

### 3.1 沟通确认词表

维护可版本化的规则配置，初始包含：

```text
听见、听得到、信号、方便说话、稍等、等一下、开始录制、录音、共享屏幕、看到吗、能看到吗、我们开始、可以开始了吗
```

规则输出：`communication_check`。支持正则、关键词和短语模板；规则命中后不调用 AI。

### 3.2 条件核验识别

按条件类型输出：

```text
location / availability / salary / non_compete / work_mode / travel / shift
```

识别依据包含关键词、岗位规则和 JD。规则输出必须保留原句，不把候选人的回答误算为面试官问题。

### 3.3 岗位问题候选

候选条件：

- 说话人是面试官或招聘人员
- 出现经历、项目、职责、结果、方法、判断、专业术语等岗位相关词
- 有问句、追问模式或疑问语气
- 与当前岗位口径存在至少一个可关联点

岗位问题候选先进入 `job_question_candidate`，最终是否进入高频问题由后续分类决定。

## 4. AI 边界分类

### 输入

- 当前候选句
- 前后 1 至 3 个问答段
- 当前岗位名称
- JD 摘要
- 岗位规则和条件核验项
- 已有问题分类示例

### 输出 Schema

```json
{
  "classification": "communication_check|condition_check|job_question|needs_context",
  "conditionType": "location|availability|salary|non_compete|work_mode|travel|shift|null",
  "jobCriteriaId": "string|null",
  "normalizedQuestion": "string|null",
  "evidenceQuote": "string",
  "mergeWithPrevious": true,
  "reasonCode": "string"
}
```

硬约束：

- `classification` 只能是枚举值。
- `evidenceQuote` 必须能在输入转写文本中程序化找到。
- `normalizedQuestion` 不能引入原句没有的事实。
- AI 不得生成未实际出现的问题。
- 无法归类时必须返回 `needs_context`。

## 5. 上下文合并与去重

- 对“也是你们自己做吗？”等短句，先尝试与前一个面试官问题合并。
- 合并后保留原始句和合并后的问点。
- 如果找不到明确前置问题，分类为 `needs_context`。
- 同一场次同一问点只保留一条；跨场次按标准化问题和岗位准则去重。
- 去重不得删除来源场次列表。

## 6. 面试官分析门槛

### 少于 5 场有效转写

展示：

- 高频候选问题，但标记“未经 AI 归类”
- 条件核验列表
- 已过滤的沟通确认数量
- 原始问题和来源场次

不展示：

- 提问偏好
- 追问方式结论
- 通过率、覆盖率等个人比率
- 面试官个人评价

### 不少于 5 场有效转写且岗位已绑定

允许展示：

- 岗位问题高频项
- 条件核验覆盖
- 岗位必备项覆盖
- 追问方式描述
- 可补充核验项

每条分析必须回溯到场次、原句和岗位准则。

## 7. 页面设计

当前“面试问题与偏好”区域调整为三段：

### 高频岗位问题

只展示 `job_question`。问题标签显示标准化问法，点击可查看原句、场次、岗位准则和证据。

### 条件核验

展示地点、到岗、薪资、竞业、办公方式等，标明“岗位要求”“通用核验”或“待关联”。

### 待判断

展示缺少上下文、无法确认岗位关联或 AI 未通过校验的句子。提供人工“归入岗位问题”“归入条件核验”“保留待判断”操作。

区域底部显示：`已排除 N 条通话确认`。当 N 为 0 时不显示，避免干扰。

## 8. 测试策略

- 单元测试：沟通确认、条件核验、岗位问题、上下文合并、去重、原文证据匹配。
- 边界样本：无问号问句、跨行问句、中英文混排、多个面试官、无岗位绑定、短句追问、JD 未提地点。
- AI 输出测试：非法枚举、虚构问题、证据不存在、条件类型错误、超长输出。
- 小样本测试：1、2、4、5、6 场转写分别验证展示边界。
- 回归测试：确保“你好，可以听见吗？”不会出现在高频岗位问题中。
