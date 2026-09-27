import { createHash } from 'node:crypto';
import policy from '../../config/knowledge/information-feed-policy.json' with { type: 'json' };
const config = policy.relevance;
const whitelist = policy.whitelist;
if (config.enabled !== true) throw new Error('information feed whitelist must remain enabled');

const pattern = (value) => new RegExp(value, 'iu');
const quoteOnly = { ...config.quoteOnly, title: pattern(config.quoteOnly.title), body: pattern(config.quoteOnly.body),
  factCue: pattern(config.quoteOnly.factCue) };
const companyEvent = pattern(whitelist.companyEvent);
const priceOnly = /(?:期货|指数|股价|股票|现货).*(?:涨|跌|收盘|盘前|盘中)/iu;
const marketRoundup = /^(?:美股|港股|A股|欧股|亚太股市|周[一二三四五六日]你需要知道的隔夜全球要闻).*(?:收涨|收跌|高开|低开|上涨|下跌|要闻)/iu;
const operationalCue = /(?:财报|业绩|订单|签署|收购|融资|IPO|关税|降息|加息|减产|增产|停产|投产|供应中断|运输中断|获批|召回|诉讼|罚款|产品发布|推出|升级)/iu;
const industryEvent = pattern(whitelist.industryEvent);
const macro = whitelist.macro.map((rule) => ({ ...rule, subject: pattern(rule.subject), event: pattern(rule.event) }));
const fold = (value) => String(value || '').normalize('NFKC').toLocaleUpperCase();
const stockHashCache = new WeakMap();

function containsAlias(text, alias) {
  const term = fold(alias);
  if (!term) return false;
  if (/^[A-Z0-9 .-]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![A-Z0-9])' + escaped + '(?![A-Z0-9])', 'u').test(text);
  }
  return text.includes(term);
}
/** The caller supplies the current stock/stock_alias snapshot; no stock list is hard-coded here. */
export function stockWhitelistEntries(rows) {
  const entries = new Map();
  for (const row of rows) {
    const code = fold(row.code).trim();
    if (!code) continue;
    const names = entries.get(code) || new Set();
    for (const value of [row.short_name, row.alias]) {
      const name = fold(value).trim();
      if (!name || name === code || /^\d+$/.test(name)) continue;
      if (/^[A-Z0-9 .-]+$/.test(name) ? name.length >= 3 || (name.length === 2 && /\d/.test(name)) : name.length >= 2)
        names.add(name);
    }
    entries.set(code, names);
  }
  return [...entries].sort(([a], [b]) => a.localeCompare(b))
    .map(([code, names]) => ({ code, names: [...names].sort() }));
}

function matchedStock(title, entries) {
  const normalized = fold(title);
  for (const { code, names } of entries) {
    const name = names.find((item) => containsAlias(normalized, item));
    if (name) return { code, matched: name };
    const match = /^([A-Z0-9.]+)\.(SH|SZ|BJ|HK|US|KS|KQ|T)$/.exec(code);
    if (!match) continue;
    const [, ticker, market] = match;
    if (containsAlias(normalized, code) || containsAlias(normalized, `${market}${ticker}`)) return { code, matched: code };
    // Bare numeric codes are also prices and dates. Alphabetic tickers need
    // their original uppercase spelling to avoid matching ordinary words.
    if (/^[A-Z]{3,}$/.test(ticker) && new RegExp(`(?<![A-Za-z0-9])${ticker}(?![A-Za-z0-9])`, 'u').test(title))
      return { code, matched: ticker };
  }
  return null;
}

export const INVESTMENT_RELEVANCE_VERSION = config.version;
export const investmentRelevanceBodyHash = (body) => createHash('sha256').update(body).digest('hex');

export function stockWhitelistHash(entries) {
  if (!stockHashCache.has(entries)) stockHashCache.set(entries, createHash('sha256').update(JSON.stringify(entries)).digest('hex'));
  return stockHashCache.get(entries);
}

export function currentInvestmentGate(gate, { title, body, stockEntries = [] }) {
  return gate?.policyVersion === INVESTMENT_RELEVANCE_VERSION && gate.title === title
    && gate.bodySha256 === investmentRelevanceBodyHash(body)
    && gate.stockWhitelistHash === stockWhitelistHash(stockEntries)
    && ['pass', 'reject'].includes(gate.effectiveDisposition)
    && !gate.reasonCodes?.includes('gate_disabled');
}

export function evaluateInvestmentRelevance({ title, body, stockEntries = [] }) {
  const heading = String(title || '');
  const content = String(body || '');
  const normalizedTitle = fold(heading);
  const text = (heading + '\n' + content.slice(0, 600)).normalize('NFKC');
  const result = (decision, reasonCodes, evidence = [], matchedKeywords = []) => ({ decision, effectiveDisposition: decision,
    reasonCodes, evidence, ...(decision === 'pass' ? { matchedKeywords } : {}), policyVersion: INVESTMENT_RELEVANCE_VERSION, title: heading,
    bodySha256: investmentRelevanceBodyHash(content), stockWhitelistHash: stockWhitelistHash(stockEntries) });
  if (!heading || !content) return result('reject', ['missing_input']);
  if (marketRoundup.test(heading) || (priceOnly.test(heading) && !operationalCue.test(content.slice(0, 600))))
    return result('reject', ['price_only']);
  if (content.length <= quoteOnly.maxBodyLength && quoteOnly.title.test(heading) && quoteOnly.body.test(content)
    && !quoteOnly.factCue.test(text)) return result('reject', ['quote_only']);

  const stock = matchedStock(heading, stockEntries);
  const stockEvent = stock && companyEvent.exec(text);
  if (stock && stockEvent) return result('pass', ['stock'], [stock.code, stock.matched], [stock.matched, stockEvent[0]]);
  const industry = whitelist.industries.find((aliases) => aliases.some((alias) => containsAlias(normalizedTitle, alias)));
  const industryAlias = industry?.find((alias) => containsAlias(normalizedTitle, alias));
  const matchedIndustryEvent = industryAlias && industryEvent.exec(text);
  if (industryAlias && matchedIndustryEvent) return result('pass', ['industry'], [industry[0]], [industryAlias, matchedIndustryEvent[0]]);
  for (const rule of macro) {
    const subject = rule.subject.exec(heading);
    const event = subject && rule.event.exec(text);
    if (subject && event) return result('pass', ['macro_' + rule.name], [], [subject[0], event[0]]);
  }
  return result('reject', ['whitelist_miss']);
}
