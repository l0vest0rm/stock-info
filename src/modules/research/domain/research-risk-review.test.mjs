import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_SNAPSHOT_DIFF_VERSION,
  assertResearchRiskPressureScenario,
  assertResearchRiskRelationship,
  buildPublicRiskSnapshotModules,
  buildResearchRiskThesisPropagation,
  calculateResearchRiskStress,
  diffResearchSnapshotModules,
} from "./research-risk-review.ts";
import { loadPublicRiskReviewSnapshotHistory, planPublicRiskSnapshotDifferences, savePublicRiskReviewSnapshot } from "../application/research-risk-review.ts";
import { loadPublicResearchSnapshotHistory } from "../application/research-public-snapshot.ts";
import { buildPublicResearchSnapshotModules, planPublicResearchSnapshotDifferences } from "./research-public-snapshot.ts";
import { projectPublicResearchSnapshot } from "../application/project-public-research-snapshot.ts";
import { researchRoutes } from "../api/research.routes.ts";

const source = [{ sourceKind: "filing", documentId: "filing:2025" }];

test("risk pressure scenarios preserve versioned inputs and results without a total risk score", () => {
  const scenario = {
    scenarioId: "pressure:1", companyId: "company:1", securityCode: "00700.HK", asOf: 100, scenarioKey: "revenue-downside", version: 2,
    supersedesScenarioId: "pressure:0", status: "reviewed", scope: "operating_company", title: "收入压力", transmission: "需求下降传导至收入与自由现金流。",
    modelVersion: "pressure-model.v1", inputs: [{ key: "revenue_growth", label: "收入增速", baseline: 0.12, stressed: 0.02, unit: "ratio", epistemicType: "observed_fact", sourceReferences: source }],
    results: [{ key: "fcf", label: "自由现金流", value: -100, unit: "CNYm", explanation: "仅为该情景模型输出。" }], sourceReferences: source, createdAt: 100, updatedAt: 100,
  };
  assert.doesNotThrow(() => assertResearchRiskPressureScenario(scenario));
  assert.ok(!Object.keys(scenario).some((key) => /score/i.test(key)));
});

test("risk relationships retain concentration basis and reject private portfolio scope", () => {
  const relationship = {
    relationshipId: "relationship:1", companyId: "company:1", securityCode: "00700.HK", asOf: 100, scope: "operating_company", relationshipType: "customer",
    counterpartyName: "主要客户", description: "客户集中度来自年报披露。", transmission: "客户缩减采购会压缩收入。", concentrationValue: 0.31,
    concentrationBasis: "2025 年披露收入占比", status: "active", epistemicType: "observed_fact", sourceReferences: source, createdAt: 100, updatedAt: 100,
  };
  assert.doesNotThrow(() => assertResearchRiskRelationship(relationship));
  assert.throws(() => assertResearchRiskRelationship({ ...relationship, scope: "user_portfolio" }), /cannot be user_portfolio/);
  assert.throws(() => assertResearchRiskRelationship({ ...relationship, concentrationBasis: null }), /concentrationBasis/);
});

test("snapshot diffs are deterministic, field-level, and exclude private decision fields", () => {
  const baseline = [{ moduleId: "financials", availability: "available", versionId: "v1", asOf: 90, payload: { revenue: 100, metadata: { currency: "CNY" } } }];
  const current = [{ moduleId: "financials", availability: "available", versionId: "v2", asOf: 100, payload: { metadata: { currency: "CNY" }, revenue: 120 } }, { moduleId: "risks", availability: "empty", versionId: null, asOf: 100, payload: {} }];
  const differences = diffResearchSnapshotModules({ differenceIdPrefix: "diff:100", securityCode: "00700.HK", companyId: "company:1", baselineSnapshotId: "snapshot:90", currentSnapshotId: "snapshot:100", baseline, current, createdAt: 100 });
  assert.equal(differences.length, 2);
  assert.equal(differences[0].moduleId, "financials");
  assert.equal(differences[0].changeType, "changed");
  assert.equal(differences[0].diffVersion, RESEARCH_SNAPSHOT_DIFF_VERSION);
  assert.deepEqual(differences[0].fields.map((field) => field.path), ["/asOf", "/payload/revenue", "/versionId"]);
  assert.equal(differences[1].changeType, "added");
  assert.throws(() => diffResearchSnapshotModules({ differenceIdPrefix: "diff:101", securityCode: "00700.HK", companyId: null, baselineSnapshotId: null, currentSnapshotId: "snapshot:101", baseline: [], current: [{ moduleId: "private", availability: "available", versionId: null, asOf: 101, payload: { ownerKey: "local-user" } }], createdAt: 101 }), /private decision field/);
});

