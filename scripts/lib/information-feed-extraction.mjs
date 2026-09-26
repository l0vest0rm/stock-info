import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ontologyText = readFileSync(new URL('../../config/knowledge-ontology.json', import.meta.url), 'utf8');
const ontology = JSON.parse(ontologyText).informationExtraction;
const categoryRules = ontology.categories;
const informationTypes = new Set(ontology.informationTypes);
const forecastCategories = new Set(['revenue', 'revenue_growth', 'net_profit', 'net_profit_growth', 'gross_margin', 'eps', 'operating_cash_flow']);
const rawUnits = new Set(['currency', 'ten_thousand_currency', 'million_currency', 'hundred_million_currency', 'billion_currency', 'percent', 'currency_per_share']);
const accountingBases = new Set(['gaap', 'non_gaap', 'adjusted', 'unspecified']);
const ownershipBases = new Set(['attributable_to_parent', 'consolidated', 'common_shareholders', 'unspecified']);
const shareBases = new Set(['basic', 'diluted', 'unspecified']);

export function feedCategoryCatalog() {
  return Object.entries(categoryRules).map(([id, rule]) => `${id}: ${rule.informationTypes.join('|')}；period=${rule.periodPolicy}`).join('\n');
}

// Display-only labels must not invalidate existing extraction fingerprints. Strip
// the inline labels before hashing so records made before labels were added keep
// their original category contract hash.
export function feedCategoryCatalogHash(text = ontologyText) {
  const contractText = text.replace(/, "label": "(?:[^"\\]|\\.)*"/g, '');
  return createHash('sha256').update(contractText).digest('hex');
}

export function parseFeedExtraction(text) {
  const response = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || Object.keys(response).join(',') !== 'records' || !Array.isArray(response.records) || response.records.length > 3) {
    throw new Error('invalid feed extraction response');
  }
  return response.records.map(parseRecord);
}

function parseRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['entity', 'informationType', 'category', 'period', 'statement', 'forecastMeasurement'].includes(key))) {
    throw new Error('invalid feed record');
  }
  const entity = typeof value.entity === 'string' ? value.entity.trim() : '';
  const statement = typeof value.statement === 'string' ? value.statement.trim() : '';
  const category = value.category;
  const informationType = value.informationType;
  const period = value.period === undefined || value.period === null || value.period === '' ? null : value.period;
  const rule = categoryRules[category];
  if (!entity || entity.length > 120 || !statement || statement.length > 120 || !statement.includes(entity)
    || !informationTypes.has(informationType) || !rule?.informationTypes.includes(informationType)
    || (period !== null && (typeof period !== 'string' || !isPeriod(period)))
    || (rule.periodPolicy === 'required' && !period) || (rule.periodPolicy === 'forbidden' && period)) {
    throw new Error('invalid feed record fields');
  }
  const forecastMeasurement = informationType === 'forecast' && forecastCategories.has(category)
    ? parseMeasurement(value.forecastMeasurement, period) : null;
  return { entity, informationType, category, period, statement, forecastMeasurement };
}

function parseMeasurement(value, period) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = ['fiscalYear', 'rawValue', 'rawUnit', 'currency', 'accountingBasis', 'ownershipBasis', 'shareBasis'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || !Number.isInteger(value.fiscalYear) || !Number.isFinite(value.rawValue)
    || !rawUnits.has(value.rawUnit) || !accountingBases.has(value.accountingBasis)
    || !ownershipBases.has(value.ownershipBasis) || !shareBases.has(value.shareBasis)
    || (value.currency !== null && (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)))
    || !new RegExp(`^${value.fiscalYear}(?:FY|Q[1-4])$`).test(period || '')) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function isPeriod(value) {
  return value.length <= 24 && (/^\d{4}(?:Q[1-4]|H[12]|FY)$/.test(value)
    || /^截至\d{4}-\d{2}-\d{2}$/.test(value)
    || /^(?:近|最近|过去|未来)\d{1,2}(?:天|周|个月|月|季度|年)$/.test(value)
    || /^\d{4}年(?:第?[一二三四1-4]季度|上半年|下半年|全年|前\d{1,2}个月)$/.test(value));
}

export function companyTagsForRecords(records, candidates) {
  const tags = new Set();
  for (const record of records) {
    const entity = normalizeName(record.entity);
    const matches = candidates.filter((candidate) => normalizeName(candidate.name) === entity || normalizeName(candidate.matchedAlias) === entity);
    if (matches.length === 1) tags.add(matches[0].tagId);
  }
  return [...tags];
}

function normalizeName(value) {
  return String(value || '').trim().replace(/(?:股份)?有限公司$/, '').toLowerCase();
}
