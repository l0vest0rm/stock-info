/**
 * Conservative valuation bands, one per archetype.
 *
 * Scope rules this module enforces without exception:
 * - It never emits a price target, a "fair value" point estimate, or a
 *   buy/sell instruction.  A band is a multiple range plus the assumption it
 *   depends on.
 * - It never invents a denominator.  When a required input is missing the
 *   metric is `insufficient_data` with the missing keys named.
 * - It never compares across capital-intensity classes without saying so: the
 *   EV/EBITDA warning from the depreciation work is carried into the band.
 * - Every band is anchored to a financial report date, never to a price date.
 *
 * Price is optional.  Anchor inputs (TTM and forward values, EV components,
 * cash flow) come from disclosed statements; the quote only decides whether the
 * *implied* column can be filled.  That separation is what lets the engine run
 * while a market-data provider is unavailable.
 */

export type ValuationBandBasis =
  | "net_income_ttm"
  | "net_income_forward"
  | "ebit_ttm"
  | "ebitda_ttm"
  | "revenue_ttm"
  | "operating_cash_flow_ttm"
  | "free_cash_flow_ttm"
  | "book_equity"
  | "dividend_per_share"
  | "net_income_mid_cycle"
  | "ebit_mid_cycle";

export type ValuationBandStatus = "available" | "insufficient_data" | "forbidden_for_archetype";

export type ValuationBand = {
  /** Stable key: `pe_ttm`, `ev_ebit`, `ev_ebitda`, `ev_revenue`, `pb`, `fcf_yield`, `dividend_yield`, `reverse_dcf`. */
  key: string;
  label: string;
  role: "primary" | "auxiliary";
  status: ValuationBandStatus;
  /**
   * Conservative multiple range, ordered low..high.  For yield-style metrics
   * this is a yield range in percent, not a multiple.
   */
  range: { low: number; high: number } | null;
  /** Unit of `range`: multiple, percent or times. */
  unit: "multiple" | "percent" | null;
  /** The denominator actually used, in the statement currency. */
  denominator: { basis: ValuationBandBasis; value: number; reportDate: string } | null;
  /**
   * Value the range implies for the whole company when a price is supplied.
   * Never presented alone: it always travels with `range` and `assumptions`.
   */
  implied?: { metric: "market_cap" | "enterprise_value"; low: number; high: number; source: "derived_from_denominator" } | null;
  /** Everything the range depends on, so a reader can disagree with a number, not a black box. */
  assumptions: string[];
  /** Keys that blocked the computation; empty when `status === "available"`. */
  missingInputs: string[];
  /** Why the band is unusable even when a denominator exists. */
  reasons: string[];
};

export type ValuationBandReadModel = {
  code: string;
  archetype: string;
  /** Statement dates the denominators come from. */
  asOf: { income: string | null; balance: string | null; cashflow: string | null };
  bands: ValuationBand[];
  /**
   * Cross-band diagnostics that a reader must see before using any multiple
   * from this company against another company.
   */
  warnings: string[];
  /** Explicit statement that this output is research input, not advice. */
  disclaimer: string;
};