test("public research snapshots freeze six public layers and isolate a changed formal actual", () => {
  const initial = {
    asOf: 100,
    subjectAndMarketStructure: { records: [{ listedSecurity: { code: "BABA.US", updatedAt: 1 } }] },
    formalFinancialCoverage: { records: [{ statutoryVerifications: { items: [{ verificationId: "v:1", status: "match", verifiedAt: 2 }] } }] },
    operatingModelAndDriverPlan: { records: [] }, forecastAndFormalActual: { records: [{ formalActuals: [{ actualId: "actual:1", revisionNumber: 1, createdAt: 3 }] }] },
    valuationVersions: { records: [] }, researchConclusions: { records: [] },
  };
  const changed = { ...initial, asOf: 200, forecastAndFormalActual: { records: [{ formalActuals: [{ actualId: "actual:2", revisionNumber: 2, supersedesActualId: "actual:1", createdAt: 4 }] }] } };
  const modules = buildPublicResearchSnapshotModules(initial);
  assert.deepEqual(modules.map((item) => item.moduleId), ["subject-and-market-structure", "formal-financial-coverage", "operating-model-and-driver-plan", "forecast-and-formal-actual", "valuation-versions", "research-conclusions"]);
  const plan = planPublicResearchSnapshotDifferences({ differenceIdPrefix: "full:200", securityCode: "BABA.US", companyId: "company:1", baselineSnapshotId: "full:100", currentSnapshotId: "full:200", baselineModules: modules, createdAt: 200, snapshot: changed });
  assert.deepEqual(plan.differences.map((item) => item.moduleId), ["forecast-and-formal-actual"]);
  assert.throws(() => buildPublicResearchSnapshotModules({ ...initial, researchConclusions: { records: [{ position: "100 shares" }] } }), /private or draft field/);
});

test("public research snapshot keeps valuation versions auditable but never exposes per-security value", () => {
  const snapshot = projectPublicResearchSnapshot({
    asOf: 100,
    valuationGate: { status: "ready", conclusionImpact: "可读", nextEvidence: "持续复核" },
    valuationModels: { availability: "available", items: [{ modelVersionId: "dcf:1", status: "saved", perSecurityValue: 123.45, valuationCurrency: "CNY" }] },
  });
  const valuation = snapshot.valuationVersions.records[0];
  assert.equal(valuation.gate.status, "blocked");
  assert.equal(valuation.dcf.items[0].modelVersionId, "dcf:1");
  assert.equal("perSecurityValue" in valuation.dcf.items[0], false);
});

