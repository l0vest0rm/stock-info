import { createHash } from "node:crypto";

export function mapClsTelegraphItem(item, fetchedAt = new Date().toISOString()) {
  const clsId = String(item?.id ?? "").trim();
  const ctime = Number(item?.ctime);
  const content = firstText(item?.content, item?.brief);
  const title = firstText(item?.title, titleFromContent(content));
  if (!clsId || !Number.isFinite(ctime) || ctime <= 0 || !title) {
    throw new Error(`invalid CLS telegraph item: id=${clsId || "missing"} ctime=${String(item?.ctime ?? "missing")}`);
  }
  const publishedAt = new Date(ctime * 1000).toISOString();
  const subjects = Array.isArray(item?.subjects) ? item.subjects : [];
  const stocks = Array.isArray(item?.stock_list) ? item.stock_list : [];
  const stockNames = unique(stocks.map(stockName));
  const stockCodes = unique(stocks.map(stockCode));
  const subjectNames = unique(subjects.map((subject) => firstText(subject?.subject_name, subject?.name)));

  return {
    docId: stableKnowledgeDocId(`cls_telegraph|${clsId}`),
    sourceType: "web_news",
    reportType: "news",
    sourceName: "财联社",
    title,
    url: `https://www.cls.cn/detail/${encodeURIComponent(clsId)}`,
    publishedAt,
    fetchedAt,
    eventTime: publishedAt,
    discoveryMethod: "cls_backend_api",
    accessMethod: "markdown",
    summary: firstText(item?.brief, content).slice(0, 600),
    markdown: content,
    tags: unique(["财联社电报", ...subjectNames]),
    metadata: {
      source: "cls_telegraph",
      clsId,
      author: firstText(item?.author),
      level: firstText(item?.level),
      category: firstText(item?.category),
      subjects,
      stockList: stocks,
      stockNames,
      stockCodes,
    },
  };
}

export function stableKnowledgeDocId(value) {
  return `k_${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24)}`;
}

function titleFromContent(value) {
  return String(value || "")
    .replace(/^【([^】]+)】.*$/s, "$1")
    .replace(/^财联社[^，。]*[，。]?/, "")
    .trim()
    .slice(0, 120);
}

function stockName(item) {
  return firstText(item?.name, item?.stock_name, item?.stockName, item?.secu_name);
}

function stockCode(item) {
  return firstText(
    item?.code,
    item?.stock_code,
    item?.stockCode,
    item?.StockCode,
    item?.StockID,
    item?.secu_code,
    item?.SecuCode,
    item?.symbol,
    item?.Symbol,
  );
}

function firstText(...values) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
