import type { FinancialStatement } from "../../../types";

/**
 * Per-industry valuation inputs derived only from disclosed statement fields.
 *
 * The existing TTM valuation (market cap / net profit, / equity, / revenue) is
 * a single generic formula.  Banks, insurers, resource cyclicals and property
 * operators are structurally distorted by it, so this module exposes the
 * intermediate building blocks an archetype-specific model needs:
 * enterprise-value debt, minority interests, EBIT, EBITDA and operating cash
 * flow.  Every value keeps the source fields it came from; a missing field
 * simply does not appear and its dependent metric becomes `null` instead of a
 * guessed number.
 */
export type StatementRole = "latest" | "prior_year_same_period";
export type StatementRows = { latest: FinancialStatement | null; priorYearSamePeriod: FinancialStatement | null };

export type ValuationInputLine = {
  key: string;
  label: string;
  value: number;
  sourceFields: string[];
  statement: "income" | "balance" | "cashflow";
};

export type ValuationInputGap = {
  key: string;
  label: string;
  reason: "field_not_reported" | "requires_provisional_policy";
};

export type BalanceSheetRevenueArchetype = "non_financial" | "bank" | "insurer" | "broker";

/** Revenue is not operating revenue for balance-sheet-driven businesses. */
export type RevenueArchetype = "operating_revenue" | "bank_net_interest_plus_fee" | "insurer_premium_net" | "broker_net_revenue";

export type ValuationInputsReadModel = {
  code: string;
  /** Statement dates the metrics are computed from; never mixed with a quote date. */
  incomeReportDate: string | null;
  balanceReportDate: string | null;
  cashflowReportDate: string | null;
  periods: Array<{
    role: StatementRole;
    reportDate: string;
    fiscalPeriod: string | null;
    currency: string | null;
  }>;
  balanceSheetArchetype: BalanceSheetRevenueArchetype;
  revenueArchetype: RevenueArchetype;
  lines: ValuationInputLine[];
  gaps: ValuationInputGap[];
  /** EBIT/EBITDA/FCF are meaningful only outside banks, insurers and brokers. */
  enterpriseValueApplicable: boolean;
  /** Historical revenue multiples are not meaningful for financials awaiting a dedicated revenue metric. */
  evRevenueApplicable: boolean;
  limitations: string[];
};

const DEBT_FIELDS: Array<[string, string[]]> = [
  ["shortLoan", ["SHORT_LOAN", "shortLoan"]],
  ["noncurrentLiab1year", ["NONCURRENT_LIAB_1YEAR", "noncurrentLiab1year"]],
  ["longLoan", ["LONG_LOAN", "longLoan"]],
  ["bondPayable", ["BOND_PAYABLE", "bondPayable"]],
  ["leaseLiab", ["LEASE_LIAB", "leaseLiab"]],
  ["shortLeaseLiab", ["SHORT_LEASE_LIAB", "shortLeaseLiab"]],
];
const CASH_FIELDS: Array<[string, string[]]> = [
  ["monetaryFunds", ["MONETARYFUNDS", "monetaryFunds"]],
  ["tradeFinassetNotfvtpl", ["TRADE_FINASSET_NOTFVTPL", "tradeFinassetNotfvtpl"]],
];
const OCF_FIELDS = ["NETCASH_OPERATE", "netcashOperate", "netCashOperate"];

/**
 * Builds dated valuation inputs from three primary statements.  The caller
 * supplies the rows; this function never fetches, adjusts for FX or blends
 * A/H/ADR securities.
 */
