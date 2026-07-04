import { Hono } from "hono";
import { fail, ok } from '../../../shared/http';
import { normalizeSupportedCompanyCode } from "../../../shared/codes";
import type { AppEnv } from '../../../types';

export const knowledgeRoutes = new Hono<AppEnv>();

type KnowledgeDocRow = {
  doc_id: string;
  source_type: string;
  report_type: string | null;
  source_name: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  event_time: string | null;
  target_name: string | null;
  target_code: string | null;
  discovery_method: string | null;
  access_method: string | null;
  summary: string | null;
  content_key: string | null;
  content_url: string | null;
  content_type: string | null;
  content_encoding: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
  content_preview: string | null;
  metadata_json: string | null;
  recommendation_score: number;
  recommendation_level: string | null;
  recommendation_tags_json: string | null;
  recommendation_reasons_json: string | null;
  rank_score: number;
  source_weight: number;
  updated_at: number;
};

type KnowledgeContentRefRow = {
  content_key: string | null;
  content_url: string | null;
  content_type: string | null;
  content_encoding: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
};

type KnowledgeDocsQuery = {
  sourceType: string;
  source: string;
  code: string;
  tags: string[];
  q: string;
  page: number;
  pageSize: number;
};

type KnowledgeContentUrlContext = {
  local: boolean;
  origin: string;
  publicBaseUrl: string;
};

type KnowledgeFilteredDocRow = {
  doc_id: string;
  source_type: string;
  report_type: string | null;
  source_name: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  event_time: string | null;
  target_name: string | null;
  target_code: string | null;
  access_method: string | null;
  summary: string | null;
  content_key: string | null;
  content_url: string | null;
  content_type: string | null;
  content_encoding: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
  content_preview: string | null;
  metadata_json: string | null;
  filter_method: string | null;
  filter_score: number;
  filter_confidence: number | null;
  filter_reasons_json: string | null;
  source_file: string | null;
  reviewed_status: string;
  reviewed_at: number | null;
  updated_at: number;
};

const KNOWLEDGE_DOC_BASE_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code,
  d.discovery_method, d.access_method, d.summary, c.content_key, c.content_url, c.content_type,
  c.content_encoding, c.content_bytes, c.content_sha256, d.content_preview, d.metadata_json,
  d.recommendation_score, d.recommendation_level, d.recommendation_tags_json,
  d.recommendation_reasons_json, d.rank_score, d.source_weight, d.updated_at
 from knowledge_docs d
 left join knowledge_doc_content_refs c on c.doc_id = d.doc_id`;

const KNOWLEDGE_DOC_LIST_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code,
  d.discovery_method, d.access_method, d.summary, null as content_key, null as content_url, null as content_type,
  null as content_encoding, 0 as content_bytes, null as content_sha256, d.content_preview, d.metadata_json,
  d.recommendation_score, d.recommendation_level, d.recommendation_tags_json,
  d.recommendation_reasons_json, d.rank_score, d.source_weight, d.updated_at
 from knowledge_docs d`;

const KNOWLEDGE_DOC_TIME_ORDER = "d.sort_time desc, d.rank_score desc, d.doc_id desc";

const KNOWLEDGE_FILTERED_DETAIL_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code, d.access_method, d.summary,
  c.content_key, c.content_url, c.content_type, c.content_encoding, c.content_bytes, c.content_sha256,
  d.content_preview, d.metadata_json, d.filter_method, d.filter_score, d.filter_confidence,
  d.filter_reasons_json, d.source_file, d.reviewed_status, d.reviewed_at, d.updated_at
 from knowledge_filtered_docs d
 left join knowledge_filtered_doc_content_refs c on c.doc_id = d.doc_id`;

const KNOWLEDGE_FILTERED_LIST_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code, d.access_method, d.summary,
  null as content_key, null as content_url, null as content_type, null as content_encoding, 0 as content_bytes, null as content_sha256,
  d.content_preview, d.metadata_json, d.filter_method, d.filter_score, d.filter_confidence,
  d.filter_reasons_json, d.source_file, d.reviewed_status, d.reviewed_at, d.updated_at
 from knowledge_filtered_docs d`;

