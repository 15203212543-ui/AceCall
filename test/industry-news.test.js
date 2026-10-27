const test = require('node:test');
const assert = require('node:assert/strict');
const { filingsFromFeed, mergeFilings, officialFilingUrl } = require('../cloudfunctions/acecall-api/industry-news');

const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <company-info><address type="business"><phone>8675525233312</phone></address></company-info>
  <entry>
    <title>6-K  - Report of foreign issuer [Rules 13a-16 and 15d-16]</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1754581/example-index.htm" rel="alternate" />
    <updated>2026-08-20T06:00:54-04:00</updated>
    <summary type="html">full filing body should not be copied</summary>
  </entry>
  <entry>
    <title>4  - Statement of changes in beneficial ownership of securities</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1754581/insider.htm" rel="alternate" />
    <updated>2026-06-23T06:00:54-04:00</updated>
  </entry>
  <entry>
    <title>6-K  - Report of foreign issuer</title>
    <link href="https://evil.example/filing.htm" rel="alternate" />
    <updated>2026-08-01T00:00:00Z</updated>
  </entry>
</feed>`;

test('sec filings keep substantive reports and drop insider forms', () => {
  const items = filingsFromFeed(feed, { company: '富途控股' });
  assert.equal(items.length, 1);
  assert.equal(items[0].company, '富途控股');
  assert.equal(items[0].form, '6-K');
  assert.equal(items[0].intelligenceType, '外部公告');
  assert.equal(items[0].trend, false);
  assert.equal(items[0].title.includes('行业趋势'), false);
  assert.equal(JSON.stringify(items).includes('8675525233312'), false);
  assert.equal(JSON.stringify(items).includes('full filing body'), false);
  assert.equal(officialFilingUrl('https://evil.example/filing.htm'), '');
});

test('merged filings stay separate from industry trend labels', () => {
  const merged = mergeFilings([[
    { url: 'https://www.sec.gov/a', publishedAt: '2026-08-01T00:00:00.000Z', trend: false, intelligenceType: '外部公告' },
    { url: 'https://www.sec.gov/a', publishedAt: '2026-08-02T00:00:00.000Z', trend: false, intelligenceType: '外部公告' },
    { url: 'https://www.sec.gov/b', publishedAt: '2026-07-01T00:00:00.000Z', trend: true, intelligenceType: '行业趋势' }
  ]]);
  assert.deepEqual(merged.map(item => item.url), ['https://www.sec.gov/a']);
});

test('homepage cards hide an empty period and do not call a filing an industry trend', async () => {
  const { industryNewsMarkup } = await import('../public/industry-news-cards.mjs');
  const items = filingsFromFeed(feed, { company: '富途控股' });
  const markup = industryNewsMarkup(items, 'all', Date.parse('2026-10-27T00:00:00Z'));
  assert.match(markup, /外部公告/);
  assert.match(markup, /单条公告/);
  assert.match(markup, /不作为行业趋势/);
  assert.equal(markup.includes('>行业趋势<'), false);
  assert.equal(markup.includes('上一页'), false);
  assert.equal(industryNewsMarkup(items, '30', Date.parse('2026-10-27T00:00:00Z')), '<div class="intelligence-home-empty">本期无外部动态。</div>');
});

test('homepage shows three filings per page', async () => {
  const { industryNewsMarkup } = await import('../public/industry-news-cards.mjs');
  const items = [1, 2, 3, 4].map(index => ({
    title: `公告${index}`,
    summary: '单条公告不作为行业趋势。',
    company: '富途控股',
    url: `https://www.sec.gov/Archives/${index}.htm`,
    publishedAt: `2026-08-0${index}T00:00:00.000Z`,
    intelligenceType: '外部公告',
    trend: false
  }));
  const now = Date.parse('2026-10-27T00:00:00Z');
  const first = industryNewsMarkup(items, 'all', now, '本期无外部动态。', 1);
  assert.match(first, /公告1/);
  assert.match(first, /公告3/);
  assert.equal(first.includes('公告4'), false);
  assert.match(first, /第 1 \/ 2 页/);
  const second = industryNewsMarkup(items, 'all', now, '本期无外部动态。', 2);
  assert.match(second, /公告4/);
  assert.equal(second.includes('公告1'), false);
  assert.match(second, /第 2 \/ 2 页/);
  assert.equal((second.match(/intelligence-external-card/g) || []).length, 1);
});
