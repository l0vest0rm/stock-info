import { Hono } from 'hono';
import type { AppEnv } from '../../../types';
import { isLocalDevelopmentRuntime } from '../../../shared/request';
import { fail, ok } from '../../../shared/http';
import ontology from '../../../../config/knowledge-ontology.json';
import companyProfiles from '../../../../config/eastmoney-company-em2016-profiles.json';
import informationLabels from '../../../../web/src/config/information-feed-labels.json';
import feedConfig from '../../../../config/information-feed.json';
import { FEED_EXTRACTION_CONTRACT } from '../../../generated/information-records-contract';
import { currentExtractionSql, informationRowsJsonSql, recordsDigestInput, rowToInformation,
  sha256Text, sqlText, type InformationRow, type ExtractionState } from '../domain/information-records';

export const informationFeedRoutes = new Hono<AppEnv>();
type FeedRow = {
  doc_id: string; title: string; url: string | null; source_name: string | null;
  published_at: string | null; sort_time: string; summary: string | null;
  metadata_json: string; tags_json: string; records_json: string; current_valid: number;
};
const contract = FEED_EXTRACTION_CONTRACT;
const categories = new Set(Object.keys(ontology.informationExtraction.categories));
const nameByCompany = new Map(companyProfiles.profiles.map((item) => [`company:${item.code}`, item.name]));
const industryByCompany = new Map(companyProfiles.profiles.filter((item) => item.availability === 'available' && item.industry)
  .map((item) => [`company:${item.code}`, item.industry]));
const industryCompanies = new Map<string, string[]>();
for (const [company, industry] of industryByCompany) industryCompanies.set(industry, [...(industryCompanies.get(industry) || []), company]);

const currentPath = '$.informationExtraction.current';
const tagsJson = (alias: 'v' | 'd') => `(select coalesce(json_group_array(json_object('tagId',t.tag,'weight',t.weight)), '[]')
  from knowledge_doc_tags t where t.doc_id=${alias}.doc_id and (t.tag like 'company:%' or t.tag like 'category:%')
  and t.tagging_input_fingerprint=json_extract(${alias}.metadata_json,'${currentPath}.inputFingerprint')
  and t.contract_version=json_extract(${alias}.metadata_json,'${currentPath}.contractVersion')
  and t.contract_version=${sqlText(contract.contractVersion)})`;
const ELIGIBLE = `d.source_type='information_feed' and d.access_method='markdown'
  and json_extract(d.metadata_json,'$.feed.version')='v1'
  and json_extract(d.metadata_json,'$.feed.originalFormat')='text'
  and exists (select 1 from knowledge_doc_content_refs c where c.doc_id=d.doc_id and c.content_key is not null)`;
const TAGGED = `${currentExtractionSql('d', contract)}
  and json_extract(d.metadata_json,'$.feed.publishAllowed')=1
  and exists (select 1 from knowledge_information_records r where r.doc_id=d.doc_id)
  and not exists (select 1 from knowledge_information_records r where r.doc_id=d.doc_id
    and not exists (select 1 from knowledge_doc_tags t where t.doc_id=d.doc_id and t.tag='category:'||r.category
      and t.tagging_input_fingerprint=json_extract(d.metadata_json,'${currentPath}.inputFingerprint')
      and t.contract_version=json_extract(d.metadata_json,'${currentPath}.contractVersion')))`;
const selectFields = (alias: 'v' | 'd') => `${alias}.doc_id,${alias}.title,${alias}.url,${alias}.source_name,
  ${alias}.published_at,${alias}.sort_time,${alias}.summary,${alias}.metadata_json,
  ${tagsJson(alias)} as tags_json,${informationRowsJsonSql(alias)} as records_json,
  ${currentExtractionSql(alias, contract, true)} as current_valid`;

function visibleCte(local: boolean) {
  return `with ranked as (
    select d.doc_id,d.title,d.url,d.source_name,d.published_at,d.sort_time,d.summary,d.metadata_json,
      row_number() over (partition by json_extract(d.metadata_json,'$.feed.storyKey') order by d.sort_time desc,d.doc_id desc) as rn
    from knowledge_docs d where ${ELIGIBLE} ${local ? '' : `and ${TAGGED}`}
  ), visible as (select * from ranked where rn=1)`;
}
function parseCsv(value: string | undefined) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}
function placeholders(count: number) { return new Array(count).fill('?').join(','); }

