import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ontologyText = readFileSync(new URL('../../config/knowledge/knowledge-ontology.json', import.meta.url), 'utf8');
const ontologyConfig = JSON.parse(ontologyText);
const ontology = ontologyConfig.informationExtraction;
const categoryRules = ontology.categories;
const informationTypes = new Set(ontology.informationTypes);
const forecastCategories = new Set(['revenue', 'revenue_growth', 'net_profit', 'net_profit_growth', 'gross_margin', 'eps', 'operating_cash_flow']);
const rawUnits = new Set(['currency', 'ten_thousand_currency', 'million_currency', 'hundred_million_currency', 'billion_currency', 'percent', 'currency_per_share']);
const accountingBases = new Set(['gaap', 'non_gaap', 'adjusted', 'unspecified']);
const ownershipBases = new Set(['attributable_to_parent', 'consolidated', 'common_shareholders', 'unspecified']);
const shareBases = new Set(['basic', 'diluted', 'unspecified']);

export function feedCategoryCatalog() {
  return Object.entries(categoryRules).map(([id, rule]) => `${id}（${rule.label}）: ${rule.informationTypes.join('|')}；period=${rule.periodPolicy}${rule.description ? `；${rule.description}` : ''}`).join('\n');
}

export function feedEntityTypes() {
  return ontologyConfig.entityTypes.join('|');
}

// Display-only labels must not invalidate existing extraction fingerprints. Strip
// the inline labels before hashing so records made before labels were added keep
// their original category contract hash.
export function feedCategoryCatalogHash(text = ontologyText) {
  const contractText = text.replace(/, "label": "(?:[^"\\]|\\.)*"/g, '');
  return createHash('sha256').update(contractText).digest('hex');
}

export function parseFeedExtraction(text, sourceContent) {
  const response = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || Object.keys(response).length !== 2 || !Object.hasOwn(response, 'records') || !Object.hasOwn(response, 'categoryCandidates')
    || !Array.isArray(response.records) || !Array.isArray(response.categoryCandidates)
    || response.records.length + response.categoryCandidates.length > 3) {
    throw new Error('invalid feed extraction response');
  }
  const records = response.records.map(parseRecord);
  const categoryCandidates = response.categoryCandidates.map((value) => parseCategoryCandidate(value, sourceContent));
  if (categoryCandidates.some((candidate) => records.some((record) => record.statement === candidate.statement))) {
    throw new Error('feed category candidate duplicates a record');
  }
  return { records, categoryCandidates };
}

function parseCategoryCandidate(value, sourceContent) {
  const keys = ['entity', 'informationType', 'statement', 'suggestedCategory', 'evidence', 'whyNotExisting'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('invalid feed category candidate');
  }
  const candidate = Object.fromEntries(keys.map((key) => [key, typeof value[key] === 'string' ? value[key].trim() : '']));
  const { entity, informationType, statement, suggestedCategory, evidence, whyNotExisting } = candidate;
  if (!entity || entity.length > 120 || !informationTypes.has(informationType)
    || !statement || statement.length > 120 || !statement.includes(entity)
    || suggestedCategory.length < 2 || suggestedCategory.length > 40 || /^(?:其他|综合信息|一般事件)$/.test(suggestedCategory)
    || Object.hasOwn(categoryRules, suggestedCategory)
    || Object.values(categoryRules).some((rule) => rule.label === suggestedCategory)
    || evidence.length < 10 || evidence.length > 160 || !String(sourceContent || '').includes(evidence)
    || !whyNotExisting || whyNotExisting.length > 160) {
    throw new Error('invalid feed category candidate fields');
  }
  return candidate;
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
  const rule = typeof category === 'string' && Object.hasOwn(categoryRules, category) ? categoryRules[category] : undefined;
  const issues = [];
  if (!entity || entity.length > 120) issues.push('entity must contain 1–120 characters');
  if (!statement || statement.length > 120) issues.push('statement must contain 1–120 characters');
  if (!statement.includes(entity)) issues.push('statement must include entity');
  if (!informationTypes.has(informationType) || !rule?.informationTypes.includes(informationType)) {
    issues.push(`unsupported category/informationType: ${String(category)}/${String(informationType)}`);
  }
  if (period !== null && (typeof period !== 'string' || !isPeriod(period))) issues.push(`invalid period: ${JSON.stringify(period)}`);
  if (rule?.periodPolicy === 'required' && !period) issues.push(`period required for ${category}`);
  if (rule?.periodPolicy === 'forbidden' && period) issues.push(`period forbidden for ${category}`);
  if (issues.length) throw new Error(`invalid feed record fields: ${issues.join('; ')}`);
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

export function entityKeyForRecord(record, candidates) {
  const entity = normalizeName(record.entity);
  const matches = [...new Set(candidates.filter((candidate) =>
    normalizeName(candidate.name) === entity || normalizeName(candidate.matchedAlias) === entity
  ).map((candidate) => candidate.tagId))];
  return matches.length === 1 ? matches[0] : null;
}

export function companyTagsForRecords(records, candidates) {
  return [...new Set(records.map((record) => entityKeyForRecord(record, candidates)).filter(Boolean))];
}

function normalizeName(value) {
  return String(value || '').trim().replace(/(?:股份)?有限公司$/, '').toLowerCase();
}
