import assert from "node:assert/strict";
import test from "node:test";

import { buildResearchFinancialQuality } from "./research-financial-quality.ts";

const basis = {
  id: "consolidated-cny-gaap",
  currency: "CNY",
  accountingStandard: "CAS",
  scope: "consolidated-parent",
  revision: "reported",
};

function quarter(fiscalYear, fiscalQuarter) {
  const endMonth = String(fiscalQuarter * 3).padStart(2, "0");
  const endDay = fiscalQuarter === 1 || fiscalQuarter === 4 ? "31" : "30";
  const startMonth = String((fiscalQuarter - 1) * 3 + 1).padStart(2, "0");
  return {
    kind: "quarter",
    startDate: `${fiscalYear}-${startMonth}-01`,
    endDate: `${fiscalYear}-${endMonth}-${endDay}`,
    fiscalYear,
    fiscalQuarter,
  };
}

function annual(fiscalYear) {
  return {
    kind: "annual",
    startDate: `${fiscalYear}-01-01`,
    endDate: `${fiscalYear}-12-31`,
    fiscalYear,
  };
}

function fact(metric, period, value, options = {}) {
  const id = options.id ?? `${options.basis?.id ?? basis.id}:${metric}:${period.endDate}`;
  return {
    id,
    metric,
    period,
    value,
    basis: options.basis ?? basis,
    provenance: options.provenance ?? {
      sourceId: "annual-report",
      sourceType: "statutory_filing",
      documentId: `doc-${period.endDate}`,
      locator: metric,
    },
    derivationFormula: options.derivationFormula,
    derivationStatus: options.derivationStatus,
    derivationReasonCodes: options.derivationReasonCodes,
    inputReferences: options.inputReferences,
  };
}

function observation(result, kind, frequency, endDate, selectedBasis = basis) {
  return result.observations.find((item) =>
    item.kind === kind
    && item.frequency === frequency
    && item.period.endDate === endDate
    && item.basis.id === selectedBasis.id
  );
}

function trend(result, metric, kind, frequency, endDate) {
  return result.trends.find((item) =>
    item.metric === metric
    && item.kind === kind
    && item.frequency === frequency
    && item.period.endDate === endDate
  );
}

test("builds quarterly and TTM financial quality observations with auditable inputs", () => {
  const facts = [];
  const values = [
    { revenue: 100, gross_profit: 40, operating_profit: 20, net_profit: 10, operating_cash_flow: 12, capital_expenditure: 2, cash: 30, total_debt: 50, total_equity: 80, diluted_weighted_average_shares: 10, diluted_shares: 10 },
    { revenue: 110, gross_profit: 44, operating_profit: 22, net_profit: 11, operating_cash_flow: 13, capital_expenditure: 3, cash: 32, total_debt: 50, total_equity: 84, diluted_weighted_average_shares: 10, diluted_shares: 10 },
    { revenue: 121, gross_profit: 48.4, operating_profit: 24.2, net_profit: 12.1, operating_cash_flow: 14, capital_expenditure: 3, cash: 35, total_debt: 48, total_equity: 90, diluted_weighted_average_shares: 10, diluted_shares: 10 },
    { revenue: 133.1, gross_profit: 53.24, operating_profit: 26.62, net_profit: 13.31, operating_cash_flow: 16, capital_expenditure: 4, cash: 40, total_debt: 46, total_equity: 96, diluted_weighted_average_shares: 10, diluted_shares: 10 },
  ];
  values.forEach((row, index) => {
    for (const [metric, value] of Object.entries(row)) facts.push(fact(metric, quarter(2025, index + 1), value));
  });

  const result = buildResearchFinancialQuality({ facts });
  const ttmRevenue = result.series.find((item) => item.metric === "revenue" && item.frequency === "ttm");
  const latestTtm = ttmRevenue.points.at(-1);
  assert.equal(latestTtm.status, "available");
  assert.ok(Math.abs(latestTtm.value - 464.1) < 1e-9);
  assert.equal(latestTtm.inputs.length, 4);
  assert.equal(latestTtm.inputs[0].provenance.sourceType, "statutory_filing");

  assert.ok(Math.abs(trend(result, "revenue", "qoq", "quarterly", "2025-06-30").value - 10) < 1e-9);
  assert.ok(Math.abs(observation(result, "net_margin", "ttm", "2025-12-31").value - 10) < 1e-9);
  assert.ok(Math.abs(observation(result, "cash_conversion", "ttm", "2025-12-31").value - (55 / 46.41 * 100)) < 1e-9);
  assert.ok(Math.abs(observation(result, "free_cash_flow", "ttm", "2025-12-31").value - 43) < 1e-9);
  assert.ok(Math.abs(observation(result, "free_cash_flow_per_share", "ttm", "2025-12-31").value - 4.3) < 1e-9);
  assert.equal(observation(result, "net_debt", "quarterly", "2025-12-31").value, 6);
  assert.equal(observation(result, "book_value_per_share", "quarterly", "2025-12-31").value, 9.6);
});