test("public research snapshot history redacts legacy valuation outputs from modules and differences", async () => {
  const legacyValuation = {
    gate: { status: "blocked" },
    dcf: { items: [{ modelVersionId: "dcf:legacy", perSecurityValue: 123.45, enterpriseValue: 999, sensitivity: [{ wacc: 0.1 }] }] },
    reverseDcf: { items: [{ modelVersionId: "reverse:legacy", impliedTerminalRevenue: 321 }] },
  };
  const module = { moduleId: "valuation-versions", availability: "available", versionId: JSON.stringify(legacyValuation), asOf: null, payload: legacyValuation };
  const db = {
    prepare(sql) {
      return { bind() { return {
        async all() {
          if (sql.includes("from research_analysis_snapshots")) return { results: [{
            analysisSnapshotId: "snapshot:legacy", companyId: "company:1", securityCode: "00700.HK", asOf: 100,
            completionLevel: "basic", state: "历史", summaryJson: JSON.stringify({ kind: "public_research_snapshot" }), moduleStatusJson: JSON.stringify({ "valuation-versions": { versionId: JSON.stringify(legacyValuation) } }), createdAt: 100,
          }] };
          if (sql.includes("from research_snapshot_module_differences")) return { results: [{
            difference_id: "diff:legacy", company_id: "company:1", security_code: "00700.HK", baseline_snapshot_id: null,
            current_snapshot_id: "snapshot:legacy", module_id: "valuation-versions", diff_version: "research-snapshot-diff.v1", change_type: "added",
            baseline_json: null, current_json: JSON.stringify(module), fields_json: JSON.stringify([{ path: "/payload", changeType: "added", baselineValue: null, currentValue: module }]), created_at: 100,
          }] };
          if (sql.includes("from research_analysis_snapshot_modules")) return { results: [{
            moduleId: "valuation-versions", availability: "available", versionId: JSON.stringify(legacyValuation), asOf: null, payloadJson: JSON.stringify(legacyValuation),
          }] };
          return { results: [] };
        },
      }; } };
    },
  };
  const history = await loadPublicResearchSnapshotHistory(db, { securityCode: "00700.HK", asOf: 200 });
  const replay = JSON.stringify(history.items[0]);
  assert.equal(history.availability, "available");
  assert.equal(replay.includes("perSecurityValue"), false);
  assert.equal(replay.includes("enterpriseValue"), false);
  assert.equal(replay.includes("sensitivity"), false);
  assert.equal(replay.includes("impliedTerminalRevenue"), false);
  assert.equal(history.items[0].modules[0].payload.dcf.items[0].modelVersionId, "dcf:legacy");
});

test("public research snapshot freezes financial observations and accepted source facts for later differences", () => {
  const snapshot = projectPublicResearchSnapshot({
    asOf: 100,
    financialQuality: { ruleVersion: "research-financial-quality.v2", series: [{ metric: "revenue", frequency: "annual", unit: "CNY", basis: { id: "CNY:CAS", revision: "reported" }, points: [{ period: { fiscalYear: 2025 }, status: "available", value: 100, formula: "reported", reasonCodes: [], inputs: [{ factId: "income:2025", provenance: { sourceId: "eastmoney:income:2025" } }] }] }], observations: [], gaps: [] },
    operatingSourceFacts: { availability: "available", items: [{ operatingSourceFactId: "fact:1", evidenceReferenceId: "evidence:1", factKind: "contract_commitment", sourceUrl: "https://example.test/filing", recordedAt: 99 }] },
    operatingSourceFactBindings: { availability: "available", items: [{ operatingSourceFactBindingId: "binding:1", operatingSourceFactId: "fact:1", reviewStatus: "reviewed", targetField: "contract_amount" }] },
  });
  const formal = snapshot.formalFinancialCoverage.records[0];
  const operating = snapshot.operatingModelAndDriverPlan.records[0];
  assert.equal(formal.financialQuality.series[0].points[0].value, 100);
  assert.equal(formal.financialQuality.series[0].points[0].inputs[0].factId, "income:2025");
  assert.equal(operating.acceptedSourceFacts.items[0].operatingSourceFactId, "fact:1");
  assert.equal(operating.sourceFactBindings.items[0].reviewStatus, "reviewed");
});