/** Inputs the caller has already extracted from disclosed statements. */
export type ValuationBandInput = {
  code: string;
  archetype: string;
  asOf: { income: string | null; balance: string | null; cashflow: string | null };
  ttm: {
    netProfit?: number | null;
    revenue?: number | null;
    operatingCashFlow?: number | null;
    /** EBIT proxy: operating profit net of investment and fair-value income. */
    ebit?: number | null;
    /** EBIT + depreciation & amortization from the cash-flow supplement block. */
    ebitda?: number | null;
    /** Operating cash flow − capital expenditure.  Null when capex is undisclosed. */
    freeCashFlow?: number | null;
  };
  balance: {
    /** Equity attributable to the parent. */
    parentEquity?: number | null;
    /** Disclosed interest-bearing debt total; null when any line is missing. */
    grossDebt?: number | null;
    /** Disclosed cash and equivalents. */
    cash?: number | null;
    minorityEquity?: number | null;
    /** True when the debt total is a partial sum over disclosed lines only. */
    debtIncomplete?: boolean;
  };
  /** Forward estimate, only when it is a real analyst/company figure. */
  forward?: { netProfit?: number | null; source?: string | null } | null;
  /** Optional quote; absence only disables the implied column. */
  marketCap?: number | null;
  /** Diagnostic carried from the depreciation work. */
  capitalIntensity?: { depreciationToEbit: number | null } | null;
  /**
   * Through-cycle earnings.  Required for `cyclical_commodity`: TTM embeds
   * whatever point of the cycle the latest report lands on, so a peak year
   * makes the company look permanently cheap and a trough year makes it look
   * permanently expensive.  Absent or too short a history means the PE band is
   * `insufficient_data`, never a TTM fallback.
   */
  midCycle?: {
    status: "available" | "insufficient_data";
    mean: number | null;
    median: number | null;
    window: string | null;
    /**
     * The annual observations behind the centre, oldest first.  Their
     * `reportDate` is the only real date in the group — `window` is a label
     * like `2016..2025` and cannot anchor a band.
     */
    years?: Array<{ fiscalYear: number; value: number; reportDate: string }>;
    /** EBIT-basis centre, used by the EV/EBIT midpoint band when present. */
    ebitMedian?: number | null;
    notes?: string[];
  } | null;
};

const DISCLAIMER = "保守区间是研究方法输入，不是目标价、不是买卖指令；区间只对所列假设成立。";

/**
 * Default conservative multiple ranges per method.  These are deliberately
 * wide and deliberately low at the bottom: the purpose is to bracket a
 * defensible range, not to certify a multiple.  Callers may override, and any
 * override must be echoed in `assumptions`.
 */
const DEFAULT_RANGES: Record<string, { low: number; high: number; unit: "multiple" | "percent"; note: string }> = {
  pe_ttm: { low: 8, high: 18, unit: "multiple", note: "TTM 口径，未做周期调整；仅适用于利润为正且可持续的公司。" },
  pe_forward: { low: 10, high: 22, unit: "multiple", note: "前瞻口径依赖盈利预测，预测来源必须写明。" },
  ev_ebit: { low: 8, high: 16, unit: "multiple", note: "EV/EBIT 对资本密度不敏感，可作为 EV/EBITDA 的交叉检验。" },
  // EV/EBITDA is split by capital-intensity class.  Measured across the 78
  // A-shares, depreciation/EBIT spans 0.04 (贵州茅台) to 17.07 (启明星辰); using
  // one range for both ends reads a capital-heavy business as permanently cheap.
  ev_ebitda: { low: 5, high: 11, unit: "multiple", note: "EV/EBITDA 高度依赖资本密度，跨公司比较前必须确认折旧/EBIT 量级相近。" },
  ev_ebitda_light: { low: 14, high: 28, unit: "multiple", note: "轻资本（折旧/EBIT < 0.5）：EBITDA 与 EBIT 几乎同量级，倍数自然更高，不能用重资本区间衡量。" },
  ev_ebitda_medium: { low: 9, high: 18, unit: "multiple", note: "中等资本密度（折旧/EBIT 0.5–1）。" },
  ev_ebitda_heavy: { low: 5, high: 11, unit: "multiple", note: "重资本（折旧/EBIT > 1）：折旧摊销吞掉大部分利润，EV/EBITDA 与 EV/EBIT 必须并列。" },
  ev_revenue: { low: 0.6, high: 2.4, unit: "multiple", note: "EV/营业收入只在无正利润阶段使用，利润率恢复后失效。" },
  pb: { low: 0.8, high: 2.5, unit: "multiple", note: "PB 必须与 ROE 一起看，单独使用的 PB 区间没有信息量。" },
  fcf_yield: { low: 3, high: 6, unit: "percent", note: "自由现金流收益率下限体现机会成本，上限体现不确定性打折。" },
  dividend_yield: { low: 2.5, high: 5, unit: "percent", note: "股息率必须以可持续分红为前提，一次性特别股息不计入门槛。" },
  pe_mid_cycle: { low: 8, high: 15, unit: "multiple", note: "周期中枢 PE 以 5–10 年年报利润中位数为分母，上限低于 TTM PE 区间，因为中枢本身已含周期不确定性。" },
  ev_ebit_mid_cycle: { low: 7, high: 14, unit: "multiple", note: "周期中枢 EV/EBIT，与 EV/EBITDA 相比对重资产周期更稳健。" },
};

