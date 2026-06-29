import { basename, extname } from "node:path";

export function parseKnowledgeFilename(file) {
  const originalStem = basename(file, extname(file)).trim();
  const normalizedStem = originalStem.replace(/[_-]+/g, " ").trim();
  const tokens = originalStem
    .split(/[-_]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return emptyResult(normalizedStem);
  }

  const dateIndex = tokens.findIndex((token, index) => index < 3 && Boolean(parseDateToken(token)));
  const prefixTokens = dateIndex > 0 ? tokens.slice(0, dateIndex) : [];
  const publishedAt = dateIndex >= 0 ? parseDateToken(tokens[dateIndex]) : "";
  const sourceIndex = dateIndex >= 0 && dateIndex + 2 < tokens.length ? dateIndex + 1 : -1;
  const sourceName = sourceIndex >= 0 ? tokens[sourceIndex] : "";
  const titleTokens = sourceIndex >= 0
    ? tokens.slice(sourceIndex + 1)
    : tokens.slice(dateIndex >= 0 ? dateIndex + 1 : 0);
  const reportType = inferReportType(prefixTokens, titleTokens);
  const target = inferTarget(reportType, titleTokens);
  const cleanedTitle = buildTitle(titleTokens, target);

  return {
    originalStem,
    normalizedStem,
    publishedAt,
    sourceName,
    targetName: target.name,
    targetCode: target.code,
    reportType: target.code ? "company_report" : reportType,
    title: cleanedTitle || normalizedStem,
  };
}

function emptyResult(normalizedStem) {
  return {
    originalStem: normalizedStem,
    normalizedStem,
    publishedAt: "",
    sourceName: "",
    targetName: "",
    targetCode: "",
    reportType: "research_report",
    title: normalizedStem,
  };
}

function parseDateToken(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!/^\d{8}$/.test(digits)) {
    return "";
  }
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return "";
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function inferReportType(prefixTokens, titleTokens) {
  const prefixText = prefixTokens.join(" ");
  const titleLead = titleTokens.slice(0, 2).join(" ");
  if (/(行业|赛道|策略|周报|月报|晨报|深度行业)/.test(prefixText) || /(行业|赛道|策略|周报|月报|晨报)/.test(titleLead)) {
    return "industry_report";
  }
  if (/(个股|公司|点评|首次覆盖)/.test(prefixText)) {
    return "company_report";
  }
  return "research_report";
}

function inferTarget(reportType, titleTokens) {
  if (titleTokens.length === 0 || reportType === "industry_report") {
    return { name: "", code: "" };
  }

  const joined = titleTokens.join(" ");
  const parenMatch = joined.match(/^(.+?)\(([^()]+)\)/);
  if (parenMatch) {
    const code = normalizeStockCode(parenMatch[2]);
    if (code) {
      return {
        name: cleanTargetName(parenMatch[1]),
        code,
      };
    }
  }

  if (titleTokens.length >= 2) {
    const code = normalizeStockCode(titleTokens[1]);
    if (code) {
      return {
        name: cleanTargetName(titleTokens[0]),
        code,
      };
    }
  }

  return { name: "", code: "" };
}

function buildTitle(titleTokens, target) {
  if (titleTokens.length === 0) {
    return "";
  }
  if (target.code) {
    if (titleTokens.length >= 2 && cleanTargetName(titleTokens[0]) === target.name && normalizeStockCode(titleTokens[1]) === target.code) {
      return titleTokens.slice(2).join(" ").trim() || `${target.name} (${target.code})`;
    }
    const joined = titleTokens.join(" ").trim();
    if (joined.startsWith(`${target.name}(`) || joined.startsWith(`${target.name} (`)) {
      return joined;
    }
  }
  return titleTokens.join(" ").trim();
}

function cleanTargetName(value) {
  return String(value || "")
    .replace(/[（(]\s*$/, "")
    .trim();
}

function normalizeStockCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const usMatch = raw.match(/^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return `${usMatch[1]}.US`;
  }
  const cnMatch = raw.match(/^([036]\d{5})$/);
  if (cnMatch) {
    return `${cnMatch[1]}.${cnMatch[1].startsWith("6") ? "SH" : "SZ"}`;
  }
  const twMatch = raw.match(/^(\d{4})\.(TW|TWO)$/);
  if (twMatch) {
    return `${twMatch[1]}.${twMatch[2]}`;
  }
  const hkMatch = raw.match(/^(\d{3,5})\.HK$/);
  if (hkMatch) {
    return `${hkMatch[1]}.HK`;
  }
  const suffixMatch = raw.match(/^([A-Z0-9.-]+)\.(SH|SZ|HK|US|TW|TWO)$/);
  if (suffixMatch) {
    return `${suffixMatch[1]}.${suffixMatch[2]}`;
  }
  return "";
}