async function verifiedRows(row: FeedRow): Promise<InformationRow[] | null> {
  if (!row.current_valid) return null;
  const current = JSON.parse(row.metadata_json).informationExtraction?.current;
  try {
    const rows = JSON.parse(row.records_json || '[]') as InformationRow[];
    if (rows.length !== current?.recordCount || await sha256Text(recordsDigestInput(rows)) !== current.recordsDigest) return null;
    return rows;
  } catch { return null; }
}

type RecordFilters = { categories: string[]; entities: string[]; companies: string[]; industries: string[] };
type EntityIdentity = { entity: string; entity_key: string | null };
const entityFacetId = (record: EntityIdentity) => record.entity_key || `entity:${encodeURIComponent(record.entity)}`;

function decodeEntityFacetId(id: string): { key: string | null; name: string | null } | null {
  if (id.startsWith('company:') && id.length <= 200) return { key: id, name: null };
  if (!id.startsWith('entity:') || id.length > 900) return null;
  try {
    const name = decodeURIComponent(id.slice('entity:'.length));
    return name && name.length <= 200 && `entity:${encodeURIComponent(name)}` === id ? { key: null, name } : null;
  } catch { return null; }
}

function matchesRecord(record: InformationRow, filters: RecordFilters): boolean {
  return (!filters.categories.length || filters.categories.includes(record.category))
    && (!filters.entities.length || filters.entities.includes(entityFacetId(record)))
    && (!filters.companies.length || !!record.entity_key && filters.companies.includes(record.entity_key))
    && (!filters.industries.length || !!record.entity_key && filters.industries.includes(record.entity_key));
}

async function mapRow(row: FeedRow, cutoff: string, local: boolean, filters?: RecordFilters) {
  const metadata = JSON.parse(row.metadata_json || '{}');
  const extraction = metadata.informationExtraction as ExtractionState | undefined;
  const rows = await verifiedRows(row);
  const valid = rows !== null;
  const tags = (valid ? JSON.parse(row.tags_json || '[]') : []) as Array<{ tagId: string; weight: number }>;
  const industries = [...new Set(tags.map((tag) => industryByCompany.get(tag.tagId)).filter((value): value is string => !!value))];
  const orderedRows = filters && (filters.categories.length || filters.entities.length || filters.companies.length || filters.industries.length)
    ? [...(rows || [])].sort((a, b) => Number(matchesRecord(b, filters)) - Number(matchesRecord(a, filters))) : rows || [];
  const leadingTags = new Set(orderedRows.length ? [`category:${orderedRows[0].category}`, orderedRows[0].entity_key] : []);
  const rawStatus = extraction?.status || 'pending';
  const status = !valid && row.sort_time < cutoff ? 'expired' : rawStatus === 'complete' && !valid ? 'pending' : rawStatus;
  return {
    doc_id: row.doc_id, title: row.title, url: row.url, source_name: row.source_name,
    published_at: row.published_at, sort_time: row.sort_time, summary: row.summary,
    content_type: metadata.feed?.contentType || 'news', kind: metadata.feed?.kind || 'new', story_key: metadata.feed?.storyKey || row.doc_id,
    tagging_status: status,
    sources: ((metadata.feed?.sources || []) as Array<{ sourceKey: string }>).map((source) => source.sourceKey),
    tags: tags.sort((a, b) => Number(leadingTags.has(b.tagId)) - Number(leadingTags.has(a.tagId)) || b.weight - a.weight), industries,
    records: orderedRows.map((record) => ({ ...rowToInformation(record), information_id: record.information_id,
      entity_key: record.entity_key })),
    ...(local ? { category_candidates: valid && Array.isArray(extraction?.categoryCandidates) ? extraction.categoryCandidates : null } : {}),
  };
}