test("risk stress calculation uses only explicit comparable inputs and leaves missing metrics unavailable", () => {
  const scenario = {
    scenarioId: "pressure:stress", companyId: "company:1", securityCode: "00700.HK", asOf: 100, scenarioKey: "downside", version: 1,
    supersedesScenarioId: null, status: "reviewed", scope: "operating_company", title: "下行情景", transmission: "量价与利润率同步承压。",
    modelVersion: "pressure-model.v2", inputs: [
      { key: "revenue", label: "收入", baseline: 1000, stressed: 800, unit: "CNYm", epistemicType: "observed_fact", sourceReferences: source },
      { key: "ebit_margin", label: "EBIT率", baseline: 0.2, stressed: 0.1, unit: "ratio", epistemicType: "analysis_assumption", sourceReferences: [] },
      { key: "cash", label: "现金", baseline: 300, stressed: 180, unit: "CNYm", epistemicType: "observed_fact", sourceReferences: source },
      { key: "annual_cash_burn", label: "年现金消耗", baseline: 0, stressed: 90, unit: "CNYm", epistemicType: "analysis_assumption", sourceReferences: [] },
    ], results: [{ key: "manual", label: "人工结果", value: null, unit: null, explanation: "由确定性计算器重新生成。" }], sourceReferences: source, createdAt: 100, updatedAt: 100,
  };
  const result = calculateResearchRiskStress({ scenario, monetaryUnit: "CNYm" });
  assert.equal(result.availability, "partial");
  assert.deepEqual(result.observations.find((item) => item.key === "ebit"), {
    key: "ebit", label: "息税前利润", baselineValue: 200, stressedValue: 80, deltaValue: -120, unit: "CNYm", status: "available", inputKeys: ["revenue", "ebit_margin"], limitation: null,
  });
  assert.equal(result.observations.find((item) => item.key === "net_debt")?.status, "unavailable");
  assert.equal(result.observations.find((item) => item.key === "cash_runway_years")?.status, "unavailable");
});

test("risk propagation needs an explicit public link and never auto-edits a thesis", () => {
  const risk = {
    riskId: "risk:1", companyId: "company:1", securityCode: "00700.HK", asOf: 100, category: "demand", scope: "operating_company", title: "需求下滑", exposure: "主产品", transmission: "收入下降",
    lossRange: null, likelihood: null, impact: null, speed: null, reversibility: null, grossRisk: null, verifiedMitigation: null, residualRisk: null,
    triggerCondition: "订单下降", reviewFrequency: "quarterly", status: "upgraded", epistemicType: "system_judgment", sourceReferences: source, createdAt: 100, updatedAt: 100,
  };
  const thesis = { thesisId: "thesis:1", companyId: "company:1", asOf: 100, title: "需求增长", statement: "需求持续增长", status: "active", epistemicType: "system_judgment", invalidationCondition: "订单下降", reviewBy: 200, evidence: [], createdAt: 100, updatedAt: 100 };
  const result = buildResearchRiskThesisPropagation({ risks: [risk], theses: [thesis], links: [{ riskId: "risk:1", thesisId: "thesis:1", relationship: "invalidates", rationale: "同一订单指标", sourceReferences: source }] });
  assert.deepEqual(result[0], { riskId: "risk:1", thesisId: "thesis:1", state: "requires_review", rationale: "同一订单指标；风险状态为 upgraded，需要人工复核命题与相关估值。" });
  assert.equal(thesis.status, "active");
});

test("public risk snapshot modules reject personal content instead of silently copying it", () => {
  assert.throws(() => buildPublicRiskSnapshotModules({ asOf: 100, risks: [], theses: [{ thesisId: "private", companyId: "company:1", asOf: 100, title: "私人", statement: "私人", status: "active", epistemicType: "user_decision", invalidationCondition: "私人", reviewBy: null, evidence: [], createdAt: 100, updatedAt: 100 }], pressureScenarios: [], relationships: [] }), /personal thesis/);
});

test("public snapshot freezes source-impact mappings with their appended thesis/risk disposition", () => {
  const modules = buildPublicRiskSnapshotModules({ asOf: 100, risks: [], theses: [], pressureScenarios: [], relationships: [], impactReviews: [{
    ruleVersion: "guidance-event-impact-review.v2", impactReviewId: "impact:1", securityCode: "00700.HK", companyId: "company:1",
    sourceKind: "formal_actual", sourceId: "actual:1", sourceObservedAt: "2026-04-20", reviewer: "local-user", rationale: "收入实际触发命题复核。",
    sourceBinding: { epistemicType: "observed_fact", statement: "法定收入实际", sourceReferences: source }, createdAt: 100,
    targets: [{ impactReviewTargetId: "impact:1:thesis:1:1", targetKind: "thesis", targetId: "thesis:1", reviewState: "no_change", action: {
      actionId: "impact-action:1", impactReviewTargetId: "impact:1:thesis:1:1", previousState: "requires_review", decision: "no_change", rationale: "原命题不变。", actedBy: "local-user", followUpTargetId: null, actedAt: 101,
    } }],
  }] });
  const mapping = modules.find((module) => module.moduleId === "source-impact-review-mappings");
  assert.equal(mapping?.availability, "available");
  assert.equal(mapping?.payload.records[0].targets[0].action.decision, "no_change");
});

