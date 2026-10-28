function buildCallQuestions({ profile = {}, items = [], manual = [] } = {}) {
  const questions = [];
  const push = (question, source) => {
    const text = String(question || '').trim();
    if (!text || questions.some(item => item.question === text)) return;
    questions.push({ category: '重点核验', question: text, reason: source, source });
  };
  for (const item of items) {
    if (item.state === '冲突') push(`请核对${item.item}，材料之间存在差异。`, '冲突');
    else if (item.state === '待核验') push(`请确认${item.item}。`, '待核验');
    else if (item.role === '必备' && item.state !== '命中') push(`请说明与${item.item}相关的经历。`, '必备');
  }
  for (const item of profile.verify || []) push(`请确认${item}。`, '必备');
  for (const item of manual) push(typeof item === 'string' ? item : item?.question, '人工配置');
  return questions;
}

module.exports = { buildCallQuestions };