const FINANCIAL_LED_ARCHETYPES = new Set(["bank", "insurer", "broker"]);
const EV_METRICS_FORBIDDEN = FINANCIAL_LED_ARCHETYPES;

export function buildValuationBands(input: ValuationBandInput): ValuationBandReadModel {
  const bands: ValuationBand[] = [];
  const warnings: string[] = [];

  const add = (band: ValuationBand) => bands.push(band);

  // ---------------------------------------------------------------- PE (TTM)
  const isCyclical = input.archetype === "cyclical_commodity";
  if (input.archetype === "pre_profit_milestone") {
    add(forbidden("pe_ttm", "PE(TTM)", "primary", input.archetype, "里程碑型公司尚无可持续利润，PE 无意义。"));
  } else {
    // A bank's or insurer's earnings are an output of the balance sheet, not an
    // independent anchor: `valuation-coverage` marks PE as auxiliary there and
    // says so explicitly ("PE 辅助，不单独使用"), because profit is moved by
    // provisioning and reserve releases faster than by the business.  Keeping
    // it primary made every bank screen as 60–70% cheap against the generic
    // 8–18x range — a wide margin that measured the wrong method, not value.
    const earningsLed = FINANCIAL_LED_ARCHETYPES.has(input.archetype);
    add(multipleBand({
      key: "pe_ttm",
      label: isCyclical
        ? "PE(TTM)（周期股仅作参考）"
        : earningsLed
          ? "PE(TTM)（资产负债表驱动，仅作辅助）"
          : "PE(TTM)",
      // A cyclical's TTM denominator is peak- or trough-biased, so the band is
      // demoted and the mid-cycle PE below carries the primary role.
      role: isCyclical || earningsLed ? "auxiliary" : "primary",
      basis: "net_income_ttm",
      value: input.ttm.netProfit ?? null,
      reportDate: input.asOf.income,
      metric: "market_cap",
      marketCap: input.marketCap,
      extraMissing: netProfitUsable(input.ttm.netProfit) ? [] : ["净利润为正（当前为负或缺失）"],
      extraAssumptions: [
        ...(isCyclical
          ? ["周期股 TTM 利润可能处在周期高点或低点，只用 TTM PE 会系统性误判，须与周期中枢 PE 并列。"]
          : []),
        ...(earningsLed
          ? ["银行的利润受拨备与减值影响，PE 不能单独作为估值依据；主方法为 PB-ROE 与股息率。"]
          : []),
      ],
    }));
  }

  // -------------------------------------------------- PE (through the cycle)
  if (isCyclical) {
    add(midCycleBand(input));
  }

  // ------------------------------------------------------------ PE (forward)
  add({
    key: "pe_forward",
    label: "前瞻 PE",
    role: "auxiliary",
    status: input.forward?.netProfit && input.forward.netProfit > 0 && input.forward.source
      ? (positive(input.marketCap) ? "available" : "insufficient_data")
      : "insufficient_data",
    range: input.forward?.netProfit && input.forward.netProfit > 0 && input.forward.source
      ? rangeOf("pe_forward")
      : null,
    unit: input.forward?.netProfit && input.forward.netProfit > 0 && input.forward.source ? "multiple" : null,
    denominator: input.forward?.netProfit && input.forward.netProfit > 0
      ? { basis: "net_income_forward", value: input.forward.netProfit, reportDate: input.asOf.income ?? "" }
      : null,
    implied: input.forward?.netProfit && input.forward.netProfit > 0 && positive(input.marketCap)
      ? impliedMarketCap(input.forward.netProfit, rangeOf("pe_forward"), input.marketCap)
      : null,
    assumptions: [
      DEFAULT_RANGES.pe_forward.note,
      "前瞻净利润必须来自可引用的盈利预测；本模块不自行推算未来利润。",
    ],
    missingInputs: [
      ...(input.forward?.netProfit && input.forward.netProfit > 0 ? [] : ["前瞻净利润"]),
      ...(input.forward?.source ? [] : ["前瞻净利润来源"]),
      ...(positive(input.marketCap) ? [] : ["市值（用于隐含值）"]),
    ],
    reasons: [],
  });

  // ----------------------------------------------------------- EV / EBIT
  if (EV_METRICS_FORBIDDEN.has(input.archetype)) {
    for (const [key, label] of [["ev_ebit", "EV/EBIT"], ["ev_ebitda", "EV/EBITDA"], ["ev_revenue", "EV/营业收入"]] as const) {
      add(forbidden(key, label, "primary", input.archetype, `${input.archetype} 属资产负债表驱动业务，EV 口径不适用。`));
    }
  } else {
    add(enterpriseBand({
      key: "ev_ebit",
      label: "EV/EBIT",
      role: "primary",
      basis: "ebit_ttm",
      value: input.ttm.ebit ?? null,
      input,
    }));
    add(enterpriseBand({
      key: "ev_ebitda",
      label: "EV/EBITDA",
      role: "auxiliary",
      basis: "ebitda_ttm",
      value: input.ttm.ebitda ?? null,
      input,
    }));

    // EV/Revenue is only a pre-profit tool; elsewhere it is a forbidden smell.
    const preProfit = !positive(input.ttm.netProfit);
    if (input.archetype === "pre_profit_milestone" || preProfit) {
      add(enterpriseBand({
        key: "ev_revenue",
        label: "EV/营业收入",
        role: input.archetype === "pre_profit_milestone" ? "primary" : "auxiliary",
        basis: "revenue_ttm",
        value: input.ttm.revenue ?? null,
        input,
      }));
    }
  }

  // ------------------------------------------------------------------ PB
  if (input.archetype === "bank") {
    add(multipleBand({
      key: "pb",
      label: "PB（须与 ROE 联读）",
      role: "primary",
      basis: "book_equity",
      value: input.balance.parentEquity ?? null,
      reportDate: input.asOf.balance,
      metric: "market_cap",
      marketCap: input.marketCap,
    }));
  } else if (FINANCIAL_LED_ARCHETYPES.has(input.archetype)) {
    add(forbidden("pb", "PB", "primary", input.archetype, "保险/券商的账面权益不反映内含价值或经纪业务质量，未调整的 PB 会失真。"));
  } else if (!["software_platform", "property_operator", "payment", "healthcare_services"].includes(input.archetype)) {
    add(multipleBand({
      key: "pb",
      label: "PB（辅助）",
      role: "auxiliary",
      basis: "book_equity",
      value: input.balance.parentEquity ?? null,
      reportDate: input.asOf.balance,
      metric: "market_cap",
      marketCap: input.marketCap,
    }));
  }

  // -------------------------------------------------- FCF / dividend yield
  if (["stable_cash_dividend", "software_platform", "payment", "growth_manufacturing"].includes(input.archetype)) {
    add(yieldBand({
      key: "fcf_yield",
      label: "自由现金流收益率",
      role: "primary",
      basis: "free_cash_flow_ttm",
      flow: input.ttm.freeCashFlow ?? null,
      reportDate: input.asOf.cashflow ?? input.asOf.income,
      metric: "market_cap",
      marketCap: input.marketCap,
      missing: input.ttm.freeCashFlow === null || input.ttm.freeCashFlow === undefined
        ? ["自由现金流（经营现金流 − 资本开支）"]
        : [],
    }));
  }

  // -------------------------------------------- profile-level method bans
  // Non-cyclical companies must never use a through-cycle centre: it averages
  // away real growth and makes a compounder look permanently expensive.
  if (!isCyclical && !bands.some((band) => band.key === "pe_mid_cycle")) {
    add(forbidden("pe_mid_cycle", "PE（周期中枢利润）", "auxiliary", input.archetype, "非周期公司的利润增长是真实信号，用周期中枢会抹掉成长。"));
  }

  // ------------------------------------------------------ cross-band checks
  const midCycleBandResult = bands.find((band) => band.key === "pe_mid_cycle");
  const ttmBand = bands.find((band) => band.key === "pe_ttm");
  if (midCycleBandResult?.status === "available" && midCycleBandResult.denominator && ttmBand?.denominator) {
    const divergence = Math.abs(ttmBand.denominator.value - midCycleBandResult.denominator.value)
      / Math.abs(midCycleBandResult.denominator.value);
    if (divergence > 0.5) {
      warnings.push(
        `TTM 利润是周期中枢的 ${(ttmBand.denominator.value / midCycleBandResult.denominator.value).toFixed(2)} 倍（相差 ${(divergence * 100).toFixed(0)}%）：当前处在周期的偏${ttmBand.denominator.value > midCycleBandResult.denominator.value ? "高" : "低"}位，倍数结论必须同时给出两种口径。`,
      );
    }
  }
  if (isCyclical && midCycleBandResult?.status === "insufficient_data") {
    warnings.push("周期股缺少可用的中枢利润，PE 类结论暂不成立；不要退回 TTM 单独使用。");
  }

  const ebitBand = bands.find((band) => band.key === "ev_ebit");
  const ebitdaBand = bands.find((band) => band.key === "ev_ebitda");
  if (ebitBand?.status === "available" && ebitdaBand?.status === "available" && ebitBand.denominator && ebitdaBand.denominator) {
    const spread = ebitdaBand.denominator.value / ebitBand.denominator.value;
    if (spread > 1.5) {
      warnings.push(
        `折旧摊销是 EBIT 的 ${(spread - 1).toFixed(1)} 倍：EV/EBITDA 会显著压低倍数，必须与 EV/EBIT 并列阅读，且不能与轻资产公司直接比较。`,
      );
      if (ebitdaBand.role === "primary") ebitdaBand.role = "auxiliary";
    }
  }
  const ratio = input.capitalIntensity?.depreciationToEbit ?? null;
  if (ratio !== null && ratio > 1) {
    warnings.push(`折旧摊销/EBIT = ${ratio.toFixed(2)}，属重资本模式；倍数比较必须先分组。`);
  }
  if (input.balance.debtIncomplete) {
    warnings.push("有息负债为部分披露科目的合计，EV 偏低；补齐缺失科目后再用 EV 类区间。");
  }
  if (!positive(input.marketCap)) {
    warnings.push("未提供市值：区间只给出倍数与假设，不填隐含值。");
  }
  if (bands.every((band) => band.status !== "available")) {
    warnings.push("当前没有一个区间成立，说明估值输入不足，不应据此形成任何判断。");
  }

  return {
    code: input.code,
    archetype: input.archetype,
    asOf: input.asOf,
    bands,
    warnings,
    disclaimer: DISCLAIMER,
  };
}