test("keeps directly auditable free cash flow while blocking entity-specific mechanics for an unclassified company", () => {
  const period = annual(2025);
  const facts = [
    fact("revenue", period, 100), fact("net_profit", period, 10), fact("operating_cash_flow", period, 20), fact("capital_expenditure", period, 4),
    fact("total_assets", period, 80), fact("total_equity", period, 40), fact("total_debt", period, 30), fact("cash", period, 8),
  ];
  const result = buildResearchFinancialQuality({ facts, entityType: "unknown" });
  const freeCashFlow = observation(result, "free_cash_flow", "annual", period.endDate);
  assert.equal(freeCashFlow.status, "available");
  assert.equal(freeCashFlow.value, 16);
  assert.equal(freeCashFlow.inputs.length, 2);
  for (const kind of ["cash_conversion", "return_on_assets", "return_on_invested_capital"]) {
    const item = observation(result, kind, "annual", period.endDate);
    assert.equal(item.status, "missing"); assert.equal(item.value, null);
    assert.deepEqual(item.reasonCodes, ["entity_financial_profile_unconfirmed"]);
  }
  assert.equal(observation(result, "net_margin", "annual", period.endDate).status, "available");
});

test("marks generic cash-flow and capital mechanics not applicable for a sourced financial entity", () => {
  const period = annual(2025);
  const result = buildResearchFinancialQuality({ facts: [fact("revenue", period, 100), fact("net_profit", period, 10), fact("operating_cash_flow", period, 20), fact("capital_expenditure", period, 4)], entityType: "financial" });
  assert.equal(observation(result, "free_cash_flow", "annual", period.endDate).status, "not_applicable");
  assert.equal(observation(result, "cash_conversion", "annual", period.endDate).status, "not_applicable");
  assert.equal(observation(result, "net_margin", "annual", period.endDate).status, "available");
});

test("calculates annual YoY and CAGR without mixing periods", () => {
  const result = buildResearchFinancialQuality({
    facts: [
      fact("revenue", annual(2023), 100),
      fact("revenue", annual(2024), 121),
      fact("revenue", annual(2025), 144),
    ],
  });
  assert.ok(Math.abs(trend(result, "revenue", "yoy", "annual", "2024-12-31").value - 21) < 1e-9);
  assert.ok(Math.abs(trend(result, "revenue", "yoy", "annual", "2025-12-31").value - (144 / 121 * 100 - 100)) < 1e-9);
  assert.ok(Math.abs(trend(result, "revenue", "cagr", "annual", "2025-12-31").value - 20) < 1e-9);
});

test("keeps missing values missing and never turns them into zero", () => {
  const period = annual(2025);
  const result = buildResearchFinancialQuality({
    facts: [
      fact("revenue", period, 100),
      fact("net_profit", period, null),
      fact("operating_cash_flow", period, 20),
    ],
  });
  const margin = observation(result, "net_margin", "annual", period.endDate);
  const conversion = observation(result, "cash_conversion", "annual", period.endDate);
  assert.equal(margin.status, "missing");
  assert.equal(margin.value, null);
  assert.deepEqual(margin.reasonCodes, ["missing_net_profit"]);
  assert.equal(conversion.status, "missing");
  assert.ok(result.gaps.some((gap) => gap.observationId === margin.id));
});

