import { Hono } from 'hono';
import type { AppEnv } from '../../../types';
import { isLocalDevelopmentRuntime } from '../../../shared/request';
import { fail, ok } from '../../../shared/http';
import taxonomy from '../../../../config/information-feed-topics.json';
import feedConfig from '../../../../config/information-feed.json';

export const informationFeedRoutes = new Hono<AppEnv>();

type FeedRow = {
  doc_id: string; title: string; url: string | null; source_name: string | null;
  published_at: string | null; sort_time: string; summary: string | null;
  metadata_json: string; tags_json: string;
};

const topicMap = new Map(taxonomy.topics.map((item) => [`topic:${item.id}`, item]));
const currentTagContract = String(feedConfig.tagContract).replaceAll("'", "''");
const currentTaxonomyVersion = String(taxonomy.version).replaceAll("'", "''");
const industryTopics = new Map<string, string[]>();
for (const topic of taxonomy.topics) for (const industry of topic.industryIds) {
  industryTopics.set(industry, [...(industryTopics.get(industry) || []), `topic:${topic.id}`]);
}

const tagsJson = (alias: 'v' | 'd') => `(select coalesce(json_group_array(json_object('tagId',t.tag,'weight',t.weight)), '[]')
  from knowledge_doc_tags t where t.doc_id=${alias}.doc_id and (t.tag like 'company:%' or t.tag like 'topic:%')
  and t.tagging_input_fingerprint=json_extract(${alias}.metadata_json,'$.feed.taggingInputFingerprint')
  and t.contract_version=json_extract(${alias}.metadata_json,'$.feed.tagContract')
  and json_extract(${alias}.metadata_json,'$.feed.taxonomyVersion')='${currentTaxonomyVersion}'
  and t.contract_version='${currentTagContract}')`;
const ELIGIBLE = `d.source_type='information_feed' and d.access_method='markdown'
  and json_extract(d.metadata_json,'$.feed.version')='v1'
  and json_extract(d.metadata_json,'$.feed.originalFormat')='text'
  and exists (select 1 from knowledge_doc_content_refs c where c.doc_id=d.doc_id and c.content_key is not null)`;
const TAGGED = `json_extract(d.metadata_json,'$.feed.taggingStatus')='complete'
  and json_extract(d.metadata_json,'$.feed.tagContract')='${currentTagContract}'
  and json_extract(d.metadata_json,'$.feed.taxonomyVersion')='${currentTaxonomyVersion}'
  and json_extract(d.metadata_json,'$.feed.publishAllowed')=1
  and exists (select 1 from knowledge_doc_content_refs c where c.doc_id=d.doc_id
    and c.content_sha256=json_extract(d.metadata_json,'$.feed.taggingContentSha256'))
  and json_extract(d.metadata_json,'$.feed.taggingInputFingerprint') is not null
  and exists (select 1 from knowledge_doc_tags t where t.doc_id=d.doc_id
    and (t.tag like 'company:%' or t.tag like 'topic:%')
    and t.tagging_input_fingerprint=json_extract(d.metadata_json,'$.feed.taggingInputFingerprint')
    and t.contract_version=json_extract(d.metadata_json,'$.feed.tagContract'))`;

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

function mapRow(row: FeedRow) {
  const metadata = JSON.parse(row.metadata_json || '{}');
  const tags = JSON.parse(row.tags_json || '[]') as Array<{ tagId: string; weight: number }>;
  const industries = [...new Set(tags.flatMap((tag) => topicMap.get(tag.tagId)?.industryIds || []))];
  return {
    doc_id: row.doc_id, title: row.title, url: row.url, source_name: row.source_name,
    published_at: row.published_at, sort_time: row.sort_time, summary: row.summary,
    content_type: metadata.feed?.contentType || 'news', kind: metadata.feed?.kind || 'new', story_key: metadata.feed?.storyKey || row.doc_id,
    tagging_status: metadata.feed?.taggingStatus === 'complete' && (metadata.feed?.tagContract !== feedConfig.tagContract
      || metadata.feed?.taxonomyVersion !== taxonomy.version)
      ? 'pending' : (metadata.feed?.taggingStatus || 'pending'),
    sources: ((metadata.feed?.sources || []) as Array<{ sourceKey: string }>).map((source) => source.sourceKey),
    tags: tags.sort((a, b) => b.weight - a.weight), industries,
  };
}