function multipleBand(input: {
  key: string;
  label: string;
  role: ValuationBand["role"];
  basis: ValuationBandBasis;
  value: number | null;
  reportDate: string | null;
  metric: "market_cap";
  marketCap: number | null | undefined;
  extraMissing?: string[];
  extraAssumptions?: string[];
}): ValuationBand {
  const usable = positive(input.value);
  const range = rangeOf(input.key);
  const missing = [
    ...(usable ? [] : ["分母（值为负或缺失）"]),
    ...(input.extraMissing ?? []),
    ...(positive(input.marketCap) ? [] : ["市值（用于隐含值）"]),
  ];
  return {
    key: input.key,
    label: input.label,
    role: input.role,
    status: usable ? "available" : "insufficient_data",
    range: usable ? range : null,
    unit: usable ? DEFAULT_RANGES[input.key].unit : null,
    denominator: usable && input.reportDate
      ? { basis: input.basis, value: input.value as number, reportDate: input.reportDate }
      : null,
    implied: usable && positive(input.marketCap)
      ? impliedMarketCap(input.value as number, range, input.marketCap)
      : null,
    assumptions: [DEFAULT_RANGES[input.key].note, ...(input.extraAssumptions ?? [])],
    missingInputs: missing,
    reasons: [],
  };
}

