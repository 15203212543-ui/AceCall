const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-v2.js'), 'utf8');

test('list page sizes stay stable when pages use natural document scrolling', () => {
  assert.match(source, /let inboxQueuePageSize = 6;/);
  assert.match(source, /let candidatePageSize = 8;/);
  assert.match(source, /let jobPageSize = 4;/);
  assert.doesNotMatch(source, /function fit(?:InboxQueue|CandidatePage|JobPage)\s*\(/);
  assert.doesNotMatch(source, /(?:inboxQueue|candidate|job)FitPasses/);
});
