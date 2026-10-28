const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPhoneScreenQuestions } = require('./phone-screen-questions');

function item(category, question, extra = {}) {
  return { category, question, reason: extra.reason || '核对材料', source: '简历事实', evidence: extra.evidence || '简历写明该段经历', ...extra };
}

test('keeps six basic questions and four business questions', () => {
  const basic = Array.from({ length: 8 }, (_, index) => item('基本信息', `请确认第${index}项基本信息是否与简历一致？`));
  const business = [
    item('业务问题', '你在资产结算项目里具体负责哪一块？'),
    item('业务问题', '这笔结算结果是你推动上线的吗？'),
    item('业务问题', '请说明与高并发相关的经历。'),
    item('业务问题', '高并发的底层原理是什么？'),
    item('业务问题', '券商交易链路上你负责过哪一段？'),
    item('业务问题', '这个岗位里的订单状态你做过吗？')
  ];
  const selected = selectPhoneScreenQuestions([...business, ...basic]);
  assert.equal(selected.filter(question => question.category === '基本信息').length, 6);
  assert.equal(selected.filter(question => question.category === '业务问题').length, 4);
  assert.equal(selected[0].category, '基本信息');
  assert.equal(selected.some(question => /请说明与|底层原理/.test(question.question)), false);
});

test('a resume conflict can add one basic question and leave three business questions', () => {
  const basic = [
    item('基本信息', '简历写的是券商后端，JD 要求的结算经验未体现，请说明差异？', { reason: '简历与 JD 不一致' }),
    ...Array.from({ length: 6 }, (_, index) => item('基本信息', `目前所在城市、薪资和看机会原因，第${index}项请核对。`))
  ];
  const business = Array.from({ length: 4 }, (_, index) => item('业务问题', `你在第${index}个结算项目中负责哪一块？`));
  const selected = selectPhoneScreenQuestions([...basic, ...business]);
  assert.equal(selected.filter(question => question.category === '基本信息').length, 7);
  assert.equal(selected.filter(question => question.category === '业务问题').length, 3);
  assert.match(selected[0].question, /未体现/);
});

test('rejects a set that is only basic information', () => {
  const basic = Array.from({ length: 8 }, (_, index) => item('基本信息', `请确认第${index}项基本信息？`));
  assert.throws(() => selectPhoneScreenQuestions(basic), /6 个基本信息/);
});
