import assert from "node:assert/strict";
import test from "node:test";
import { insertResearchMarketSpaceAssessment, insertResearchOperatingDriverPlan, insertResearchOperatingModel, loadResearchOperatingModels } from "../application/research-operating-market.ts";
import { calculateMarketProfitPool, compileDriverPlanToSelfBuiltScenario, evaluateMarketShareBridge, reconcileMarketSpaceEstimates, validateMarketSpaceHierarchy } from "./research-operating-market.ts";

const refs = [{ sourceKind: "filing", documentId: "annual:1", locator: "p.10" }];
const mockDb = () => { const batches = []; return { batches, prepare(sql) { return { bind(...values) { return { sql, values }; } }; }, async batch(statements) { batches.push(statements); } }; };
const segment = { operatingSegmentId: "segment:1", name: "核心产品", productScope: "数据中心交换机", customerScope: "云厂商", geographicScope: "全球", revenueFormula: "端口数 × ASP", revenueRecognition: "验收", sortOrder: 1, sourceReferences: refs, contracts: [{ contractDriverId: "contract:1", contractType: "framework", customerOrChannel: "客户 A", commitmentDescription: "年度框架", pricingBasis: "每端口", renewalOrDeliveryConstraint: "认证", startPeriod: "FY2026", endPeriod: null, sortOrder: 1, sourceReferences: refs }], unitEconomics: [{ unitEconomicId: "unit:1", unitName: "100G port", pricePerUnit: 2, variableCostPerUnit: 1, currency: "CNY", amountScale: "million", periodBasis: "FY2026", contributionDescription: "单位毛利", sortOrder: 1, sourceReferences: refs }] };

test("typed operating model persists segments, contracts, unit economics, constraints and evidence", async () => {
  const db = mockDb(); const result = await insertResearchOperatingModel(db, { operatingModelId: "model:1", companyId: "company:1", asOf: 10, version: 1, status: "reviewed", modelType: "product", primaryEarningDriver: "端口销量和 ASP", revenueRecognition: "验收", summary: "主营业务", epistemicType: "observed_fact", sourceReferences: refs, segments: [segment], growthConstraints: [{ growthConstraintId: "constraint:1", operatingSegmentId: "segment:1", constraintKind: "capacity", description: "产能", affectedStatement: "income", affectedDriver: "volume", invalidationOrReleaseCondition: "扩产验收", sortOrder: 1, sourceReferences: refs }], createdAt: 10, updatedAt: 10 });
  assert.equal(result.state, "saved"); const sql = db.batches[0].map((x) => x.sql).join("\n"); assert.match(sql, /contracts_typed/); assert.match(sql, /unit_economics_typed/); assert.match(sql, /operating_market_evidence_refs/); assert.doesNotMatch(sql, /_json/i);
});

test("driver plan derives three-statement scenario from segment volume and price without a forecast shortcut", async () => {
  const plan = { operatingDriverPlanId: "plan:1", operatingModelId: "model:1", scenarioName: "base", asOf: 10, version: 1, status: "reviewed", valuationCurrency: "CNY", amountScale: "million", openingRevenue: 100, openingNetWorkingCapital: 10, epistemicType: "analysis_assumption", sourceReferences: refs, createdAt: 10, updatedAt: 10, years: [
    { operatingDriverPlanYearId: "year:2027", fiscalYear: 2027, taxRate: .25, forecastNetDebt: 20, sortOrder: 1, sourceReferences: refs, segments: [{ operatingDriverSegmentYearId: "driver:2027:1", operatingSegmentId: "segment:1", volume: 60, pricePerUnit: 2, grossMargin: .5, operatingExpenseMargin: .2, depreciationAmortizationMargin: .05, capitalExpenditureMargin: .08, netWorkingCapitalToRevenue: .1, sortOrder: 1, sourceReferences: refs }] },
    { operatingDriverPlanYearId: "year:2028", fiscalYear: 2028, taxRate: .25, forecastNetDebt: 18, sortOrder: 2, sourceReferences: refs, segments: [{ operatingDriverSegmentYearId: "driver:2028:1", operatingSegmentId: "segment:1", volume: 72, pricePerUnit: 2, grossMargin: .5, operatingExpenseMargin: .2, depreciationAmortizationMargin: .05, capitalExpenditureMargin: .08, netWorkingCapitalToRevenue: .1, sortOrder: 1, sourceReferences: refs }] },
  ] };
  const scenario = compileDriverPlanToSelfBuiltScenario(plan, { wacc: .1, terminalGrowth: .03, netDebtAtValuation: 8, dilutedShares: 10, sourceReferences: refs });
  approximately(scenario.years[0].revenueGrowth, .2); approximately(scenario.years[0].ebitMargin, .3); approximately(scenario.years[1].revenueGrowth, .2);
  const db = mockDb(); const result = await insertResearchOperatingDriverPlan(db, plan); assert.equal(result.state, "saved"); assert.match(db.batches[0].map((x) => x.sql).join("\n"), /driver_segment_years/);
});

