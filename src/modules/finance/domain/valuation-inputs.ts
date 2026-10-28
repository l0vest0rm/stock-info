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
export type StatementRole = "latest" | "prior_year_same_period" | "prior_fiscal_year" | "current_fiscal_year_same_period";
export type StatementRows = {
  latest: FinancialStatement | null;
  priorYearSamePeriod: FinancialStatement | null;
  /**
   * Prior fiscal-year-end statement.  Depreciation must roll on year ends
   * because Eastmoney publishes the cash-flow supplement block (FA_IR_DEPR and
   * friends) only for annual and half-year reports — never for Q1 or Q3.
   */
  priorFiscalYear?: FinancialStatement | null;
  /**
   * The same fiscal endpoint one year before `latest`, which is the
   * half-year/9M/annual row the TTM subtraction needs.  Equal to
   * `priorYearSamePeriod` for most periods, but kept explicit because the
   * annual case subtracts nothing.
   */
  currentFiscalYearSamePeriod?: FinancialStatement | null;
};

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
    statement: "income" | "balance" | "cashflow";
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
  /** Latest row is a provisional pre-disclosure estimate; keep it visible but not trade-ready. */
  provisional: boolean;
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
 * Depreciation and amortization, taken from the cash-flow supplement block.
 *
 * `FA_IR_DEPR` is the reported "固定资产折旧、油气资产折耗、生产性生物资产折旧"
 * line.  `OILGAS_BIOLOGY_DEPR` repeats the same figure to within 1e-5 on every
 * issuer sampled, so the two are alternate labels and must never be summed.
 * `IA_AMORTIZE` / `LPE_AMORTIZE` / `USERIGHT_ASSET_AMORTIZE` are the remaining
 * amortization lines of the same block and are additive.
 */
