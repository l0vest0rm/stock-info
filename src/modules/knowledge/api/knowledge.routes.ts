import { Hono } from "hono";
import { fail, ok } from '../../../shared/http';
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
  md_text?: string | null;
  search_text: string | null;
  metadata_json: string | null;
  recommendation_score: number;
  recommendation_level: string | null;
  recommendation_tags_json: string | null;
  recommendation_reasons_json: string | null;
  rank_score: number;
  source_weight: number;
  updated_at: number;
};

type KnowledgeDocsQuery = {
  sourceType: string;
  source: string;
  tags: string[];
  q: string;
  page: number;
  pageSize: number;
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
  summary: string | null;
  md_text?: string | null;
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

knowledgeRoutes.get("/knowledge/docs", async (c) => {
  const query = parseDocsQuery(c.req.query());
  const { whereSql, binds } = buildKnowledgeWhere(query);
  const offset = (query.page - 1) * query.pageSize;
  const rows = await c.env.DB.prepare(
    `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
        d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code,
        d.discovery_method, d.access_method, d.summary, d.search_text, d.metadata_json,
        d.recommendation_score, d.recommendation_level, d.recommendation_tags_json,
        d.recommendation_reasons_json, d.rank_score, d.source_weight, d.updated_at
       from knowledge_docs d
       ${whereSql}
       order by d.rank_score desc, coalesce(d.event_time, d.published_at, d.fetched_at) desc, d.doc_id desc
       limit ? offset ?`
  )
    .bind(...binds, query.pageSize, offset)
    .all<KnowledgeDocRow>();
  const total = await c.env.DB.prepare(
    `select count(*) as count from knowledge_docs d ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();
  return ok(c, {
    page: query.page,
    page_size: query.pageSize,
    total: total?.count ?? 0,
    list: (rows.results ?? []).map(mapKnowledgeDocListItem),
  });
});

knowledgeRoutes.get("/knowledge/doc", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) {
    return fail(c, 400, "missing doc id");
  }
  const row = await c.env.DB.prepare(
    `select doc_id, source_type, report_type, source_name, title, url,
      published_at, fetched_at, event_time, target_name, target_code,
      discovery_method, access_method, summary, md_text, search_text, metadata_json,
      recommendation_score, recommendation_level, recommendation_tags_json,
      recommendation_reasons_json, rank_score, source_weight, updated_at
     from knowledge_docs
     where doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeDocRow>();
  if (!row) {
    return fail(c, 404, `knowledge document not found: ${id}`);
  }
  return ok(c, mapKnowledgeDocDetail(row));
});

knowledgeRoutes.get("/knowledge/filtered", async (c) => {
  const q = String(c.req.query("q") ?? "").trim();
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
      or lower(coalesce(summary, '')) like ?
      or lower(coalesce(url, '')) like ?
    )`);
    binds.push(like, like, like, like, like, like);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const offset = (page - 1) * pageSize;
  const rows = await c.env.DB.prepare(
    `select doc_id, source_type, report_type, source_name, title, url,
        published_at, fetched_at, event_time, target_name, target_code, summary,
        metadata_json, filter_method, filter_score, filter_confidence,
        filter_reasons_json, source_file, reviewed_status, reviewed_at, updated_at
       from knowledge_filtered_docs
       ${whereSql}
       order by filter_score desc, coalesce(event_time, published_at, fetched_at) desc, doc_id desc
       limit ? offset ?`
  )
    .bind(...binds, pageSize, offset)
    .all<KnowledgeFilteredDocRow>();
  return ok(c, {
    page,
    page_size: pageSize,
    list: (rows.results ?? []).map(mapFilteredDocListItem),
  });
});

knowledgeRoutes.get("/knowledge/filtered/doc", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) return fail(c, 400, "missing doc id");
  const row = await c.env.DB.prepare(
    `select doc_id, source_type, report_type, source_name, title, url,
      published_at, fetched_at, event_time, target_name, target_code, summary, md_text,
      metadata_json, filter_method, filter_score, filter_confidence,
      filter_reasons_json, source_file, reviewed_status, reviewed_at, updated_at
     from knowledge_filtered_docs
     where doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeFilteredDocRow>();
  if (!row) return fail(c, 404, `filtered document not found: ${id}`);
  return ok(c, mapFilteredDocDetail(row));
});

knowledgeRoutes.post("/knowledge/filtered/keep", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { id?: string };
  const id = String(body.id || c.req.query("id") || "").trim();
  if (!id) return fail(c, 400, "missing doc id");
  const row = await c.env.DB.prepare(
    `select doc_id, source_type, report_type, source_name, title, url,
      published_at, fetched_at, event_time, target_name, target_code, summary, md_text,
      metadata_json, filter_reasons_json, updated_at
     from knowledge_filtered_docs
     where doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeFilteredDocRow>();
  if (!row) return fail(c, 404, `filtered document not found: ${id}`);
  const tags = ["review_kept"];
  const now = Date.now();
  await c.env.DB.prepare(
    `insert into knowledge_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, discovery_method, access_method, summary, md_text,
      search_text, metadata_json, recommendation_score, recommendation_level,
      recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'filtered_review_keep', 'markdown',
      ?, ?, ?, ?, 1, 'D', ?, ?, 1, 0, ?)
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
      md_text=excluded.md_text,
      search_text=excluded.search_text,
      metadata_json=excluded.metadata_json,
      recommendation_tags_json=excluded.recommendation_tags_json,
      recommendation_reasons_json=excluded.recommendation_reasons_json,
      updated_at=excluded.updated_at`
  )
    .bind(
      row.doc_id, row.source_type, row.report_type || row.source_type, row.source_name || "",
      row.title, row.url || "", row.published_at || "", row.fetched_at || "",
      row.event_time || row.published_at || row.fetched_at || "", row.target_name || "", row.target_code || "",
      row.summary || "", row.md_text || "", [row.title, row.summary || "", row.md_text || ""].join(" "),
      row.metadata_json || "{}", JSON.stringify(tags), row.filter_reasons_json || "[]", now,
    )
    .run();
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
    list: (rows.results ?? []).map((row) => ({
      key: row.name,
      name: row.name,
      count: row.count,
    })),
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

function parseDocsQuery(raw: Record<string, string>): KnowledgeDocsQuery {
  return {
    sourceType: normalizeSourceType(raw.sourceType ?? ""),
    source: normalizeSource(raw.source ?? ""),
    tags: String(raw.tags ?? raw.tag ?? "")
      .split(",")
      .map((item) => normalizeFilter(item))
      .filter(Boolean),
    q: String(raw.q ?? "").trim(),
    page: clampInteger(raw.page, 1, 1, 10000),
    pageSize: clampInteger(raw.pageSize, 50, 1, 100),
  };
}

function normalizeSource(value: string): string {
  const normalized = normalizeFilter(value);
  return normalized === "all" ? "" : normalized;
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
    filters.push("lower(d.source_name) = ?");
    binds.push(query.source);
  }
  if (query.q) {
    const like = `%${query.q.toLowerCase()}%`;
    filters.push(`(
      lower(d.title) like ?
      or lower(coalesce(d.source_name, '')) like ?
      or lower(coalesce(d.target_name, '')) like ?
      or lower(coalesce(d.target_code, '')) like ?
      or lower(coalesce(d.summary, '')) like ?
      or lower(coalesce(d.search_text, '')) like ?
      or lower(coalesce(d.url, '')) like ?
    )`);
    binds.push(like, like, like, like, like, like, like);
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

function mapKnowledgeDocListItem(row: KnowledgeDocRow): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata_json);
  const target = sanitizeKnowledgeTarget(row.title, row.target_name || "", row.target_code || "", metadata);
  const stockLinks = stockLinksFromMetadata(metadata, target.name, target.code);
  const recommendationTags = sanitizeKnowledgeDisplayTags(parseJsonArray(row.recommendation_tags_json), stockLinks);
  const tags = [
    ...recommendationTags,
    ...(isPdf(row) ? ["pdf"] : []),
  ];
  return {
    doc_id: row.doc_id,
    source_type: row.source_type,
    report_type: row.report_type || row.source_type,
    source_name: row.source_name || "",
    title: row.title,
    url: row.url || "",
    published_at: row.published_at || "",
    fetched_at: row.fetched_at || "",
    event_time: row.event_time || row.published_at || row.fetched_at || "",
    target_name: target.name,
    target_code: target.code,
    discovery_method: row.discovery_method || metadata.discovery_method || "",
    access_method: row.access_method || (isPdf(row) ? "remote_pdf" : "markdown"),
    summary: row.summary || "",
    metadata,
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

function mapKnowledgeDocDetail(row: KnowledgeDocRow): Record<string, unknown> {
  return {
    ...mapKnowledgeDocListItem(row),
    content: row.md_text || row.summary || "",
  };
}

function mapFilteredDocListItem(row: KnowledgeFilteredDocRow): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata_json);
  const filterReasons = parseJsonArray(row.filter_reasons_json);
  const target = sanitizeKnowledgeTarget(row.title, row.target_name || "", row.target_code || "", metadata);
  const stockLinks = stockLinksFromMetadata(metadata, target.name, target.code);
  return {
    doc_id: row.doc_id,
    source_type: row.source_type,
    report_type: row.report_type || row.source_type,
    source_name: row.source_name || "",
    title: row.title,
    url: row.url || "",
    published_at: row.published_at || "",
    fetched_at: row.fetched_at || "",
    event_time: row.event_time || row.published_at || row.fetched_at || "",
    target_name: target.name,
    target_code: target.code,
    discovery_method: "filtered_review",
    access_method: row.md_text ? "markdown" : (row.url?.includes(".pdf") ? "remote_pdf" : ""),
    summary: row.summary || "",
    metadata,
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

function mapFilteredDocDetail(row: KnowledgeFilteredDocRow): Record<string, unknown> {
  return {
    ...mapFilteredDocListItem(row),
    content: row.md_text || row.summary || "",
  };
}

function normalizeSourceType(value: string): string {
  const normalized = normalizeFilter(value);
  return normalized === "all" ? "" : normalized;
}

function normalizeFilter(value: string): string {
  return value.trim().toLowerCase();
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
    .map((item) => ({
      name: String(item.name || ""),
      code: String(item.code || ""),
      aliases: Array.isArray(item.aliases)
        ? item.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
        : [],
    }))
    .filter((item) => item.name || item.code);
}

function sanitizeKnowledgeTarget(title: string, targetName: string, targetCode: string, metadata: Record<string, unknown>): { name: string; code: string } {
  const stockNames = Array.isArray(metadata.stockNames) ? metadata.stockNames : [];
  if (metadata.source !== "tencent_stock_news" || stockNames.length <= 1) {
    return { name: targetName, code: targetCode };
  }
  const baseName = securityBaseName(targetName);
  if (baseName && title.includes(baseName) && !isSecurityDisplayTag(targetName)) {
    return { name: targetName, code: targetCode };
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

function isPdf(row: KnowledgeDocRow): boolean {
  return [row.url, row.access_method, row.metadata_json]
    .some((value) => String(value || "").toLowerCase().includes(".pdf"));
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