/**
 * PE on through-cycle earnings, the primary band for `cyclical_commodity`.
 *
 * The denominator is the median of five to ten annual net-profit observations.
 * The median is used by default because a single boom year (中远海控 2021–2022)
 * moves the mean by more than the whole rest of the window, and averaging it
 * in would still anchor the band to the cycle's best moment.
 */
function midCycleBand(input: ValuationBandInput): ValuationBand {
  const midCycle = input.midCycle ?? null;
  const usable = midCycle?.status === "available" && positive(midCycle.median);
  const range = rangeOf("pe_mid_cycle");
  const missing = [
    ...(midCycle ? [] : ["周期中枢利润（5–10 年年报）"]),
    ...(midCycle && midCycle.status === "insufficient_data" ? ["足够长的年报历史"] : []),
    ...(usable ? [] : midCycle ? ["中枢利润为正"] : []),
    ...(positive(input.marketCap) ? [] : ["市值（用于隐含值）"]),
  ];
  // `window` is a range label such as `2016..2025`, not a date.  Using it as the
  // anchor made `pe_mid_cycle` undateable: date parsing failed, so every
  // cyclical (中远海控, 紫金矿业, 万华化学 …) fell through to `stale_basis` and
  // could never be screened, even though its median came from real annual
  // filings.  Anchor on the newest annual report actually inside the window.
  const anchorDate = midCycle?.years?.length
    ? [...midCycle.years].sort((left, right) => left.reportDate.localeCompare(right.reportDate)).at(-1)!.reportDate
    : null;
  return {
    key: "pe_mid_cycle",
    label: "PE（周期中枢利润）",
    role: "primary",
    status: usable && anchorDate ? "available" : "insufficient_data",
    range: usable && anchorDate ? range : null,
    unit: usable && anchorDate ? "multiple" : null,
    denominator: usable && midCycle?.median && anchorDate
      ? { basis: "net_income_mid_cycle", value: midCycle.median, reportDate: anchorDate }
      : null,
    implied: usable && midCycle?.median && anchorDate && positive(input.marketCap)
      ? impliedMarketCap(midCycle.median, range, input.marketCap)
      : null,
    assumptions: [
      DEFAULT_RANGES.pe_mid_cycle.note,
      "分母取年报利润中位数；缺失年度不插值，亏损年度保留。",
      ...(midCycle?.window ? [`中枢窗口 ${midCycle.window}。`] : []),
      ...(midCycle?.notes ?? []),
    ],
    missingInputs: [
      ...missing,
      ...(anchorDate ? [] : ["中枢窗口内没有可用的年报报告期"]),
    ],
    reasons: [],
  };
}