informationFeedRoutes.get('/knowledge/feed', async (c) => {
  const local = isLocalDevelopmentRuntime(c.env);
  const sources = parseCsv(c.req.query('source'));
  const contentTypes = parseCsv(c.req.query('content_type'));
  const companies = parseCsv(c.req.query('company'));
  const topics = parseCsv(c.req.query('topic'));
  const industries = parseCsv(c.req.query('industry'));
  const status = c.req.query('status')?.trim() || '';
  if (status && (!local || !['unclassified', 'pending', 'failed', 'complete'].includes(status))) return fail(c, 400, 'invalid feed status');
  if (industries.some((industry) => !industryTopics.has(industry))) return fail(c, 400, 'unknown industry');
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(c.req.query('limit') || 20) || 20)));
  const cursor = parseCursor(c.req.query('cursor'));
  if (c.req.query('cursor') && !cursor) return fail(c, 400, 'invalid cursor');
  const conditions = ['v.rn=1'];
  const binds: Array<string | number> = [];
  if (sources.length) {
    conditions.push(`exists (select 1 from json_each(v.metadata_json,'$.feed.sources') src where json_extract(src.value,'$.sourceKey') in (${placeholders(sources.length)}))`);
    binds.push(...sources);
  }
  if (contentTypes.length) {
    conditions.push(`json_extract(v.metadata_json,'$.feed.contentType') in (${placeholders(contentTypes.length)})`);
    binds.push(...contentTypes);
  }
  const tagExists = (values: string[]) => {
    conditions.push(`exists (select 1 from knowledge_doc_tags t where t.doc_id=v.doc_id and t.tag in (${placeholders(values.length)})
      and t.tagging_input_fingerprint=json_extract(v.metadata_json,'$.feed.taggingInputFingerprint')
      and t.contract_version=json_extract(v.metadata_json,'$.feed.tagContract')
      and json_extract(v.metadata_json,'$.feed.taxonomyVersion')='${currentTaxonomyVersion}'
      and t.contract_version='${currentTagContract}')`);
    binds.push(...values);
  };
  if (companies.length) tagExists(companies.map((item) => `company:${item.replace(/^company:/, '')}`));
  if (topics.length) tagExists(topics.map((item) => `topic:${item.replace(/^topic:/, '')}`));
  if (industries.length) tagExists([...new Set(industries.flatMap((industry) => industryTopics.get(industry) || []))]);
  if (status === 'unclassified') conditions.push(`not exists (select 1 from knowledge_doc_tags t where t.doc_id=v.doc_id and (t.tag like 'company:%' or t.tag like 'topic:%')
    and t.tagging_input_fingerprint=json_extract(v.metadata_json,'$.feed.taggingInputFingerprint')
    and json_extract(v.metadata_json,'$.feed.taxonomyVersion')='${currentTaxonomyVersion}' and t.contract_version='${currentTagContract}')`);
  else if (status === 'pending') conditions.push(`(json_extract(v.metadata_json,'$.feed.taggingStatus')='pending'
    or (json_extract(v.metadata_json,'$.feed.taggingStatus')='complete' and (json_extract(v.metadata_json,'$.feed.tagContract')!='${currentTagContract}'
      or coalesce(json_extract(v.metadata_json,'$.feed.taxonomyVersion'),'')!='${currentTaxonomyVersion}')))`);
  else if (status) {
    conditions.push(`json_extract(v.metadata_json,'$.feed.taggingStatus')=?${status === 'complete' ? ` and json_extract(v.metadata_json,'$.feed.tagContract')='${currentTagContract}'
      and json_extract(v.metadata_json,'$.feed.taxonomyVersion')='${currentTaxonomyVersion}'` : ''}`);
    binds.push(status);
  }
  if (cursor) { conditions.push('(v.sort_time < ? or (v.sort_time = ? and v.doc_id < ?))'); binds.push(cursor.time, cursor.time, cursor.id); }
  const sql = `${visibleCte(local)} select v.doc_id,v.title,v.url,v.source_name,v.published_at,v.sort_time,v.summary,v.metadata_json,
    ${tagsJson('v')} as tags_json from visible v where ${conditions.join(' and ')}
    order by v.sort_time desc,v.doc_id desc limit ?`;
  const rows = await c.env.DB.prepare(sql).bind(...binds, pageSize + 1).all<FeedRow>();
  const hasNext = rows.results.length > pageSize;
  const list = rows.results.slice(0, pageSize).map(mapRow);
  const last = list.at(-1);
  return ok(c, { list, has_next: hasNext, next_cursor: hasNext && last ? btoa(JSON.stringify({ time: last.sort_time, id: last.doc_id })) : null });
});

