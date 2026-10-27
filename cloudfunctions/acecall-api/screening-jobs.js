const SCREENING_RULES = '重点核实个人职责、项目上线结果、业务规模和团队分工。';

const SCREENING_JOBS = [
  {
    name: '法务BP',
    department: 'QS运营组',
    location: '',
    category: '职能类',
    industry: '证券',
    jdSource: 'moka',
    keywords: ['法律审核', '合同审核', '跨境法律', '工商登记', '用章管理', '证券从业资格', '法律职业资格', '英文合同'],
    jd: '【岗位职责】 1、业务法律支持：提供日常法律咨询，对业务方案、协议文本、制度文件进行法律审核，出具法律意见； 2、合同与文件审核：审核、起草公司日常经营及业务相关合同、协议及对外函件，确保条款符合法律要求与公司利益； 3、跨境/涉外法律事务：支持公司海外业务及跨境项目的法律需求，包括但不限于跨境交易文件审核、境外法律调研、与境外律师的协调对接； 4、主体维护:负责公司及下属主体(含境外主体)的设立、变更、注销、年检等工商登记及维护工作，确保主体资格合法有效； 5、用章管理:负责公司公章、合同章、法人章等印章的日常管理、用印审核与登记，规范用印流程，防范用印风险； 6、日常法务运营:完成合同归档及部门交办的其他法律事务。 【任职要求】 1、法律素养良好：法学/法律相关专业本科及以上学历，具备扎实的法律功底和良好的法律逻辑思维； 2、具备证券从业资格及法律职业资格者优先； 3、海外留学经验：有海外留学背景，熟悉普通法体系或国际法律实务者优先； 4、海外项目支持经验:有参与海外项目法律支持的实际经历，包括但不限于跨境合同审核、境外法律调研、与境外律师对接等； 5、英语可作为工作语言：能够独立审阅英文合同、与境外合作方进行书面及口头沟通； 6、工作经验：1-3年证券公司、律师事务所（金融/证券方向）或相关金融机构法务工作经验； 7、工作积极主动，有责任心：能够主动对接业务需求，对交办事项负责到底，具备良好的沟通协调能力与团队协作意识； 8、善于学习，自驱力强，适应快节奏的业务支持需求。'
  },
  {
    name: '交易产品经理',
    department: 'QS产品组',
    location: '深圳市',
    category: '产品类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['证券交易', '港美股', '订单', '交易时段', '下单', '风控', 'PRD', '交易规则'],
    jd: '岗位职责： 1、负责证券交易产品规划与迭代，覆盖港股、美股、A股的下单、改撤单、订单状态、成交回报和交易时段规则。 2、梳理交易链路中的产品规则，包括交易品种、订单类型、价格限制、交易日历、清算交收前置条件和异常订单处理。 3、对接行情、账户、风控、清结算和研发团队，推动交易需求从 PRD、原型到联调上线。 4、跟踪下单转化、失败原因和用户路径，持续优化交易体验与规则准确性。 任职要求： 1、本科及以上学历，有证券、券商或交易工具产品经验。 2、理解股票、ETF、期权等至少一类交易品种，以及港美股或 A 股交易规则。 3、能独立输出 PRD、流程和接口需求，并能与研发、测试、合规协作落地。'
  },
  {
    name: '清结算产品经理',
    department: 'QS产品组',
    location: '深圳市',
    category: '产品类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['清结算', 'CCASS', '交收', '对账', '公司行动', '资金划拨', '期权', '港股'],
    jd: '岗位职责： 1、负责证券清结算产品规划，覆盖港股 CCASS 交收、资金划拨、交易与持仓对账、公司行动入账。 2、梳理交收指令、资金流水、分红、拆合股、供股、代码变更等结算规则，并转化为可上线的产品流程。 3、对接结算运营、研发和合规，处理交收差异、保证金、行权指派和到期处理等异常场景。 4、关注结算时点的准确性、时效和可追踪性，推动对账与差异处理产品化。 任职要求： 1、本科及以上学历，有证券清结算、券商运营或相关产品经验。 2、了解港股结算规则，有期权清结算或 CCASS 相关经验优先。 3、能把结算操作抽象成规则、流程和系统需求。'
  },
  {
    name: '行情产品经理',
    department: 'QS产品组',
    location: '深圳市',
    category: '产品类',
    industry: '证券',
    jdSource: 'moka',
    keywords: ['证券行情', '港股', '美股', 'A股', 'K线', '盘口', 'Level 2', '复权'],
    jd: '1、负责证券行情产品的规划、设计与迭代，覆盖港股、美股、A股等市场行情能力，包括自选股、分时/K线、盘口、逐笔成交、市场榜单、资讯入口、提醒预警等模块。 2、梳理行情数据链路和产品规则，包括市场分类、交易时段、涨跌幅、复权、币种、停复牌、延时/实时行情、Level 1/Level 2 权限等。 3、对接行情供应商、交易所规则、研发、运营、合规及业务团队，推动行情接入、数据校验、异常处理、联调测试和上线验收。 4、持续优化行情体验和数据质量，关注刷新速度、稳定性、准确性、用户路径和转化效果。 5、结合交易、账户、资产、风控等业务场景，建设行情与交易链路的联动能力，提升用户看盘、决策和交易效率。 1、本科及以上学历，3年以上产品经理经验，有证券、金融、行情、交易、资讯或投资工具类产品经验优先。 2、熟悉股票、ETF、期权、基金等至少一类金融产品，对港美股或A股行情展示、交易时段、市场规则有基础理解。 3、具备较强的业务抽象和流程设计能力，能独立输出PRD、流程图、原型及接口需求。 4、对数据敏感，能通过数据分析定位产品问题，推动行情准确性、稳定性和用户体验优化。 5、具备良好的跨团队沟通推动能力，能协调研发、测试、运营、合规及外部供应商完成需求落地。 6、逻辑清晰、执行力强，对证券交易和投资工具产品有兴趣。'
  },
  {
    name: '账户产品经理',
    department: 'QS产品组',
    location: '深圳市',
    category: '产品类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['开户', '证券账户', '资金账户', '适当性', '权限', '实名认证', '港美股', '账户状态'],
    jd: '岗位职责： 1、负责证券账户产品规划，覆盖开户、实名认证、资料审核、资金账户、交易权限和账户状态变更。 2、梳理港美股及 A 股账户规则，包括适当性、风险披露、权限开通、冻结、销户和资料更新。 3、对接运营、合规、研发和客服，推动开户转化、审核时效和账户异常处理上线。 4、结合交易、入金和行情权限，设计账户与交易链路的衔接。 任职要求： 1、本科及以上学历，有券商、证券账户或金融产品经验。 2、理解开户审核、权限和适当性管理的基本规则。 3、能输出 PRD、流程和异常场景，并推动跨团队落地。'
  },
  {
    name: '数据分析师',
    department: 'QS运营组',
    location: '深圳市',
    category: '运营类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['SQL', '证券业务', '转化分析', '交易漏斗', '留存', '数据看板', '用户行为', '业务复盘'],
    jd: '岗位职责： 1、负责 QS 证券业务的数据分析，围绕开户、入金、行情访问、下单转化和留存建立指标与看板。 2、针对交易、账户、行情和运营活动做专题分析，定位转化流失和异常波动。 3、跟踪关键项目上线效果，输出可执行的业务复盘和改进建议。 4、与产品、运营和研发对齐口径，保证指标定义和数据结果可复核。 任职要求： 1、本科及以上学历，有互联网或金融数据分析经验。 2、能熟练使用 SQL，具备 Python 或看板工具经验优先。 3、能把证券业务问题拆成可验证的数据结论。'
  },
  {
    name: '券商服务端开发工程师（长沙）',
    department: 'QS服务端组',
    location: '长沙市',
    category: '技术类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['Golang', 'Java', 'MySQL', 'Redis', 'Kafka', '交易系统', '高并发', '长沙'],
    jd: '岗位职责： 1、负责券商服务端系统的方案设计与开发，覆盖交易、账户、行情接入或结算相关服务，工作地点为长沙。 2、处理高并发、低延迟场景下的稳定性问题，完成接口设计、编码、单元测试和上线支持。 3、与产品、测试、合规协作，把证券业务规则落实到服务端实现。 任职要求： 1、3 年以上后端开发经验，有证券、支付或交易系统经验优先。 2、熟练使用 Golang 或 Java，掌握 MySQL、Redis、Kafka。 3、能独立排查线上问题，并接受长沙办公。'
  },
  {
    name: '结算专员',
    department: '创新拓展线',
    location: '',
    category: '职能类',
    industry: '证券',
    jdSource: 'moka',
    keywords: ['CCASS', '港股交收', '资金划拨', '对账', '公司行动', '期权清结算', 'Excel'],
    jd: '岗位职责： 1、负责港股CCASS交收指示的录入、核对及执行，确保证券交收准确、及时完成 2、负责系统内客户及公司资金划拨操作，确保资金流转合规、准确 3、执行每日交易、资金、持仓等多维度对账工作，及时排查并处理差异 4、处理股票分红、拆合股、供股、更改股票代码等公司行动（Corporate Action），确保客户权益准确入账 任职要求： 1、本科及以上学历，金融、经济或相关专业背景，3年以上证券/互联网券商风控相关结算经验 2、熟悉CCASS交收流程及港股结算规则，有期权清结算实操经验（行权指派、保证金计算、到期处理）者优先 3、细心严谨，具备较强的数据敏感度及问题排查能力，能承受结算时点的工作压力 4、熟练使用Excel等办公软件，具备一定的英语读写能力 【加分项】有券商结算岗位实操经验或CCASS相关系统操作经验者优先'
  },
  {
    name: '券商客服主管',
    department: 'QS项目组',
    location: '长沙市',
    category: '运营类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['券商客服', '港美股', '开户咨询', '投诉处理', '团队管理', '长沙', '服务流程'],
    jd: '岗位职责： 1、负责券商客服团队的日常管理，覆盖开户咨询、交易与行情问题、入金出金和投诉升级。 2、制定港美股业务的服务话术、质检标准和升级流程，降低重复咨询和错误答复。 3、跟踪服务时效、一次解决率和投诉原因，推动产品与运营修复高频问题。 4、工作地点为长沙，需要带教客服专员并保障交易时段的服务稳定性。 任职要求： 1、有客服团队管理经验，有券商、证券或金融客户服务经验优先。 2、了解开户、交易、资金和行情权限的常见问题。 3、能处理投诉并推动跨团队闭环。'
  },
  {
    name: '证券设计师',
    department: 'QS项目组',
    location: '',
    category: '设计类',
    industry: '证券',
    jdSource: 'moka',
    keywords: ['UI', 'UX', '港美股', '移动端', '交互设计', '设计规范', 'C端'],
    jd: '岗位职责： 1. 负责公司海外金融产品（以港美股证券App为主）的移动端UI/UX设计，产出高质量界面与交互方案，保障用户体验一致性与产品易用性； 2. 主导产品视觉风格的探索与定义，参与新产品从0到1的设计搭建，并负责日常迭代中的设计优化与用户反馈跟进； 3. 结合业务目标，输出系统化、可落地的设计解决方案，协同推动项目高质量上线，持续完善产品设计规范与团队工作流程； 4. 主动进行设计总结与经验分享，助力团队能力提升与设计影响力建设。 任职要求： 1. 本科及以上学历，1年以上证券相关设计经验 2. 具备丰富的C端移动端产品视觉与交互设计经验，深入理解以用户为中心的设计理念，并能有效推动设计在产品中落地； 3. 具备国际化设计视野，熟悉西方用户审美习惯，对海外主流互联网产品有较深了解，有海外金融或港美股产品设计经验者优先； 4. 逻辑清晰，具备良好的创新意识与学习能力，关注设计趋势与行业动态，对体验设计方法论有系统理解并持续追求体验优化； 5. 具备出色的沟通表达能力和团队协作精神，对设计工作充满热情，责任心强，能适应高挑战的项目节奏。'
  },
  {
    name: '证券运维工程师',
    department: 'QS服务端组',
    location: '',
    category: '技术类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['Linux', '监控告警', '发布', '故障处理', '券商系统', '稳定性', '日志'],
    jd: '岗位职责： 1、负责证券业务服务的部署、监控、发布和故障处理，保障交易时段系统可用。 2、维护 Linux 环境、日志、告警和应用发布流程，定位服务中断、延迟升高和资源异常。 3、与研发配合完成变更窗口、回滚和容量检查，减少行情、交易和结算链路的线上风险。 任职要求： 1、有服务端运维或 SRE 经验，有金融、证券或高可用系统经验优先。 2、熟悉 Linux、监控告警、日志排查和发布流程。 3、能在交易时段独立响应故障。'
  },
  {
    name: '券商测试工程师',
    department: 'QS服务端组',
    location: '',
    category: '技术类',
    industry: '证券',
    jdSource: 'screening',
    keywords: ['测试用例', '接口测试', '回归测试', '交易链路', '证券业务', '缺陷跟踪'],
    jd: '岗位职责： 1、负责券商交易、账户、行情和结算相关需求的测试，覆盖功能、接口、回归和上线验证。 2、根据交易规则、账户权限和清结算时点设计用例，跟踪缺陷直到关闭。 3、参与联调，核对订单、成交、资金和行情数据的一致性。 任职要求： 1、有服务端或 App 测试经验，有证券、支付或交易系统测试经验优先。 2、能编写接口测试和回归用例，能读懂基本业务日志。 3、对交易时段的发布验证有责任心。'
  },
  {
    name: '券商业务后端开发工程师',
    department: 'QS服务端组',
    location: '',
    category: '技术类',
    industry: '证券',
    jdSource: 'moka',
    keywords: ['Golang', 'Java', 'MySQL', 'Redis', 'Kafka', '交易', '资产结算', '高并发'],
    jd: '岗位职责： 1、负责券商核心业务系统（如股票/期权交易、资产结算、账户管理、风控等模块）的后端方案设计、编码实现与单元测试 2、持续优化系统性能，解决高并发、低延迟下的技术挑战，确保系统的高可用性和稳定性，满足金融级业务要求 3、与产品、合规、业务团队紧密协作，深入理解券商业务逻辑与合规要求 4、负责解决系统中碰到的各类技术难点 任职要求： 1、具备3年以上后端开发经验，有证券、金融、支付、交易所等相关行业系统开发经验者优先 2、精通Golang或Java，具备扎实的编程基础和良好的代码规范 3、精通数据库设计，熟练掌握 MySQL 4、熟练掌握常用中间件，包括 Redis（缓存）、Kafka等 5、有大规模、高并发系统设计或调优经验者'
  }
];