function enterpriseBand(input: {
  key: string;
  label: string;
  role: ValuationBand["role"];
  basis: ValuationBandBasis;
  value: number | null;
  input: ValuationBandInput;
}): ValuationBand {
  const usable = positive(input.value);
  const range = rangeOf(input.key, input.input);
  const debt = input.input.balance.grossDebt ?? null;
  const cash = input.input.balance.cash ?? null;
  const evReady = debt !== null && cash !== null && input.input.balance.debtIncomplete !== true;
  const missing = [
    ...(usable ? [] : ["分母（值为负或缺失）"]),
    ...(debt === null ? ["有息负债"] : []),
    ...(cash === null ? ["现金及等价物"] : []),
    ...(input.input.balance.debtIncomplete ? ["完整有息负债科目"] : []),
    ...(positive(input.input.marketCap) ? [] : ["市值（用于隐含值）"]),
  ];
  return {
    key: input.key,
    label: input.label,
    role: input.role,
    status: usable ? "available" : "insufficient_data",
    range: usable ? range : null,
    unit: usable ? "multiple" : null,
    denominator: usable && input.input.asOf.income
      ? { basis: input.basis, value: input.value as number, reportDate: input.input.asOf.income }
      : null,
    implied: usable && positive(input.input.marketCap) && evReady
      ? {
          metric: "enterprise_value",
          low: (input.value as number) * range.low,
          high: (input.value as number) * range.high,
          source: "derived_from_denominator",
        }
      : null,
    assumptions: [
      DEFAULT_RANGES[rangeKeyFor(input.key, input.input)].note,
      "EV = 市值 + 有息负债 − 现金；有息负债缺失时不计算 EV，而不是当作零。",
      ...(input.input.balance.minorityEquity !== null && input.input.balance.minorityEquity !== undefined
        ? ["未将少数股东权益计入 EV；跨公司比较时需统一口径。"]
        : []),
    ],
    missingInputs: missing,
    reasons: [],
  };
}

