import { createHash } from 'node:crypto';
import policy from '../../config/knowledge/information-feed-policy.json' with { type: 'json' };
const config = policy.relevance;
const whitelist = policy.whitelist;

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
const listed = Object.entries(whitelist.listed).flatMap(([market, entries]) => entries.map((aliases) => ({ market, aliases })));
const privateCompanies = whitelist.private;

function containsAlias(text, alias) {
  const term = fold(alias);
  if (!term) return false;
  if (/^[A-Z0-9 .-]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![A-Z0-9])' + escaped + '(?![A-Z0-9])', 'u').test(text);
  }
  return text.includes(term);
}
function matchedCompany(title, entries) {
  return entries.find((entry) => entry.aliases.some((alias) => containsAlias(title, alias)));
}

export const INVESTMENT_RELEVANCE_VERSION = config.version;
export const investmentRelevanceEnabled = config.enabled === true;
export const investmentRelevanceBodyHash = (body) => createHash('sha256').update(body).digest('hex');

export function currentInvestmentGate(gate, { title, body }) {
  return gate?.policyVersion === INVESTMENT_RELEVANCE_VERSION && gate.title === title
    && gate.bodySha256 === investmentRelevanceBodyHash(body)
    && ['pass', 'reject'].includes(gate.effectiveDisposition)
    && Boolean(gate.reasonCodes?.includes('gate_disabled')) === !investmentRelevanceEnabled;
}

export function evaluateInvestmentRelevance({ title, body, kind = 'new', previousStoryRelevant = false }) {
  const heading = String(title || '');
  const content = String(body || '');
  const normalizedTitle = fold(heading);
  const text = (heading + '\n' + content.slice(0, 600)).normalize('NFKC');
  const result = (decision, reasonCodes, evidence = []) => ({ decision, effectiveDisposition: decision,
    reasonCodes, evidence, policyVersion: INVESTMENT_RELEVANCE_VERSION, title: heading,
    bodySha256: investmentRelevanceBodyHash(content) });
  if (!heading || !content) return result('reject', ['missing_input']);
  if (kind === 'update' && previousStoryRelevant) return result('pass', ['relevant_story_update']);
  if (marketRoundup.test(heading) || (priceOnly.test(heading) && !operationalCue.test(content.slice(0, 600))))
    return result('reject', ['price_only']);
  if (content.length <= quoteOnly.maxBodyLength && quoteOnly.title.test(heading) && quoteOnly.body.test(content)
    && !quoteOnly.factCue.test(text)) return result('reject', ['quote_only']);

  const company = matchedCompany(normalizedTitle, listed);
  if (company && companyEvent.test(text)) return result('pass', ['listed_' + company.market], [company.aliases[0]]);
  const privateCompany = privateCompanies.find((aliases) => aliases.some((alias) => containsAlias(normalizedTitle, alias)));
  if (privateCompany && companyEvent.test(text)) return result('pass', ['private_company'], [privateCompany[0]]);
  const industry = whitelist.industries.find((aliases) => aliases.some((alias) => containsAlias(normalizedTitle, alias)));
  if (industry && industryEvent.test(text)) return result('pass', ['industry'], [industry[0]]);
  for (const rule of macro) {
    if (rule.subject.test(heading) && rule.event.test(text)) return result('pass', ['macro_' + rule.name]);
  }
  return result('reject', ['whitelist_miss']);
}