function approximately(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be approximately ${expected}`); }

test("market reconciliation refuses mixed bases, share bridge detects unexplained change, and profit pool is deterministic", () => {
  const base = { layer: "tam", methodBasis: "terminal_demand", amount: 100, currency: "CNY", amountScale: "million", periodLabel: "FY2027", periodKind: "annual_flow", calculationDescription: "公式", status: "available", sortOrder: 1, sourceReferences: refs };
  const result = reconcileMarketSpaceEstimates([{ ...base, marketSpaceEstimateId: "top", method: "top_down" }, { ...base, marketSpaceEstimateId: "bottom", method: "bottom_up", amount: 70 }], .2)[0]; assert.equal(result.status, "conflict");
  const bridge = { marketShareBridgeId: "bridge:1", shareType: "revenue", periodLabel: "FY2027", startingShare: .1, endingShare: .14, unit: "ratio", status: "reviewed", sourceReferences: refs, createdAt: 10, updatedAt: 10, steps: [{ marketShareBridgeStepId: "step:1", stepKind: "new_customer", direction: "gain", shareDelta: .02, description: "新客户", sortOrder: 1, sourceReferences: refs }] }; assert.equal(evaluateMarketShareBridge(bridge).status, "conflict");
  assert.deepEqual(calculateMarketProfitPool({ marketProfitPoolId: "pool:1", periodLabel: "FY2027", industryRevenue: 100, sustainableOperatingMargin: .2, currency: "CNY", amountScale: "million", normalizationNote: "周期正常化", status: "reviewed", sourceReferences: refs, createdAt: 10, updatedAt: 10 }), { status: "available", amount: 20, currency: "CNY", amountScale: "million", formula: "industry revenue × sustainable operating margin" });
});

test("TAM/SAM/SOM hierarchy only validates one comparable chain and never chooses among candidates", () => {
  const estimate = { method: "top_down", methodBasis: "terminal_demand", currency: "CNY", amountScale: "million", periodLabel: "FY2027", periodKind: "annual_flow", calculationDescription: "公式", status: "available", sortOrder: 1, sourceReferences: refs };
  const chain = [
    { ...estimate, marketSpaceEstimateId: "tam", layer: "tam", amount: 100 },
    { ...estimate, marketSpaceEstimateId: "sam", layer: "sam", amount: 70 },
    { ...estimate, marketSpaceEstimateId: "som", layer: "som", amount: 20 },
  ];
  assert.deepEqual(validateMarketSpaceHierarchy(chain), { status: "reconciled", estimateIds: { tam: "tam", sam: "sam", som: "som" }, reason: null });
  assert.match(validateMarketSpaceHierarchy([...chain, { ...chain[1], marketSpaceEstimateId: "sam:other", amount: 60 }]).reason, /multiple available estimates/);
  assert.match(validateMarketSpaceHierarchy([{ ...chain[0], amount: 60 }, ...chain.slice(1)]).reason, /hierarchy is reversed/);
  assert.match(validateMarketSpaceHierarchy([{ ...chain[0], currency: "USD" }, ...chain.slice(1)]).reason, /same period, currency, amount scale, and flow\/stock basis/);
});

test("typed market space persists TAM/SAM/SOM, share steps and profit-pool inputs as relational fields", async () => {
  const db = mockDb(); const estimate = { marketSpaceEstimateId: "tam:top", layer: "tam", method: "top_down", methodBasis: "terminal_demand", amount: 100, currency: "CNY", amountScale: "million", periodLabel: "FY2027", periodKind: "annual_flow", calculationDescription: "需求量 × ASP", status: "available", sortOrder: 1, sourceReferences: refs };
  const result = await insertResearchMarketSpaceAssessment(db, { marketSpaceAssessmentId: "market:1", companyId: "company:1", operatingModelId: "model:1", asOf: 10, version: 1, status: "reviewed", marketDefinition: "数据中心交换机", productBoundary: "交换机", geographicBoundary: "全球", customerBoundary: "云厂商", measurementDefinition: "年度厂商收入", epistemicType: "observed_fact", sourceReferences: refs, estimates: [estimate], shareBridges: [], profitPools: [], createdAt: 10, updatedAt: 10 });
  assert.equal(result.state, "saved"); const sql = db.batches[0].map((x) => x.sql).join("\n"); assert.match(sql, /market_space_estimates_typed/); assert.doesNotMatch(sql, /_json/i);
});

test("operating-model reader fully hydrates field rows and normalized evidence", async () => {
  const sources = [{ subject_type: "operating_model", subject_id: "model:1", source_kind: "filing", document_id: "annual:1", created_at: 10 }, { subject_type: "operating_segment", subject_id: "segment:1", source_kind: "filing", document_id: "annual:1", created_at: 10 }, { subject_type: "contract_driver", subject_id: "contract:1", source_kind: "filing", document_id: "annual:1", created_at: 10 }, { subject_type: "unit_economic", subject_id: "unit:1", source_kind: "filing", document_id: "annual:1", created_at: 10 }, { subject_type: "growth_constraint", subject_id: "constraint:1", source_kind: "filing", document_id: "annual:1", created_at: 10 }];
  const db = { prepare(sql) { return { bind() { return { async all() { if (sql.includes("research_operating_models_typed where")) return { results: [{ operating_model_id: "model:1", company_id: "company:1", as_of: 10, version: 1, status: "reviewed", model_type: "product", primary_earning_driver: "volume", revenue_recognition: "delivery", summary: "summary", epistemic_type: "observed_fact", created_at: 10, updated_at: 10 }] }; if (sql.includes("segments_typed")) return { results: [{ operating_segment_id: "segment:1", operating_model_id: "model:1", name: "core", product_scope: "product", customer_scope: "customer", geographic_scope: "global", revenue_formula: "units × price", revenue_recognition: "delivery", sort_order: 1 }] }; if (sql.includes("growth_constraints_typed")) return { results: [{ growth_constraint_id: "constraint:1", operating_model_id: "model:1", operating_segment_id: "segment:1", constraint_kind: "capacity", description: "capacity", affected_statement: "income", affected_driver: "volume", invalidation_or_release_condition: "new line", sort_order: 1 }] }; if (sql.includes("contracts_typed")) return { results: [{ contract_driver_id: "contract:1", operating_segment_id: "segment:1", contract_type: "project", customer_or_channel: "customer", commitment_description: "contract", pricing_basis: "unit", renewal_or_delivery_constraint: "delivery", start_period: null, end_period: null, sort_order: 1 }] }; if (sql.includes("unit_economics_typed")) return { results: [{ unit_economic_id: "unit:1", operating_segment_id: "segment:1", unit_name: "unit", price_per_unit: 2, variable_cost_per_unit: 1, currency: "CNY", amount_scale: "million", period_basis: "FY2027", contribution_description: "margin", sort_order: 1 }] }; if (sql.includes("evidence_refs")) return { results: sources }; return { results: [] }; } }; } }; } };
  const result = await loadResearchOperatingModels(db, { companyId: "company:1", asOf: 20 });
  assert.equal(result.availability, "available"); assert.equal(result.items[0].segments[0].contracts[0].contractDriverId, "contract:1"); assert.equal(result.items[0].segments[0].unitEconomics[0].pricePerUnit, 2); assert.equal(result.items[0].growthConstraints[0].growthConstraintId, "constraint:1"); assert.equal(result.items[0].sourceReferences[0].documentId, "annual:1");
});