function yieldBand(input: {
  key: string;
  label: string;
  role: ValuationBand["role"];
  basis: ValuationBandBasis;
  flow: number | null;
  /**
   * Statement date the flow is anchored on.  Leaving this empty made every
   * yield band undateable, so a reader could not tell a one-year-old cash flow
   * from a fresh one — and any staleness check had to reject the band outright.
   */
  reportDate: string | null;
  metric: "market_cap";
  marketCap: number | null | undefined;
  missing: string[];
}): ValuationBand {
  const usable = positive(input.flow);
  const range = rangeOf(input.key);
  const dated = usable && input.reportDate;
  return {
    key: input.key,
    label: input.label,
    role: input.role,
    status: usable && positive(input.marketCap) && input.reportDate ? "available" : "insufficient_data",
    range: usable && positive(input.marketCap) && input.reportDate ? range : null,
    unit: usable && positive(input.marketCap) && input.reportDate ? "percent" : null,
    denominator: dated ? { basis: input.basis, value: input.flow as number, reportDate: input.reportDate as string } : null,
    implied: null,
    assumptions: [DEFAULT_RANGES[input.key].note, "收益率区间是门槛值，不是对当前价格的判断。"],
    missingInputs: [
      ...input.missing,
      ...(positive(input.marketCap) ? [] : ["市值"]),
      ...(input.reportDate ? [] : ["现金流报告期"]),
    ],
    reasons: [],
  };
}

function forbidden(key: string, label: string, role: ValuationBand["role"], archetype: string, reason: string): ValuationBand {
  return {
    key,
    label,
    role,
    status: "forbidden_for_archetype",
    range: null,
    unit: null,
    denominator: null,
    implied: null,
    assumptions: [],
    missingInputs: [],
    reasons: [reason, `原型 ${archetype} 的禁用规则见 docs/investment-valuation-coverage.md。`],
  };
}

/**
 * Range lookup.  EV/EBITDA resolves to a capital-intensity-specific range so a
 * light-asset platform and a wafer fab are never measured with the same
 * multiple; every other metric is capital-neutral and keeps one range.
 */
function rangeOf(key: string, input?: ValuationBandInput): { low: number; high: number } {
  if (key === "ev_ebitda" && input) {
    const className = intensityClassOf(input);
    if (className) {
      const entry = DEFAULT_RANGES[`ev_ebitda_${className}`];
      return { low: entry.low, high: entry.high };
    }
  }
  const entry = DEFAULT_RANGES[key];
  return { low: entry.low, high: entry.high };
}

function rangeKeyFor(key: string, input: ValuationBandInput): string {
  if (key === "ev_ebitda") {
    const className = intensityClassOf(input);
    if (className) return `ev_ebitda_${className}`;
  }
  return key;
}

function intensityClassOf(input: ValuationBandInput): "light" | "medium" | "heavy" | null {
  const ratio = input.capitalIntensity?.depreciationToEbit ?? null;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  if (ratio < 0.5) return "light";
  if (ratio <= 1) return "medium";
  return "heavy";
}

function impliedMarketCap(denominator: number, range: { low: number; high: number }, _marketCap: number | null | undefined) {
  return {
    metric: "market_cap" as const,
    low: denominator * range.low,
    high: denominator * range.high,
    source: "derived_from_denominator" as const,
  };
}

function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function netProfitUsable(value: number | null | undefined): boolean {
  return positive(value);
}
