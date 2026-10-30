const test = require('node:test');
const assert = require('node:assert/strict');
const { extractLabeledCandidateName, extractCandidateName, extractNameFromFileName, isPlausibleCandidateName } = require('./resume-text');
const { proposeNameCandidates, chooseDisplayedName } = require('./resume-profile');
const { localNameReason, selectReasonableName } = require('./resume-name-review');

const fileName = '【人力管培_北京 10-15K】杨月 1年.pdf';

test('a section title after the name field is not captured as the name', () => {
  assert.equal(extractLabeledCandidateName(['姓名杨月外语水平']), '');
  assert.equal(extractLabeledCandidateName(['姓名：杨月 外语水平']), '杨月');
  assert.equal(isPlausibleCandidateName('外语水平'), false);
  assert.equal(extractCandidateName(['外语水平', '英语 CET-6']), '');
});

test('the recruitment file name wins when the resume body only has a section title', () => {
  const displayed = chooseDisplayedName(proposeNameCandidates({
    labeled: '外语水平',
    fromBody: '外语水平',
    fromFile: extractNameFromFileName(fileName),
    fileName
  }));
  assert.equal(displayed.candidateName, '杨月');
  assert.equal(displayed.candidateNameStatus, '已识别');
  assert.equal(displayed.candidateNameSource, '文件名');
});

test('surname check keeps 杨月 and rejects a section title or a name without a surname', () => {
  assert.equal(localNameReason('杨月').reasonable, true);
  assert.equal(localNameReason('欧阳修').reasonable, true);
  assert.equal(localNameReason('外语水平').reasonable, false);
  assert.equal(localNameReason('菜苔').reasonable, false);
  assert.equal(localNameReason('沙女士').titled, true);
  assert.equal(localNameReason('John Smith').reasonable, true);
});

test('the model can reject a name and the next reasonable candidate is used', async () => {
  const ranked = proposeNameCandidates({ labeled: '示例甲', fromFile: '杨月', fileName });
  const accepted = await selectReasonableName(ranked, async name => name === '杨月');
  assert.equal(accepted.candidateName, '杨月');
  assert.equal(accepted.candidateNameReview, 'model');
  const rejected = await selectReasonableName(ranked, async () => false);
  assert.equal(rejected.candidateName, '');
  assert.equal(rejected.candidateNameReview, 'rejected');
});
