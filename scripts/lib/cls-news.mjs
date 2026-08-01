import { createHash } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://www.cls.cn";
const DEFAULT_APP = "CailianpressWeb";
const DEFAULT_OS = "web";
const DEFAULT_SERVICE_VERSION = "8.7.9";

export function clsRequestSign(params) {
  const query = Object.keys(params)
    .sort(compareParamNames)
    .map((key) => `${key}=${String(params[key])}`)
    .join("&");
  const sha1 = createHash("sha1").update(query).digest("hex");
  return createHash("md5").update(sha1).digest("hex");
}

export function buildClsRollListUrl({
  apiBaseUrl = DEFAULT_API_BASE_URL,
  app = DEFAULT_APP,
  os = DEFAULT_OS,
  serviceVersion = DEFAULT_SERVICE_VERSION,
  lastTime,
  pageSize,
}) {
  if (!Number.isInteger(Number(pageSize)) || Number(pageSize) < 1 || Number(pageSize) > 50) {
    throw new Error(`CLS pageSize must be between 1 and 50: ${String(pageSize)}`);
  }
  const params = {
    app,
    last_time: String(lastTime),
    os,
    refresh_type: "1",
    rn: String(pageSize),
    sv: serviceVersion,
  };
  const url = new URL("/v1/roll/get_roll_list", apiBaseUrl);
  for (const key of Object.keys(params).sort(compareParamNames)) {
    url.searchParams.set(key, params[key]);
  }
  url.searchParams.set("sign", clsRequestSign(params));
  return url;
}

export async function fetchClsRollPage({
  fetchImpl = fetch,
  apiBaseUrl,
  app,
  os,
  serviceVersion,
  lastTime,
  pageSize,
  timeoutMs = 10_000,
}) {
  const url = buildClsRollListUrl({ apiBaseUrl, app, os, serviceVersion, lastTime, pageSize });
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cls.cn/telegraph",
      "User-Agent": "Mozilla/5.0 (compatible; stock-info-local/0.1)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`CLS roll list failed: status=${response.status} body=${body.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`CLS roll list returned invalid JSON: ${body.slice(0, 300)}`);
  }
  if (parsed?.errno !== 0 || !Array.isArray(parsed?.data?.roll_data)) {
    throw new Error(`CLS roll list returned an unexpected payload: ${body.slice(0, 500)}`);
  }
  return parsed.data.roll_data;
}

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

function compareParamNames(left, right) {
  const upperLeft = left.toUpperCase();
  const upperRight = right.toUpperCase();
  return upperLeft > upperRight ? 1 : upperLeft < upperRight ? -1 : 0;
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
