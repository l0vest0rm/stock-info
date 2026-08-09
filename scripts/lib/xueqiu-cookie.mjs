const XUEQIU_KLINE_URL = "https://stock.xueqiu.com/v5/stock/chart/kline.json";
const XUEQIU_REFERER = "https://xueqiu.com/";
const XUEQIU_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const XUEQIU_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
const XUEQIU_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";

export function cookieHeaderFromCdp(cookies) {
  return cookies
    .filter((cookie) => typeof cookie?.name === "string" && typeof cookie?.value === "string")
    .filter((cookie) => String(cookie.domain ?? "").replace(/^\./, "").endsWith("xueqiu.com"))
    .map((cookie) => [cookie.name.trim(), cookie.value.trim()])
    .filter(([name]) => name)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/**
 * Check a candidate cookie against the same Xueqiu K-line endpoint and request
 * profile used by the local Node runtime. Cookie extraction alone is not evidence
 * that the resulting session is usable.
 */
export async function validateXueqiuKlineCookie(
  cookie,
  { fetchImpl = fetch, timeoutMs = 10_000, now = new Date() } = {},
) {
  const value = typeof cookie === "string" ? cookie.trim() : "";
  if (!value) throw new Error("Xueqiu cookie validation requires a non-empty cookie");
  const request = createXueqiuKlineValidationRequest(value, now);
  const response = await fetchImpl(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Xueqiu cookie validation request failed: status=${response.status}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Xueqiu cookie validation returned invalid JSON");
  }
  if (String(body?.error_code ?? "") === "400016"
    || /重新登录|登录.*失效|login/i.test(String(body?.error_description ?? ""))) {
    throw new Error(`Xueqiu cookie validation rejected: ${body?.error_description ?? body?.error_code}`);
  }
  const rows = body?.data?.item;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Xueqiu cookie validation returned no K-line rows");
  }
  return { url: request.url, rowCount: rows.length };
}

export function createXueqiuKlineValidationRequest(cookie, now = new Date()) {
  const url = new URL(XUEQIU_KLINE_URL);
  url.searchParams.set("symbol", "SH600519");
  url.searchParams.set("begin", String(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000));
  url.searchParams.set("period", "day");
  url.searchParams.set("type", "before");
  url.searchParams.set("count", "-7500");
  url.searchParams.set("indicator", "kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance");
  return {
    url: url.toString(),
    headers: {
      Accept: XUEQIU_ACCEPT,
      "Accept-Language": XUEQIU_ACCEPT_LANGUAGE,
      Cookie: cookie,
      Referer: XUEQIU_REFERER,
      "User-Agent": XUEQIU_USER_AGENT,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  };
}