knowledgeRoutes.get("/knowledge/docs", async (c) => {
  const query = parseDocsQuery(c.req.query());
  if (query.q && !isKnowledgeTextSearchEnabled(c.env)) {
    return fail(c, 400, "keyword search is only enabled for local development");
  }
  const { whereSql, binds } = buildKnowledgeWhere(query);
  const deduped = await listKnowledgeDocsDeduped(c.env.DB, query, whereSql, binds, knowledgeContentUrlContext(c));
  return ok(c, {
    page: query.page,
    page_size: query.pageSize,
    total: deduped.total,
    has_next: deduped.hasNext,
    list: deduped.list,
  });
});

knowledgeRoutes.get("/knowledge/doc", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) {
    return fail(c, 400, "missing doc id");
  }
  const row = await c.env.DB.prepare(
    `${KNOWLEDGE_DOC_BASE_SELECT}
     where d.doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeDocRow>();
  if (!row) {
    return fail(c, 404, `knowledge document not found: ${id}`);
  }
  return ok(c, await mapKnowledgeDocDetail(row, knowledgeContentUrlContext(c)));
});

knowledgeRoutes.get("/knowledge/filtered", async (c) => {
  const q = String(c.req.query("q") ?? "").trim();
  if (q && !isKnowledgeTextSearchEnabled(c.env)) {
    return fail(c, 400, "keyword search is only enabled for local development");
  }
  const status = normalizeFilter(c.req.query("status") ?? "pending") || "pending";
  const page = clampInteger(c.req.query("page"), 1, 1, 10000);
  const pageSize = clampInteger(c.req.query("pageSize"), 50, 1, 100);
  const filters = ["reviewed_status = ?"];
  const binds: unknown[] = [status];
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    filters.push(`(
      lower(title) like ?
      or lower(coalesce(source_name, '')) like ?
      or lower(coalesce(target_name, '')) like ?
      or lower(coalesce(target_code, '')) like ?
      or lower(coalesce(url, '')) like ?
    )`);
    binds.push(like, like, like, like, like);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const offset = (page - 1) * pageSize;
  const rows = await c.env.DB.prepare(
    `${KNOWLEDGE_FILTERED_LIST_SELECT}
       ${whereSql}
       order by d.filter_score desc, coalesce(d.event_time, d.published_at, d.fetched_at) desc, d.doc_id desc
       limit ? offset ?`
  )
    .bind(...binds, pageSize, offset)
    .all<KnowledgeFilteredDocRow>();
  return ok(c, {
    page,
    page_size: pageSize,
    list: (rows.results ?? []).map((row) => mapFilteredDocListItem(row, knowledgeContentUrlContext(c))),
  });
});

knowledgeRoutes.get("/knowledge/filtered/doc", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) return fail(c, 400, "missing doc id");
  const row = await c.env.DB.prepare(
    `${KNOWLEDGE_FILTERED_DETAIL_SELECT}
     where d.doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeFilteredDocRow>();
  if (!row) return fail(c, 404, `filtered document not found: ${id}`);
  return ok(c, await mapFilteredDocDetail(row, knowledgeContentUrlContext(c)));
});

