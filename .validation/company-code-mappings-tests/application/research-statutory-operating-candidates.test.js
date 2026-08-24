// src/modules/research/application/research-statutory-operating-candidates.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

// config/research-information-evidence-mapping.json
var research_information_evidence_mapping_default = {
  version: "research-information-evidence-mapping.v2",
  mappings: [
    { category: "shipment_volume", informationTypes: ["fact", "guidance", "forecast"], targetModule: "operating_driver", targetField: "segment_volume", requiredFields: ["operatingModelId", "operatingSegmentId", "fiscalYear"] },
    { category: "production_capacity", informationTypes: ["fact", "guidance", "event"], targetModule: "operating_model", targetField: "capacity_constraint", requiredFields: ["operatingModelId", "constraintDescription"] },
    { category: "capacity_utilization", informationTypes: ["fact", "guidance", "forecast"], targetModule: "operating_driver", targetField: "capacity_utilization", requiredFields: ["operatingModelId", "operatingSegmentId", "fiscalYear"] },
    { category: "order_backlog", informationTypes: ["fact", "guidance", "forecast"], targetModule: "operating_model", targetField: "order_backlog", requiredFields: ["operatingModelId", "operatingSegmentId", "periodBasis"] },
    { category: "contract_award", informationTypes: ["fact", "event"], targetModule: "operating_model", targetField: "contract_driver", requiredFields: ["operatingModelId", "operatingSegmentId", "customerOrChannel"] },
    { category: "project_signing", informationTypes: ["fact", "event"], targetModule: "operating_model", targetField: "contract_driver", requiredFields: ["operatingModelId", "operatingSegmentId", "customerOrChannel"] },
    { category: "customer_relationship", informationTypes: ["fact", "relationship"], targetModule: "operating_model", targetField: "customer_relationship", requiredFields: ["operatingModelId", "operatingSegmentId", "customerOrChannel"] },
    { category: "price_change", informationTypes: ["fact", "guidance", "forecast"], targetModule: "operating_driver", targetField: "price_per_unit", requiredFields: ["operatingModelId", "operatingSegmentId", "fiscalYear", "unit"] },
    { category: "market_share", informationTypes: ["fact", "forecast", "opinion"], targetModule: "market_space", targetField: "market_share_bridge", requiredFields: ["marketSpaceAssessmentId", "periodLabel", "shareType"] },
    { category: "capacity_expansion", informationTypes: ["fact", "guidance", "event"], targetModule: "operating_model", targetField: "growth_constraint", requiredFields: ["operatingModelId", "affectedDriver"] },
    { category: "investment", informationTypes: ["event"], statementIncludesAll: ["\u9879\u76EE", "\u5DF2\u5B9E\u65BD\u5B8C\u6BD5"], targetModule: "operating_model", targetField: "growth_constraint", requiredFields: ["operatingModelId", "affectedDriver", "independent_capacity_or_delivery_evidence"] },
    { category: "net_interest_margin", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "net_interest_margin", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "loan_growth_rate", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "loan_growth_rate", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "deposit_growth_rate", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "deposit_growth_rate", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "deposit_cost_rate", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "deposit_cost_rate", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "non_performing_loan_ratio", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "non_performing_loan_ratio", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "special_mention_loan_ratio", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "special_mention_loan_ratio", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "loan_loss_reserve_coverage_ratio", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "loan_loss_reserve_coverage_ratio", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "credit_cost_ratio", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "credit_cost_ratio", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "capital_adequacy_ratio", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "capital_adequacy_ratio", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] },
    { category: "common_equity_tier1_capital_ratio", informationTypes: ["fact"], targetModule: "financial_specialty", targetField: "common_equity_tier1_capital_ratio", requiredFields: ["financialProfileId", "asOf", "definitionNote", "comparabilityNote"] }
  ]
};

// src/shared/codes.ts
function normalizeSecurityCode(input) {
  const raw = input.trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const compactKorea = raw.match(/^(\d{6})(KS|KQ)$/);
  if (compactKorea) {
    return `${compactKorea[1]}.${compactKorea[2]}`;
  }
  const malformedKorea = raw.match(/^(\d{6})(KS|KQ)\.(SH|SZ)$/);
  if (malformedKorea) {
    return `${malformedKorea[1]}.${malformedKorea[2]}`;
  }
  if (raw.includes(".")) {
    return raw;
  }
  if (/^\d{6}$/.test(raw)) {
    if (raw.startsWith("5") || raw.startsWith("6") || raw.startsWith("9")) {
      return `${raw}.SH`;
    }
    if (raw.startsWith("0") || raw.startsWith("1") || raw.startsWith("2") || raw.startsWith("3")) {
      return `${raw}.SZ`;
    }
  }
  if (/^\d{5}$/.test(raw)) {
    return `${raw}.HK`;
  }
  return raw;
}
function isSupportedCompanyCode(input) {
  const normalized = normalizeSecurityCode(input);
  return /^\d{6}\.(SH|SZ|BJ)$/.test(normalized) || /^\d{5}\.HK$/.test(normalized) || /^[A-Z0-9.-]+\.US$/.test(normalized);
}
function isSupportedSecurityCode(input) {
  const normalized = normalizeSecurityCode(input);
  return isSupportedCompanyCode(normalized) || /^\d{6}\.(OF|SF|ZF|KS|KQ)$/.test(normalized) || normalized === "KS11.UI" || normalized === "HSI.HK";
}
function normalizeSupportedCompanyCode(input) {
  const raw = input.trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const usMatch = raw.match(/^US([A-Z0-9.-]+)\.(?:OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return `${usMatch[1]}.US`;
  }
  const prefixedMatch = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixedMatch) {
    return `${prefixedMatch[2]}.${prefixedMatch[1]}`;
  }
  const hkPrefixedMatch = raw.match(/^HK(\d{5})$/);
  if (hkPrefixedMatch) {
    return `${hkPrefixedMatch[1]}.HK`;
  }
  const normalized = normalizeSecurityCode(raw);
  return isSupportedCompanyCode(normalized) ? normalized : "";
}
function securityMarket(code) {
  const normalized = normalizeSecurityCode(code);
  const suffix = normalized.split(".").pop() ?? "";
  switch (suffix) {
    case "SH":
      return "cn-sh";
    case "SZ":
      return "cn-sz";
    case "BJ":
      return "cn-bj";
    case "HK":
      return "hk";
    case "US":
      return "us";
    case "OF":
      return "fund";
    case "UI":
      return normalized === "KS11.UI" ? "kr" : "global";
    default:
      return "global";
  }
}
function inferSecurityType(code) {
  const normalized = normalizeSecurityCode(code);
  if (normalized.endsWith(".OF") || normalized.endsWith(".SF") || normalized.endsWith(".ZF")) {
    return "fund";
  }
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) {
    const base = normalized.slice(0, 6);
    if (base.startsWith("5") || base.startsWith("1")) {
      return "fund";
    }
    return "stock";
  }
  return "stock";
}

