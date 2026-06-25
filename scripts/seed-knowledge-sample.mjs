import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const remote = process.argv.includes("--remote");
const now = Date.now();
const samples = [
  {
    docId: "sample:company-report:300308",
    sourceType: "research_report",
    reportType: "company_report",
    sourceName: "样例证券",
    title: "中际旭创：AI 算力需求拉动高速光模块增长",
    url: "https://example.com/reports/300308-ai-optical.pdf",
    publishedAt: "2026-06-24",
    fetchedAt: "2026-06-25T09:00:00+08:00",
    eventTime: "2026-06-24",
    targetName: "中际旭创",
    targetCode: "300308.SZ",
    discoveryMethod: "local_seed",
    accessMethod: "markdown",
    summary: "样例研报摘要：AI 算力资本开支继续推动高速光模块需求，关注订单兑现和毛利率变化。",
    mdText: [
      "# 中际旭创：AI 算力需求拉动高速光模块增长",
      "",
      "本样例用于验证 Cloudflare 版研报资讯页面。PDF 不进入 D1，页面读取的是本地加工后的 Markdown。",
      "",
      "## 核心观点",
      "",
      "- AI 数据中心需求维持高景气。",
      "- 高速光模块产品结构改善。",
      "- 风险包括客户集中度和价格波动。",
    ].join("\n"),
    tags: ["AI算力", "光模块", "pdf"],
    recommendationLevel: "A",
    recommendationScore: 82,
    recommendationReasons: ["公司研报", "AI算力主题", "关注标的"],
    rankScore: 112,
    sourceWeight: 10,
  },
  {
    docId: "sample:industry-report:semiconductor",
    sourceType: "research_report",
    reportType: "industry_report",
    sourceName: "样例研究所",
    title: "半导体行业：先进封装与 HBM 产业链跟踪",
    url: "https://example.com/reports/semiconductor-hbm.pdf",
    publishedAt: "2026-06-23",
    fetchedAt: "2026-06-25T09:05:00+08:00",
    eventTime: "2026-06-23",
    targetName: "半导体",
    targetCode: "",
    discoveryMethod: "local_seed",
    accessMethod: "markdown",
    summary: "样例行业研报摘要：先进封装和 HBM 需求扩张，产业链景气度延续。",
    mdText: "## 半导体行业跟踪\n\n先进封装、HBM、设备材料是本轮产业链跟踪重点。",
    tags: ["AI算力", "HBM", "行业研报"],
    recommendationLevel: "B",
    recommendationScore: 64,
    recommendationReasons: ["行业研报", "AI算力主题"],
    rankScore: 84,
    sourceWeight: 8,
  },
  {
    docId: "sample:web-news:reuters",
    sourceType: "web_news",
    reportType: "news",
    sourceName: "Reuters",
    title: "Foxconn expands AI server capacity as demand rises",
    url: "https://example.com/news/foxconn-ai-server",
    publishedAt: "2026-06-22",
    fetchedAt: "2026-06-25T09:10:00+08:00",
    eventTime: "2026-06-22",
    targetName: "工业富联",
    targetCode: "601138.SH",
    discoveryMethod: "local_seed",
    accessMethod: "markdown",
    summary: "样例新闻摘要：AI 服务器需求带动供应链扩产。",
    mdText: "AI server capacity expansion remains a public market focus.",
    tags: ["AI服务器", "新闻"],
    recommendationLevel: "C",
    recommendationScore: 38,
    recommendationReasons: ["新闻", "AI服务器"],
    rankScore: 50,
    sourceWeight: 5,
  },
];

const sql = [
  "delete from knowledge_doc_tags where doc_id like 'sample:%';",
  "delete from knowledge_docs where doc_id like 'sample:%';",
  ...samples.flatMap((item) => [
    `insert into knowledge_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, discovery_method, access_method, summary, md_text,
      search_text, metadata_json, recommendation_score, recommendation_level,
      recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight, updated_at
    ) values (
      ${q(item.docId)}, ${q(item.sourceType)}, ${q(item.reportType)}, ${q(item.sourceName)},
      ${q(item.title)}, ${q(item.url)}, ${q(item.publishedAt)}, ${q(item.fetchedAt)},
      ${q(item.eventTime)}, ${q(item.targetName)}, ${q(item.targetCode)}, ${q(item.discoveryMethod)},
      ${q(item.accessMethod)}, ${q(item.summary)}, ${q(item.mdText)}, ${q(`${item.title} ${item.summary} ${item.tags.join(" ")}`)},
      ${q(JSON.stringify({ source: "sample", pdfStored: false }))}, ${item.recommendationScore},
      ${q(item.recommendationLevel)}, ${q(JSON.stringify(item.tags))}, ${q(JSON.stringify(item.recommendationReasons))},
      ${item.rankScore}, ${item.sourceWeight}, ${now}
    );`,
    ...item.tags.map((tag) =>
      `insert into knowledge_doc_tags (doc_id, tag) values (${q(item.docId)}, ${q(tag.toLowerCase())});`
    ),
  ]),
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-"));
const file = join(dir, "seed.sql");
try {
  writeFileSync(file, sql);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "stock_info", remote ? "--remote" : "--local", "--file", file],
    { stdio: "inherit" }
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function q(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