test("public snapshot may freeze a public company focus reference graph but never membership", () => {
  const modules = buildPublicRiskSnapshotModules({ asOf: 100, risks: [], theses: [], pressureScenarios: [], relationships: [], focusProfile: {
    focusProfileId: "focus:1", companyId: "company:1", version: 1, asOf: 100, status: "reviewed", title: "经营重点", reviewBy: null, epistemicType: "system_judgment",
    items: [{ focusItemId: "item:1", role: "thesis", targetKind: "research_thesis", targetId: "thesis:1", securityCode: null, sortOrder: 0, target: { title: "可证伪命题" }, unavailableReason: null }],
  } });
  const focus = modules.find((item) => item.moduleId === "company-focus-profile");
  assert.equal(focus?.versionId, "focus:1");
  assert.equal(focus?.payload.privateDataIncluded, false);
  assert.equal(JSON.stringify(focus?.payload).includes("ownerKey"), false);
  assert.throws(() => buildPublicRiskSnapshotModules({ asOf: 100, risks: [], theses: [], pressureScenarios: [], relationships: [], focusProfile: {
    focusProfileId: "focus:private", companyId: "company:1", version: 1, asOf: 100, status: "reviewed", title: "不应公开", reviewBy: null, epistemicType: "system_judgment",
    items: [{ focusItemId: "item:private", role: "thesis", targetKind: "research_thesis", targetId: "thesis:1", securityCode: null, sortOrder: 0, target: { membership: { ownerKey: "alice" } }, unavailableReason: null }],
  } }), /private decision field membership/);
});

test("snapshot application plan freezes public risk modules before persisting field differences", () => {
  const plan = planPublicRiskSnapshotDifferences({ differenceIdPrefix: "diff:200", securityCode: "00700.HK", companyId: "company:1", baselineSnapshotId: null, currentSnapshotId: "snapshot:200", baselineModules: [], asOf: 200, createdAt: 200, risks: [], theses: [], pressureScenarios: [], relationships: [] });
  assert.deepEqual(plan.currentModules.map((item) => [item.moduleId, item.availability]), [["risk-register", "empty"], ["theses", "empty"], ["risk-pressure-scenarios", "empty"], ["risk-relationships", "empty"], ["source-impact-review-mappings", "empty"]]);
  assert.equal(plan.differences.length, 5);
  assert.ok(plan.differences.every((item) => item.changeType === "added"));
});

test("public risk snapshot save batches immutable modules and differences after the snapshot row", async () => {
  const batches = [];
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values, async first() { return null; }, async all() { return { results: [] }; } }; } }; },
    async batch(statements) { batches.push(statements); },
  };
  const saved = await savePublicRiskReviewSnapshot(db, {
    analysisSnapshotId: "snapshot:300", companyId: "company:1", securityCode: "00700.HK", asOf: 300,
    completionLevel: "basic", state: "资料待补", createdAt: 300, risks: [], theses: [], pressureScenarios: [], relationships: [],
  });
  assert.equal(saved.state, "saved");
  assert.equal(saved.moduleCount, 5);
  assert.equal(batches[0].length, 11);
  assert.match(batches[0][0].sql, /insert into research_analysis_snapshots/i);
  assert.match(batches[0][1].sql, /insert into research_analysis_snapshot_modules/i);
  assert.match(batches[0].at(-1).sql, /insert into research_snapshot_module_differences/i);
});

