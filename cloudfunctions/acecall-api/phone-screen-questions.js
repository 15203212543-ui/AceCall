const PHONE_SCREEN_STANDARD = 'hr-phone-6-4';

function prepareQuestionGuide() {
  return 'questions 数组每项含 category、question、reason、source、evidence。category 只能是「基本信息」或「业务问题」。这是 HR 第一轮电话，总共约 10 题，按基本信息 6 题、业务问题 4 题。基本信息先写：现公司与岗位是否和简历一致、工作地点与到岗方式、目前薪资和期望薪资、到岗时间、看机会的原因、竞业限制或简历里的明显空档。地点、薪资、到岗、竞业只要 JD 或初筛规则提到，就必须占用基本信息名额，并点名材料里的原话。简历和 JD 明显不一致时，可以多写 1 个基本信息问题，这时业务问题写 3 个。业务问题只问该岗位最有代表性的职责和结果，必须点名简历或 JD 里的公司、项目或职责，问到能判断口述和材料是否一致即可。不要问原理、算法、源码、手写或系统设计。每个问题一句，适合电话口述。evidence 必须是简历、JD 或初筛规则中的连续依据。禁止「请说明与某技能相关的经历」「请确认地点」这类不点名事实的句子。不要问性别、年龄、婚育、籍贯。';
}

function isConflictQuestion(item) {
  return /不一致|对不上|冲突|空档|未写明|未体现/.test(`${item.question || ''} ${item.reason || ''}`);
}

function isTemplateQuestion(item) {
  return /请说明与.+相关的经历|请确认(?:地点|薪资|到岗|竞业)/.test(String(item.question || ''));
}

function isDeepBusinessQuestion(item) {
  return /原理|算法|源码|手写|复杂度|底层|系统设计/.test(String(item.question || ''));
}

function selectPhoneScreenQuestions(questions = []) {
  const usable = (Array.isArray(questions) ? questions : []).map(item => ({
    ...item,
    category: String(item?.category || '').trim(),
    question: String(item?.question || '').replace(/\s+/g, ' ').trim(),
    reason: String(item?.reason || '').replace(/\s+/g, ' ').trim(),
    source: String(item?.source || '').replace(/\s+/g, ' ').trim(),
    evidence: String(item?.evidence || '').replace(/\s+/g, ' ').trim()
  })).filter(item => item.question.length >= 8 && item.question.length <= 90 && item.evidence.length >= 6 && !isTemplateQuestion(item) && (item.category === '基本信息' || item.category === '业务问题'));
  const basic = usable.filter(item => item.category === '基本信息');
  const business = usable.filter(item => item.category === '业务问题' && !isDeepBusinessQuestion(item));
  const conflicts = basic.filter(isConflictQuestion);
  const ordinary = basic.filter(item => !isConflictQuestion(item));
  let chosenBasic;
  let chosenBusiness;
  if (conflicts.length && basic.length >= 7 && business.length >= 3) {
    chosenBasic = [...conflicts, ...ordinary].slice(0, 7);
    chosenBusiness = business.slice(0, 3);
  } else if (basic.length >= 6 && business.length >= 4) {
    chosenBasic = [...conflicts, ...ordinary].slice(0, 6);
    chosenBusiness = business.slice(0, 4);
  } else {
    throw new Error('电话初筛问题需要约 6 个基本信息和 4 个业务问题，并且每题都要有材料依据');
  }
  return [...chosenBasic, ...chosenBusiness];
}

module.exports = { PHONE_SCREEN_STANDARD, prepareQuestionGuide, selectPhoneScreenQuestions };