export function buildValuationInputs(input: {
  code: string;
  income: StatementRows;
  balance: StatementRows;
  cashflow: StatementRows;
  balanceSheetArchetype?: BalanceSheetRevenueArchetype;
}): ValuationInputsReadModel {
  const archetype = input.balanceSheetArchetype ?? "non_financial";
  const periodRows = [
    ["income", input.income],
    ["balance", input.balance],
    ["cashflow", input.cashflow],
  ] as const;
  const periods = periodRows.flatMap(([statement, rows]) =>
    ([rows.latest, rows.priorYearSamePeriod] as const)
      .filter((row): row is FinancialStatement => Boolean(row))
      .map((row) => ({
        role: row === rows.latest ? "latest" as const : "prior_year_same_period" as const,
        reportDate: `${statement}:${row.reportDate}`,
        fiscalPeriod: row.fiscalPeriod ?? fiscalString(row, "FISCAL_PERIOD"),
        currency: fiscalString(row, "REPORTING_CURRENCY") ?? fiscalString(row, "CURRENCY"),
      }))
  );

  const lines: ValuationInputLine[] = [];
  const gaps: ValuationInputGap[] = [];
  const limitations: string[] = [];

  const latestIncome = payload(input.income.latest);
  const priorIncome = payload(input.income.priorYearSamePeriod);
  const latestBalance = payload(input.balance.latest);
  const latestCashflow = payload(input.cashflow.latest);

  const operatingIncome = pick(latestIncome, ["OPERATE_PROFIT", "operateProfit"]);
  const revenue = pick(latestIncome, ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME", "totalOperateIncome", "operateIncome"]);
  const netProfit = pick(latestIncome, ["NETPROFIT", "netProfit"]);
  const parentNetProfit = pick(latestIncome, ["PARENT_NETPROFIT", "HOLDER_PROFIT", "parentNetprofit"]);
  const minorityProfit = pick(latestIncome, ["MINORITY_INTEREST", "minorityInterest"]);
  const investIncome = pick(latestIncome, ["INVEST_INCOME", "investIncome", "INVEST_JOINT_INCOME", "investJointIncome"]);
  const fairValueChange = pick(latestIncome, ["FAIRVALUE_CHANGE_INCOME", "fairvalueChangeIncome"]);
  const incomeTax = pick(latestIncome, ["INCOME_TAX", "incomeTax"]);

  if (revenue) lines.push(line("revenue", "营业总收入", revenue, "income"));
  if (operatingIncome) lines.push(line("operatingIncome", "营业利润", operatingIncome, "income"));
  if (netProfit) lines.push(line("netProfit", "净利润", netProfit, "income"));
  if (parentNetProfit) lines.push(line("parentNetProfit", "归母净利润", parentNetProfit, "income"));
  if (minorityProfit) lines.push(line("minorityProfit", "少数股东损益", minorityProfit, "income"));

  const totalParentEquity = pick(latestBalance, ["TOTAL_PARENT_EQUITY", "totalParentEquity"]);
  const totalEquity = pick(latestBalance, ["TOTAL_EQUITY", "totalEquity"]);
  const minorityEquity = pick(latestBalance, ["MINORITY_EQUITY", "minorityEquity"]);
  const totalAssets = pick(latestBalance, ["TOTAL_ASSETS", "totaAssets", "totalAssets"]);

  if (totalAssets) lines.push(line("totalAssets", "总资产", totalAssets, "balance"));
  if (totalEquity) lines.push(line("totalEquity", "股东权益合计", totalEquity, "balance"));
  if (totalParentEquity) lines.push(line("parentEquity", "归母权益", totalParentEquity, "balance"));
  if (minorityEquity) lines.push(line("minorityEquity", "少数股东权益", minorityEquity, "balance"));

  const debtParts: ValuationInputLine[] = [];
  for (const [key, candidates] of DEBT_FIELDS) {
    const matched = pick(latestBalance, candidates);
    if (matched) debtParts.push(line(key, key, matched, "balance"));
  }
  const cashParts: ValuationInputLine[] = [];
  for (const [key, candidates] of CASH_FIELDS) {
    const matched = pick(latestBalance, candidates);
    if (matched) cashParts.push(line(key, key, matched, "balance"));
  }

  if (debtParts.length > 0) {
    // Only an explicit partial sum when at least one debt line is disclosed;
    // missing debt lines are recorded as gaps rather than treated as zero.
    const debt = sum(debtParts);
    lines.push({ key: "grossDebtDisclosed", label: "已披露有息负债合计", value: debt, sourceFields: debtParts.flatMap((item) => item.sourceFields), statement: "balance" });
    const missingDebt = DEBT_FIELDS.filter(([key]) => !debtParts.some((part) => part.key === key));
    for (const [key] of missingDebt) {
      gaps.push({ key, label: `有息负债科目 ${key}`, reason: "field_not_reported" });
    }
    if (missingDebt.length > 0) {
      limitations.push("有息负债合计只包含已披露科目，缺失科目未被当作零；净负债与EV需人工补齐后再用。");
    }
  } else {
    gaps.push({ key: "grossDebtDisclosed", label: "有息负债", reason: "field_not_reported" });
    limitations.push("未取得有息负债明细，不能计算净负债与EV口径。");
  }

  if (cashParts.length > 0) {
    lines.push({ key: "cashDisclosed", label: "已披露现金类资产", value: sum(cashParts), sourceFields: cashParts.flatMap((item) => item.sourceFields), statement: "balance" });
  }

  const ocf = pick(latestCashflow, OCF_FIELDS);
  if (ocf) lines.push(line("operatingCashFlow", "经营活动现金流净额", ocf, "cashflow"));
  else gaps.push({ key: "operatingCashFlow", label: "经营现金流", reason: "field_not_reported" });

  const depreciation = pick(latestIncome, ["DEPRECIATION_AMORTIZATION", "depreciationAmortization"])
    ?? pick(latestCashflow, ["DEPRECIATION_AMORTIZATION", "depreciationAmortization"]);

  // EBIT proxy.  Eastmoney exposes operating profit tax-inclusive-of-non-
  // operating items; subtracting investment and fair-value income keeps a
  // cleaner operating base.  The proxy is labelled, never presented as a
  // reported EBIT.
  const enterpriseValueApplicable = archetype === "non_financial";
  if (enterpriseValueApplicable && operatingIncome) {
    let ebit = operatingIncome.value;
    for (const excluded of [investIncome, fairValueChange]) {
      if (excluded) ebit -= excluded.value;
    }
    lines.push({
      key: "ebit",
      label: "EBIT（营业利润扣除投资收益与公允价值变动）",
      value: ebit,
      sourceFields: [...operatingIncome.sourceFields, ...(investIncome?.sourceFields ?? []), ...(fairValueChange?.sourceFields ?? [])],
      statement: "income",
    });
    if (depreciation) {
      lines.push({
        key: "ebitda",
        label: "EBITDA（EBIT + 折旧摊销）",
        value: ebit + depreciation.value,
        sourceFields: [...(depreciation.sourceFields), "derived:ebit"],
        statement: "income",
      });
      lines.push(line("depreciationAmortization", "折旧摊销", depreciation, "income"));
    } else {
      gaps.push({ key: "ebitda", label: "折旧摊销", reason: "field_not_reported" });
      limitations.push("折旧摊销不在标准三表字段中，EBITDA不可计算；不得用资本开支或猜测值代替。");
    }
  } else if (!enterpriseValueApplicable) {
    limitations.push(`${archetype} 属资产负债表驱动业务，EBIT/EBITDA/EV 口径不适用。`);
  }

  if (archetype !== "non_financial") {
    limitations.push("本次未提供银行/保险/证券专用口径（净利息收入、拨备前利润、NBV/EV）；通用营收与EBIT不可用于该类公司估值。");
  }

  if (!incomeTax) gaps.push({ key: "incomeTax", label: "所得税", reason: "field_not_reported" });

  // Prior-year same-period row is required for growth comparisons; report it
  // as a gap so callers degrade to "unavailable" instead of using YoY fields.
  for (const [name, rows] of [["income", input.income], ["balance", input.balance], ["cashflow", input.cashflow]] as const) {
    if (!rows.priorYearSamePeriod) {
      gaps.push({ key: `${name}.priorYearSamePeriod`, label: `${name} 上年同期`, reason: "field_not_reported" });
    }
  }

  return {
    code: input.code,
    incomeReportDate: input.income.latest?.reportDate ?? null,
    balanceReportDate: input.balance.latest?.reportDate ?? null,
    cashflowReportDate: input.cashflow.latest?.reportDate ?? null,
    periods,
    balanceSheetArchetype: archetype,
    revenueArchetype: revenueArchetypeFor(archetype),
    lines,
    gaps,
    enterpriseValueApplicable,
    evRevenueApplicable: archetype === "non_financial",
    limitations,
  };
}

function revenueArchetypeFor(archetype: BalanceSheetRevenueArchetype): RevenueArchetype {
  switch (archetype) {
    case "bank": return "bank_net_interest_plus_fee";
    case "insurer": return "insurer_premium_net";
    case "broker": return "broker_net_revenue";
    default: return "operating_revenue";
  }
}

type Matched = { value: number; sourceFields: string[] };

function pick(payload: Record<string, unknown>, candidates: string[]): Matched | null {
  for (const field of candidates) {
    const value = payload[field];
    if (typeof value === "number" && Number.isFinite(value)) return { value, sourceFields: [field] };
  }
  return null;
}

function line(key: string, label: string, matched: Matched, statement: ValuationInputLine["statement"]): ValuationInputLine {
  return { key, label, value: matched.value, sourceFields: matched.sourceFields, statement };
}

function sum(items: ValuationInputLine[]): number {
  return items.reduce((total, item) => total + item.value, 0);
}

function payload(row: FinancialStatement | null): Record<string, unknown> {
  return row && row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}

function fiscalString(row: FinancialStatement, field: string): string | null {
  const value = payload(row)[field];
  return typeof value === "string" && value ? value : null;
}