// shared/finance-mappings.json
var finance_mappings_default = {
  marketMap: {
    SZ: 0,
    BJ: 0,
    SH: 1,
    ZF: 0,
    SF: 1,
    ZI: 0,
    SI: 1,
    HI: 2,
    SO: 10,
    ZO: 12,
    LO: -1,
    OF: 150,
    HK: 116,
    O: 105,
    N: 106,
    AF: 107
  },
  usCodeMap: {
    "PDD.US": "PDD.O",
    "BEKE.US": "BEKE.N"
  },
  bankCodes: [
    "000001.SZ",
    "600000.SH",
    "601398.SH",
    "601939.SH",
    "601288.SH",
    "601166.SH",
    "601328.SH",
    "601169.SH",
    "600036.SH",
    "601988.SH",
    "601818.SH",
    "600015.SH",
    "600016.SH",
    "601997.SH",
    "002142.SZ",
    "601998.SH",
    "601229.SH",
    "600919.SH",
    "601009.SH",
    "600926.SH",
    "601916.SH",
    "601825.SH",
    "601658.SH",
    "601860.SH",
    "002839.SZ",
    "601577.SH",
    "002807.SH",
    "601963.SH",
    "002958.SZ",
    "002936.SZ",
    "002948.SZ",
    "601665.SH",
    "601187.SH",
    "600928.SH",
    "601231.SH",
    "601838.SH",
    "002966.SZ",
    "601128.SH",
    "603323.SH",
    "601077.SH",
    "601528.SH"
  ],
  securityCodes: [
    "600030.SH",
    "600999.SH",
    "601211.SH",
    "601377.SH",
    "601688.SH",
    "000776.SZ"
  ],
  insuranceCodes: [
    "601318.SH",
    "601601.SH",
    "601628.SH",
    "601336.SH"
  ],
  ignoreKeys: [
    "CONVERT_DIFF",
    "OPERATE_PROFIT_BALANCE",
    "ABLE_OCI",
    "CURRENT_ASSET_BALANCE",
    "LIAB_BALANCE",
    "NONCURRENT_ASSET_BALANCE",
    "NONCURRENT_LIAB_BALANCE",
    "CURRENT_LIAB_BALANCE",
    "PARENT_EQUITY_BALANCE",
    "EQUITY_BALANCE",
    "ASSET_BALANCE",
    "\u57FA\u672C\u52A0\u6743\u5E73\u5747\u80A1\u6570-\u666E\u901A\u80A1",
    "\u644A\u8584\u52A0\u6743\u5E73\u5747\u80A1\u6570-\u666E\u901A\u80A1",
    "\u975E\u8FD0\u7B97\u9879\u76EE",
    "\u5176\u4ED6\u50A8\u5907",
    "\u603B\u6743\u76CA\u53CA\u975E\u6D41\u52A8\u8D1F\u503A",
    "\u51C0\u6D41\u52A8\u8D44\u4EA7",
    "\u603B\u8D44\u4EA7\u51CF\u6D41\u52A8\u8D1F\u503A",
    "\u51C0\u8D44\u4EA7",
    "\u603B\u8D44\u4EA7\u51CF\u603B\u8D1F\u503A\u5408\u8BA1",
    "\u80A1\u4E1C\u6743\u76CA\u5176\u4ED6\u9879\u76EE",
    "\u53EF\u8F6C\u6362\u53EF\u8D4E\u56DE\u4F18\u5148\u80A1",
    "\u4F18\u5148\u80A1",
    "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u6743\u76CA\u5176\u4ED6\u9879\u76EE"
  ],
  coreKeys: [
    [
      "totalOperateIncome",
      "\u8425\u4E1A\u603B\u6536\u5165"
    ],
    [
      "netProfit",
      "\u51C0\u5229\u6DA6"
    ],
    [
      "roa",
      "\u603B\u8D44\u4EA7\u6536\u76CA\u7387(%)"
    ],
    [
      "roe",
      "\u51C0\u8D44\u4EA7\u6536\u76CA\u7387(%)"
    ],
    [
      "grossProfitRatio",
      "\u6BDB\u5229\u6DA6\u7387(%)"
    ],
    [
      "netProfitRatio",
      "\u51C0\u5229\u6DA6\u7387(%)"
    ],
    [
      "totalAssetsTurnover",
      "\u603B\u8D44\u4EA7\u5468\u8F6C\u7387"
    ],
    [
      "assetLiabRatio",
      "\u8D44\u4EA7\u8D1F\u503A\u7387(%)"
    ],
    [
      "equityMultiplier",
      "\u6743\u76CA\u4E58\u6570"
    ]
  ],
  incomeKeys: [
    [
      "totalOperateIncome",
      "\u8425\u4E1A\u603B\u6536\u5165",
      "TOTAL_OPERATE_INCOME",
      "\u8425\u8FD0\u6536\u5165",
      "\u8425\u4E1A\u6536\u5165",
      "info"
    ],
    [
      "operateIncome",
      "\u8425\u4E1A\u6536\u5165",
      "OPERATE_INCOME",
      "\u8425\u4E1A\u989D",
      "\u4E3B\u8425\u6536\u5165"
    ],
    [
      "interestIncome",
      "\u5229\u606F\u6536\u5165",
      "INTEREST_INCOME",
      "",
      ""
    ],
    [
      "feeCommissionIncome",
      "\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u6536\u5165",
      "FEE_COMMISSION_INCOME",
      "",
      ""
    ],
    [
      "otherBusinessIncome",
      "\u5176\u4ED6\u4E1A\u52A1\u6536\u5165",
      "OTHER_BUSINESS_INCOME",
      "\u5176\u4ED6\u8425\u4E1A\u6536\u5165",
      "\u5176\u4ED6\u4E1A\u52A1\u6536\u5165"
    ],
    [
      "totalOperateCost",
      "\u8425\u4E1A\u603B\u6210\u672C",
      "TOTAL_OPERATE_COST",
      "\u8425\u8FD0\u652F\u51FA",
      "\u8425\u4E1A\u6210\u672C",
      "info"
    ],
    [
      "operateCost",
      "\u8425\u4E1A\u6210\u672C",
      "OPERATE_COST",
      "\u9500\u552E\u6210\u672C",
      "\u4E3B\u8425\u6210\u672C"
    ],
    [
      "grossProfit",
      "\u6BDB\u5229",
      "",
      "\u6BDB\u5229",
      "\u6BDB\u5229"
    ],
    [
      "interestExpense",
      "\u5229\u606F\u652F\u51FA",
      "INTEREST_EXPENSE",
      "",
      ""
    ],
    [
      "feeCommissionExpense",
      "\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u652F\u51FA",
      "FEE_COMMISSION_EXPENSE",
      "",
      ""
    ],
    [
      "operateTaxAdd",
      "\u8425\u4E1A\u7A0E\u91D1\u53CA\u9644\u52A0",
      "OPERATE_TAX_ADD"
    ],
    [
      "totalOperateExpense",
      "\u8425\u4E1A\u603B\u8D39\u7528",
      "",
      "",
      "\u8425\u4E1A\u8D39\u7528",
      "info"
    ],
    [
      "saleExpense",
      "\u9500\u552E\u8D39\u7528",
      "SALE_EXPENSE",
      "\u9500\u552E\u53CA\u5206\u9500\u8D39\u7528",
      "\u8425\u9500\u8D39\u7528"
    ],
    [
      "manageExpense",
      "\u7BA1\u7406\u8D39\u7528",
      "MANAGE_EXPENSE",
      "\u884C\u653F\u5F00\u652F",
      "\u4E00\u822C\u53CA\u884C\u653F\u8D39\u7528"
    ],
    [
      "researchExpense",
      "\u7814\u53D1\u8D39\u7528",
      "RESEARCH_EXPENSE",
      "\u7814\u53D1\u8D39\u7528",
      "\u7814\u53D1\u8D39\u7528"
    ],
    [
      "financeExpense",
      "\u8D22\u52A1\u8D39\u7528",
      "FINANCE_EXPENSE",
      "\u878D\u8D44\u6210\u672C"
    ],
    [
      "feInterestExpense",
      "\u5176\u4E2D:\u5229\u606F\u8D39\u7528",
      "FE_INTEREST_EXPENSE",
      "",
      "\u5229\u606F\u652F\u51FA"
    ],
    [
      "feInterestIncome",
      "\u5176\u4E2D:\u5229\u606F\u6536\u5165",
      "FE_INTEREST_INCOME",
      "\u5229\u606F\u6536\u5165",
      "\u5229\u606F\u6536\u5165"
    ],
    [
      "assetImpairmentLoss",
      "\u8D44\u4EA7\u51CF\u503C\u635F\u5931(\u65E7)",
      "ASSET_IMPAIRMENT_LOSS",
      "\u51CF\u503C\u53CA\u62E8\u5907",
      "\u51CF\u503C\u53CA\u62E8\u5907"
    ],
    [
      "creditImpairmentLoss",
      "\u4FE1\u7528\u51CF\u503C\u635F\u5931(\u65E7)",
      "CREDIT_IMPAIRMENT_LOSS"
    ],
    [
      "fairvalueChangeIncome",
      "\u52A0:\u516C\u5141\u4EF7\u503C\u53D8\u52A8\u6536\u76CA",
      "FAIRVALUE_CHANGE_INCOME",
      "\u91CD\u4F30\u76C8\u4F59",
      "\u516C\u5141\u4EF7\u503C\u53D8\u52A8\u635F\u76CA"
    ],
    [
      "equityInvestIncome",
      "\u6743\u76CA\u6027\u6295\u8D44\u635F\u76CA",
      "",
      "\u6EA2\u5229\u5176\u4ED6\u9879\u76EE",
      "\u6743\u76CA\u6027\u6295\u8D44\u635F\u76CA"
    ],
    [
      "investIncome",
      "\u6295\u8D44\u6536\u76CA",
      "INVEST_INCOME",
      "",
      "\u6295\u8D44\u6027\u51CF\u503C\u51C6\u5907"
    ],
    [
      "investJointIncome",
      "\u5176\u4E2D:\u5BF9\u8054\u8425\u4F01\u4E1A\u548C\u5408\u8425\u4F01\u4E1A\u7684\u6295\u8D44\u6536\u76CA",
      "INVEST_JOINT_INCOME",
      "\u5E94\u5360\u8054\u8425\u516C\u53F8\u6EA2\u5229"
    ],
    [
      "assetDisposalIncome",
      "\u8D44\u4EA7\u5904\u7F6E\u6536\u76CA",
      "ASSET_DISPOSAL_INCOME"
    ],
    [
      "assetImpairmentIncome",
      "\u8D44\u4EA7\u51CF\u503C\u635F\u5931(\u65B0)",
      "ASSET_IMPAIRMENT_INCOME"
    ],
    [
      "creditImpairmentIncome",
      "\u4FE1\u7528\u51CF\u503C\u635F\u5931(\u65B0)",
      "CREDIT_IMPAIRMENT_INCOME"
    ],
    [
      "exchangeIncome",
      "\u6C47\u5151\u635F\u76CA",
      "",
      "",
      "\u6C47\u5151\u635F\u76CA"
    ],
    [
      "otherIncome",
      "\u5176\u4ED6\u6536\u76CA",
      "OTHER_INCOME",
      "\u5176\u4ED6\u6536\u76CA",
      "\u5176\u4ED6\u6536\u5165(\u652F\u51FA)"
    ],
    [
      "operateProfit",
      "\u8425\u4E1A\u5229\u6DA6",
      "OPERATE_PROFIT",
      "\u7ECF\u8425\u6EA2\u5229",
      "\u8425\u4E1A\u5229\u6DA6",
      "info"
    ],
    [
      "nonbusinessIncome",
      "\u52A0:\u8425\u4E1A\u5916\u6536\u5165",
      "NONBUSINESS_INCOME",
      "\u5176\u5B83\u6536\u5165"
    ],
    [
      "noneCurrentDisposalIncome",
      "\u5176\u4E2D:\u975E\u6D41\u52A8\u8D44\u4EA7\u5904\u7F6E\u5229\u5F97",
      "NONCURRENT_DISPOSAL_INCOME"
    ],
    [
      "nonbusinessExpense",
      "\u51CF:\u8425\u4E1A\u5916\u652F\u51FA",
      "NONBUSINESS_EXPENSE",
      "\u5176\u4ED6\u652F\u51FA"
    ],
    [
      "noneCurrentDisposalLoss",
      "\u5176\u4E2D:\u975E\u6D41\u52A8\u8D44\u4EA7\u5904\u7F6E\u51C0\u635F\u5931",
      "NONCURRENT_DISPOSAL_LOSS"
    ],
    [
      "totalProfit",
      "\u5229\u6DA6\u603B\u989D",
      "TOTAL_PROFIT",
      "\u9664\u7A0E\u524D\u6EA2\u5229",
      "\u6301\u7EED\u7ECF\u8425\u7A0E\u524D\u5229\u6DA6"
    ],
    [
      "incomeTax",
      "\u51CF:\u6240\u5F97\u7A0E",
      "INCOME_TAX",
      "\u7A0E\u9879",
      "\u6240\u5F97\u7A0E"
    ],
    [
      "netProfit",
      "\u51C0\u5229\u6DA6",
      "NETPROFIT",
      "\u9664\u7A0E\u540E\u6EA2\u5229",
      "\u51C0\u5229\u6DA6"
    ],
    [
      "continuedNetProfit",
      "\u6301\u7EED\u7ECF\u8425\u51C0\u5229\u6DA6",
      "CONTINUED_NETPROFIT",
      "\u6301\u7EED\u7ECF\u8425\u4E1A\u52A1\u7A0E\u540E\u5229\u6DA6",
      "\u6301\u7EED\u7ECF\u8425\u51C0\u5229\u6DA6",
      "info"
    ],
    [
      "priorityNetprofit",
      "\u5F52\u5C5E\u4E8E\u4F18\u5148\u80A1\u51C0\u5229\u6DA6\u53CA\u5176\u4ED6\u9879",
      "",
      "",
      "\u5F52\u5C5E\u4E8E\u4F18\u5148\u80A1\u51C0\u5229\u6DA6\u53CA\u5176\u4ED6\u9879"
    ],
    [
      "commonShareHoldersNetprofit",
      "\u5F52\u5C5E\u4E8E\u666E\u901A\u80A1\u80A1\u4E1C\u51C0\u5229\u6DA6",
      "",
      "",
      "\u5F52\u5C5E\u4E8E\u666E\u901A\u80A1\u80A1\u4E1C\u51C0\u5229\u6DA6"
    ],
    [
      "parentNetprofit",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u7684\u51C0\u5229\u6DA6",
      "PARENT_NETPROFIT",
      "\u80A1\u4E1C\u5E94\u5360\u6EA2\u5229",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u51C0\u5229\u6DA6"
    ],
    [
      "minorityInterest",
      "\u5C11\u6570\u80A1\u4E1C\u635F\u76CA",
      "MINORITY_INTEREST",
      "\u5C11\u6570\u80A1\u4E1C\u635F\u76CA",
      "\u5C11\u6570\u80A1\u4E1C\u635F\u76CA"
    ],
    [
      "deductParentNetprofit",
      "\u6263\u9664\u975E\u7ECF\u5E38\u6027\u635F\u76CA\u540E\u7684\u51C0\u5229\u6DA6",
      "DEDUCT_PARENT_NETPROFIT"
    ],
    [
      "basicEps",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA",
      "BASIC_EPS",
      "\u6BCF\u80A1\u57FA\u672C\u76C8\u5229",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA-\u666E\u901A\u80A1",
      "info"
    ],
    [
      "dilutedEps",
      "\u7A00\u91CA\u6BCF\u80A1\u6536\u76CA",
      "DILUTED_EPS",
      "\u6BCF\u80A1\u644A\u8584\u76C8\u5229",
      "\u644A\u8584\u6BCF\u80A1\u6536\u76CA-\u666E\u901A\u80A1"
    ],
    [
      "basicEpsAds",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA-ADS",
      "",
      "",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA-ADS"
    ],
    [
      "dilutedEpsAds",
      "\u644A\u8584\u6BCF\u80A1\u6536\u76CA-ADS",
      "",
      "",
      "\u644A\u8584\u6BCF\u80A1\u6536\u76CA-ADS"
    ],
    [
      "totalCompreIncome",
      "\u7EFC\u5408\u6536\u76CA\u603B\u989D",
      "TOTAL_COMPRE_INCOME",
      "\u5168\u9762\u6536\u76CA\u603B\u989D",
      "\u5168\u9762\u6536\u76CA\u603B\u989D",
      "info"
    ],
    [
      "parentTci",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u7684\u7EFC\u5408\u6536\u76CA\u603B\u989D",
      "PARENT_TCI",
      "\u672C\u516C\u53F8\u62E5\u6709\u4EBA\u5E94\u5360\u5168\u9762\u6536\u76CA\u603B\u989D",
      "\u672C\u516C\u53F8\u62E5\u6709\u4EBA\u5360\u5168\u9762\u6536\u76CA\u603B\u989D"
    ],
    [
      "minorityTci",
      "\u5F52\u5C5E\u4E8E\u5C11\u6570\u80A1\u4E1C\u7684\u7EFC\u5408\u6536\u76CA\u603B\u989D",
      "MINORITY_TCI",
      "\u975E\u63A7\u80A1\u6743\u76CA\u5E94\u5360\u5168\u9762\u6536\u76CA\u603B\u989D",
      "\u975E\u63A7\u80A1\u6743\u76CA\u5360\u5168\u9762\u6536\u76CA\u603B\u989D"
    ],
    [
      "otherCompreIncome",
      "\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "OTHER_COMPRE_INCOME",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5408\u8BA1\u9879"
    ],
    [
      "otherCompreIncomeOther",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5176\u4ED6\u9879\u76EE",
      "",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5176\u4ED6\u9879\u76EE",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "parentOci",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u7684\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "PARENT_OCI"
    ],
    [
      "minorityOci",
      "\u5F52\u5C5E\u4E8E\u5C11\u6570\u80A1\u4E1C\u7684\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "MINORITY_OCI"
    ]
  ],
  balanceKeys: [
    [
      "totaAssets",
      "\u8D44\u4EA7\u603B\u8BA1",
      "TOTAL_ASSETS",
      "\u603B\u8D44\u4EA7",
      "\u603B\u8D44\u4EA7",
      "info"
    ],
    [
      "totalCurrentAssets",
      "\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "TOTAL_CURRENT_ASSETS",
      "\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "info"
    ],
    [
      "monetaryFunds",
      "\u8D27\u5E01\u8D44\u91D1",
      "MONETARYFUNDS",
      "\u73B0\u91D1\u53CA\u7B49\u4EF7\u7269",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269"
    ],
    [
      "restrictedMonetary",
      "\u53D7\u9650\u5236\u5B58\u6B3E\u53CA\u73B0\u91D1",
      "",
      "\u53D7\u9650\u5236\u5B58\u6B3E\u53CA\u73B0\u91D1",
      "\u9650\u5236\u6027\u73B0\u91D1\u53CA\u5176\u4ED6(\u6D41\u52A8)"
    ],
    [
      "lendFund",
      "\u62C6\u51FA\u8D44\u91D1",
      "LEND_FUND"
    ],
    [
      "tradeFinassetNotfvtpl",
      "\u4EA4\u6613\u6027\u91D1\u878D\u8D44\u4EA7",
      "TRADE_FINASSET_NOTFVTPL",
      "\u77ED\u671F\u6295\u8D44",
      "\u77ED\u671F\u6295\u8D44"
    ],
    [
      "deriveFinasset",
      "\u884D\u751F\u91D1\u878D\u8D44\u4EA7",
      "DERIVE_FINASSET"
    ],
    [
      "noteAccountsRece",
      "\u5E94\u6536\u7968\u636E\u53CA\u5E94\u6536\u8D26\u6B3E",
      "NOTE_ACCOUNTS_RECE"
    ],
    [
      "noteRece",
      "\u5176\u4E2D:\u5E94\u6536\u7968\u636E",
      "NOTE_RECE"
    ],
    [
      "accountsRece",
      "\u5176\u4E2D:\u5E94\u6536\u8D26\u6B3E",
      "ACCOUNTS_RECE",
      "\u5E94\u6536\u5E10\u6B3E",
      "\u5E94\u6536\u8D26\u6B3E"
    ],
    [
      "accountsReceToRelatedParties",
      "\u5E94\u6536\u5173\u8054\u65B9\u6B3E\u9879",
      "",
      "",
      "\u5E94\u6536\u5173\u8054\u65B9\u6B3E\u9879"
    ],
    [
      "financeRece",
      "\u5E94\u6536\u6B3E\u9879\u878D\u8D44",
      "FINANCE_RECE"
    ],
    [
      "prepayment",
      "\u9884\u4ED8\u6B3E\u9879",
      "PREPAYMENT",
      "\u9884\u4ED8\u6B3E\u6309\u91D1\u53CA\u5176\u4ED6\u5E94\u6536\u6B3E",
      "\u9884\u4ED8\u6B3E\u9879(\u6D41\u52A8)"
    ],
    [
      "totalOtherRece",
      "\u5176\u4ED6\u5E94\u6536\u6B3E\u5408\u8BA1",
      "TOTAL_OTHER_RECE"
    ],
    [
      "interestRece",
      "\u5176\u4E2D:\u5E94\u6536\u5229\u606F",
      "INTEREST_RECE"
    ],
    [
      "dividendRece",
      "\u5176\u4E2D:\u5E94\u6536\u80A1\u5229",
      "DIVIDEND_RECE"
    ],
    [
      "otherRece",
      "\u5176\u4E2D:\u5176\u4ED6\u5E94\u6536\u6B3E",
      "OTHER_RECE"
    ],
    [
      "buyResaleFinasset",
      "\u4E70\u5165\u8FD4\u552E\u91D1\u878D\u8D44\u4EA7",
      "BUY_RESALE_FINASSET"
    ],
    [
      "inventory",
      "\u5B58\u8D27",
      "INVENTORY",
      "\u5B58\u8D27"
    ],
    [
      "contractAsset",
      "\u5408\u540C\u8D44\u4EA7",
      "CONTRACT_ASSET"
    ],
    [
      "noncurrentAsset1year",
      "\u4E00\u5E74\u5185\u5230\u671F\u7684\u975E\u6D41\u52A8\u8D44\u4EA7",
      "NONCURRENT_ASSET_1YEAR"
    ],
    [
      "holdsaleAsset",
      "\u6301\u6709\u5F85\u552E\u8D44\u4EA7",
      "HOLDSALE_ASSET",
      "\u6301\u4F5C\u51FA\u552E\u7684\u8D44\u4EA7(\u6D41\u52A8)"
    ],
    [
      "otherCurrentAsset",
      "\u5176\u4ED6\u6D41\u52A8\u8D44\u8D44\u4EA7",
      "OTHER_CURRENT_ASSET"
    ],
    [
      "totalNoncurrentAssets",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "TOTAL_NONCURRENT_ASSETS",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "info"
    ],
    [
      "loanAdvance",
      "\u53D1\u653E\u8D37\u6B3E\u53CA\u57AB\u6B3E",
      "LOAN_ADVANCE"
    ],
    [
      "creditorInvest",
      "\u503A\u6743\u6295\u8D44",
      "CREDITOR_INVEST"
    ],
    [
      "avaiableSaleFinasset",
      "\u53EF\u4F9B\u51FA\u552E\u91D1\u878D\u8D44\u4EA7",
      "AVAILABLE_SALE_FINASSET"
    ],
    [
      "longRece",
      "\u957F\u671F\u5E94\u6536\u6B3E",
      "LONG_RECE",
      "",
      "\u5176\u4ED6\u957F\u671F\u5E94\u6536\u6B3E"
    ],
    [
      "holdMaturityInvest",
      "\u6301\u6709\u81F3\u5230\u671F\u6295\u8D44",
      "HOLD_MATURITY_INVEST"
    ],
    [
      "longEquityInvest",
      "\u957F\u671F\u80A1\u6743\u6295\u8D44",
      "LONG_EQUITY_INVEST",
      "\u957F\u671F\u6295\u8D44"
    ],
    [
      "otherEquityInvest",
      "\u5176\u4ED6\u6743\u76CA\u5DE5\u5177\u6295\u8D44",
      "OTHER_EQUITY_INVEST",
      "\u5176\u4ED6\u6295\u8D44"
    ],
    [
      "otherNoncurrentFinasset",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u91D1\u878D\u8D44\u4EA7",
      "OTHER_NONCURRENT_FINASSET",
      "\u6307\u5B9A\u4EE5\u516C\u5141\u4EF7\u503C\u8BB0\u8D26\u4E4B\u91D1\u878D\u8D44\u4EA7"
    ],
    [
      "investRealestate",
      "\u6295\u8D44\u6027\u623F\u5730\u4EA7",
      "INVEST_REALESTATE"
    ],
    [
      "fixedAsset",
      "\u56FA\u5B9A\u8D44\u4EA7",
      "FIXED_ASSET",
      "\u7269\u4E1A\u5382\u623F\u53CA\u8BBE\u5907",
      "\u7269\u4E1A\u3001\u5382\u623F\u53CA\u8BBE\u5907"
    ],
    [
      "cip",
      "\u5728\u5EFA\u5DE5\u7A0B",
      "CIP"
    ],
    [
      "projectMaterial",
      "\u5DE5\u7A0B\u7269\u8D44",
      "PROJECT_MATERIAL"
    ],
    [
      "userightAsset",
      "\u4F7F\u7528\u6743\u8D44\u4EA7",
      "USERIGHT_ASSET"
    ],
    [
      "productiveBiologyAsset",
      "\u751F\u4EA7\u6027\u751F\u7269\u8D44\u4EA7",
      "PRODUCTIVE_BIOLOGY_ASSET"
    ],
    [
      "fixedAssetDisposal",
      "\u56FA\u5B9A\u8D44\u4EA7\u6E05\u7406",
      "FIXED_ASSET_DISPOSAL"
    ],
    [
      "intangibleAsset",
      "\u65E0\u5F62\u8D44\u4EA7",
      "INTANGIBLE_ASSET",
      "\u65E0\u5F62\u8D44\u4EA7",
      "\u65E0\u5F62\u8D44\u4EA7"
    ],
    [
      "developExpense",
      "\u5F00\u53D1\u652F\u51FA",
      "DEVELOP_EXPENSE"
    ],
    [
      "goodwill",
      "\u5546\u8A89",
      "GOODWILL"
    ],
    [
      "longPrepaidExpense",
      "\u957F\u671F\u5F85\u644A\u8D39\u7528",
      "LONG_PREPAID_EXPENSE"
    ],
    [
      "deferTaxAsset",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D44\u4EA7",
      "DEFER_TAX_ASSET",
      "\u9012\u5EF6\u7A0E\u9879\u8D44\u4EA7",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D44\u4EA7(\u975E\u6D41\u52A8)"
    ],
    [
      "otherNoncurrentAsset",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D44\u8D44\u4EA7",
      "OTHER_NONCURRENT_ASSET",
      "",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D44\u4EA7"
    ],
    [
      "noncurrentAssetOther",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5176\u4ED6\u9879\u76EE",
      "",
      "",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "totalLiabilities",
      "\u8D1F\u503A\u5408\u8BA1",
      "TOTAL_LIABILITIES",
      "\u603B\u8D1F\u503A",
      "\u603B\u8D1F\u503A",
      "info"
    ],
    [
      "totalCurrentLiab",
      "\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "TOTAL_CURRENT_LIAB",
      "\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "info"
    ],
    [
      "shortLoan",
      "\u77ED\u671F\u501F\u6B3E",
      "SHORT_LOAN",
      "\u77ED\u671F\u8D37\u6B3E"
    ],
    [
      "tradeFinliabNotfvtpl",
      "\u4EA4\u6613\u6027\u91D1\u878D\u8D1F\u503A",
      "TRADE_FINLIAB_NOTFVTPL"
    ],
    [
      "deriveFinliab",
      "\u884D\u751F\u91D1\u878D\u8D1F\u503A",
      "DERIVE_FINLIAB"
    ],
    [
      "noteAccountsPayable",
      "\u5E94\u4ED8\u7968\u636E\u53CA\u5E94\u4ED8\u8D26\u6B3E",
      "NOTE_ACCOUNTS_PAYABLE"
    ],
    [
      "notePayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u7968\u636E",
      "NOTE_PAYABLE",
      "\u5E94\u4ED8\u7968\u636E"
    ],
    [
      "accountsPayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u8D26\u6B3E",
      "ACCOUNTS_PAYABLE",
      "\u5E94\u4ED8\u5E10\u6B3E",
      "\u5E94\u4ED8\u8D26\u6B3E"
    ],
    [
      "accountsPayableToRelatedparties",
      "\u5E94\u4ED8\u5173\u8054\u65B9\u6B3E\u9879(\u6D41\u52A8)",
      "",
      "\u5E94\u4ED8\u5173\u8054\u65B9\u6B3E\u9879(\u6D41\u52A8)",
      "\u5E94\u4ED8\u5173\u8054\u65B9\u6B3E\u9879(\u6D41\u52A8)"
    ],
    [
      "shortDebt",
      "\u77ED\u671F\u503A\u52A1",
      "",
      "",
      "\u77ED\u671F\u503A\u52A1"
    ],
    [
      "shortLeaseLiab",
      "\u77ED\u671F\u79DF\u8D41\u8D1F\u503A",
      "",
      "\u878D\u8D44\u79DF\u8D41\u8D1F\u503A(\u6D41\u52A8)",
      "\u8D44\u672C\u79DF\u8D41\u503A\u52A1(\u6D41\u52A8)"
    ],
    [
      "shortDeferIncome",
      "\u77ED\u671F\u9012\u5EF6\u6536\u5165",
      "",
      "\u9012\u5EF6\u6536\u5165(\u6D41\u52A8)"
    ],
    [
      "advanceReceivables",
      "\u9884\u6536\u6B3E\u9879",
      "ADVANCE_RECEIVABLES",
      "\u9884\u6536\u6B3E\u9879",
      "\u9884\u6536\u53CA\u9884\u63D0\u8D39\u7528"
    ],
    [
      "contractLiab",
      "\u5408\u540C\u8D1F\u503A",
      "CONTRACT_LIAB"
    ],
    [
      "acceptDepositInterbank",
      "\u5438\u6536\u5B58\u6B3E\u53CA\u540C\u4E1A\u5B58\u653E",
      "ACCEPT_DEPOSIT_INTERBANK"
    ],
    [
      "staffSalaryPayable",
      "\u5E94\u4ED8\u804C\u5DE5\u85AA\u916C",
      "STAFF_SALARY_PAYABLE"
    ],
    [
      "taxPayable",
      "\u5E94\u4EA4\u7A0E\u8D39",
      "TAX_PAYABLE",
      "\u5E94\u4ED8\u7A0E\u9879"
    ],
    [
      "totalOtherPayable",
      "\u5176\u4ED6\u5E94\u4ED8\u6B3E\u5408\u8BA1",
      "TOTAL_OTHER_PAYABLE",
      ""
    ],
    [
      "interestPayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u5229\u606F",
      "INTEREST_PAYABLE"
    ],
    [
      "dividendPayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u80A1\u5229",
      "DIVIDEND_PAYABLE"
    ],
    [
      "otherPayable",
      "\u5176\u4E2D:\u5176\u4ED6\u5E94\u4ED8\u6B3E",
      "OTHER_PAYABLE",
      "\u5176\u4ED6\u5E94\u4ED8\u6B3E\u53CA\u5E94\u8BA1\u8D39\u7528"
    ],
    [
      "noncurrentLiab1year",
      "\u4E00\u5E74\u5185\u5230\u671F\u7684\u975E\u6D41\u52A8\u8D1F\u503A",
      "NONCURRENT_LIAB_1YEAR"
    ],
    [
      "holdsaleLiab",
      "\u6301\u4F5C\u51FA\u552E\u7684\u8D1F\u503A(\u6D41\u52A8)",
      "",
      "\u6301\u4F5C\u51FA\u552E\u7684\u8D1F\u503A(\u6D41\u52A8)"
    ],
    [
      "otherCurrentLiab",
      "\u5176\u4ED6\u6D41\u52A8\u8D1F\u503A",
      "OTHER_CURRENT_LIAB",
      "\u6D41\u52A8\u8D1F\u503A\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "totalNoncurrentLiab",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "TOTAL_NONCURRENT_LIAB",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "info"
    ],
    [
      "longLoan",
      "\u957F\u671F\u501F\u6B3E",
      "LONG_LOAN",
      "\u957F\u671F\u8D37\u6B3E"
    ],
    [
      "longStaffsalaryPayable",
      "\u957F\u671F\u5E94\u4ED8\u804C\u5DE5\u85AA\u916C",
      "LONG_STAFFSALARY_PAYABLE"
    ],
    [
      "bondPayable",
      "\u5E94\u4ED8\u503A\u5238",
      "BOND_PAYABLE"
    ],
    [
      "longNotePayable",
      "\u957F\u671F\u5E94\u4ED8\u7968\u636E",
      "",
      "\u5E94\u4ED8\u7968\u636E(\u975E\u6D41\u52A8)"
    ],
    [
      "leaseLiab",
      "\u79DF\u8D41\u8D1F\u503A",
      "LEASE_LIAB",
      "\u878D\u8D44\u79DF\u8D41\u8D1F\u503A(\u975E\u6D41\u52A8)",
      "\u8D44\u672C\u79DF\u8D41\u503A\u52A1(\u975E\u6D41\u52A8)"
    ],
    [
      "longPayable",
      "\u957F\u671F\u5E94\u4ED8\u6B3E",
      "LONG_PAYABLE"
    ],
    [
      "predictLiab",
      "\u9884\u8BA1\u8D1F\u503A",
      "PREDICT_LIAB"
    ],
    [
      "deferIncome",
      "\u9012\u5EF6\u6536\u76CA",
      "DEFER_INCOME",
      "\u9012\u5EF6\u6536\u5165(\u975E\u6D41\u52A8)"
    ],
    [
      "deferTaxLiab",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D1F\u503A",
      "DEFER_TAX_LIAB",
      "\u9012\u5EF6\u7A0E\u9879\u8D1F\u503A",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D1F\u503A(\u975E\u6D41\u52A8)"
    ],
    [
      "otherNoncurrentLiab",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D1F\u503A",
      "OTHER_NONCURRENT_LIAB",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D1F\u503A",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D1F\u503A"
    ],
    [
      "noncurrentLiabOther",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5176\u4ED6\u9879\u76EE",
      "",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "totalLiabEquity",
      "\u8D1F\u503A\u548C\u80A1\u4E1C\u6743\u76CA\u603B\u8BA1",
      "TOTAL_LIAB_EQUITY",
      "\u603B\u6743\u76CA\u53CA\u603B\u8D1F\u503A",
      "\u8D1F\u503A\u53CA\u80A1\u4E1C\u6743\u76CA\u5408\u8BA1",
      "info"
    ],
    [
      "totalEquity",
      "\u80A1\u4E1C\u6743\u76CA\u5408\u8BA1",
      "TOTAL_EQUITY",
      "\u603B\u6743\u76CA",
      "\u80A1\u4E1C\u6743\u76CA\u5408\u8BA1"
    ],
    [
      "totalParentEquity",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u6743\u76CA\u603B\u8BA1",
      "TOTAL_PARENT_EQUITY",
      "\u80A1\u4E1C\u6743\u76CA",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u6743\u76CA"
    ],
    [
      "minorityEquity",
      "\u5C11\u6570\u80A1\u4E1C\u6743\u76CA",
      "MINORITY_EQUITY",
      "\u5C11\u6570\u80A1\u4E1C\u6743\u76CA"
    ],
    [
      "shareCapital",
      "\u5B9E\u6536\u8D44\u672C\uFF08\u6216\u80A1\u672C\uFF09",
      "SHARE_CAPITAL",
      "\u80A1\u672C",
      "\u666E\u901A\u80A1",
      "info"
    ],
    [
      "capitalReserve",
      "\u8D44\u672C\u516C\u79EF",
      "CAPITAL_RESERVE",
      "\u80A1\u672C\u6EA2\u4EF7",
      "\u80A1\u672C\u6EA2\u4EF7"
    ],
    [
      "treasuryShares",
      "\u51CF:\u5E93\u5B58\u80A1",
      "TREASURY_SHARES"
    ],
    [
      "balanceOtherCompreIncome",
      "\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "OTHER_COMPRE_INCOME",
      "",
      "\u5176\u4ED6\u7EFC\u5408\u6536\u76CA"
    ],
    [
      "specialReserve",
      "\u4E13\u9879\u50A8\u5907",
      "SPECIAL_RESERVE"
    ],
    [
      "surplusReserve",
      "\u76C8\u4F59\u516C\u79EF",
      "SURPLUS_RESERVE"
    ],
    [
      "unassignRpofit",
      "\u672A\u5206\u914D\u5229\u6DA6",
      "UNASSIGN_RPOFIT",
      "\u4FDD\u7559\u6EA2\u5229(\u7D2F\u8BA1\u4E8F\u635F)",
      "\u7559\u5B58\u6536\u76CA"
    ],
    [
      "generalRiskReserve",
      "\u4E00\u822C\u98CE\u9669\u51C6\u5907",
      "GENERAL_RISK_RESERVE"
    ]
  ],
  cashflowKeys: [
    [
      "netcashOperate",
      "\u7ECF\u8425\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "NETCASH_OPERATE",
      "\u7ECF\u8425\u4E1A\u52A1\u73B0\u91D1\u51C0\u989D",
      "\u7ECF\u8425\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "info"
    ],
    [
      "totalOperateInflow",
      "\u7ECF\u8425\u6D3B\u52A8\u73B0\u91D1\u6D41\u5165\u5C0F\u8BA1",
      "TOTAL_OPERATE_INFLOW"
    ],
    [
      "salesServices",
      "\u9500\u552E\u5546\u54C1\u3001\u63D0\u4F9B\u52B3\u52A1\u6536\u5230\u7684\u73B0\u91D1",
      "SALES_SERVICES",
      "\u7ECF\u8425\u4EA7\u751F\u73B0\u91D1"
    ],
    [
      "depositInterbankAdd",
      "\u5BA2\u6237\u5B58\u6B3E\u548C\u540C\u4E1A\u5B58\u653E\u6B3E\u9879\u51C0\u589E\u52A0\u989D",
      "DEPOSIT_INTERBANK_ADD"
    ],
    [
      "receiveInterestCommission",
      "\u6536\u53D6\u5229\u606F\u3001\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u7684\u73B0\u91D1",
      "RECEIVE_INTEREST_COMMISSION"
    ],
    [
      "receiveTaxRefund",
      "\u6536\u5230\u7684\u7A0E\u6536\u8FD4\u8FD8",
      "RECEIVE_TAX_REFUND"
    ],
    [
      "receiveOtherOperate",
      "\u6536\u5230\u5176\u4ED6\u4E0E\u7ECF\u8425\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "RECEIVE_OTHER_OPERATE"
    ],
    [
      "totalOperateOutflow",
      "\u7ECF\u8425\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u5C0F\u8BA1",
      "TOTAL_OPERATE_OUTFLOW"
    ],
    [
      "buyServices",
      "\u8D2D\u4E70\u5546\u54C1\u3001\u63A5\u53D7\u52B3\u52A1\u652F\u4ED8\u7684\u73B0\u91D1",
      "BUY_SERVICES"
    ],
    [
      "loanAdvanceAdd",
      "\u5BA2\u6237\u8D37\u6B3E\u53CA\u57AB\u6B3E\u51C0\u589E\u52A0\u989D",
      "LOAN_ADVANCE_ADD"
    ],
    [
      "pbcInterbankAdd",
      "\u5B58\u653E\u4E2D\u592E\u94F6\u884C\u548C\u540C\u4E1A\u6B3E\u9879\u51C0\u589E\u52A0\u989D",
      "PBC_INTERBANK_ADD"
    ],
    [
      "payInterestCommission",
      "\u652F\u4ED8\u5229\u606F\u3001\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u7684\u73B0\u91D1",
      "PAY_INTEREST_COMMISSION"
    ],
    [
      "payStaffCash",
      "\u652F\u4ED8\u7ED9\u804C\u5DE5\u4EE5\u53CA\u4E3A\u804C\u5DE5\u652F\u4ED8\u7684\u73B0\u91D1",
      "PAY_STAFF_CASH"
    ],
    [
      "payAllTax",
      "\u652F\u4ED8\u7684\u5404\u9879\u7A0E\u8D39",
      "PAY_ALL_TAX",
      "\u5DF2\u4ED8\u7A0E\u9879"
    ],
    [
      "payOtherOperate",
      "\u652F\u4ED8\u5176\u4ED6\u4E0E\u7ECF\u8425\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "PAY_OTHER_OPERATE"
    ],
    [
      "operateOutflowOther",
      "\u7ECF\u8425\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u7684\u5176\u4ED6\u9879\u76EE",
      "OPERATE_OUTFLOW_OTHER"
    ],
    [
      "netcashInvest",
      "\u6295\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "NETCASH_INVEST",
      "\u6295\u8D44\u4E1A\u52A1\u73B0\u91D1\u51C0\u989D",
      "\u6295\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "info"
    ],
    [
      "totalInvestInflow",
      "\u6295\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u5165\u5C0F\u8BA1",
      "TOTAL_INVEST_INFLOW"
    ],
    [
      "withdrawInvest",
      "\u6536\u56DE\u6295\u8D44\u6536\u5230\u7684\u73B0\u91D1",
      "WITHDRAW_INVEST",
      "\u6536\u56DE\u6295\u8D44\u6240\u5F97\u73B0\u91D1"
    ],
    [
      "receiveInvestIncome",
      "\u53D6\u5F97\u6295\u8D44\u6536\u76CA\u6536\u5230\u7684\u73B0\u91D1",
      "RECEIVE_INVEST_INCOME"
    ],
    [
      "receiveInvestDividend",
      "\u5DF2\u6536\u80A1\u606F(\u6295\u8D44)",
      "",
      "\u5DF2\u6536\u80A1\u606F(\u6295\u8D44)"
    ],
    [
      "disposalLongAsset",
      "\u5904\u7F6E\u56FA\u5B9A\u8D44\u4EA7\u3001\u65E0\u5F62\u8D44\u4EA7\u548C\u5176\u4ED6\u957F\u671F\u8D44\u4EA7\u6536\u56DE\u7684\u73B0\u91D1\u51C0\u989D",
      "DISPOSAL_LONG_ASSET",
      "\u5904\u7F6E\u56FA\u5B9A\u8D44\u4EA7"
    ],
    [
      "obtainSubsidiaryOther",
      "\u53D6\u5F97\u5B50\u516C\u53F8\u53CA\u5176\u4ED6\u8425\u4E1A\u5355\u4F4D\u652F\u4ED8\u7684\u73B0\u91D1\u51C0\u989D",
      "OBTAIN_SUBSIDIARY_OTHER"
    ],
    [
      "receiveOtherInvest",
      "\u6536\u5230\u7684\u5176\u4ED6\u4E0E\u6295\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "RECEIVE_OTHER_INVEST"
    ],
    [
      "totalInvestOutflow",
      "\u6295\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u5C0F\u8BA1",
      "TOTAL_INVEST_OUTFLOW"
    ],
    [
      "constructLongAsset",
      "\u8D2D\u5EFA\u56FA\u5B9A\u8D44\u4EA7\u3001\u65E0\u5F62\u8D44\u4EA7\u548C\u5176\u4ED6\u957F\u671F\u8D44\u4EA7\u652F\u4ED8\u7684\u73B0\u91D1",
      "CONSTRUCT_LONG_ASSET",
      "\u8D2D\u5EFA\u56FA\u5B9A\u8D44\u4EA7"
    ],
    [
      "investPayCash",
      "\u6295\u8D44\u652F\u4ED8\u7684\u73B0\u91D1",
      "INVEST_PAY_CASH",
      "\u6295\u8D44\u652F\u4ED8\u73B0\u91D1"
    ],
    [
      "payOtherInvest",
      "\u652F\u4ED8\u5176\u4ED6\u4E0E\u6295\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "PAY_OTHER_INVEST"
    ],
    [
      "netcashFinance",
      "\u7B79\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "NETCASH_FINANCE",
      "\u878D\u8D44\u4E1A\u52A1\u73B0\u91D1\u51C0\u989D",
      "\u7B79\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "info"
    ],
    [
      "totalFinanceInflow",
      "\u7B79\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u5165\u5C0F\u8BA1",
      "TOTAL_FINANCE_INFLOW"
    ],
    [
      "acceptInvestCash",
      "\u5438\u6536\u6295\u8D44\u6536\u5230\u7684\u73B0\u91D1",
      "ACCEPT_INVEST_CASH"
    ],
    [
      "subsidiaryAcceptInvest",
      "\u5176\u4E2D:\u5B50\u516C\u53F8\u5438\u6536\u5C11\u6570\u80A1\u4E1C\u6295\u8D44\u6536\u5230\u7684\u73B0\u91D1",
      "SUBSIDIARY_ACCEPT_INVEST"
    ],
    [
      "receiveLoanCash",
      "\u53D6\u5F97\u501F\u6B3E\u6536\u5230\u7684\u73B0\u91D1",
      "RECEIVE_LOAN_CASH"
    ],
    [
      "receiveOtherFinance",
      "\u6536\u5230\u7684\u5176\u4ED6\u4E0E\u7B79\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "RECEIVE_OTHER_FINANCE"
    ],
    [
      "totalFinanceOutflow",
      "\u7B79\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u5C0F\u8BA1",
      "TOTAL_FINANCE_OUTFLOW"
    ],
    [
      "payDebtCash",
      "\u507F\u8FD8\u503A\u52A1\u6240\u652F\u4ED8\u7684\u73B0\u91D1",
      "PAY_DEBT_CASH"
    ],
    [
      "assignDividendPorfit",
      "\u5206\u914D\u80A1\u5229\u3001\u5229\u6DA6\u6216\u507F\u4ED8\u5229\u606F\u652F\u4ED8\u7684\u73B0\u91D1",
      "ASSIGN_DIVIDEND_PORFIT"
    ],
    [
      "subsidiaryPayDividend",
      "\u5176\u4E2D:\u5B50\u516C\u53F8\u652F\u4ED8\u7ED9\u5C11\u6570\u80A1\u4E1C\u7684\u80A1\u5229\u3001\u5229\u6DA6",
      "SUBSIDIARY_PAY_DIVIDEND"
    ],
    [
      "payOtherFinance",
      "\u652F\u4ED8\u7684\u5176\u4ED6\u4E0E\u7B79\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "PAY_OTHER_FINANCE"
    ],
    [
      "cceAdd",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u51C0\u589E\u52A0\u989D",
      "CCE_ADD",
      "\u73B0\u91D1\u51C0\u989D",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u589E\u52A0(\u51CF\u5C11)\u989D",
      "info"
    ],
    [
      "beginCce",
      "\u671F\u521D\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u4F59\u989D",
      "BEGIN_CCE",
      "\u671F\u521D\u73B0\u91D1",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u671F\u521D\u4F59\u989D"
    ],
    [
      "endCce",
      "\u671F\u672B\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u4F59\u989D",
      "END_CCE",
      "\u671F\u672B\u73B0\u91D1",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u671F\u672B\u4F59\u989D"
    ],
    [
      "rateChangeEffect",
      "\u6C47\u7387\u53D8\u52A8\u5BF9\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u7684\u5F71\u54CD",
      "RATE_CHANGE_EFFECT",
      "",
      "\u6C47\u7387\u53D8\u52A8\u5F71\u54CD"
    ]
  ]
};