function jobNameKey(name = '') {
  return String(name || '').toLowerCase().replace(/[\s\-_—·•（）()【】[\]：:·,，、_/]/g, '');
}

function screeningJobByName(name = '') {
  const key = jobNameKey(name);
  return SCREENING_JOBS.find(job => jobNameKey(job.name) === key) || null;
}

function applyScreeningProfile(job = {}) {
  const profile = screeningJobByName(job.name);
  if (!profile) return job;
  const keywords = Array.isArray(job.keywords) ? job.keywords.filter(Boolean) : [];
  return {
    ...job,
    industry: job.industry || profile.industry,
    department: job.department || profile.department,
    location: job.location || profile.location,
    category: job.category || profile.category,
    jd: String(job.jd || '').trim() || profile.jd,
    keywords: keywords.length ? keywords : profile.keywords,
    rules: job.rules || SCREENING_RULES
  };
}

function jobRichness(job = {}) {
  const jd = String(job.jd || '').trim().length;
  const keywords = Array.isArray(job.keywords) ? job.keywords.filter(Boolean).length : 0;
  return (jd > 0 ? 10000 + Math.min(jd, 2000) : 0) + keywords * 20 + (job.status !== 'closed' ? 5 : 0) + (job.department ? 1 : 0);
}

function dedupeStoredJobs(jobs = []) {
  const map = new Map();
  for (const job of jobs) {
    const key = jobNameKey(job.name);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || jobRichness(job) > jobRichness(existing)) map.set(key, job);
  }
  return [...map.values()];
}

function isAutomaticAssignmentJob(job = {}) {
  if (!job.id || job.status === 'closed' || job.status === 'archived') return false;
  if (job.source === 'screening') return false;
  // Historical Moka interview/application records are not evidence that a
  // requisition is currently open. Only a job confirmed by the current Moka
  // job feed may enter the automatic assignment pool.
  if (job.source === 'moka') return job.mokaCurrent === true && Boolean(job.mokaJobId);
  // Explicitly maintained active workspace jobs remain a safe fallback while
  // the tenant's Moka job-list endpoint is unavailable.
  return true;
}

function automaticAssignmentJobs(jobs = []) {
  return dedupeStoredJobs(jobs).filter(isAutomaticAssignmentJob);
}

module.exports = {
  SCREENING_JOBS,
  SCREENING_RULES,
  jobNameKey,
  screeningJobByName,
  applyScreeningProfile,
  jobRichness,
  dedupeStoredJobs,
  isAutomaticAssignmentJob,
  automaticAssignmentJobs
};
