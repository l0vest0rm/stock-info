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

function kindForCurrentPage(pathname: string): SecurityKind | null {
  const page = pathname.split("/").pop() || "";
  if (page === "company.html" || page.startsWith("company-")) return "company";
  if (page === "fund.html" || page.startsWith("fund-")) return "fund";
  return null;
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
  if (kindForCurrentPage(currentUrl.pathname) === kind && currentUrl.searchParams.has("code")) {
    currentUrl.searchParams.set("code", code);
    return relativeHref(currentUrl);
  }

  return kind === "fund"
    ? `fund.html?code=${encodeURIComponent(code)}`
    : `company.html?code=${encodeURIComponent(code)}`;
}
