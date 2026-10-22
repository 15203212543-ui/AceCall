const { execFileSync } = require('node:child_process');

const WATCHED = [
  'public/app-v2.js',
  'public/styles-v2.css',
  'public/index.html',
  'public/interviewer-page.js',
  'public/interviewer.css',
  'public/auth-session.js'
];
const THRESHOLD = 80;
const RECENT_DAYS = 21;
const MIN_LINE_LENGTH = 15;

function normalize(line) {
  return String(line || '').replace(/\r/g, '').trim();
}

function countable(line) {
  return normalize(line).length >= MIN_LINE_LENGTH;
}

function parseDiff(diffText) {
  const deleted = [];
  const added = [];
  let file = '';
  let oldLine = 0;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/ b\/(.+)$/);
      file = match ? match[1] : '';
      oldLine = 0;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      continue;
    }
    if (!file || line.startsWith('\\')) continue;
    if (line.startsWith('-') && !line.startsWith('---')) {
      deleted.push({ file, line: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ file, text: line.slice(1) });
    } else if (!line.startsWith('+') && !line.startsWith('-')) {
      oldLine += 1;
    }
  }
  return { deleted, added };
}

function droppedLines(deleted, added) {
  const available = new Map();
  for (const item of added) {
    const text = normalize(item.text);
    if (!countable(text)) continue;
    available.set(text, (available.get(text) || 0) + 1);
  }
  const dropped = [];
  for (const item of deleted) {
    const text = normalize(item.text);
    if (!countable(text)) continue;
    const remaining = available.get(text) || 0;
    if (remaining > 0) {
      available.set(text, remaining - 1);
      continue;
    }
    dropped.push({ file: item.file, line: item.line, text });
  }
  return dropped;
}

function isSelf(blame, self) {
  const names = new Set((self.names || []).map(value => String(value).toLowerCase()));
  const emails = new Set((self.emails || []).map(value => String(value).replace(/[<>]/g, '').toLowerCase()));
  const name = String(blame.name || '').toLowerCase();
  const email = String(blame.email || '').replace(/[<>]/g, '').toLowerCase();
  return names.has(name) || emails.has(email) || names.has(email.split('@')[0]);
}

function recentForeignLosses(dropped, blameByKey, self, now, recentDays = RECENT_DAYS) {
  const recentAfter = now - recentDays * 24 * 60 * 60 * 1000;
  const losses = [];
  for (const item of dropped) {
    const blame = blameByKey.get(`${item.file}:${item.line}`);
    if (!blame || blame.time < recentAfter || isSelf(blame, self)) continue;
    losses.push({ ...item, author: blame.name, email: blame.email });
  }
  return losses;
}

function wiringProblems(files) {
  const html = files['public/index.html'] || '';
  const app = files['public/app-v2.js'] || '';
  const problems = [];
  if (!html.includes('./interviewer.css?v=__ACE_CALL_BUILD__')) problems.push('index.html 没有再加载独立的面试官分析样式');
  if (!html.includes('./styles-v2.css?v=__ACE_CALL_BUILD__') || !html.includes('./app-v2.js?v=__ACE_CALL_BUILD__')) problems.push('index.html 的页面版本被写成了固定号码');
  if (!app.includes("from './interviewer-page.js?v=__ACE_CALL_BUILD__'")) problems.push('主脚本不再从独立文件加载面试官分析');
  return problems;
}

function hasOverride(text) {
  return String(text || '').includes('版式调整');
}

function summarize(losses) {
  const groups = new Map();
  for (const item of losses) {
    const key = `${item.file} · ${item.author || '未知作者'}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()].sort((left, right) => right[1] - left[1]);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function fileAt(revision, file) {
  try {
    return git(['show', `${revision}:${file}`]);
  } catch {
    return '';
  }
}

function readSelf(base, head) {
  const names = [];
  const emails = [];
  const actor = String(process.env.ACTOR || '').trim();
  if (actor) names.push(actor);
  const listed = git(['log', '--format=%an%x1f%ae', `${base}..${head}`]);
  for (const row of listed.split('\n')) {
    if (!row.trim()) continue;
    const [name, email] = row.split('\x1f');
    if (name) names.push(name);
    if (email) emails.push(email);
  }
  return { names, emails };
}

function blameDropped(base, dropped) {
  const byFile = new Map();
  for (const item of dropped) {
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item.line);
  }
  const blameByKey = new Map();
  for (const [file, lineNumbers] of byFile) {
    const ranges = coalesce(lineNumbers);
    for (const range of ranges) {
      let output = '';
      try {
        output = git(['blame', '-L', `${range.start},${range.end}`, '--line-porcelain', base, '--', file]);
      } catch {
        continue;
      }
      let cursor = range.start;
      let record = {};
      for (const line of output.split('\n')) {
        if (/^[0-9a-f]{8,}\s/.test(line)) {
          record = {};
          continue;
        }
        if (line.startsWith('author ')) record.name = line.slice(7);
        else if (line.startsWith('author-mail ')) record.email = line.slice(12).replace(/[<>]/g, '');
        else if (line.startsWith('author-time ')) record.time = Number(line.slice(12)) * 1000;
        else if (line.startsWith('\t')) {
          blameByKey.set(`${file}:${cursor}`, record);
          cursor += 1;
          record = {};
        }
      }
    }
  }
  return blameByKey;
}

function coalesce(lineNumbers) {
  const sorted = [...new Set(lineNumbers)].sort((left, right) => left - right);
  const ranges = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

function main() {
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA || 'HEAD';
  if (!base) {
    console.error('缺少 BASE_SHA，无法对比这次改动和 main。');
    process.exit(2);
  }
  const messages = [
    process.env.PR_TITLE || '',
    process.env.PR_BODY || '',
    git(['log', '--format=%s%n%b', `${base}..${head}`])
  ].join('\n');
  if (hasOverride(messages)) {
    console.log('本次合并请求注明了版式调整，跳过覆盖检查。');
    return;
  }
  const diff = git(['diff', '-U0', '--no-ext-diff', base, head, '--', ...WATCHED]);
  const parsed = parseDiff(diff);
  const dropped = droppedLines(parsed.deleted, parsed.added);
  const losses = recentForeignLosses(dropped, blameDropped(base, dropped), readSelf(base, head), Date.now());
  const wiring = wiringProblems({
    'public/index.html': fileAt(head, 'public/index.html'),
    'public/app-v2.js': fileAt(head, 'public/app-v2.js')
  });
  if (losses.length < THRESHOLD && wiring.length === 0) {
    console.log(`覆盖检查通过。别人最近的代码被删除 ${losses.length} 行，未达到 ${THRESHOLD} 行。`);
    return;
  }
  if (losses.length >= THRESHOLD) {
    console.error(`这次改动删掉了别人最近 ${RECENT_DAYS} 天内写的 ${losses.length} 行，像是用旧文件覆盖了现有页面。`);
    for (const [label, count] of summarize(losses)) console.error(`- ${label}：${count} 行`);
  }
  for (const problem of wiring) console.error(problem);
  console.error('页面内容可以继续改。如果这是确认过的大改版，请在合并请求标题或说明里写上「版式调整」。');
  process.exit(1);
}

module.exports = {
  WATCHED,
  THRESHOLD,
  RECENT_DAYS,
  parseDiff,
  droppedLines,
  recentForeignLosses,
  wiringProblems,
  hasOverride,
  summarize,
  isSelf
};

if (require.main === module) main();
