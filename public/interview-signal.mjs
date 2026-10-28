const COMMUNICATION = /听[见清得到]|听得到|听得见|信号|方便说话|方便沟通|现在方便|稍等|等一下|录音|在录|录制|共享屏幕|看到屏幕|自我介绍|介绍一下你自己|你好/;
const JOB = /负责|职责|项目|结果|指标|上线|经验|下单|订单|委托|成交|交易|资金|持仓|结算|清算|风控|报价|期权|衍生品|FIX|开户|行情|银行卡|入金|出金|证券|港股|美股/;
const CONDITION = /人在哪|哪里|工作地点|工作城市|到岗|入职时间|薪资|工资|薪水|待遇|年薪|月薪|竞业|远程|出差/;
const QUESTION = /[？?]|(?:吗|呢|什么|怎么|如何|为什么|为何|是否|有没有|能不能)$/;
const FOLLOW = /为什么|为何|结果|怎么衡量|具体负责|个人负责|原因|规模|上线/;

function bodyOf(line) {
  return String(line || '').replace(/^(?:面试官|候选人|Interviewer|Candidate)[：:]\s*/i, '').trim();
}

function speakerOf(line) {
  if (/^(?:候选人|Candidate)/i.test(line)) return 'candidate';
  if (/^(?:面试官|Interviewer)/i.test(line)) return 'interviewer';
  return '';
}

export function analyzeTranscript(text = '') {
  let questions = 0;
  let followUps = 0;
  let seenAnswer = false;
  for (const line of String(text || '').split(/\n+/)) {
    const raw = line.trim();
    if (!raw) continue;
    const speaker = speakerOf(raw);
    const body = bodyOf(raw);
    if (speaker === 'candidate') {
      if (body.length >= 6) seenAnswer = true;
      continue;
    }
    if (COMMUNICATION.test(body) && !JOB.test(body) && !CONDITION.test(body)) continue;
    const asking = QUESTION.test(body) && (JOB.test(body) || CONDITION.test(body));
    if (!asking) {
      if (body.length >= 6) seenAnswer = true;
      continue;
    }
    questions += 1;
    if (seenAnswer && FOLLOW.test(body)) followUps += 1;
    seenAnswer = false;
  }
  return { questions, followUps };
}

function evaluated(item = {}) {
  return item.interviewPassed === true || item.interviewRejected === true || item.hired === true || item.offerAccepted === true || item.outcomeStatus === 'passed' || item.outcomeStatus === 'rejected' || Boolean(String(item.outcome || '').trim());
}

export function scoreInterviewSelection(records = [], filters = {}) {
  const completed = records.filter(item => item.completed !== false);
  const transcribed = completed.filter(item => String(item.transcript || '').trim().length >= 16);
  let questionTotal = 0;
  let followTotal = 0;
  let covered = 0;
  for (const item of transcribed) {
    const signal = analyzeTranscript(item.transcript);
    questionTotal += signal.questions;
    followTotal += signal.followUps;
    if (signal.questions > 0) covered += 1;
  }
  const evaluatedCount = completed.filter(evaluated).length;
  const completeness = completed.length ? Math.round(evaluatedCount / completed.length * 100) : 0;
  const coverage = transcribed.length ? Math.round(covered / transcribed.length * 100) : null;
  const depth = questionTotal ? Math.round(followTotal / questionTotal * 100) : null;
  const limited = completed.length < 5;
  const score = !limited && coverage !== null ? Math.round(coverage * 0.35 + (depth || 0) * 0.35 + completeness * 0.3) : null;
  const scope = filters.interviewer && filters.job ? `${filters.interviewer} · ${filters.job}` : (filters.interviewer || filters.job || '当前筛选整体');
  const recommendations = [];
  if (!limited) {
    if (!transcribed.length) recommendations.push('当前筛选还没有可用转写，问题覆盖和追问深度先不计算。');
    else {
      if (coverage < 60) recommendations.push('有转写的场次里，有效提问覆盖还偏低。通话确认不计入。');
      if ((depth || 0) < 60) recommendations.push('候选人回答后，继续追问职责、结果或原因。');
    }
    if (completeness < 80) recommendations.push('面试结束后及时写下通过或淘汰结论。');
  }
  return { scope, limited, completed: completed.length, transcribed: transcribed.length, covered, questionTotal, followTotal, evaluated: evaluatedCount, coverage, depth, completeness, score, recommendations };
}