const DEPRECIATION_FIELDS = ["FA_IR_DEPR", "faIrDepr"];
const AMORTIZATION_FIELDS = ["IA_AMORTIZE", "LPE_AMORTIZE", "USERIGHT_ASSET_AMORTIZE"];

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
  provisional?: boolean;
}): ValuationInputsReadModel {
  const archetype = input.balanceSheetArchetype ?? "non_financial";
  const periodRows = [
    ["income", input.income],
    ["balance", input.balance],
    ["cashflow", input.cashflow],
  ] as const;
  const periods = periodRows.flatMap(([statement, rows]) => {
    const entries: Array<[StatementRole, FinancialStatement | null | undefined]> = [
      ["latest", rows.latest],
      ["prior_year_same_period", rows.priorYearSamePeriod],
      ["prior_fiscal_year", rows.priorFiscalYear],
      ["current_fiscal_year_same_period", rows.currentFiscalYearSamePeriod],
    ];
    return entries
      .filter((entry): entry is [StatementRole, FinancialStatement] => Boolean(entry[1]))
      // A row can serve two roles (e.g. prior FY doubles as prior-year same
      // period for a December report); report it once per role it occupies.
      .map(([role, row]) => ({
        statement,
        role,
        reportDate: row.reportDate,
        fiscalPeriod: row.fiscalPeriod ?? fiscalString(row, "FISCAL_PERIOD"),
        currency: fiscalString(row, "REPORTING_CURRENCY") ?? fiscalString(row, "CURRENCY"),
      }));
  });

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
    // Eastmoney omits a balance-sheet key entirely when the issuer has no such
    // line ("no short-term lease liability" simply does not appear), while it
    // returns an explicit `null` when the line exists but the value was not
    // supplied.  Only the second case is a data gap; treating an absent key as
    // missing would flag every issuer that legitimately carries no bonds.
    const debt = sum(debtParts);
    lines.push({ key: "grossDebtDisclosed", label: "已披露有息负债合计", value: debt, sourceFields: debtParts.flatMap((item) => item.sourceFields), statement: "balance" });
    const unsuppliedDebt = DEBT_FIELDS.filter(([key, candidates]) =>
      !debtParts.some((part) => part.key === key)
      && candidates.some((field) => field in latestBalance && latestBalance[field] === null)
    );
    for (const [key] of unsuppliedDebt) {
      gaps.push({ key, label: `有息负债科目 ${key}`, reason: "field_not_reported" });
    }
    if (unsuppliedDebt.length > 0) {
      limitations.push("有息负债合计只包含已披露科目；有科目存在但未返回数值的项已列出，未当作零，净负债与EV需补齐后再用。");
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

  // Depreciation & amortization come from the cash-flow supplement block, which
  // Eastmoney only publishes for annual and half-year reports.  Rolling it on
  // year ends is therefore the only honest path: a Q1/Q3 statement still has to
  // borrow the prior year end instead of reporting a hard zero.
  const depreciation = deprivationSchedule(
    latestCashflow,
    payload(input.cashflow.priorFiscalYear ?? null),
    payload(input.cashflow.currentFiscalYearSamePeriod ?? null),
    input.cashflow.latest?.reportDate ?? null,
  );
  if (depreciation.basis === "unavailable") {
    gaps.push({ key: "depreciationAmortization", label: "折旧摊销", reason: "field_not_reported" });
  }

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
    if (depreciation.basis !== "unavailable") {
      lines.push({
        key: "depreciationAmortization",
        label: "折旧摊销（现金流量表补充资料）",
        value: depreciation.value,
        sourceFields: depreciation.sourceFields,
        statement: "cashflow",
      });
      lines.push({
        key: "ebitda",
        label: "EBITDA（EBIT + 折旧摊销）",
        value: ebit + depreciation.value,
        sourceFields: [...depreciation.sourceFields, "derived:ebit"],
        statement: "cashflow",
      });
      limitations.push(`折旧摊销口径：${depreciation.note}`);
    } else {
      gaps.push({ key: "ebitda", label: "折旧摊销", reason: "field_not_reported" });
      limitations.push("现金流量表补充资料未提供折旧摊销，EBITDA 不可计算；不得用资本开支或猜测值代替。");
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
    provisional: input.provisional ?? false,
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

/**
 * Basis of a depreciation/amortization value, always exposed so a consumer
 * cannot mistake a rolled figure for the period's own disclosure.
 *
 * - `annual`: the statement itself is a fiscal-year-end report.
 * - `trailing_twelve_months`: prior FY + current half-year/YTD − prior-year same
 *   period, all from the supplement block.
 * - `prior_fiscal_year`: the latest report is a Q1/Q3 with no supplement block,
 *   so the prior year end is used and labelled as such.
 * - `unavailable`: no supplement block anywhere in the window.
 */
type DepreciationBasis = "annual" | "trailing_twelve_months" | "prior_fiscal_year" | "unavailable";

type DepreciationSchedule = {
  value: number;
  sourceFields: string[];
  basis: DepreciationBasis;
  note: string;
};

function deprivationSchedule(
  latest: Record<string, unknown>,
  priorFiscalYear: Record<string, unknown>,
  currentFiscalYearSamePeriod: Record<string, unknown>,
  latestReportDate: string | null,
): DepreciationSchedule {
  const empty: DepreciationSchedule = { value: 0, sourceFields: [], basis: "unavailable", note: "" };
  const reportMonth = latestReportDate ? Number(latestReportDate.slice(5, 7)) : 0;

  const fromAnnual = depreciationFromRow(priorFiscalYear, "priorFY");
  if (reportMonth === 12) {
    const own = depreciationFromRow(latest, "latest");
    if (own) {
      return { ...own, basis: "annual", note: `取 ${latestReportDate} 年报补充资料。` };
    }
  }

  const ownCurrent = depreciationFromRow(latest, "latest");
  const priorSame = depreciationFromRow(currentFiscalYearSamePeriod, "priorSame");
  if (fromAnnual && ownCurrent && priorSame && (reportMonth === 6 || reportMonth === 9)) {
    const value = fromAnnual.value + ownCurrent.value - priorSame.value;
    return {
      value,
      sourceFields: [...new Set([...fromAnnual.sourceFields, ...ownCurrent.sourceFields, ...priorSame.sourceFields])],
      basis: "trailing_twelve_months",
      note: `上年报 + 本期（${latestReportDate}） − 上年同期，均为现金流量表补充资料口径。`,
    };
  }

  if (fromAnnual) {
    return {
      ...fromAnnual,
      basis: "prior_fiscal_year",
      note: `${latestReportDate ?? "最新期"} 无补充资料（一季报/三季报不披露），沿用最近年报口径。`,
    };
  }
  return empty;
}

function depreciationFromRow(payloadOfRow: Record<string, unknown>, tag: string): DepreciationSchedule | null {
  const depreciation = pick(payloadOfRow, DEPRECIATION_FIELDS);
  const amortizations = AMORTIZATION_FIELDS
    .map((field) => pick(payloadOfRow, [field]))
    .filter((item): item is Matched => item !== null);
  if (!depreciation && amortizations.length === 0) return null;
  const value = (depreciation?.value ?? 0) + amortizations.reduce((total, item) => total + item.value, 0);
  return {
    value,
    sourceFields: [
      ...(depreciation ? depreciation.sourceFields.map((field) => `${tag}.${field}`) : []),
      ...amortizations.flatMap((item) => item.sourceFields.map((field) => `${tag}.${field}`)),
    ],
    basis: "annual",
    note: "",
  };
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