test("marks cross-basis inputs incomparable instead of combining currencies or accounting scope", () => {
  const usdBasis = { ...basis, id: "parent-usd-gaap", currency: "USD", accountingStandard: "US-GAAP", scope: "parent" };
  const period = annual(2025);
  const result = buildResearchFinancialQuality({
    facts: [
      fact("revenue", period, 100, { basis }),
      fact("net_profit", period, 10, { basis: usdBasis }),
    ],
  });
  const cnyMargin = observation(result, "net_margin", "annual", period.endDate, basis);
  assert.equal(cnyMargin.status, "incomparable");
  assert.equal(cnyMargin.value, null);
  assert.deepEqual(cnyMargin.reasonCodes, ["required_fact_has_different_basis"]);
});

test("preserves conflicting source facts and blocks downstream derived values", () => {
  const period = annual(2025);
  const result = buildResearchFinancialQuality({
    facts: [
      fact("revenue", period, 100, { id: "revenue-source-a" }),
      fact("revenue", period, 120, { id: "revenue-source-b", provenance: { sourceId: "filing-b", sourceType: "statutory_filing" } }),
      fact("net_profit", period, 10),
    ],
  });
  const revenue = result.series.find((item) => item.metric === "revenue" && item.frequency === "annual").points[0];
  assert.equal(revenue.status, "incomparable");
  assert.equal(revenue.value, null);
  assert.equal(revenue.inputs.length, 2);
  assert.equal(observation(result, "net_margin", "annual", period.endDate).status, "incomparable");
});

test("marks non-positive profit and financial-company cash conversion as not applicable", () => {
  const period = annual(2025);
  const commonFacts = [
    fact("net_profit", period, -5),
    fact("operating_cash_flow", period, 20),
    fact("capital_expenditure", period, 3),
  ];
  const nonFinancial = buildResearchFinancialQuality({ facts: commonFacts });
  assert.equal(observation(nonFinancial, "cash_conversion", "annual", period.endDate).status, "not_applicable");
  assert.deepEqual(observation(nonFinancial, "cash_conversion", "annual", period.endDate).reasonCodes, ["non_positive_profit_denominator"]);

  const financial = buildResearchFinancialQuality({ facts: commonFacts, entityType: "financial" });
  assert.equal(observation(financial, "cash_conversion", "annual", period.endDate).status, "not_applicable");
  assert.deepEqual(observation(financial, "free_cash_flow", "annual", period.endDate).reasonCodes, ["financial_company_fcf_not_applicable"]);
});

test("does not create an available TTM point from non-consecutive quarters", () => {
  const result = buildResearchFinancialQuality({
    facts: [
      fact("revenue", quarter(2025, 1), 100),
      fact("revenue", quarter(2025, 2), 100),
      fact("revenue", quarter(2025, 4), 100),
    ],
  });
  const latest = result.series.find((item) => item.metric === "revenue" && item.frequency === "ttm").points.at(-1);
  assert.equal(latest.status, "missing");
  assert.equal(latest.value, null);
  assert.deepEqual(latest.reasonCodes, ["insufficient_quarter_history"]);
});

test("keeps an unauditable cumulative bridge incomparable instead of calculating through a basis change", () => {
  const result = buildResearchFinancialQuality({
    facts: [fact("revenue", quarter(2025, 2), null, {
      derivationFormula: "H1 cumulative value - Q1 cumulative value",
      derivationStatus: "incomparable",
      derivationReasonCodes: ["cumulative_bridge_mixed_accounting_basis"],
      inputReferences: [
        { factId: "h1", provenance: { sourceId: "h1", sourceType: "eastmoney" } },
        { factId: "q1", provenance: { sourceId: "q1", sourceType: "eastmoney" } },
      ],
    })],
  });
  const series = result.series.find((item) => item.metric === "revenue" && item.frequency === "quarterly");
  assert.equal(series.points[0].status, "incomparable");
  assert.deepEqual(series.points[0].reasonCodes, ["cumulative_bridge_mixed_accounting_basis"]);
  assert.equal(series.points[0].inputs.length, 2);
});