test("public snapshot diffs only baseline against a prior frozen public snapshot", async () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return { bind(...values) {
        return {
          sql, values,
          async first() {
            if (sql.includes("from research_analysis_snapshots")) {
              // The production query must exclude a generic dossier snapshot;
              // only a snapshot with frozen modules can be a valid baseline.
              assert.match(sql, /json_extract\(summary_json, '\$\.kind'\)='public_risk_review_snapshot'/);
              return { analysisSnapshotId: "public-snapshot:prior" };
            }
            return null;
          },
          async all() {
            if (sql.includes("from research_analysis_snapshot_modules")) return { results: [{
              moduleId: "risk-register", availability: "empty", versionId: null, asOf: 200, payloadJson: JSON.stringify({ records: [] }),
            }] };
            return { results: [] };
          },
        };
      } };
    },
    async batch() {},
  };
  const saved = await savePublicRiskReviewSnapshot(db, {
    analysisSnapshotId: "public-snapshot:current", companyId: "company:1", securityCode: "00700.HK", asOf: 300,
    completionLevel: "basic", state: "资料待补", createdAt: 300, risks: [], theses: [], pressureScenarios: [], relationships: [],
  });
  assert.equal(saved.baselineSnapshotId, "public-snapshot:prior");
  assert.ok(prepared.some((sql) => sql.includes("json_extract(summary_json")));
});