// src/shared/cache-policy.ts
var MINUTE_MS = 60 * 1e3;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;
var OPEN_MARKET_TTL_MS = 10 * MINUTE_MS;
var MARKET_SCHEDULES = {
  cn: {
    timeZone: "Asia/Shanghai",
    sessions: [
      { startMinutes: 9 * 60 + 30, endMinutes: 11 * 60 + 30 },
      { startMinutes: 13 * 60, endMinutes: 15 * 60 }
    ]
  },
  hk: {
    timeZone: "Asia/Hong_Kong",
    sessions: [
      { startMinutes: 9 * 60 + 30, endMinutes: 12 * 60 },
      { startMinutes: 13 * 60, endMinutes: 16 * 60 }
    ]
  },
  us: {
    timeZone: "America/New_York",
    sessions: [{ startMinutes: 9 * 60 + 30, endMinutes: 16 * 60 }]
  }
};

// src/db/queries.ts
async function getHttpCache(db, cacheKey, now = Date.now()) {
  const row = await db.prepare(
    `select status, headers_json as headersJson, body_text as bodyText,
        expires_at as expiresAt, updated_at as updatedAt
       from http_cache
       where cache_key = ? and expires_at > ?`
  ).bind(cacheKey, now).first();
  return row ?? null;
}
async function putHttpCache(db, record) {
  await db.prepare(
    `insert into http_cache
        (cache_key, url, method, status, headers_json, body_text, expires_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(cache_key) do update set
        url = excluded.url,
        method = excluded.method,
        status = excluded.status,
        headers_json = excluded.headers_json,
        body_text = excluded.body_text,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
  ).bind(
    record.cacheKey,
    record.url,
    record.method,
    record.status,
    record.headersJson,
    record.bodyText,
    record.expiresAt,
    record.updatedAt
  ).run();
}

// src/shared/http.ts
var DEFAULT_EXTERNAL_HTTP_TIMEOUT_MS = 1e4;
var DEFAULT_DOMAIN_CONCURRENCY = 3;
var domainLimiters = /* @__PURE__ */ new Map();
var ExternalRequestTimeoutError = class extends Error {
  status = 504;
  constructor(host, timeoutMs, options) {
    super(`external request timed out: host=${host} timeoutMs=${timeoutMs}`, options);
    this.name = "ExternalRequestTimeoutError";
  }
};
var ExternalConcurrencyTimeoutError = class extends Error {
  status = 504;
  constructor(host, limit, timeoutMs) {
    super(`external request concurrency wait timed out: host=${host} limit=${limit} timeoutMs=${timeoutMs}`);
    this.name = "ExternalConcurrencyTimeoutError";
  }
};
async function cachedFetchJson(db, url, init, ttlMs = 60 * 60 * 1e3, options) {
  const text2 = await cachedFetchText(db, url, init, ttlMs, options);
  return parseJsonOrJsonp(text2);
}
async function cachedFetchText(db, url, init, ttlMs = 60 * 60 * 1e3, options) {
  const request = normalizeRequest(url, init);
  const cacheKey = options?.cacheKey || await digestHex(JSON.stringify(request));
  const cacheTtlMs = options?.cacheTtlMs ?? ttlMs;
  const cached = await getHttpCache(db, cacheKey);
  if (cached) {
    return cached.bodyText;
  }
  const { status, headers, text: text2 } = await fetchTextResponse(url, init, options);
  const now = Date.now();
  const resolvedTtlMs = options?.resolveCacheTtlMs?.({ status, headers, text: text2 });
  const finalCacheTtlMs = Number.isFinite(resolvedTtlMs) && resolvedTtlMs && resolvedTtlMs > 0 ? resolvedTtlMs : cacheTtlMs;
  if (!options?.cacheMaxBytes || new TextEncoder().encode(text2).byteLength <= options.cacheMaxBytes) {
    await putHttpCache(db, {
      cacheKey,
      url,
      method: request.method,
      status,
      headersJson: JSON.stringify(headers),
      bodyText: text2,
      expiresAt: now + Math.max(1, finalCacheTtlMs),
      updatedAt: now
    });
  }
  return text2;
}
async function fetchTextResponse(url, init, options) {
  const host = new URL(url).hostname.toLowerCase();
  const concurrency = options?.domainConcurrency ?? DEFAULT_DOMAIN_CONCURRENCY;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXTERNAL_HTTP_TIMEOUT_MS;
  return runWithDomainLimit(host, concurrency, timeoutMs, async () => {
    const attempts = isRetryableMethod(init?.method) ? 2 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptInit = withTimeoutSignal(init, timeoutMs);
      try {
        if (shouldUseProxy(url, options)) {
          return await fetchTextViaProxy(url, attemptInit, options);
        }
        return await fetchTextDirect(url, attemptInit);
      } catch (err) {
        lastError = isTimeoutError(err) ? new ExternalRequestTimeoutError(host, timeoutMs, { cause: err }) : err;
        if (attempt >= attempts || !isRetryableNetworkError(lastError)) {
          throw lastError;
        }
        console.warn(
          `external request failed for ${host}; retrying with a new request (attempt ${attempt}/${attempts}):`,
          lastError
        );
      }
    }
    throw lastError;
  });
}
function withTimeoutSignal(init, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  };
}
async function fetchTextDirect(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; stock-info-worker/0.1; +https://workers.cloudflare.com/)",
      ...init?.headers ?? {}
    }
  });
  const text2 = await res.text();
  if (!res.ok) {
    throw new Error(`request failed: status=${res.status} body=${truncate(text2)}`);
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: text2 };
}
function isRetryableMethod(method) {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}
function isRetryableNetworkError(err) {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  if (err.retryable === true) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /network connection lost|fetch failed|connection reset|socket closed|timed out|timeout/i.test(message);
}
function isTimeoutError(err) {
  return err instanceof Error && err.name === "TimeoutError";
}
async function fetchTextViaProxy(url, init, options) {
  if (!options?.proxyRelayUrl) {
    throw new Error("HTTP_PROXY_RELAY_URL is required when HTTP proxying is enabled");
  }
  return fetchTextViaProxyRelay(options.proxyRelayUrl, url, init);
}
async function fetchTextViaProxyRelay(relayUrl, url, init) {
  const res = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: init?.signal,
    body: JSON.stringify({
      url,
      method: init?.method ?? "GET",
      headers: normalizeOutgoingHeaders(init?.headers),
      body: typeof init?.body === "string" ? init.body : void 0
    })
  });
  const text2 = await res.text();
  if (!res.ok) {
    throw new Error(`proxy relay request failed: status=${res.status} body=${truncate(text2)}`);
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: text2 };
}
function shouldUseProxy(url, options) {
  if (!options?.proxyUrl || options.proxyEnabled === false) {
    return false;
  }
  const domains = options.proxyDomains ?? [];
  if (domains.length === 0) {
    return false;
  }
  const host = new URL(url).hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
async function runWithDomainLimit(host, concurrency, timeoutMs, fn) {
  const limit = Math.max(1, concurrency || DEFAULT_DOMAIN_CONCURRENCY);
  let limiter = domainLimiters.get(host);
  if (!limiter || limiter.limit !== limit) {
    limiter = new DomainLimiter(limit);
    domainLimiters.set(host, limiter);
  }
  return limiter.run(fn, host, timeoutMs);
}
var DomainLimiter = class {
  constructor(limit) {
    this.limit = limit;
  }
  limit;
  slots = /* @__PURE__ */ new Map();
  async run(fn, host, timeoutMs) {
    const token = Symbol(host);
    const deadline = Date.now() + timeoutMs;
    const leaseMs = Math.max(timeoutMs * 3, timeoutMs + 1e3);
    while (true) {
      const now = Date.now();
      this.pruneExpiredSlots(now);
      if (this.slots.size < this.limit) {
        this.slots.set(token, now + leaseMs);
        break;
      }
      const remainingMs = deadline - now;
      if (remainingMs <= 0) {
        throw new ExternalConcurrencyTimeoutError(host, this.limit, timeoutMs);
      }
      await delay(Math.min(25, remainingMs));
    }
    try {
      return await fn();
    } finally {
      this.slots.delete(token);
    }
  }
  pruneExpiredSlots(now) {
    for (const [token, expiresAt] of this.slots) {
      if (expiresAt <= now) {
        this.slots.delete(token);
      }
    }
  }
};
function delay(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function parseJsonOrJsonp(text2) {
  const trimmed = text2.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start + 1, end));
  }
  throw new Error(`invalid json/jsonp body: ${truncate(trimmed)}`);
}
function truncate(value, max = 300) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
function normalizeRequest(url, init) {
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    headers: normalizeHeaders(init?.headers),
    body: typeof init?.body === "string" ? init.body : null
  };
}
function normalizeHeaders(headers) {
  const result2 = {};
  if (!headers) {
    return result2;
  }
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    const lowered = key.toLowerCase();
    if (lowered === "authorization" || lowered === "cookie") {
      result2[lowered] = "<redacted>";
    } else {
      result2[lowered] = String(value);
    }
  }
  return Object.fromEntries(Object.entries(result2).sort(([a], [b]) => a.localeCompare(b)));
}
function normalizeOutgoingHeaders(headers) {
  const result2 = {};
  if (!headers) {
    return result2;
  }
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    result2[key] = String(value);
  }
  return result2;
}
async function digestHex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

// src/adapters/eastmoney.ts
var bankCodeSet = new Set((finance_mappings_default.bankCodes ?? []).map((code) => normalizeSecurityCode(code)));
var securityCodeSet = new Set((finance_mappings_default.securityCodes ?? []).map((code) => normalizeSecurityCode(code)));
var insuranceCodeSet = new Set((finance_mappings_default.insuranceCodes ?? []).map((code) => normalizeSecurityCode(code)));
var PROVISIONAL_FINANCE_SOURCE_TTL_MS = 10 * 60 * 1e3;
var EASTMONEY_SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
async function fetchEastmoneySuggest(db, q) {
  const url = new URL("https://searchadapter.eastmoney.com/api/suggest/get");
  url.searchParams.set("input", q);
  url.searchParams.set("type", "8");
  url.searchParams.set("token", EASTMONEY_SUGGEST_TOKEN);
  url.searchParams.set("count", "10");
  const body = await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://www.eastmoney.com/" }
  }, 7 * 24 * 60 * 60 * 1e3);
  const now = Date.now();
  const records = [];
  for (const item of body.GubaCodeTable?.Data ?? []) {
    const rawCode = item.OuterCode?.trim() ?? "";
    const normalized = normalizeEastmoneySuggestCode(rawCode);
    const name = item.ShortName?.trim() ?? "";
    if (!normalized || !name || !isSupportedSecurityCode(normalized)) {
      continue;
    }
    records.push({
      code: normalized,
      market: securityMarket(normalized),
      type: inferSecurityType(normalized),
      name,
      source: "eastmoney",
      updatedAt: now
    });
  }
  return records;
}
function normalizeEastmoneySuggestCode(rawCode) {
  const code = rawCode.trim();
  const lowered = code.toLowerCase();
  if (lowered.startsWith("us") && code.length > 2) {
    return `${code.slice(2).toUpperCase()}.US`;
  }
  if (lowered.startsWith("hk") && code.length > 2) {
    return normalizeSecurityCode(code.slice(2));
  }
  if ((lowered.startsWith("sh") || lowered.startsWith("sz") || lowered.startsWith("bj")) && code.length > 2) {
    return normalizeSecurityCode(code.slice(2));
  }
  if (lowered.startsWith("of") && code.length > 2) {
    return `${code.slice(2).toUpperCase()}.OF`;
  }
  return normalizeSecurityCode(code);
}

// src/modules/security/application/search-securities.ts
async function searchSecurities(db, q) {
  const trimmed = q.trim();
  if (!trimmed) {
    return [];
  }
  return mergeSecurityResults(await fetchEastmoneySuggest(db, trimmed));
}
function mergeSecurityResults(...groups) {
  const seen = /* @__PURE__ */ new Set();
  const result2 = [];
  for (const group of groups) {
    for (const item of group) {
      const normalized = normalizeSearchRecord(item);
      if (!isSupportedSecurityCode(normalized.code) || seen.has(normalized.code)) {
        continue;
      }
      seen.add(normalized.code);
      result2.push(normalized);
    }
  }
  return result2.slice(0, 12);
}
function normalizeSearchRecord(record) {
  const match = record.code.match(/^US(.+)$/i);
  if (!match || record.code.includes(".")) {
    return record;
  }
  const code = `${match[1].toUpperCase()}.US`;
  return {
    ...record,
    code,
    market: "global",
    type: "stock"
  };
}

// config/knowledge-company-code-mappings.json
var knowledge_company_code_mappings_default = {
  version: 1,
  mappings: []
};

// src/modules/knowledge/application/company-code-mappings.ts
var DEFAULT_MAPPING_FILE = "config/knowledge-company-code-mappings.json";
var bundledMappings = normalizeMappings(Array.isArray(knowledge_company_code_mappings_default.mappings) ? knowledge_company_code_mappings_default.mappings : []);
var writeQueue = Promise.resolve();
async function resolveKnowledgeCompanyCodeMappings(db, companyNames, options = {}) {
  const names = uniqueCompanyNames(companyNames);
  if (names.length === 0) return [];
  const file = options.file ?? resolveLocalMappingFile();
  if (!file) return selectMappings(groupMappings(bundledMappings), names);
  const cached = await readMappingFile(file);
  const cachedByCompany = groupMappings(cached.mappings);
  const missing = names.filter((companyName) => !cachedByCompany.has(companyName));
  if (missing.length === 0) return selectMappings(cachedByCompany, names);
  const search = options.search ?? ((companyName) => searchExactCompanyMappings(db, companyName));
  const discovered = (await Promise.all(missing.map(async (companyName) => {
    try {
      return await search(companyName);
    } catch (error) {
      console.warn(JSON.stringify({ event: "knowledge_company_code_mapping_search_failed", companyName, error: error instanceof Error ? error.message : String(error) }));
      return [];
    }
  }))).flat();
  const validDiscovered = normalizeMappings(discovered);
  if (validDiscovered.length > 0) await persistMappings(file, validDiscovered);
  return selectMappings(groupMappings([...cached.mappings, ...validDiscovered]), names);
}
function hasExactKnowledgeCompanyCodeMapping(mappings, companyName, code) {
  const expectedCompanyName = String(companyName || "").trim();
  const expectedCode = normalizeSupportedCompanyCode(code);
  return mappings.some((mapping) => mapping.companyName === expectedCompanyName && mapping.code === expectedCode);
}
async function filterExactCompanyCodeMappedRows(db, rows, code) {
  const mappings = await resolveKnowledgeCompanyCodeMappings(db, rows.map((row) => row.entity));
  return rows.filter((row) => hasExactKnowledgeCompanyCodeMapping(mappings, row.entity, code));
}
async function searchExactCompanyMappings(db, companyName) {
  const matches = (await searchSecurities(db, companyName)).filter((item) => normalizeComparableName(item.name) === normalizeComparableName(companyName)).map((item) => ({
    companyName,
    code: normalizeSupportedCompanyCode(item.code),
    securityName: item.name.trim()
  }));
  return normalizeMappings(matches);
}
function resolveLocalMappingFile() {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path) return null;
  const configured = String(getProcessEnv().LOCAL_KNOWLEDGE_COMPANY_CODE_MAPPINGS_PATH || "").trim();
  return path.resolve(getProcessCwd(), configured || DEFAULT_MAPPING_FILE);
}
async function readMappingFile(file) {
  const fs = getNodeBuiltin("node:fs/promises");
  if (!fs) return { version: 1, mappings: [] };
  try {
    const parsed = JSON.parse(String(await fs.readFile(file, "utf8") || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Number(parsed.version) !== 1 || !Array.isArray(parsed.mappings)) {
      throw new Error("expected { version: 1, mappings: [] }");
    }
    return { version: 1, mappings: normalizeMappings(parsed.mappings) };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { version: 1, mappings: [] };
    throw new Error(`invalid local company-code mapping file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function persistMappings(file, discovered) {
  writeQueue = writeQueue.then(async () => {
    const fs = getNodeBuiltin("node:fs/promises");
    const path = getNodeBuiltin("node:path");
    if (!fs || !path) return;
    const current = await readMappingFile(file);
    const mappings = normalizeMappings([...current.mappings, ...discovered]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${getProcessId()}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, mappings }, null, 2)}
`, { encoding: "utf8", mode: 384 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => void 0);
    }
  });
  return writeQueue;
}
function normalizeMappings(items) {
  const seen = /* @__PURE__ */ new Set();
  const mappings = [];
  for (const item of items) {
    const raw = item && typeof item === "object" ? item : {};
    const companyName = String(raw.companyName || raw.company_name || "").trim();
    const code = normalizeSupportedCompanyCode(String(raw.code || ""));
    const securityName = String(raw.securityName || raw.security_name || "").trim();
    const key = `${companyName}\0${code}`;
    if (!companyName || !securityName || !isSupportedCompanyCode(code) || seen.has(key)) continue;
    seen.add(key);
    mappings.push({ companyName, code, securityName });
  }
  return mappings.sort((left, right) => left.companyName.localeCompare(right.companyName) || left.code.localeCompare(right.code));
}
function groupMappings(mappings) {
  const grouped = /* @__PURE__ */ new Map();
  for (const mapping of mappings) {
    const values = grouped.get(mapping.companyName) ?? [];
    values.push(mapping);
    grouped.set(mapping.companyName, values);
  }
  return grouped;
}
function selectMappings(grouped, names) {
  return names.flatMap((companyName) => grouped.get(companyName) ?? []);
}
function uniqueCompanyNames(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}
function normalizeComparableName(value) {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase();
}
function getNodeBuiltin(name) {
  const processObject = globalThis.process;
  return processObject?.getBuiltinModule?.(name) ?? null;
}
function getProcessCwd() {
  const processObject = globalThis.process;
  return processObject?.cwd?.() || ".";
}
function getProcessEnv() {
  const processObject = globalThis.process;
  return processObject?.env ?? {};
}
function getProcessId() {
  const processObject = globalThis.process;
  return Number(processObject?.pid || 0);
}

// src/modules/research/application/research-information-evidence.ts
var config = research_information_evidence_mapping_default;
async function materializeResearchInformationEvidenceCandidates(db, securityCode, records, createdAt = Date.now(), options = {}) {
  const code = required(securityCode, "securityCode").toUpperCase();
  let created = 0;
  let existing = 0;
  const candidates = [];
  for (const record of records) {
    const matching = config.mappings.filter((item) => item.category === record.category && item.informationTypes.includes(record.informationType) && matchesStatementGuard(item, record.statement));
    for (const mapping of matching) {
      const generatedCandidateId = `research-information-evidence:${crypto.randomUUID()}`;
      const result2 = await db.prepare(`insert into research_information_evidence_candidates (
        candidate_id, security_code, information_id, result_id, run_id, version_id, content_hash, doc_id,
        entity, information_type, category, period, statement, target_module, target_field, required_fields_json,
        source_url, content_url, title, source_name, published_at, mapping_config_version, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(security_code, information_id, target_module, target_field) do nothing`).bind(
        generatedCandidateId,
        code,
        record.informationId,
        record.resultId,
        record.runId,
        record.versionId,
        record.contentHash,
        record.docId,
        record.entity,
        record.informationType,
        record.category,
        record.period,
        record.statement,
        mapping.targetModule,
        mapping.targetField,
        JSON.stringify(mapping.requiredFields),
        record.sourceUrl,
        record.contentUrl,
        record.title,
        record.sourceName,
        record.publishedAt,
        config.version,
        createdAt
      ).run();
      const wasCreated = Number(result2.meta.changes ?? 0) > 0;
      if (wasCreated) created += Number(result2.meta.changes);
      else existing += 1;
      if (options.includePersistedIds) {
        let candidateId = generatedCandidateId;
        if (!wasCreated) {
          const stored = await db.prepare(`select candidate_id as candidateId from research_information_evidence_candidates
            where security_code=? and information_id=? and target_module=? and target_field=?`).bind(code, record.informationId, mapping.targetModule, mapping.targetField).first();
          if (!stored) throw new Error("existing research information evidence candidate could not be resolved");
          candidateId = text(stored.candidateId);
        }
        candidates.push({ candidateId, source: record, mapping });
      }
    }
  }
  return { created, existing, candidates };
}
function matchesStatementGuard(mapping, statement) {
  const terms = mapping.statementIncludesAll;
  return !terms?.length || terms.every((term) => statement.includes(term));
}
function required(value, label) {
  const result2 = String(value ?? "").trim();
  if (!result2) throw new Error(`${label} is required`);
  return result2;
}
function text(value) {
  return required(value === null || value === void 0 ? "" : String(value), "stored evidence text");
}

// src/modules/research/application/research-statutory-operating-candidates.ts
async function produceResearchStatutoryOperatingEvidenceCandidates(db, securityCode, createdAt = Date.now()) {
  const code = required2(securityCode, "securityCode").toUpperCase();
  const indexed = await db.prepare(`select registry, document_id as documentId, document_url as documentUrl, source_locator as sourceLocator
    from research_statutory_disclosure_documents where security_code=? order by published_at desc, indexed_at desc, document_id desc limit 200`).bind(code).all();
  const statutoryDocuments = indexed.results.map(document);
  if (!statutoryDocuments.length) return result(code, 0, 0, 0, 0, 0, ["statutory_documents_not_indexed"]);
  const sourceRows = await db.prepare(`select record.information_id as informationId, record.entity, record.information_type as informationType,
      record.category, record.period, record.statement, result.result_id as resultId, result.run_id as runId,
      version.version_id as versionId, version.content_hash as contentHash, version.doc_id as docId,
      coalesce(version.source_url, doc.url) as sourceUrl, content.content_url as contentUrl, doc.title,
      doc.source_name as sourceName, coalesce(version.published_at, doc.published_at) as publishedAt,
      statutory.registry, statutory.document_id as documentId, statutory.document_url as documentUrl, statutory.source_locator as sourceLocator
    from research_statutory_disclosure_documents statutory
    join knowledge_docs doc on doc.url=statutory.document_url
    join knowledge_document_versions version on version.doc_id=doc.doc_id and coalesce(version.source_url, doc.url)=statutory.document_url
    join knowledge_document_results result on result.version_id=version.version_id and result.outcome='extracted'
    join knowledge_information_records record on record.result_id=result.result_id
    left join knowledge_doc_content_refs content on content.doc_id=doc.doc_id
    where statutory.security_code=?
    order by result.created_at desc, record.sort_order asc, record.information_id asc`).bind(code).all();
  const sourceRecords = (await filterExactCompanyCodeMappedRows(
    db,
    sourceRows.results.map((row) => ({ ...row, entity: required2(row.entity, "stored entity") })),
    code
  )).map(statutorilyBoundRecord);
  const materialized = await materializeResearchInformationEvidenceCandidates(
    db,
    code,
    sourceRecords,
    createdAt,
    { includePersistedIds: true }
  );
  let provenanceCreated = 0;
  for (const item of materialized.candidates) {
    const origin = sourceRecords.find((record) => record.informationId === item.source.informationId && record.resultId === item.source.resultId && record.versionId === item.source.versionId && record.documentUrl === item.source.sourceUrl);
    if (!origin) throw new Error("statutory candidate provenance could not be resolved from immutable source row");
    const inserted = await db.prepare(`insert into research_statutory_operating_candidate_provenance (
      candidate_id, registry, security_code, statutory_document_id, statutory_document_url, statutory_source_locator,
      knowledge_doc_id, result_id, run_id, version_id, content_hash, producer_version, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'research-statutory-operating-candidates.v1', ?)
    on conflict(candidate_id) do nothing`).bind(
      item.candidateId,
      origin.registry,
      code,
      origin.documentId,
      origin.documentUrl,
      origin.sourceLocator,
      origin.docId,
      origin.resultId,
      origin.runId,
      origin.versionId,
      origin.contentHash,
      createdAt
    ).run();
    provenanceCreated += Number(inserted.meta.changes ?? 0);
  }
  const rejectionReasons = sourceRecords.length === 0 ? ["no_exact_statutory_information_processing_record"] : materialized.candidates.length === 0 ? ["no_configured_operating_mapping_for_statutory_records"] : [];
  return result(code, statutoryDocuments.length, sourceRecords.length, materialized.created, materialized.existing, provenanceCreated, rejectionReasons);
}
function result(securityCode, indexedDocumentCount, processedInformationRecordCount, created, existing, provenanceCreated, rejectionReasons) {
  return {
    securityCode,
    indexedDocumentCount,
    processedInformationRecordCount,
    created,
    existing,
    provenanceCreated,
    rejectionReasons,
    limitations: [
      "\u4EC5\u590D\u7528\u5DF2\u5B8C\u6210\u7684\u4FE1\u606F\u9884\u5904\u7406\u8BB0\u5F55\u53CA\u5176 document/result/run/version/content_hash \u94FE\uFF1B\u4E0D\u4F1A\u91CD\u65B0\u89E3\u6790\u539F\u6587\u6216\u7ED5\u8FC7\u672C\u5730 LLM \u8FB9\u754C\u3002",
      "\u53EA\u751F\u6210\u5F85\u5BA1\u6838\u5019\u9009\u548C\u6CD5\u5B9A\u62AB\u9732\u6765\u6E90\u7ED1\u5B9A\uFF1B\u4E0D\u4F1A\u63A5\u53D7\u8BC1\u636E\u3001\u4E0D\u4F1A\u5199\u5165\u7ECF\u8425\u6A21\u578B\u3001\u9A71\u52A8\u8BA1\u5212\u3001\u60C5\u666F\u3001\u5E02\u573A\u7A7A\u95F4\u6216\u4F30\u503C\u3002",
      "\u4EC5\u63A5\u53D7\u7D22\u5F15\u6CD5\u5B9A\u62AB\u9732 URL \u4E0E\u4FE1\u606F\u5904\u7406\u7248\u672C URL \u7684\u7CBE\u786E\u5339\u914D\uFF1B\u7F3A\u5C11\u5BFC\u5165\u3001\u5904\u7406\u3001\u7CBE\u786E\u516C\u53F8\u6620\u5C04\u6216\u914D\u7F6E\u5B57\u6BB5\u65F6\u4F1A\u4FDD\u7559\u62D2\u7EDD\u539F\u56E0\u3002"
    ]
  };
}
function statutorilyBoundRecord(row) {
  const sourceUrl = optional(row.sourceUrl);
  const documentUrl = required2(row.documentUrl, "stored statutory documentUrl");
  if (sourceUrl !== documentUrl) throw new Error("statutory information source URL must exactly match indexed document URL");
  return {
    informationId: required2(row.informationId, "stored informationId"),
    entity: required2(row.entity, "stored entity"),
    informationType: required2(row.informationType, "stored informationType"),
    category: required2(row.category, "stored category"),
    period: optional(row.period),
    statement: required2(row.statement, "stored statement"),
    resultId: required2(row.resultId, "stored resultId"),
    runId: required2(row.runId, "stored runId"),
    versionId: required2(row.versionId, "stored versionId"),
    contentHash: required2(row.contentHash, "stored contentHash"),
    docId: required2(row.docId, "stored docId"),
    sourceUrl,
    contentUrl: optional(row.contentUrl),
    title: optional(row.title),
    sourceName: optional(row.sourceName),
    publishedAt: optional(row.publishedAt),
    ...document(row)
  };
}
function document(row) {
  const registry = required2(row.registry, "stored statutory registry");
  if (!(registry === "cninfo" || registry === "hkex" || registry === "sec")) throw new Error("stored statutory registry is invalid");
  return { registry, documentId: required2(row.documentId, "stored statutory documentId"), documentUrl: required2(row.documentUrl, "stored statutory documentUrl"), sourceLocator: required2(row.sourceLocator, "stored statutory sourceLocator") };
}
function required2(value, label) {
  const text2 = String(value ?? "").trim();
  if (!text2) throw new Error(`${label} is required`);
  return text2;
}
function optional(value) {
  const text2 = String(value ?? "").trim();
  return text2 || null;
}

// src/modules/research/application/research-statutory-operating-candidates.test.mjs
process.env.LOCAL_KNOWLEDGE_COMPANY_CODE_MAPPINGS_PATH = resolve("src/modules/research/application/company-code-mappings.fixture.json");
var indexedDocument = {
  registry: "cninfo",
  documentId: "AN202601010001",
  documentUrl: "https://static.cninfo.com.cn/finalpage/2026-01-01/AN202601010001.PDF",
  sourceLocator: "CNINFO announcementId=AN202601010001"
};
var informationRecord = {
  informationId: "information:capacity:1",
  entity: "\u4E0A\u6D77\u67D0\u516C\u53F8",
  informationType: "fact",
  category: "production_capacity",
  period: "2026Q1",
  statement: "\u4E0A\u6D77\u67D0\u516C\u53F8\u4E00\u671F\u4EA7\u80FD\u5DF2\u6295\u5165\u8FD0\u884C\u3002",
  resultId: "result:1",
  runId: "run:1",
  versionId: "version:1",
  contentHash: "sha256:filing",
  docId: "document:1",
  sourceUrl: indexedDocument.documentUrl,
  contentUrl: "https://local.test/content/1",
  title: "2025\u5E74\u5E74\u5EA6\u62A5\u544A",
  sourceName: "\u4E0A\u6D77\u67D0\u516C\u53F8",
  publishedAt: "2026-03-31",
  ...indexedDocument
};
function database({ records = [informationRecord], candidateChanges = 1 } = {}) {
  const queries = [];
  const writes = [];
  return {
    queries,
    writes,
    prepare(sql) {
      return { bind(...values) {
        if (sql.startsWith("select registry, document_id")) {
          queries.push({ sql, values });
          return { all: async () => ({ results: [indexedDocument] }) };
        }
        if (sql.includes("from research_statutory_disclosure_documents statutory")) {
          queries.push({ sql, values });
          return { all: async () => ({ results: records }) };
        }
        if (sql.includes("insert into research_information_evidence_candidates")) {
          writes.push({ sql, values });
          return { run: async () => ({ meta: { changes: candidateChanges } }) };
        }
        if (sql.includes("select candidate_id as candidateId from research_information_evidence_candidates")) {
          return { first: async () => ({ candidateId: "candidate:existing" }) };
        }
        if (sql.includes("insert into research_statutory_operating_candidate_provenance")) {
          writes.push({ sql, values });
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
        throw new Error(`unexpected statement: ${sql}`);
      } };
    }
  };
}
test("public statutory candidate producer requires exact indexed URL and retains the full information-processing chain", async () => {
  const db = database();
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.sz", 100);
  assert.deepEqual({ created: output.created, existing: output.existing, provenanceCreated: output.provenanceCreated, rejectionReasons: output.rejectionReasons }, { created: 1, existing: 0, provenanceCreated: 1, rejectionReasons: [] });
  assert.equal(db.queries[1].values[0], "300308.SZ");
  assert.match(db.queries[1].sql, /join knowledge_docs doc on doc\.url=statutory\.document_url/);
  assert.match(db.queries[1].sql, /coalesce\(version\.source_url, doc\.url\)=statutory\.document_url/);
  assert.match(db.queries[1].sql, /result\.outcome='extracted'/);
  assert.doesNotMatch(db.queries[1].sql, /knowledge_company_code_mappings/);
  const allWrites = db.writes.map((write) => write.sql).join("\n");
  assert.match(allWrites, /research_information_evidence_candidates/);
  assert.match(allWrites, /research_statutory_operating_candidate_provenance/);
  assert.doesNotMatch(allWrites, /research_(operating_model|operating_driver|market_space|valuation)/);
  const provenance = db.writes.find((write) => write.sql.includes("research_statutory_operating_candidate_provenance")).values;
  assert.deepEqual(provenance.slice(1, 12), ["cninfo", "300308.SZ", indexedDocument.documentId, indexedDocument.documentUrl, indexedDocument.sourceLocator, "document:1", "result:1", "run:1", "version:1", "sha256:filing", 100]);
});
test("unconfigured statutory information stays absent and reports the narrow rejection reason", async () => {
  const db = database({ records: [{ ...informationRecord, category: "unconfigured_category" }] });
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.SZ", 100);
  assert.deepEqual({ created: output.created, provenanceCreated: output.provenanceCreated, rejectionReasons: output.rejectionReasons }, { created: 0, provenanceCreated: 0, rejectionReasons: ["no_configured_operating_mapping_for_statutory_records"] });
  assert.equal(db.writes.length, 0);
});
test("an existing generic candidate can receive its missing statutory authority binding without being rewritten", async () => {
  const db = database({ candidateChanges: 0 });
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.SZ", 100);
  assert.deepEqual({ created: output.created, existing: output.existing, provenanceCreated: output.provenanceCreated }, { created: 0, existing: 1, provenanceCreated: 1 });
  const provenance = db.writes.find((write) => write.sql.includes("research_statutory_operating_candidate_provenance"));
  assert.equal(provenance.values[0], "candidate:existing");
});
test("missing statutory index is visible instead of widening to arbitrary processed documents", async () => {
  const db = {
    prepare(sql) {
      return { bind() {
        if (sql.startsWith("select registry, document_id")) return { all: async () => ({ results: [] }) };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    }
  };
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.SZ", 100);
  assert.deepEqual({ indexedDocumentCount: output.indexedDocumentCount, rejectionReasons: output.rejectionReasons }, { indexedDocumentCount: 0, rejectionReasons: ["statutory_documents_not_indexed"] });
});
