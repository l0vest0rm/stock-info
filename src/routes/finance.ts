import { Hono } from "hono";
import { fetchEastmoneyCompanyOverview, fetchEastmoneyDataRows } from "../adapters/eastmoney";
import { loadFinancialStatements, parseStatementType } from "../services/finance";
import { fail, ok, requireQuery } from "../shared/http";
import { normalizeSecurityCode } from "../shared/codes";
import type { AppEnv } from "../types";

export const financeRoutes = new Hono<AppEnv>();

financeRoutes.get("/finance/sharechange", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  return ok(c, await fetchShareChange(code));
});

financeRoutes.get("/finance/sharebonus", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  return ok(c, await fetchShareBonus(code));
});

financeRoutes.get("/finance/shareadditional", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  return ok(c, await fetchShareAdditional(code));
});

financeRoutes.get("/finance/dividendyield", async (c) => ok(c, await fetchDividendYield(c.req.query("code") ?? "")));

financeRoutes.get("/finance/freeholders", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  return ok(c, await fetchFreeHolders(code));
});

financeRoutes.get("/finance/orgholders", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  const reportDate = requireQuery(c, "reportDate");
  if (reportDate instanceof Response) return reportDate;
  return ok(c, await fetchOrgHolders(code, reportDate));
});

financeRoutes.get("/company/restriction", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  const normalized = normalizeSecurityCode(code);
  const rows = await fetchEastmoneyDataRows("https://datacenter.eastmoney.com/securities/api/data/v1/get", {
    reportName: "RPTA_APP_LIFTFUTURE",
    columns:
      "SECUCODE,SECURITY_CODE,LIFT_DATE,LIFT_NUM,TOTAL_SHARES_RATIO,UNLIMITED_A_SHARES_RATIO,LIFT_TYPE",
    quoteColumns: "",
    filter: `(SECUCODE="${normalized}")`,
    pageNumber: "1",
    pageSize: "200",
    sortTypes: "1",
    sortColumns: "LIFT_DATE",
    source: "HSF10",
    client: "PC",
  });
  return ok(c, { result: { data: rows } });
});

financeRoutes.get("/finance/:statementType", async (c) => {
  const statementType = parseStatementType(c.req.param("statementType"));
  if (!statementType) {
    return fail(c, 404, "unsupported finance statement type");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const data = await loadFinancialStatements(c.env.DB, code, statementType);
  return ok(c, data.rows.map((row) => toLegacyFinancePayload(row.payload)));
});

function toLegacyFinancePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const row = payload as Record<string, unknown>;
  return {
    ...row,
    reportDate: trimDate(row.REPORT_DATE),
    noticeDate: trimDate(row.NOTICE_DATE),
    parentNetprofit: row.PARENT_NETPROFIT ?? null,
    basicEps: row.BASIC_EPS ?? null,
    totalOperateIncome: row.TOTAL_OPERATE_INCOME ?? row.OPERATE_INCOME ?? null,
    operateIncome: row.OPERATE_INCOME ?? row.TOTAL_OPERATE_INCOME ?? null,
    netprofit: row.NETPROFIT ?? null,
  };
}

function trimDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

async function fetchShareChange(code: string): Promise<Record<string, unknown>[]> {
  const normalized = normalizeSecurityCode(code);
  const rows = await fetchEastmoneyDataRows("https://datacenter.eastmoney.com/securities/api/data/v1/get", {
    reportName: "RPT_F10_EH_EQUITY",
    columns:
      "SECUCODE,SECURITY_CODE,END_DATE,TOTAL_SHARES,LIMITED_SHARES,LIMITED_OTHARS,LIMITED_DOMESTIC_NATURAL,LIMITED_STATE_LEGAL,UNLIMITED_SHARES,LISTED_A_SHARES,FREE_SHARES,LIMITED_A_SHARES,LIMITED_DOMESTIC_NOSTATE,CHANGE_REASON",
    quoteColumns: "",
    filter: `(SECUCODE="${normalized}")`,
    pageNumber: "1",
    pageSize: "5000",
    sortTypes: "-1",
    sortColumns: "END_DATE",
    source: "HSF10",
    client: "PC",
  });
  if (!rows.length) {
    const overview = await fetchEastmoneyCompanyOverview(normalized);
    const totalShares =
      overview.marketCapYi && overview.latestPrice && overview.latestPrice > 0
        ? (overview.marketCapYi * 100_000_000) / overview.latestPrice
        : null;
    return totalShares ? [{ changeDate: new Date().toISOString().slice(0, 10), totalShares }] : [];
  }
  return rows.map((row, idx) => {
    const totalShares = num(row.TOTAL_SHARES);
    const prevTotalShares = idx + 1 < rows.length ? num(rows[idx + 1].TOTAL_SHARES) : 0;
    return {
      totalShares,
      changeDate: trimDate(row.END_DATE),
      changeReason: row.CHANGE_REASON ?? "",
      changeRatio: prevTotalShares ? (100 * totalShares / prevTotalShares - 100).toFixed(4) : "0.0000",
      freeShares: row.FREE_SHARES ?? null,
      limitedAShares: row.LIMITED_A_SHARES ?? null,
      limitedDomesticNatural: row.LIMITED_DOMESTIC_NATURAL ?? null,
      limitedDomesticNostate: row.LIMITED_DOMESTIC_NOSTATE ?? null,
      limitedOthers: row.LIMITED_OTHARS ?? null,
      limitedShares: row.LIMITED_SHARES ?? null,
      limitedStateLegal: row.LIMITED_STATE_LEGAL ?? null,
      listedAShares: row.LISTED_A_SHARES ?? null,
      unlimitedShares: row.UNLIMITED_SHARES ?? null,
      changeShares: idx + 1 < rows.length ? totalShares - prevTotalShares : 0,
    };
  });
}

