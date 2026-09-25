import { createHash } from 'node:crypto';
import { canonicalFeedUrl, normalizedFeedBody } from './information-feed-dedupe.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function pythonLiteralField(value, key) {
  const input = String(value || '');
  const match = new RegExp(`["']${key}["']\\s*:\\s*(["'])`).exec(input);
  if (!match) return '';
  const quote = match[1];
  let result = '';
  for (let i = match.index + match[0].length; i < input.length; i += 1) {
    const char = input[i];
    if (char === quote) return result;
    if (char === '\\' && i + 1 < input.length) {
      const next = input[++i];
      if (next === 'n') result += '\n';
      else if (next === 't') result += '\t';
      else if (next === 'r') result += '\r';
      else if ((next === 'u' || next === 'U') && /^[0-9a-fA-F]+$/.test(input.slice(i + 1, i + 1 + (next === 'u' ? 4 : 8)))) {
        const width = next === 'u' ? 4 : 8;
        result += String.fromCodePoint(Number.parseInt(input.slice(i + 1, i + 1 + width), 16));
        i += width;
      }
      else result += next;
    } else result += char;
  }
  return '';
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

function isoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  const date = Number.isFinite(n) && String(value).trim() !== ''
    ? new Date(n < 1e11 ? n * 1000 : n)
    : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function sourceKeyFor(raw) {
  const explicit = text(raw?.sourceKey || raw?.source_key || raw?.metadata?.source);
  if (explicit) return explicit;
  if (raw?.metadata?.source === 'cls_telegraph' || /cls\.cn/.test(String(raw?.url || ''))) return 'cls_telegraph';
  if (raw?.dedupe_title || raw?.stockInfo || /gu\.qq\.com/.test(String(raw?.url || ''))) return 'tencent_stock_news';
  return '';
}

export function normalizeFeedSource(raw) {
  if (!raw || typeof raw !== 'object') return { accepted: false, reason: 'invalid_source' };
  const access = text(raw.accessMethod || raw.access_method).toLowerCase();
  const mime = text(raw.originalMime || raw.original_mime || raw.mimeType || raw.mime_type).toLowerCase();
  const originalFormat = text(raw.originalFormat || raw.original_format || raw?.metadata?.originalFormat).toLowerCase();
  const url = canonicalFeedUrl(raw.url);
  if (/pdf/.test(access) || /application\/pdf/.test(mime) || /\.pdf(?:$|\?)/i.test(String(raw.url || '')) || originalFormat === 'pdf') {
    return { accepted: false, reason: 'pdf_origin' };
  }
  const sourceKey = sourceKeyFor(raw);
  const knownTextSource = sourceKey === 'cls_telegraph' || sourceKey === 'tencent_stock_news';
  if (!knownTextSource && !['text', 'html', 'markdown'].includes(originalFormat) && !/^text\/(?:plain|html|markdown)/.test(mime)) {
    return { accepted: false, reason: 'unknown_origin_format' };
  }
  if (!sourceKey) return { accepted: false, reason: 'missing_source' };
  const content = raw.content;
  const html = typeof content === 'object' && content !== null ? text(content.text)
    : pythonLiteralField(content, 'text') || (/^\s*</.test(String(content || '')) ? text(content) : '');
  const directText = text(raw.markdown || raw.mdText || raw.md_text || raw.body || raw.text)
    || (/^text\/(?:plain|markdown)/.test(mime) && typeof content === 'string' ? text(content) : '');
  const body = normalizedFeedBody(directText || htmlToText(html));
  if (!body) return { accepted: false, reason: 'missing_text_body' };
  if (/^\(?以下内容从.{0,100}研报附件原文摘录\)?/u.test(body)) {
    return { accepted: false, reason: 'pdf_derived_excerpt' };
  }
  const title = text(raw.title || raw.dedupe_title) || body.slice(0, 80);
  const sourceItemId = text(raw?.metadata?.clsId || raw?.metadata?.newsId || raw.id || raw.sourceItemId || raw.source_item_id);
  if (!sourceItemId && !url) return { accepted: false, reason: 'missing_identity' };
  const publishedAt = isoDate(raw.publishedAt || raw.published_at || raw.publish_time || raw.eventTime || raw.event_time);
  const fetchedAt = isoDate(raw.fetchedAt || raw.fetched_at) || new Date().toISOString();
  const sourceName = text(raw.sourceName || raw.source_name || raw.source) || (sourceKey === 'cls_telegraph' ? '财联社' : '腾讯自选股');
  const sourceCodes = [
    ...(Array.isArray(raw?.metadata?.stockCodes) ? raw.metadata.stockCodes : []),
    ...String(raw.stock_codes || raw.stockInfo || '').matchAll(/(?:sh|sz|bj)\d{6}|hk\d{5}|\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK/giu),
  ].map((item) => String(item).trim().toUpperCase()).filter(Boolean);
  const rawType = text(raw.reportType || raw.report_type || raw.contentType || raw.content_type).toLowerCase();
  const contentType = sourceKey === 'cls_telegraph' ? 'flash' : (({ news: 'news', flash: 'flash', fast_news: 'flash', telegraph: 'flash',
    announcement: 'announcement', text_report: 'text_report' })[rawType] || 'news');
  const stable = `${sourceKey}|${sourceItemId || url}`;
  return {
    accepted: true, sourceKey, sourceItemId, sourceName, url, title, body,
    contentType, publishedAt, fetchedAt, entityCodes: [...new Set(sourceCodes)],
    identityKey: createHash('sha256').update(stable).digest('hex'),
  };
}