knowledgeRoutes.post("/knowledge/filtered/keep", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { id?: string };
  const id = String(body.id || c.req.query("id") || "").trim();
  if (!id) return fail(c, 400, "missing doc id");
  const row = await c.env.DB.prepare(
    `${KNOWLEDGE_FILTERED_DETAIL_SELECT}
     where d.doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeFilteredDocRow>();
  if (!row) return fail(c, 404, `filtered document not found: ${id}`);
  const tags = ["review_kept"];
  const now = Date.now();
  await c.env.DB.prepare(
    `insert into knowledge_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, discovery_method, access_method, summary,
      content_preview, metadata_json, recommendation_score, recommendation_level,
      recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight,
      sort_time, source_name_normalized, target_code_normalized, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'filtered_review_keep', ?,
      ?, ?, ?, 1, 'D', ?, ?, 1, 0, ?, ?, ?, ?)
    on conflict(doc_id) do update set
      source_type=excluded.source_type,
      report_type=excluded.report_type,
      source_name=excluded.source_name,
      title=excluded.title,
      url=excluded.url,
      published_at=excluded.published_at,
      fetched_at=excluded.fetched_at,
      event_time=excluded.event_time,
      target_name=excluded.target_name,
      target_code=excluded.target_code,
      discovery_method=excluded.discovery_method,
      access_method=excluded.access_method,
      summary=excluded.summary,
      content_preview=excluded.content_preview,
      metadata_json=excluded.metadata_json,
      recommendation_tags_json=excluded.recommendation_tags_json,
      recommendation_reasons_json=excluded.recommendation_reasons_json,
      sort_time=excluded.sort_time,
      source_name_normalized=excluded.source_name_normalized,
      target_code_normalized=excluded.target_code_normalized,
      updated_at=excluded.updated_at`
  )
    .bind(
      row.doc_id, row.source_type, row.report_type || row.source_type, row.source_name || "",
      row.title, row.url || "", row.published_at || "", row.fetched_at || "",
      row.event_time || row.published_at || row.fetched_at || "", row.target_name || "", row.target_code || "",
      row.access_method || "", row.summary || "", row.content_preview || "",
      row.metadata_json || "{}", JSON.stringify(tags), row.filter_reasons_json || "[]",
      firstNonEmpty(row.event_time, row.published_at, row.fetched_at),
      normalizeLower(row.source_name),
      normalizeUpper(row.target_code),
      now,
    )
    .run();
  await upsertKnowledgeDocContentRef(c.env.DB, {
    docId: row.doc_id,
    content_key: row.content_key,
    content_url: row.content_url,
    content_type: row.content_type,
    content_encoding: row.content_encoding,
    content_bytes: row.content_bytes,
    content_sha256: row.content_sha256,
  }, now);
  await replaceKnowledgeDocSecurityLinks(c.env.DB, row.doc_id, extractKnowledgeSecurityCodes(row.target_code, parseJsonObject(row.metadata_json)));
  await c.env.DB.prepare(
    `update knowledge_filtered_docs set reviewed_status = 'kept', reviewed_at = ?, updated_at = ? where doc_id = ?`
  ).bind(now, now, id).run();
  return ok(c, { kept: true, doc_id: id });
});

knowledgeRoutes.get("/knowledge/sources", async (c) => {
  const sourceType = normalizeSourceType(c.req.query("sourceType") ?? "");
  const binds: unknown[] = [];
  const filters: string[] = ["coalesce(source_name, '') != ''"];
  if (sourceType) {
    if (sourceType === "company_report") {
      filters.push("source_type = 'research_report'", "report_type = 'company_report'");
    } else if (sourceType === "industry_report") {
      filters.push("source_type = 'research_report'", "report_type = 'industry_report'");
    } else {
      filters.push("source_type = ?");
      binds.push(sourceType);
    }
  }
  const rows = await c.env.DB.prepare(
    `select source_name as name, count(*) as count
       from knowledge_docs
       where ${filters.join(" and ")}
       group by source_name
       order by count(*) desc, source_name asc
       limit 200`
  )
    .bind(...binds)
    .all<{ name: string; count: number }>();
  return ok(c, {
    list: (rows.results ?? [])
      .map((row) => ({
        key: row.name,
        name: displaySourceName(row.name),
        count: row.count,
      }))
      .filter((row) => row.name),
  });
});

knowledgeRoutes.get("/knowledge/file", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) {
    return fail(c, 400, "missing doc id");
  }
  const row = await c.env.DB.prepare("select url from knowledge_docs where doc_id = ?")
    .bind(id)
    .first<{ url: string | null }>();
  if (!row?.url) {
    return fail(c, 404, "document file is not stored; original url is unavailable");
  }
  return c.redirect(row.url, 302);
});

knowledgeRoutes.get("/knowledge/content", async (c) => {
  const key = c.req.query("key")?.trim() ?? "";
  if (!key) {
    return fail(c, 400, "missing content key");
  }
  if (key.startsWith("localfs:")) {
    return fail(c, 410, "localfs knowledge content is no longer supported; re-import or migrate content_key to knowledge-content/*");
  }
  const response = await readKnowledgeContentResponse(key, c.env);
  if (!response) {
    return fail(c, 404, `knowledge content not found: ${key}`);
  }
  return response;
});

function parseDocsQuery(raw: Record<string, string>): KnowledgeDocsQuery {
  return {
    sourceType: normalizeSourceType(raw.sourceType ?? ""),
    source: normalizeSource(raw.source ?? ""),
    code: normalizeSecurityCode(raw.code ?? ""),
    tags: String(raw.tags ?? raw.tag ?? "")
      .split(",")
      .map((item) => normalizeFilter(item))
      .filter(Boolean),
    q: String(raw.q ?? "").trim(),
    page: clampInteger(raw.page, 1, 1, 10000),
    pageSize: clampInteger(raw.pageSize, 50, 1, 100),
  };
}

function knowledgeContentUrlContext(c: { env: AppEnv["Bindings"]; req: { raw: Request } }): KnowledgeContentUrlContext {
  const url = new URL(c.req.raw.url);
  const host = c.req.raw.headers.get("host") || "";
  return {
    local: isLocalRequest(c.req.raw) || isKnowledgeTextSearchEnabled(c.env),
    origin: host ? `${url.protocol}//${host}` : url.origin,
    publicBaseUrl: String(c.env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || "").trim(),
  };
}

