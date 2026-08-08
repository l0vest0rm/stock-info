import type { SecuritySearchHistoryItem } from "../../platform/search-history";

type SecurityKind = "company" | "fund";

function kindForResult(result: SecuritySearchHistoryItem): SecurityKind {
  const code = String(result.code || "").trim();
  return String(result.type || "").toLowerCase() === "fund" || code.endsWith(".OF")
    ? "fund"
    : "company";
}

function codeForResult(result: SecuritySearchHistoryItem, kind: SecurityKind): string {
  const code = String(result.code || "").trim();
  return kind === "fund" && !code.endsWith(".OF") ? `${code}.OF` : code;
}

function relativeHref(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function routeForSecuritySearch(
  result: SecuritySearchHistoryItem,
  currentHref = window.location.href,
): string {
  const kind = kindForResult(result);
  const code = codeForResult(result, kind);
  if (!code) return "#";

  const currentUrl = new URL(currentHref);
  if (currentUrl.searchParams.has("code")) {
    currentUrl.searchParams.set("code", code);
    return relativeHref(currentUrl);
  }

  return kind === "fund"
    ? `fund.html?code=${encodeURIComponent(code)}`
    : `company.html?code=${encodeURIComponent(code)}`;
}
