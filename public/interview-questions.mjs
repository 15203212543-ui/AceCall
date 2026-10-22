export function directInterviewQuestions(values = [], limit = 8) {
  const seen = new Set();
  const questions = [];
  const cue = /什么|怎么|如何|为什么|为何|哪|多少|是否|有没有|是不是|能不能|可不可以|吗|介绍一下|说说|讲讲/;
  const clean = value => String(value || '')
    .replace(/^(?:嗯+|啊+|哎+|哦+|呃+|那个|就是|然后|好的|对+|呀+|呢+|吧+|这个|其实)+[，,\s]*/g, '')
    .replace(/^[\u4e00-\u9fff]{2,3}\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/^[\u4e00-\u9fffA-Za-z0-9]{1,12}[：:]/, '')
    .replace(/(?:啊|呢|吧|呀|哦|哈|嘛|啦|呗)+$/g, '')
    .replace(/为啥/g, '为什么')
    .replace(/咋样/g, '怎么')
    .replace(/咋/g, '怎么')
    .replace(/啥/g, '什么')
    .replace(/具体是/g, '具体')
    .replace(/\s+/g, '')
    .replace(/^[，,、：:]+|[。！？?]+$/g, '')
    .trim();
  const accept = clause => clause.length >= 6 && clause.length <= 28 && cue.test(clause) && !/[：:]|面试官|候选人|转写/.test(clause);
  for (const value of values) {
    const source = String(typeof value === 'string' ? value : value?.question || '')
      .replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
      .replace(/(?:面试官|候选人)\s*[：:]/g, ' ');
    for (const piece of source.split(/[？?。！\n]/)) {
      const parts = piece.split(/[，,、]|啊(?=[\u4e00-\u9fff])/).map(clean).filter(Boolean);
      const usable = parts.filter(accept);
      const chosen = usable.length ? usable : [clean(piece)].filter(accept);
      for (const clause of chosen) {
        const question = `${clause}？`;
        if (seen.has(question)) continue;
        seen.add(question);
        questions.push(question);
        if (questions.length >= limit) return questions;
      }
    }
  }
  return questions;
}
