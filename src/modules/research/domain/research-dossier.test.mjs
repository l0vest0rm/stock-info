import assert from "node:assert/strict";
import test from "node:test";

import {
  insertResearchBusinessModel,
  insertResearchAnalysisSnapshot,
  insertResearchRiskEntry,
  loadResearchDossier,
} from "../application/research-dossier.ts";
import {
  assertSourceReferences,
  availableSection,
  epistemicTypeForCatalystStatus,
  unavailableResearchDossier,
} from "./research-dossier.ts";

test("dossier sections distinguish empty data from unavailable storage", () => {
  assert.deepEqual(availableSection([]), { availability: "empty", reason: "no_records", items: [] });
  const unavailable = unavailableResearchDossier("NVDA.US", 100, "storage_not_initialized");
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.theses.availability, "unavailable");
  assert.equal(unavailable.theses.reason, "storage_not_initialized");
});

test("source-bound epistemic types cannot be persisted without a resolvable source", () => {
  assert.throws(() => assertSourceReferences("observed_fact", []), /requires at least one source reference/);
  assert.doesNotThrow(() => assertSourceReferences("analysis_assumption", []));
  assert.doesNotThrow(() => assertSourceReferences("third_party_forecast", [{
    sourceKind: "knowledge_record",
    informationId: "information:1",
  }]));
  assert.equal(epistemicTypeForCatalystStatus("guided"), "management_guidance");
  assert.equal(epistemicTypeForCatalystStatus("external_expectation"), "third_party_forecast");
});

test("missing dossier tables return an explicit unavailable result", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() { throw new Error("D1_ERROR: no such table: research_listed_securities"); },
          };
        },
      };
    },
  };
  const dossier = await loadResearchDossier(db, { securityCode: "00700.HK", asOf: 100 });
  assert.equal(dossier.availability, "unavailable");
  assert.equal(dossier.unavailableReason, "storage_not_initialized");
  assert.equal(dossier.securityCode, "00700.HK");
});

test("business-model writes preserve asOf, epistemic type and source references", async () => {
  const batches = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { return { sql, values }; } };
    },
    async batch(statements) { batches.push(statements); },
  };
  const sourceReferences = [{ sourceKind: "knowledge_document", documentId: "doc:1" }];
  const result = await insertResearchBusinessModel(db, {
    businessModelId: "business-model:1",
    companyId: "company:1",
    asOf: 100,
    status: "reviewed",
    primaryEarningDriver: "订阅收入",
    revenueRecognition: "服务期内确认",
    summary: "公司主要通过订阅服务获得收入。",
    epistemicType: "observed_fact",
    sourceReferences,
    segments: [],
    createdAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(result, { state: "saved", recordId: "business-model:1", reason: null });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.match(batches[0][0].sql, /insert into research_business_models/i);
  assert.ok(batches[0][0].values.includes("fact"));
  assert.ok(batches[0][0].values.includes(JSON.stringify(sourceReferences)));
});

test("public risk entries reject personal portfolio scope", async () => {
  const db = { prepare() { return { bind() { return {}; } }; }, async batch() {} };
  await assert.rejects(() => insertResearchRiskEntry(db, {
    riskId: "risk:private", companyId: "company:1", securityCode: "00700.HK", asOf: 100,
    category: "concentration", scope: "user_portfolio", title: "private position", exposure: "private",
    transmission: "private", lossRange: null, likelihood: null, impact: null, speed: null, reversibility: null,
    grossRisk: null, verifiedMitigation: null, residualRisk: null, triggerCondition: "private", reviewFrequency: null,
    status: "active", epistemicType: "system_judgment", sourceReferences: [], createdAt: 100, updatedAt: 100,
  }), /cannot be user_portfolio/);
});

test("legacy dossier snapshots cannot create or replay a private public-data side channel", async () => {
  const batches = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { return { sql, values, all: async () => ({ results: [] }), first: async () => null }; } };
    },
    async batch(statements) { batches.push(statements); },
  };
  const base = {
    analysisSnapshotId: "snapshot:public-boundary", companyId: "company:1", securityCode: "00700.HK", asOf: 100,
    completionLevel: "basic", state: "资料待补", summary: { dataAsOf: 100 }, moduleStatus: { financials: "blocked" }, createdAt: 100,
  };
  await assert.rejects(
    insertResearchAnalysisSnapshot(db, { ...base, summary: { ownerKey: "alice", position: "100 shares" } }),
    /private or a local draft/,
  );
  assert.equal(batches.length, 0);
  await assert.rejects(
    insertResearchAnalysisSnapshot(db, { ...base, analysisSnapshotId: "snapshot:draft", moduleStatus: { forecast: { synthesisDraft: "local only" } } }),
    /private or a local draft/,
  );
  assert.equal(batches.length, 0);

  const snapshotRows = [
    { analysis_snapshot_id: "snapshot:private-old", company_id: "company:1", security_code: "00700.HK", as_of: 99, completion_level: "basic", state: "old", summary_json: JSON.stringify({ tradePlan: "buy" }), module_status_json: "{}", created_at: 99 },
    { analysis_snapshot_id: "snapshot:public-old", company_id: "company:1", security_code: "00700.HK", as_of: 98, completion_level: "basic", state: "public", summary_json: JSON.stringify({ dataAsOf: 98 }), module_status_json: JSON.stringify({ financials: "blocked" }), created_at: 98 },
  ];
  const readDb = {
    prepare(sql) {
      return { bind() {
        if (sql.includes("from research_listed_securities")) return { first: async () => ({ security_code: "00700.HK", company_id: "company:1", venue: "HKEX", trading_currency: "HKD", share_class: null, depositary_ratio: null, mapping_status: "confirmed", mapping_basis: "official" }) };
        if (sql.includes("from research_operating_companies")) return { first: async () => ({ company_id: "company:1", canonical_name: "腾讯", reporting_currency: "CNY", fiscal_year_end: "12-31", identity_status: "confirmed" }) };
        if (sql.includes("from research_analysis_snapshots")) return { all: async () => ({ results: snapshotRows }) };
        return { all: async () => ({ results: [] }), first: async () => null };
      } };
    },
  };
  const dossier = await loadResearchDossier(readDb, { securityCode: "00700.HK", asOf: 100 });
  assert.deepEqual(dossier.snapshots.items.map((item) => item.analysisSnapshotId), ["snapshot:public-old"]);
  assert.equal(JSON.stringify(dossier.snapshots).includes("tradePlan"), false);
});
