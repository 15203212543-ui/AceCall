const crypto = require('node:crypto');

const CACHE_COLLECTION = 'acecall_industry_news';
const CACHE_ID = 'feed';
const CACHE_MS = 6 * 60 * 60 * 1000;
const USER_AGENT = 'AceCall admin@example.com';
const FILING_FORMS = new Set(['6-K', '20-F', '10-K', '10-Q', '8-K']);
const FORM_LABELS = {
  '6-K': '境外发行人当前报告',
  '20-F': '境外发行人年度报告',
  '10-K': '年度报告',
  '10-Q': '季度报告',
  '8-K': '重大事项当前报告'
};

const WATCHED_COMPANIES = [
  { name: '富途控股', cik: '0001754581' },
  { name: '老虎证券', cik: '0001756699' },
  { name: '盈透证券', cik: '0001381197' }
];

function filingSources() {
  return WATCHED_COMPANIES.map(company => ({
    company: company.name,
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.cik}&owner=exclude&count=40&output=atom`
  }));
}

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAtomEntries(xml = '') {
  return [...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(match => {
    const block = match[0];
    const title = decodeXml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const updated = decodeXml((block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '');
    const href = decodeXml((block.match(/<link\b[^>]*\bhref="([^"]+)"/i) || [])[1] || '');
    return { title, updated, href };
  });
}

function filingForm(title = '') {
  const form = String(title).split(/\s+-\s+/)[0].trim().toUpperCase().replace(/\/A$/, '');
  return FILING_FORMS.has(form) ? form : '';
}

function officialFilingUrl(value = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.sec.gov') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function toFiling(entry, source) {
  const form = filingForm(entry.title);
  const url = officialFilingUrl(entry.href);
  const publishedAt = entry.updated && Number.isFinite(Date.parse(entry.updated)) ? new Date(entry.updated).toISOString() : '';
  if (!form || !url || !publishedAt) return null;
  return {
    id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 16),
    company: source.company,
    form,
    title: `${source.company}向美国证监会提交 ${form}（${FORM_LABELS[form]}）`,
    summary: '来源是美国证监会 EDGAR 的公开公告，只保留公告类型、时间和原文链接，不摘录正文。单条公告不作为行业趋势。',
    url,
    publishedAt,
    kind: 'filing',
    intelligenceType: '外部公告',
    trend: false
  };
}

function filingsFromFeed(xml, source) {
  return parseAtomEntries(xml).map(entry => toFiling(entry, source)).filter(Boolean);
}

function mergeFilings(groups = []) {
  const seen = new Set();
  return groups.flat().filter(item => {
    if (!item?.url || seen.has(item.url) || item.trend !== false || item.intelligenceType !== '外部公告') return false;
    seen.add(item.url);
    return true;
  }).sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt))).slice(0, 24);
}

function unwrapDocument(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function readCache(database) {
  if (!database) return null;
  try {
    const result = await database.collection(CACHE_COLLECTION).doc(CACHE_ID).get();
    const cached = unwrapDocument(result.data);
    return cached?.fetchedAt ? cached : null;
  } catch {
    return null;
  }
}

async function writeCache(database, payload) {
  if (!database) return;
  try {
    await database.collection(CACHE_COLLECTION).doc(CACHE_ID).set({ id: CACHE_ID, ...payload });
  } catch {
    // The page can still use a fresh fetch when the cache collection is unavailable.
  }
}

async function fetchFilings(fetchImpl = globalThis.fetch) {
  const errors = [];
  const groups = [];
  for (const source of filingSources()) {
    try {
      const response = await fetchImpl(source.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, application/xml' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      groups.push(filingsFromFeed(await response.text(), source));
    } catch (error) {
      errors.push({ company: source.company, message: String(error.message || '读取失败').slice(0, 120) });
    }
  }
  return { items: mergeFilings(groups), errors };
}

async function listIndustryNews({ database, fetchImpl, now = new Date() } = {}) {
  const cached = await readCache(database);
  const freshEnough = cached && now.getTime() - Date.parse(cached.fetchedAt) < CACHE_MS;
  if (freshEnough) return { ok: true, source: 'sec-edgar', fetchedAt: cached.fetchedAt, stale: false, items: cached.items || [], errors: cached.errors || [] };
  try {
    const fetched = await fetchFilings(fetchImpl);
    const fetchedAt = now.toISOString();
    if (fetched.items.length || !cached?.items?.length) {
      await writeCache(database, { items: fetched.items, errors: fetched.errors, fetchedAt });
      return { ok: true, source: 'sec-edgar', fetchedAt, stale: false, items: fetched.items, errors: fetched.errors };
    }
    return { ok: true, source: 'sec-edgar', fetchedAt: cached.fetchedAt, stale: true, items: cached.items, errors: fetched.errors };
  } catch (error) {
    if (cached?.items) return { ok: true, source: 'sec-edgar', fetchedAt: cached.fetchedAt, stale: true, items: cached.items, errors: [{ company: '', message: '暂时无法更新' }] };
    return { ok: true, source: 'sec-edgar', fetchedAt: now.toISOString(), stale: false, items: [], errors: [{ company: '', message: String(error.message || '读取失败').slice(0, 120) }] };
  }
}

module.exports = {
  WATCHED_COMPANIES,
  filingsFromFeed,
  listIndustryNews,
  mergeFilings,
  officialFilingUrl,
  parseAtomEntries
};
