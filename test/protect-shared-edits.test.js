const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDiff,
  droppedLines,
  recentForeignLosses,
  wiringProblems,
  hasOverride,
  THRESHOLD
} = require('../scripts/protect-shared-edits.js');

const now = Date.parse('2026-10-22T02:00:00Z');
const recent = now - 2 * 24 * 60 * 60 * 1000;
const old = now - 40 * 24 * 60 * 60 * 1000;

function blameMap(items) {
  return new Map(items.map(item => [`${item.file}:${item.line}`, item]));
}

test('moving a block into another file is not treated as an overwrite', () => {
  const diff = [
    'diff --git a/public/app-v2.js b/public/app-v2.js',
    '--- a/public/app-v2.js',
    '+++ b/public/app-v2.js',
    '@@ -10,2 +10,1 @@',
    '-function renderInterviewers() { const layout = "面试官分析页的完整实现"; }',
    '-const kept = "同事刚发布的转写与简历关联逻辑保留在主脚本";',
    '+const kept = "同事刚发布的转写与简历关联逻辑保留在主脚本";',
    'diff --git a/public/interviewer-page.js b/public/interviewer-page.js',
    '--- /dev/null',
    '+++ b/public/interviewer-page.js',
    '@@ -0,0 +1,1 @@',
    '+function renderInterviewers() { const layout = "面试官分析页的完整实现"; }'
  ].join('\n');
  const parsed = parseDiff(diff);
  const dropped = droppedLines(parsed.deleted, parsed.added);
  assert.equal(dropped.length, 0);
});

test('a large deletion of someone else\'s recent lines fails, and their own revision does not', () => {
  const dropped = Array.from({ length: THRESHOLD }, (_item, index) => ({
    file: 'public/app-v2.js',
    line: index + 1,
    text: `别人最近写的页面逻辑第 ${index} 行，长度足够计入`
  }));
  const foreign = blameMap(dropped.map(item => ({ ...item, name: 'ziyuw661-stack', email: 'ziyu@example.com', time: recent })));
  const losses = recentForeignLosses(dropped, foreign, { names: ['zhangmingliang'], emails: [] }, now);
  assert.equal(losses.length, THRESHOLD);

  const own = blameMap(dropped.map(item => ({ ...item, name: 'zhangmingliang', email: 'me@example.com', time: recent })));
  assert.equal(recentForeignLosses(dropped, own, { names: ['zhangmingliang'], emails: ['me@example.com'] }, now).length, 0);

  const stale = blameMap(dropped.map(item => ({ ...item, name: 'ziyuw661-stack', email: 'ziyu@example.com', time: old })));
  assert.equal(recentForeignLosses(dropped, stale, { names: ['zhangmingliang'], emails: [] }, now).length, 0);
});

test('wiring stays structural and an explicit redesign can bypass the check', () => {
  assert.deepEqual(wiringProblems({
    'public/index.html': '<link rel="stylesheet" href="./styles-v2.css?v=__ACE_CALL_BUILD__">\n<link rel="stylesheet" href="./interviewer.css?v=__ACE_CALL_BUILD__">\n<script type="module" src="./app-v2.js?v=__ACE_CALL_BUILD__"></script>',
    'public/app-v2.js': "import { attachInterviewerRuntime } from './interviewer-page.js?v=__ACE_CALL_BUILD__';"
  }), []);
  const broken = wiringProblems({
    'public/index.html': '<link rel="stylesheet" href="./styles-v2.css?v=f6b60c96">\n<script type="module" src="./app-v2.js?v=27792170"></script>',
    'public/app-v2.js': 'function renderInterviewers() {}'
  });
  assert.equal(broken.length, 3);
  assert.equal(hasOverride('恢复页面\n\n版式调整'), true);
  assert.equal(hasOverride('只改行业情报'), false);
});
