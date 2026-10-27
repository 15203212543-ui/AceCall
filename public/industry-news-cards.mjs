function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function officialFilingUrl(value = '') {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.sec.gov' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function industryNewsInPeriod(item = {}, period = 'all', now = Date.now()) {
  const days = Number(period);
  if (!Number.isFinite(days) || days <= 0) return true;
  const timestamp = Date.parse(item.publishedAt || '');
  return Number.isFinite(timestamp) && timestamp >= now - days * 24 * 60 * 60 * 1000;
}

const INDUSTRY_NEWS_PAGE_SIZE = 3;

export function industryNewsMarkup(items = [], period = 'all', now = Date.now(), emptyText = '本期无外部动态。', page = 1) {
  const matched = items.filter(item => item && item.trend !== true && item.intelligenceType === '外部公告' && industryNewsInPeriod(item, period, now));
  if (!matched.length) return `<div class="intelligence-home-empty">${escapeHtml(emptyText)}</div>`;
  const pages = Math.ceil(matched.length / INDUSTRY_NEWS_PAGE_SIZE);
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const visible = matched.slice((current - 1) * INDUSTRY_NEWS_PAGE_SIZE, current * INDUSTRY_NEWS_PAGE_SIZE);
  const cards = visible.map(item => {
    const url = officialFilingUrl(item.url);
    const link = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看原文</a>` : '原文链接不可用';
    const date = escapeHtml(String(item.publishedAt || '').slice(0, 10));
    return `<article class="intelligence-insight-row intelligence-external-card"><div class="intelligence-insight-top"><span class="intelligence-topic-pill">外部公告</span><strong>${escapeHtml(item.title || '')}</strong><span class="intelligence-insight-status">单条公告</span></div><p>${escapeHtml(item.summary || '')}</p><small>${escapeHtml(item.company || '')} · ${date} · ${link}</small></article>`;
  }).join('');
  if (pages <= 1) return cards;
  return `${cards}<div class="intelligence-external-pager"><button type="button" data-industry-news-page="${current - 1}"${current <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${current} / ${pages} 页</span><button type="button" data-industry-news-page="${current + 1}"${current >= pages ? ' disabled' : ''}>下一页</button></div>`;
}