informationFeedRoutes.get('/knowledge/feed', async (c) => {
  const local = isLocalDevelopmentRuntime(c.env);
  const cutoff = new Date(Date.now() - (feedConfig.automation.maxAgeHours || 48) * 3600000).toISOString();
  const sources = parseCsv(c.req.query('source'));
  const contentTypes = parseCsv(c.req.query('content_type'));
  const entities = parseCsv(c.req.query('entity'));
  const companies = parseCsv(c.req.query('company'));
  const selectedCategories = parseCsv(c.req.query('category'));
  const industries = parseCsv(c.req.query('industry'));
  const status = c.req.query('status')?.trim() || '';
  if (status && (!local || !['unclassified','category_gap','category_unassessed','pending','failed','complete','expired'].includes(status))) return fail(c, 400, 'invalid feed status');
  if (industries.some((industry) => !industryCompanies.has(industry))) return fail(c, 400, 'unknown industry');
  if (selectedCategories.some((category) => !categories.has(category))) return fail(c, 400, 'unknown category');
  const entityFilters = entities.map(decodeEntityFacetId);
  if (entityFilters.some((item) => !item)) return fail(c, 400, 'invalid entity');
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(c.req.query('limit') || 20) || 20)));
  const cursor = parseCursor(c.req.query('cursor'));
  if (c.req.query('cursor') && !cursor) return fail(c, 400, 'invalid cursor');
  const conditions = ['v.rn=1'];
  const binds: Array<string | number> = [];
  const valid = currentExtractionSql('v', contract, true);
  const extractionStatus = `coalesce(json_extract(v.metadata_json,'$.informationExtraction.status'),'pending')`;
  if (local && !status) { conditions.push(`not (v.sort_time < ? and not (${valid}))`); binds.push(cutoff); }
  if (sources.length) {
    conditions.push(`exists (select 1 from json_each(v.metadata_json,'$.feed.sources') src where json_extract(src.value,'$.sourceKey') in (${placeholders(sources.length)}))`);
    binds.push(...sources);
  }
  if (contentTypes.length) { conditions.push(`coalesce(json_extract(v.metadata_json,'$.feed.contentType'),'news') in (${placeholders(contentTypes.length)})`); binds.push(...contentTypes); }
  const companyKeys = companies.map((item) => `company:${item.replace(/^company:/, '')}`);
  const industryKeys = [...new Set(industries.flatMap((industry) => industryCompanies.get(industry) || []))];
  if (entities.length || companyKeys.length || selectedCategories.length || industryKeys.length) {
    const recordConditions = ['r.doc_id=v.doc_id'];
    if (entities.length) {
      const keys = entityFilters.flatMap((item) => item?.key ? [item.key] : []);
      const names = entityFilters.flatMap((item) => item?.name ? [item.name] : []);
      const alternatives = [];
      if (keys.length) { alternatives.push(`r.entity_key in (${placeholders(keys.length)})`); binds.push(...keys); }
      if (names.length) { alternatives.push(`(r.entity_key is null and r.entity in (${placeholders(names.length)}))`); binds.push(...names); }
      recordConditions.push(`(${alternatives.join(' or ')})`);
    }
    if (companyKeys.length) { recordConditions.push(`r.entity_key in (${placeholders(companyKeys.length)})`); binds.push(...companyKeys); }
    if (selectedCategories.length) { recordConditions.push(`r.category in (${placeholders(selectedCategories.length)})`); binds.push(...selectedCategories); }
    if (industryKeys.length) { recordConditions.push(`r.entity_key in (${placeholders(industryKeys.length)})`); binds.push(...industryKeys); }
    conditions.push(`${valid} and exists (select 1 from knowledge_information_records r where ${recordConditions.join(' and ')})`);
  }
  if (status === 'unclassified') conditions.push(`${valid} and json_extract(v.metadata_json,'${currentPath}.outcome')='no_information'`);
  else if (status === 'category_gap') conditions.push(`${valid} and json_extract(v.metadata_json,'${currentPath}.categoryCandidateCount')>0`);
  else if (status === 'category_unassessed') conditions.push(`${valid} and json_extract(v.metadata_json,'${currentPath}.categoryCandidateCount') is null`);
  else if (status === 'pending') {
    conditions.push(`v.sort_time >= ? and (${extractionStatus}='pending' or (${extractionStatus}='complete' and not (${valid})))`); binds.push(cutoff);
  } else if (status === 'expired') { conditions.push(`v.sort_time < ? and not (${valid})`); binds.push(cutoff); }
  else if (status === 'complete') conditions.push(valid);
  else if (status === 'failed') { conditions.push(`${extractionStatus}='failed' and v.sort_time >= ?`); binds.push(cutoff); }
  if (cursor) { conditions.push('(v.sort_time < ? or (v.sort_time = ? and v.doc_id < ?))'); binds.push(cursor.time, cursor.time, cursor.id); }
  const rows = await c.env.DB.prepare(`${visibleCte(local)} select ${selectFields('v')} from visible v
    where ${conditions.join(' and ')} order by v.sort_time desc,v.doc_id desc limit ?`).bind(...binds, pageSize + 1).all<FeedRow>();
  const page = rows.results.slice(0, pageSize);
  const hasNext = rows.results.length > pageSize;
  const mapped = await Promise.all(page.map((row) => mapRow(row, cutoff, local,
    { categories: selectedCategories, entities, companies: companyKeys, industries: industryKeys })));
  const list = local ? mapped : mapped.filter((row) => row.records.length > 0);
  const last = page.at(-1);
  return ok(c, { list, has_next: hasNext, next_cursor: hasNext && last ? btoa(JSON.stringify({ time: last.sort_time, id: last.doc_id })) : null });
});