test("derives working-capital, balance-sheet, return and capital-allocation metrics only from comparable inputs", () => {
  const prior = annual(2024);
  const current = annual(2025);
  const facts = [
    ["revenue", 1000, 1200], ["cost_of_revenue", 600, 720], ["operating_profit", 100, 144], ["net_profit", 60, 90],
    ["pre_tax_profit", 80, 120], ["income_tax_expense", 20, 30], ["interest_expense", 10, 12],
    ["cash", 100, 120], ["total_debt", 200, 200], ["total_equity", 500, 560], ["total_assets", 900, 980],
    ["current_assets", 400, 480], ["current_liabilities", 200, 240], ["trade_receivables", 100, 120],
    ["contract_assets", 20, 24], ["inventory", 120, 144], ["trade_payables", 80, 90],
    ["diluted_shares", 100, 105], ["dividends_paid", 15, 20], ["share_repurchases", 8, 10], ["share_issuance", 2, 5],
  ].flatMap(([metric, priorValue, currentValue]) => [fact(metric, prior, priorValue), fact(metric, current, currentValue)]);
  const result = buildResearchFinancialQuality({ facts });

  assert.equal(observation(result, "working_capital", "annual", current.endDate).value, 198);
  assert.ok(Math.abs(observation(result, "days_sales_outstanding", "annual", current.endDate).value - (132 / 1200 * 365)) < 1e-9);
  assert.ok(Math.abs(observation(result, "days_inventory_outstanding", "annual", current.endDate).value - (132 / 720 * 365)) < 1e-9);
  assert.ok(Math.abs(observation(result, "days_payables_outstanding", "annual", current.endDate).value - (85 / 720 * 365)) < 1e-9);
  assert.ok(Math.abs(observation(result, "cash_conversion_cycle", "annual", current.endDate).value - (132 / 1200 * 365 + 132 / 720 * 365 - 85 / 720 * 365)) < 1e-9);
  assert.equal(observation(result, "current_ratio", "annual", current.endDate).value, 2);
  assert.equal(observation(result, "quick_ratio", "annual", current.endDate).value, 1.1);
  assert.equal(observation(result, "interest_coverage", "annual", current.endDate).value, 12);
  assert.ok(Math.abs(observation(result, "return_on_equity", "annual", current.endDate).value - (90 / 530 * 100)) < 1e-9);
  assert.ok(Math.abs(observation(result, "return_on_invested_capital", "annual", current.endDate).value - (108 / 620 * 100)) < 1e-9);
  assert.equal(observation(result, "incremental_roic", "annual", current.endDate).value, 82.5);
  assert.ok(Math.abs(observation(result, "net_dilution_rate", "annual", current.endDate).value - 5) < 1e-9);
  assert.equal(observation(result, "shareholder_distributions", "annual", current.endDate).value, 30);
  assert.equal(observation(result, "net_equity_distribution", "annual", current.endDate).value, 25);
});

test("does not force manufacturing ratios onto financial companies or invent returns with unsafe denominators", () => {
  const prior = annual(2024);
  const current = annual(2025);
  const facts = [
    fact("net_profit", prior, 10), fact("net_profit", current, 20),
    fact("total_equity", prior, 100), fact("total_equity", current, 120),
    fact("total_assets", prior, 200), fact("total_assets", current, 240),
    fact("cash", prior, 50), fact("cash", current, 60), fact("total_debt", prior, 80), fact("total_debt", current, 80),
  ];
  const financial = buildResearchFinancialQuality({ facts, entityType: "financial" });
  assert.equal(observation(financial, "working_capital", "annual", current.endDate).status, "not_applicable");
  assert.equal(observation(financial, "cash_conversion_cycle", "annual", current.endDate).status, "not_applicable");
  assert.equal(observation(financial, "return_on_invested_capital", "annual", current.endDate).status, "not_applicable");
  assert.ok(Math.abs(observation(financial, "return_on_equity", "annual", current.endDate).value - (20 / 110 * 100)) < 1e-9);

  const unsafe = buildResearchFinancialQuality({ facts: [fact("net_profit", prior, 10), fact("net_profit", current, 20), fact("total_equity", prior, -1), fact("total_equity", current, 1)] });
  assert.equal(observation(unsafe, "return_on_equity", "annual", current.endDate).status, "not_applicable");
  assert.deepEqual(observation(unsafe, "return_on_equity", "annual", current.endDate).reasonCodes, ["non_positive_average_balance"]);
});