function resolveKnowledgeContentUrl(
  row: Pick<KnowledgeContentRefRow, "content_key" | "content_url">,
  context: KnowledgeContentUrlContext,
): string {
  const key = String(row.content_key || "").trim();
  if (key) {
    return `/api/knowledge/content?key=${encodeURIComponent(key)}`;
  }
  if (!key) {
    const storedUrl = String(row.content_url || "").trim();
    if (storedUrl) {
      return storedUrl;
    }
    return "";
  }
  if (context.publicBaseUrl) {
    return `${context.publicBaseUrl.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  const storedUrl = String(row.content_url || "").trim();
  if (storedUrl) {
    return storedUrl;
  }
  return "";
}

function isLocalRequest(request: Request | string): boolean {
  const requestUrl = typeof request === "string" ? request : request.url;
  const headerHost = typeof request === "string" ? "" : (request.headers.get("host") || "");
  const hosts = [new URL(requestUrl).hostname, headerHost.split(":")[0]]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return hosts.some((hostname) =>
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
  ) || (typeof request !== "string" && !(request as Request & { cf?: unknown }).cf);
}

function normalizeSource(value: string): string {
  const normalized = normalizeFilter(value);
  return normalized === "all" ? "" : normalized;
}

function isKnowledgeTextSearchEnabled(env: AppEnv["Bindings"]): boolean {
  return ["1", "true", "yes", "on"].includes(String(env.KNOWLEDGE_ALLOW_TEXT_SEARCH || "").trim().toLowerCase());
}

function buildKnowledgeWhere(query: KnowledgeDocsQuery): { whereSql: string; binds: unknown[] } {
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (query.sourceType) {
    if (query.sourceType === "company_report") {
      filters.push("d.source_type = 'research_report'", "d.report_type = 'company_report'");
    } else if (query.sourceType === "industry_report") {
      filters.push("d.source_type = 'research_report'", "d.report_type = 'industry_report'");
    } else {
      filters.push("d.source_type = ?");
      binds.push(query.sourceType);
    }
  }
  if (query.source) {
    filters.push("d.source_name_normalized = ?");
    binds.push(query.source);
  }
  if (query.code) {
    filters.push("d.doc_id in (select l.doc_id from knowledge_doc_security_links l where l.code = ?)");
    binds.push(query.code);
  }
  if (query.q) {
    const like = `%${query.q.toLowerCase()}%`;
    filters.push(`(
      lower(d.title) like ?
      or lower(coalesce(d.source_name, '')) like ?
      or lower(coalesce(d.target_name, '')) like ?
      or lower(coalesce(d.target_code, '')) like ?
      or lower(coalesce(d.content_preview, '')) like ?
      or lower(coalesce(d.url, '')) like ?
    )`);
    binds.push(like, like, like, like, like, like);
  }
  for (const tag of query.tags) {
    if (tag.startsWith("recommendation:")) {
      filters.push("upper(coalesce(d.recommendation_level, '')) = ?");
      binds.push(tag.slice("recommendation:".length).toUpperCase());
      continue;
    }
    filters.push("exists (select 1 from knowledge_doc_tags t where t.doc_id = d.doc_id and lower(t.tag) = ?)");
    binds.push(tag);
  }
  return {
    whereSql: filters.length > 0 ? `where ${filters.join(" and ")}` : "",
    binds,
  };
}

function mapKnowledgeDocListItem(row: KnowledgeDocRow, contentContext: KnowledgeContentUrlContext): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata_json);
  const target = sanitizeKnowledgeTarget(row.title, row.target_name || "", row.target_code || "", metadata);
  const stockLinks = stockLinksFromMetadata(metadata, target.name, target.code);
  const sanitizedMetadata = sanitizeKnowledgeMetadata(metadata, stockLinks);
  const recommendationTags = sanitizeKnowledgeDisplayTags(parseJsonArray(row.recommendation_tags_json), stockLinks);
  const contentUrl = resolveKnowledgeContentUrl(row, contentContext);
  const tags = [
    ...recommendationTags,
    ...(isPdf(row) ? ["pdf"] : []),
  ];
  return {
    doc_id: row.doc_id,
    source_type: row.source_type,
    report_type: row.report_type || row.source_type,
    source_name: displaySourceName(row.source_name),
    title: row.title,
    url: row.url || "",
    published_at: row.published_at || "",
    fetched_at: row.fetched_at || "",
    event_time: row.event_time || row.published_at || row.fetched_at || "",
    target_name: target.name,
    target_code: target.code,
    discovery_method: row.discovery_method || metadata.discovery_method || "",
    access_method: resolveKnowledgeAccessMethod(row),
    summary: row.summary || "",
    content_preview: buildKnowledgePreview(row),
    content_key: row.content_key || "",
    content_url: contentUrl,
    content_type: row.content_type || "text/markdown; charset=utf-8",
    content_encoding: row.content_encoding || "identity",
    content_bytes: row.content_bytes || 0,
    content_sha256: row.content_sha256 || "",
    metadata: sanitizedMetadata,
    stock_links: stockLinks,
    tags: unique(tags),
    recommendation: {
      level: "",
      score: row.recommendation_score || 0,
      tags: recommendationTags,
      reasons: parseJsonArray(row.recommendation_reasons_json),
    },
    rankScore: row.rank_score || 0,
    rankReasons: rankReasons(row),
    favorited: false,
  };
}

async function mapKnowledgeDocDetail(
  row: KnowledgeDocRow,
  contentContext: KnowledgeContentUrlContext,
): Promise<Record<string, unknown>> {
  return {
    ...mapKnowledgeDocListItem(row, contentContext),
  };
}

function mapFilteredDocListItem(row: KnowledgeFilteredDocRow, contentContext: KnowledgeContentUrlContext): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata_json);
  const filterReasons = parseJsonArray(row.filter_reasons_json);
  const target = sanitizeKnowledgeTarget(row.title, row.target_name || "", row.target_code || "", metadata);
  const stockLinks = stockLinksFromMetadata(metadata, target.name, target.code);
  const sanitizedMetadata = sanitizeKnowledgeMetadata(metadata, stockLinks);
  const contentUrl = resolveKnowledgeContentUrl(row, contentContext);
  return {
    doc_id: row.doc_id,
    source_type: row.source_type,
    report_type: row.report_type || row.source_type,
    source_name: displaySourceName(row.source_name),
    title: row.title,
    url: row.url || "",
    published_at: row.published_at || "",
    fetched_at: row.fetched_at || "",
    event_time: row.event_time || row.published_at || row.fetched_at || "",
    target_name: target.name,
    target_code: target.code,
    discovery_method: "filtered_review",
    access_method: row.access_method || "",
    summary: row.summary || "",
    content_preview: row.content_preview || "",
    content_key: row.content_key || "",
    content_url: contentUrl,
    content_type: row.content_type || "text/markdown; charset=utf-8",
    content_encoding: row.content_encoding || "identity",
    content_bytes: row.content_bytes || 0,
    content_sha256: row.content_sha256 || "",
    metadata: sanitizedMetadata,
    stock_links: stockLinks,
    tags: ["filtered"],
    recommendation: {
      level: "",
      score: row.filter_score || 0,
      tags: ["filtered"],
      reasons: filterReasons,
    },
    rankScore: row.filter_score || 0,
    rankReasons: filterReasons,
    filter: {
      method: row.filter_method || "",
      score: row.filter_score || 0,
      confidence: row.filter_confidence,
      reasons: filterReasons,
      status: row.reviewed_status,
      sourceFile: row.source_file || "",
    },
    favorited: false,
  };
}

async function mapFilteredDocDetail(
  row: KnowledgeFilteredDocRow,
  contentContext: KnowledgeContentUrlContext,
): Promise<Record<string, unknown>> {
  return {
    ...mapFilteredDocListItem(row, contentContext),
  };
}

async function readKnowledgeContentResponse(
  key: string,
  env: AppEnv["Bindings"],
): Promise<Response | null> {
  const localResponse = await readKnowledgeContentFromLocalMirror(key, env);
  if (localResponse) {
    return localResponse;
  }
  if (env.KNOWLEDGE_CONTENT_BUCKET) {
    const object = await env.KNOWLEDGE_CONTENT_BUCKET.get(key);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }
  }
  return fetchKnowledgeContentFromPublicUrl(key, env);
}

async function readKnowledgeContentFromLocalMirror(
  key: string,
  env: AppEnv["Bindings"],
): Promise<Response | null> {
  const normalizedKey = normalizeKnowledgeContentKey(key);
  if (!normalizedKey) {
    return null;
  }
  const row = await env.DB.prepare(
    `select content_type, content_encoding, content_bytes
       from knowledge_local_content_cache
      where content_key = ?`
  )
    .bind(normalizedKey)
    .first<{ content_type: string | null; content_encoding: string | null; content_bytes: number | null }>();
  const chunkRows = await env.DB.prepare(
    `select payload_base64
       from knowledge_local_content_cache_chunks
      where content_key = ?
      order by chunk_index asc`
  )
    .bind(normalizedKey)
    .all<{ payload_base64: string | null }>();
  const payloadBase64 = chunkRows.results.length > 0
    ? chunkRows.results.map((chunk) => String(chunk.payload_base64 || "")).join("")
    : "";
  if (!payloadBase64) {
    return null;
  }
  const bytes = decodeBase64(payloadBase64);
  const headers = new Headers({
    "content-type": String(row?.content_type || "text/markdown; charset=utf-8"),
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(row?.content_bytes || bytes.byteLength),
  });
  const encoding = String(row?.content_encoding || "").trim();
  if (encoding && encoding !== "identity") {
    headers.set("content-encoding", encoding);
  }
  return new Response(bytes, { headers });
}

async function fetchKnowledgeContentFromPublicUrl(key: string, env: AppEnv["Bindings"]): Promise<Response | null> {
  const baseUrl = String(env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return null;
  }
  const response = await fetch(`${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`);
  if (!response.ok) {
    return null;
  }
  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function normalizeKnowledgeContentKey(key: string): string {
  const value = String(key || "").trim().replace(/^\/+|\/+$/g, "");
  if (!value.startsWith("knowledge-content/")) {
    return "";
  }
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    return "";
  }
  return value;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function upsertKnowledgeDocContentRef(
  db: AppEnv["Bindings"]["DB"],
  row: { docId: string } & KnowledgeContentRefRow,
  updatedAt: number,
): Promise<void> {
  const hasRef = [
    row.content_key,
    row.content_url,
    row.content_sha256,
    row.content_bytes,
  ].some((value) => String(value ?? "").trim() !== "" && String(value ?? "0") !== "0");
  if (!hasRef) {
    await db.prepare("delete from knowledge_doc_content_refs where doc_id = ?")
      .bind(row.docId)
      .run();
    return;
  }
  await db.prepare(
    `insert into knowledge_doc_content_refs (
      doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(doc_id) do update set
      content_key=excluded.content_key,
      content_url=excluded.content_url,
      content_type=excluded.content_type,
      content_encoding=excluded.content_encoding,
      content_bytes=excluded.content_bytes,
      content_sha256=excluded.content_sha256,
      updated_at=excluded.updated_at`
  )
    .bind(
      row.docId,
      row.content_key || "",
      row.content_url || "",
      row.content_type || "text/markdown; charset=utf-8",
      row.content_encoding || "identity",
      row.content_bytes || 0,
      row.content_sha256 || "",
      updatedAt,
    )
    .run();
}

async function replaceKnowledgeDocSecurityLinks(
  db: AppEnv["Bindings"]["DB"],
  docId: string,
  codes: string[],
): Promise<void> {
  await db.prepare("delete from knowledge_doc_security_links where doc_id = ?")
    .bind(docId)
    .run();
  if (codes.length === 0) {
    return;
  }
  const stmt = db.prepare(
    `insert into knowledge_doc_security_links (doc_id, code)
     values (?, ?)
     on conflict(doc_id, code) do nothing`
  );
  await db.batch(codes.map((code) => stmt.bind(docId, code)));
}

function normalizeSourceType(value: string): string {
  const normalized = normalizeFilter(value);
  return normalized === "all" ? "" : normalized;
}

function normalizeFilter(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSecurityCode(value: string): string {
  return value.trim().toUpperCase();
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stockLinksFromMetadata(metadata: Record<string, unknown>, targetName: string, targetCode: string): Array<Record<string, unknown>> {
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  const fallback = targetName || targetCode
    ? [{ name: targetName, code: targetCode, aliases: [targetName, targetCode].filter(Boolean) }]
    : [];
  return (links.length > 0 ? links : fallback)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const code = normalizeKnowledgeStockCode(String(item.code || ""));
      return {
        name: String(item.name || ""),
        code,
        aliases: buildSecurityAliases(
          String(item.name || ""),
          code,
          Array.isArray(item.aliases)
            ? item.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
            : [],
        ),
      };
    })
    .filter((item) => item.code);
}

function sanitizeKnowledgeTarget(title: string, targetName: string, targetCode: string, metadata: Record<string, unknown>): { name: string; code: string } {
  const normalizedCode = normalizeKnowledgeStockCode(targetCode);
  const stockNames = Array.isArray(metadata.stockNames) ? metadata.stockNames : [];
  if (metadata.source !== "tencent_stock_news" || stockNames.length <= 1) {
    return { name: targetName, code: normalizedCode };
  }
  const baseName = securityBaseName(targetName);
  if (baseName && title.includes(baseName) && !isSecurityDisplayTag(targetName)) {
    return { name: targetName, code: normalizedCode };
  }
  return { name: "", code: "" };
}

function securityBaseName(name: string): string {
  return name
    .trim()
    .replace(/\.(SH|SZ|US|HK|BJ|PT)$/i, "")
    .replace(/-(SW|W|B|S|R)$/i, "")
    .trim();
}

function buildSecurityAliases(name: string, code: string, aliases: string[]): string[] {
  const baseName = securityBaseName(name);
  const shortName = stripSecuritySuffix(baseName);
  const bareCode = String(code || "").split(".")[0];
  return unique([
    name,
    code,
    bareCode,
    baseName,
    shortName,
    ...aliases,
  ]);
}

function stripSecuritySuffix(name: string): string {
  return String(name || "")
    .replace(/(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$/u, "")
    .trim();
}

function normalizeKnowledgeStockCode(code: string): string {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const usMatch = raw.match(/^US([A-Z0-9.-]+)\.(?:OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return normalizeSupportedCompanyCode(`${usMatch[1]}.US`);
  }
  return normalizeSupportedCompanyCode(raw);
}

function extractKnowledgeSecurityCodes(targetCode: string | null, metadata: Record<string, unknown>): string[] {
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  return unique([
    normalizeKnowledgeStockCode(String(targetCode || "")),
    ...links.map((item) => normalizeKnowledgeStockCode(String((item as Record<string, unknown>)?.code || ""))),
  ]);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeLower(value: string | null): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeUpper(value: string | null): string {
  return String(value || "").trim().toUpperCase();
}

function sanitizeKnowledgeDisplayTags(tags: string[], stockLinks: Array<Record<string, unknown>>): string[] {
  const stockAliases = new Set<string>();
  for (const link of stockLinks) {
    for (const value of [link.name, link.code, ...(Array.isArray(link.aliases) ? link.aliases : [])]) {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized) stockAliases.add(normalized);
    }
  }
  return tags.filter((tag) => {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return false;
    if (stockAliases.has(normalized)) return false;
    return !isSecurityDisplayTag(tag);
  });
}

function sanitizeKnowledgeMetadata(
  metadata: Record<string, unknown>,
  stockLinks: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (stockLinks.length === 0) {
    return {
      ...metadata,
      stockLinks: [],
      stockCodes: [],
      stockNames: [],
    };
  }
  return {
    ...metadata,
    stockLinks,
    stockCodes: stockLinks.map((item) => String(item.code || "")).filter(Boolean),
    stockNames: stockLinks.map((item) => String(item.name || "")).filter(Boolean),
  };
}

function isSecurityDisplayTag(tag: string): boolean {
  const value = tag.trim();
  if (!value) return false;
  if (/\b(?:ETF|LOF|QDII)\b/i.test(value)) return true;
  if (/(?:概念|指数|板块|主题)\.PT$/i.test(value)) return true;
  if (/^[a-z]{2,4}[\w.:-]*$/i.test(value) && /(?:\.(?:SH|SZ|HK|US|PT)|^[a-z]{2}\d{5,})$/i.test(value)) return true;
  if (/^[036]\d{5}\.(?:SH|SZ)$/i.test(value)) return true;
  return false;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function resolveKnowledgeAccessMethod(row: Pick<KnowledgeDocRow, "access_method" | "content_key" | "url" | "metadata_json">): string {
  if (String(row.content_key || "").trim()) {
    return "markdown";
  }
  return row.access_method || (isPdf(row) ? "remote_pdf" : "markdown");
}

function buildKnowledgePreview(row: Pick<KnowledgeDocRow, "summary" | "content_preview" | "title">): string {
  const preview = String(row.content_preview || "").trim();
  if (preview) {
    return truncatePreview(preview, 280);
  }
  return truncatePreview(String(row.title || "").trim(), 280);
}

function truncatePreview(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max).trimEnd()}...`;
}

function displaySourceName(value: string | null): string {
  const sourceName = String(value || "").trim();
  if (!sourceName) {
    return "";
  }
  return isInternalSourceName(sourceName) ? "" : sourceName;
}

function isInternalSourceName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "本地导入" || normalized === "local import";
}

function isPdf(row: Pick<KnowledgeDocRow, "url" | "access_method" | "metadata_json">): boolean {
  return [row.url, row.access_method, row.metadata_json]
    .some((value) => String(value || "").toLowerCase().includes(".pdf"));
}

async function listKnowledgeDocsDeduped(
  db: AppEnv["Bindings"]["DB"],
  query: KnowledgeDocsQuery,
  whereSql: string,
  binds: unknown[],
  contentContext: KnowledgeContentUrlContext,
): Promise<{ list: Record<string, unknown>[]; total: number; hasNext: boolean }> {
  const startIndex = Math.max(0, (query.page - 1) * query.pageSize);
  const endExclusive = startIndex + query.pageSize + 1;
  const batchSize = Math.min(Math.max(query.pageSize * 4, 100), 400);
  const uniqueRows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let exhausted = false;

  while (uniqueRows.length < endExclusive && !exhausted) {
    const rows = await db.prepare(
      `${KNOWLEDGE_DOC_LIST_SELECT}
         ${whereSql}
         order by ${KNOWLEDGE_DOC_TIME_ORDER}
         limit ? offset ?`
    )
      .bind(...binds, batchSize, offset)
      .all<KnowledgeDocRow>();
    const batch = rows.results ?? [];
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of batch) {
      const item = mapKnowledgeDocListItem(row, contentContext);
      const dedupeKey = knowledgeDocDedupeKey(item);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      uniqueRows.push(item);
    }
    offset += batch.length;
    if (batch.length < batchSize) {
      exhausted = true;
    }
  }

  const hasNext = uniqueRows.length > startIndex + query.pageSize || !exhausted;
  return {
    list: uniqueRows.slice(startIndex, startIndex + query.pageSize),
    total: exhausted ? Math.max(uniqueRows.length, startIndex) : startIndex + uniqueRows.length,
    hasNext,
  };
}

function knowledgeDocDedupeKey(item: Record<string, unknown>): string {
  const metadata = objectRecord(item.metadata);
  const source = String(metadata.source || "");
  const sourceName = String(item.source_name || "").trim().toLowerCase();
  const title = String(item.title || "").trim().toLowerCase();
  const preview = normalizeKnowledgeDedupeText(
    String(item.content_preview || item.title || "").slice(0, 320)
  ).slice(0, 180);
  if (source === "tencent_stock_news") {
    return `tencent|${sourceName}|${title}|${preview}`;
  }
  return String(item.doc_id || "");
}

function normalizeKnowledgeDedupeText(value: string): string {
  return stripKnowledgeLeadNoise(String(value || ""))
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim()
    .toLowerCase();
}

function isIgnorableKnowledgeLeadLine(value: string): boolean {
  return /^作者[丨|｜:：\s]/.test(value)
    || /^(公众号|点击上方|来源|原标题)/.test(value)
    || /加星标/.test(value);
}

function stripKnowledgeLeadNoise(value: string): string {
  let normalized = String(value || "").trim();
  normalized = normalized.replace(/^作者[丨|｜:：\s]*[^\s，。,；;:：]{1,40}\s*/u, "");
  normalized = normalized.replace(/^(公众号|点击上方)[^。！？!?]{0,80}[。！？!?]?\s*/u, "");
  normalized = normalized.replace(/^来源[：:]\s*[^\s]+\s*/u, "");
  normalized = normalized.replace(/^原标题[：:]\s*/u, "");
  if (isIgnorableKnowledgeLeadLine(normalized)) {
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    while (lines.length > 0 && isIgnorableKnowledgeLeadLine(lines[0])) {
      lines.shift();
    }
    normalized = lines.join(" ");
  }
  return normalized.replace(/\s+/g, " ");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function rankReasons(row: KnowledgeDocRow): string[] {
  const reasons: string[] = [];
  if (row.source_weight > 0) {
    reasons.push("来源权重");
  }
  if (row.rank_score > 0) {
    reasons.push("公共排序分");
  }
  return reasons;
}