informationFeedRoutes.get('/knowledge/feed/facets', async (c) => {
  const local = isLocalDevelopmentRuntime(c.env);
  const cutoff = new Date(Date.now() - (feedConfig.automation.maxAgeHours || 48) * 3600000).toISOString();
  const rows = await c.env.DB.prepare(`${visibleCte(local)} select ${selectFields('v')} from visible v`).all<FeedRow>();
  const sources = new Map<string, number>(), contentTypes = new Map<string, number>(), companies = new Map<string, number>();
  const entities = new Map<string, { count: number; label: string }>();
  const categoryCounts = new Map<string, number>(), industries = new Map<string, number>();
  const items = await Promise.all(rows.results.map((row) => mapRow(row, cutoff, local)));
  for (const item of items) {
    if ((local && item.tagging_status === 'expired') || (!local && !item.records.length)) continue;
    contentTypes.set(item.content_type, (contentTypes.get(item.content_type) || 0) + 1);
    for (const source of new Set(item.sources)) sources.set(source, (sources.get(source) || 0) + 1);
    for (const tag of item.tags) { const target = tag.tagId.startsWith('company:') ? companies : categoryCounts; target.set(tag.tagId, (target.get(tag.tagId) || 0) + 1); }
    const seenEntities = new Set<string>();
    for (const record of item.records) {
      const id = entityFacetId(record);
      if (seenEntities.has(id)) continue;
      seenEntities.add(id);
      const previous = entities.get(id);
      if (!previous) entities.set(id, { count: 1, label: id.startsWith('company:')
        ? `${nameByCompany.get(id) || record.entity}（${id.slice('company:'.length)}）` : record.entity });
      else previous.count += 1;
    }
    for (const industry of item.industries) industries.set(industry, (industries.get(industry) || 0) + 1);
  }
  const options = (map: Map<string, number>) => [...map].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return ok(c, { sources: options(sources), content_types: options(contentTypes),
    entities: [...entities].map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    companies: options(companies).map((item) => ({ ...item, label: nameByCompany.get(item.id) || item.id.replace(/^company:/, '') })),
    categories: options(categoryCounts).map((item) => ({ ...item, label: (informationLabels.categories as Record<string, string>)[item.id.replace(/^category:/, '')] || item.id })),
    industries: options(industries), ...(local ? { statuses: ['unclassified','category_gap','category_unassessed','pending','failed','complete','expired'] } : {}) });
});

informationFeedRoutes.get('/knowledge/feed/story', async (c) => {
  const storyKey = c.req.query('key')?.trim() || '';
  if (!/^f_[a-f0-9]{24}$/.test(storyKey)) return fail(c, 400, 'invalid story key');
  const local = isLocalDevelopmentRuntime(c.env);
  const cutoff = new Date(Date.now() - (feedConfig.automation.maxAgeHours || 48) * 3600000).toISOString();
  const rows = await c.env.DB.prepare(`select ${selectFields('d')} from knowledge_docs d where ${ELIGIBLE}
    and json_extract(d.metadata_json,'$.feed.storyKey')=? ${local ? '' : `and ${TAGGED}`}
    order by d.sort_time,d.doc_id limit 100`).bind(storyKey).all<FeedRow>();
  const list = await Promise.all(rows.results.map((row) => mapRow(row, cutoff, local)));
  return ok(c, { list: local ? list : list.filter((row) => row.records.length > 0) });
});