informationFeedRoutes.get('/knowledge/feed/facets', async (c) => {
  const local = isLocalDevelopmentRuntime(c.env);
  const rows = await c.env.DB.prepare(`${visibleCte(local)} select v.doc_id,v.title,v.url,v.source_name,v.published_at,v.sort_time,v.summary,v.metadata_json,
    ${tagsJson('v')} as tags_json from visible v`).all<FeedRow>();
  const sources = new Map<string, number>();
  const contentTypes = new Map<string, number>();
  const companies = new Map<string, number>();
  const topics = new Map<string, number>();
  const industries = new Map<string, number>();
  for (const row of rows.results) {
    const item = mapRow(row);
    contentTypes.set(item.content_type, (contentTypes.get(item.content_type) || 0) + 1);
    for (const source of new Set(item.sources)) sources.set(source, (sources.get(source) || 0) + 1);
    for (const tag of item.tags) {
      const target = tag.tagId.startsWith('company:') ? companies : topics;
      target.set(tag.tagId, (target.get(tag.tagId) || 0) + 1);
    }
    for (const industry of item.industries) industries.set(industry, (industries.get(industry) || 0) + 1);
  }
  const options = (map: Map<string, number>) => [...map].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return ok(c, { sources: options(sources), content_types: options(contentTypes), companies: options(companies),
    topics: options(topics).map((item) => ({ ...item, label: topicMap.get(item.id)?.label || item.id })),
    industries: options(industries), ...(local ? { statuses: ['unclassified', 'pending', 'failed', 'complete'] } : {}) });
});

informationFeedRoutes.get('/knowledge/feed/story', async (c) => {
  const storyKey = c.req.query('key')?.trim() || '';
  if (!/^f_[a-f0-9]{24}$/.test(storyKey)) return fail(c, 400, 'invalid story key');
  const local = isLocalDevelopmentRuntime(c.env);
  const rows = await c.env.DB.prepare(`select d.doc_id,d.title,d.url,d.source_name,d.published_at,d.sort_time,d.summary,d.metadata_json,
    ${tagsJson('d')} as tags_json from knowledge_docs d where ${ELIGIBLE}
    and json_extract(d.metadata_json,'$.feed.storyKey')=? ${local ? '' : `and ${TAGGED}`}
    order by d.sort_time,d.doc_id limit 100`).bind(storyKey).all<FeedRow>();
  return ok(c, { list: rows.results.map(mapRow) });
});

function parseCursor(value: string | undefined): { time: string; id: string } | null {
  if (!value || value.length > 512) return null;
  try {
    const result = JSON.parse(atob(value));
    return typeof result?.time === 'string' && typeof result?.id === 'string' ? result : null;
  } catch { return null; }
}