test("public snapshot history replays frozen modules instead of substituting current records", async () => {
  const db = {
    prepare(sql) {
      return { bind() {
        if (sql.includes("from research_analysis_snapshots")) return { all: async () => ({ results: [{
          analysisSnapshotId: "snapshot:past", companyId: "company:1", securityCode: "00700.HK", asOf: 100,
          completionLevel: "basic", state: "历史状态", summaryJson: JSON.stringify({ kind: "public_risk_review_snapshot", privateDataIncluded: false }),
          moduleStatusJson: JSON.stringify({ "risk-register": { availability: "available" } }), createdAt: 100,
        }] }) };
        if (sql.includes("from research_snapshot_module_differences")) return { all: async () => ({ results: [{
          difference_id: "difference:past", company_id: "company:1", security_code: "00700.HK", baseline_snapshot_id: null,
          current_snapshot_id: "snapshot:past", module_id: "risk-register", diff_version: "research-snapshot-diff.v1", change_type: "added",
          baseline_json: "null", current_json: JSON.stringify({ moduleId: "risk-register", availability: "available", versionId: "risk:past", asOf: 100, payload: {} }), fields_json: JSON.stringify([{ path: "/payload", changeType: "added", baselineValue: null, currentValue: {} }]), created_at: 100,
        }] }) };
        if (sql.includes("from research_analysis_snapshot_modules")) return { all: async () => ({ results: [{
          moduleId: "risk-register", availability: "available", versionId: "risk:past", asOf: 100,
          payloadJson: JSON.stringify({ risks: [{ title: "当时风险" }] }),
        }] }) };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
  const history = await loadPublicRiskReviewSnapshotHistory(db, { securityCode: "00700.HK", asOf: 200 });
  assert.equal(history.availability, "available");
  assert.equal(history.items[0].modules[0].payload.risks[0].title, "当时风险");
  assert.equal(history.items[0].differences[0].moduleId, "risk-register");
});

test("risk stress API reads a stored scenario deterministically and writes stay local-only", async () => {
  const scenarioRow = {
    scenario_id: "pressure:api", company_id: "company:1", security_code: "00700.HK", as_of: 100, scenario_key: "api", version: 1,
    supersedes_scenario_id: null, status: "reviewed", scope: "operating_company", title: "API", transmission: "传导", model_version: "v1",
    inputs_json: JSON.stringify([{ key: "revenue", label: "收入", baseline: 100, stressed: 80, unit: "CNYm", epistemicType: "observed_fact", sourceReferences: source }]),
    results_json: JSON.stringify([{ key: "manual", label: "人工", value: null, unit: null, explanation: "保留" }]), source_refs_json: JSON.stringify(source), created_at: 100, updated_at: 100,
  };
  const db = { prepare() { return { bind() { return { async first() { return scenarioRow; } }; } }; } };
  const read = await researchRoutes.request("http://example.test/research/company/00700.HK/risk-pressure-scenarios/pressure:api/stress?monetaryUnit=CNYm", {}, { DB: db });
  const payload = await read.json();
  assert.equal(read.status, 200);
  assert.equal(payload.data.observations.find((item) => item.key === "revenue").stressedValue, 80);
  const blocked = await researchRoutes.request("http://example.test/research/company/00700.HK/risk-pressure-scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { LLM_RUNTIME: "production" });
  assert.equal(blocked.status, 404);
});

test("every research write and local synthesis endpoint is unavailable outside the local LLM runtime", async () => {
  const companyWritePaths = [
    "forecast-reviews",
    "forecast-synthesis-drafts",
    "forecast-scenarios",
    "forecast-calibrations",
    "management-guidance-forecasts",
    "formal-actuals",
    "formal-actual-candidates/refresh",
    "formal-actual-candidate-reviews",
    "formal-actual-calibrations",
    "model-review-items/model-review:example/resolve",
    "statutory-disclosures/refresh",
    "statutory-disclosure-revision-candidates/refresh",
    "statutory-disclosure-revision-candidates/candidate:example/reviews",
    "statutory-disclosures/indexed-document-example/import-local",
    "statutory-operating-candidates/produce",
    "financial-statutory-verifications/refresh",
    "us-financial-period-equivalences",
    "valuation-models/dcf",
    "valuation-models/operating-scenario",
    "valuation-models/reverse-dcf",
    "identity",
    "focus-membership",
    "focus-profiles",
    "financial-profile",
    "financial-specialty-metrics",
    "market-structure/facts",
    "risk-pressure-scenarios",
    "risk-relationships",
    "risk-thesis-links",
    "public-risk-snapshots",
    "public-research-snapshots",
    "industry-exposures",
    "peer-comparison-sets",
    "operating-models",
    "operating-source-facts",
    "operating-source-fact-bindings",
    "operating-source-fact-bindings/operating-source-fact-binding:example/reviews",
    "relative-valuations",
    "governance-capital-fact-candidates/refresh",
    "governance-capital-fact-candidates/candidate:example/reviews",
    "operating-driver-plans",
    "industry-kpi-driver-bindings",
    "operating-driver-plans/operating-driver-plan:example/industry-kpi-projection",
    "market-space-assessments",
    "catalysts/catalyst:example/reviews",
    "guidance-event-impact-reviews",
    "guidance-event-impact-review-targets/impact-target:example/resolve",
  ];
  const productionEnv = { LLM_RUNTIME: "production" };
  for (const path of companyWritePaths) {
    const response = await researchRoutes.request(
      `http://example.test/research/company/00700.HK/${path}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      productionEnv,
    );
    assert.equal(response.status, 404, `${path} must not be writable in production runtime`);
  }
  for (const path of ["forecast-source-independence-groups", "forecast-source-identities", "forecast-model-lineages", "forecast-source-identity-assertions"]) {
    const response = await researchRoutes.request(
      `http://example.test/research/${path}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      productionEnv,
    );
    assert.equal(response.status, 404, `${path} must not be writable in production runtime`);
  }
  for (const section of ["business-model", "market-space", "competitive-market", "thesis", "valuation", "risk", "catalyst", "snapshot", "user-note", "governance"]) {
    const response = await researchRoutes.request(
      `http://example.test/research/company/00700.HK/dossier/${section}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      productionEnv,
    );
    assert.equal(response.status, 404, `dossier/${section} must not be writable in production runtime`);
  }
  const industry = await researchRoutes.request(
    "http://example.test/research/industry/tracks",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    productionEnv,
  );
  assert.equal(industry.status, 404);
  const formalActualBatch = await researchRoutes.request(
    "http://example.test/research/formal-actual-candidates/materialize",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ securityCodes: ["00700.HK"] }) },
    productionEnv,
  );
  assert.equal(formalActualBatch.status, 404, "formal actual batch materialization must not be writable in production runtime");
});