async function fetchShareBonus(code: string): Promise<Record<string, unknown>[]> {
  const normalized = normalizeSecurityCode(code);
  const rows = await fetchEastmoneyDataRows("https://datacenter.eastmoney.com/securities/api/data/v1/get", {
    reportName: "RPT_F10_DIVIDEND_MAIN",
    columns:
      "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,IMPL_PLAN_PROFILE,ASSIGN_PROGRESS,EQUITY_RECORD_DATE,EX_DIVIDEND_DATE,PAY_CASH_DATE",
    quoteColumns: "",
    filter: `(SECUCODE="${normalized}")`,
    pageNumber: "1",
    pageSize: "100",
    sortTypes: "-1",
    sortColumns: "NOTICE_DATE",
    source: "HSF10",
    client: "PC",
  });
  const items: Record<string, unknown>[] = [];
  for (const row of rows) {
      const plan = String(row.IMPL_PLAN_PROFILE ?? "");
      if (!plan || plan === "不分配不转增") continue;
      items.push({
        noticeDate: trimDate(row.NOTICE_DATE),
        progress: row.ASSIGN_PROGRESS ?? "",
        plan,
        give: planNumber(plan, "送") / 10,
        trans: planNumber(plan, "转") / 10,
        bonus: planNumber(plan.replace("元", ""), "派") / 10,
        divDate: trimDate(row.EX_DIVIDEND_DATE),
        recordDate: trimDate(row.EQUITY_RECORD_DATE),
      });
  }
  return items;
}

async function fetchShareAdditional(code: string): Promise<Record<string, unknown>[]> {
  const normalized = normalizeSecurityCode(code);
  return fetchEastmoneyDataRows("https://datacenter.eastmoney.com/securities/api/data/v1/get", {
    reportName: "RPT_F10_DIVIDEND_SEO",
    columns:
      "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,ISSUE_NUM,NET_RAISE_FUNDS,ISSUE_PRICE,ISSUE_WAY_EXPLAIN,REG_DATE,LISTING_DATE,RECEIVE_DATE",
    quoteColumns: "",
    filter: `(SECUCODE="${normalized}")`,
    pageNumber: "1",
    pageSize: "100",
    sortTypes: "-1",
    sortColumns: "NOTICE_DATE",
    source: "HSF10",
    client: "PC",
  });
}

async function fetchFreeHolders(code: string): Promise<Record<string, unknown>[]> {
  const normalized = normalizeSecurityCode(code);
  return fetchEastmoneyDataRows("https://datacenter.eastmoney.com/securities/api/data/v1/get", {
    reportName: "RPT_F10_EH_FREEHOLDERS",
    columns:
      "SECUCODE,SECURITY_CODE,END_DATE,HOLDER_RANK,HOLDER_NAME,HOLDER_TYPE,SHARES_TYPE,HOLD_NUM,FREE_HOLDNUM_RATIO,HOLD_NUM_CHANGE,CHANGE_RATIO",
    quoteColumns: "",
    filter: `(SECUCODE="${normalized}")(END_DATE in ('${genReportDates(2).join("','")}'))`,
    pageNumber: "1",
    pageSize: "",
    sortTypes: "-1,1",
    sortColumns: "END_DATE,HOLDER_RANK",
    source: "HSF10",
    client: "PC",
  });
}

async function fetchOrgHolders(code: string, reportDate: string): Promise<Record<string, unknown>[]> {
  const normalized = normalizeSecurityCode(code);
  return fetchEastmoneyDataRows("https://datacenter.eastmoney.com/securities/api/data/v1/get", {
    reportName: "RPT_MAIN_ORGHOLDDETAIL",
    columns:
      "ORG_TYPE,SECUCODE,REPORT_DATE,HOLDER_CODE,HOLDER_NAME,TOTAL_SHARES,HOLD_VALUE,TOTALSHARES_RATIO,FREESHARES_RATIO,FREE_MARKET_CAP,FREE_SHARES,SECURITY_CODE,FUND_CODE,FUND_DERIVECODE,NETVALUE_RATIO",
    quoteColumns: "",
    filter: `(SECUCODE="${normalized}")(ORG_TYPE="01")(REPORT_DATE='${reportDate}')`,
    pageNumber: "1",
    pageSize: "500",
    sortTypes: "-1",
    sortColumns: "TOTAL_SHARES",
    source: "HSF10",
    client: "PC",
  });
}

async function fetchDividendYield(_code: string): Promise<Record<string, unknown>> {
  return {
    currentYield: 0,
    annualizedCash: 0,
    annualizedCashPerShare: 0,
    latestEventDate: "",
    series: [],
    events: [],
  };
}

function genReportDates(years: number): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dates: string[] = [];
  for (let i = 0; i < years; i += 1) {
    if (i > 0) dates.push(`${year - i}-12-31`);
    if (i !== 0 || month > 9) dates.push(`${year - i}-09-30`);
    if (i !== 0 || month > 6) dates.push(`${year - i}-06-30`);
    if (i !== 0 || month > 3) dates.push(`${year - i}-03-31`);
  }
  return dates;
}

function planNumber(plan: string, marker: string): number {
  const idx = plan.indexOf(marker);
  if (idx < 0) return 0;
  const match = plan.slice(idx + marker.length).match(/^\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