// Record-level input for entity summaries. No latest-card or 48-hour restriction.
informationFeedRoutes.get('/knowledge/information-records', async (c) => {
  const local = isLocalDevelopmentRuntime(c.env);
  const entityKey = c.req.query('entity_key')?.trim();
  const entity = c.req.query('entity')?.trim();
  if ((!entityKey && !entity) || (entityKey && entity) || (entityKey || entity || '').length > 200) return fail(c, 400, 'provide exactly one entity_key or entity');
  const category = c.req.query('category')?.trim();
  if (category && !categories.has(category)) return fail(c, 400, 'unknown category');
  const from = c.req.query('from'), to = c.req.query('to');
  if ([from,to].some((value) => value !== undefined && !Number.isFinite(Date.parse(value)))) return fail(c, 400, 'invalid date range');
  const cursor = parseCursor(c.req.query('cursor'));
  if (c.req.query('cursor') && (!cursor || !Number.isSafeInteger(cursor.position) || cursor.position! < 0)) return fail(c, 400, 'invalid cursor');
  const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query('limit') || 50) || 50)));
  const where = [currentExtractionSql('d', contract), entityKey ? 'r.entity_key=?' : 'r.entity=?'];
  const values: Array<string | number> = [entityKey || entity!];
  if (!local) where.push(ELIGIBLE, TAGGED);
  if (category) { where.push('r.category=?'); values.push(category); }
  if (from) { where.push('d.sort_time>=?'); values.push(new Date(from).toISOString()); }
  if (to) { where.push('d.sort_time<?'); values.push(new Date(to).toISOString()); }
  if (cursor) { where.push('(d.sort_time<? or (d.sort_time=? and (d.doc_id<? or (d.doc_id=? and r.sort_order>?))))'); values.push(cursor.time,cursor.time,cursor.id,cursor.id,cursor.position!); }
  const result = await c.env.DB.prepare(`select ${selectFields('d')},r.information_id as selected_information_id,r.sort_order as selected_position
    from knowledge_information_records r join knowledge_docs d on d.doc_id=r.doc_id where ${where.join(' and ')}
    order by d.sort_time desc,d.doc_id desc,r.sort_order limit ?`).bind(...values,limit+1).all<FeedRow & { selected_information_id: string; selected_position: number }>();
  const page = result.results.slice(0,limit);
  const cache = new Map<string, Promise<InformationRow[] | null>>();
  const list = [];
  for (const row of page) {
    if (!cache.has(row.doc_id)) cache.set(row.doc_id, verifiedRows(row));
    const selected = (await cache.get(row.doc_id))?.find((record) => record.information_id === row.selected_information_id);
    if (!selected) continue;
    const meta = JSON.parse(row.metadata_json);
    list.push({ ...rowToInformation(selected), information_id: selected.information_id, doc_id: row.doc_id,
      entity_key: selected.entity_key, entity_resolved: selected.entity_key !== null,
      source: { title: row.title, url: row.url, source_name: row.source_name, published_at: row.published_at },
      sort_time: row.sort_time, input_fingerprint: meta.informationExtraction.current.inputFingerprint,
      records_digest: meta.informationExtraction.current.recordsDigest,
      story_key: meta.feed?.storyKey ?? null, previous_item_id: meta.feed?.previousItemId ?? null,
      kind: meta.feed?.kind ?? null });
  }
  const hasNext = result.results.length > limit, last = page.at(-1);
  return ok(c, { list, has_next: hasNext, next_cursor: hasNext && last ? btoa(JSON.stringify({ time:last.sort_time,id:last.doc_id,position:last.selected_position })) : null });
});

function parseCursor(value: string | undefined): { time: string; id: string; position?: number } | null {
  if (!value || value.length > 1024) return null;
  try {
    const result = JSON.parse(atob(value));
    return typeof result?.time === 'string' && Number.isFinite(Date.parse(result.time))
      && typeof result?.id === 'string' && result.id.length > 0 && result.id.length <= 200 ? result : null;
  } catch { return null; }
}
