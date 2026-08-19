import assert from "node:assert/strict";
import test from "node:test";

import {
  appendResearchCompanyFocusMembership,
  createResearchCompanyFocusProfile,
  loadResearchCompanyFocusProfile,
} from "../application/research-company-focus-profile.ts";
import { researchRoutes } from "../api/research.routes.ts";

const companyId = "company:shared";
const sourceFact = {
  operating_source_fact_id: "fact:shared",
  period_label: "2026Q1",
  subject_label: "已披露合同",
  statement: "合同金额来自法定公告。",
  source_security_code: "00700.HK",
};

function focusDatabase({ facts = [sourceFact], membership = null } = {}) {
  const profiles = [];
  const items = [];
  const batches = [];
  return {
    profiles,
    items,
    batches,
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from research_operating_companies where company_id=?")) {
            return { first: async () => values[0] === companyId ? { companyId } : null };
          }
          if (sql.includes("from research_company_focus_profile_versions") && sql.includes("order by version desc")) {
            return { first: async () => profiles.at(-1) ?? null };
          }
          if (sql.includes("from research_operating_source_facts")) {
            const row = facts.find((fact) => fact.operating_source_fact_id === values[0] && values[1] === companyId);
            return { first: async () => row ?? null };
          }
          if (sql.includes("from research_company_focus_memberships")) {
            return { first: async () => membership };
          }
          return { sql, values, first: async () => null, all: async () => ({ results: [] }) };
        },
      };
    },
    async batch(statements) {
      batches.push(statements);
      for (const statement of statements) {
        if (statement.sql?.includes("insert into research_company_focus_profile_versions")) {
          const [focusProfileId, storedCompanyId, version, supersedesFocusProfileId, asOf, status, title, reviewBy, createdAt] = statement.values;
          profiles.push({ focusProfileId, companyId: storedCompanyId, version, supersedesFocusProfileId, asOf, status, title, reviewBy, createdAt });
        } else if (statement.sql?.includes("update research_company_focus_profile_versions set status='superseded'")) {
          const profile = profiles.find((item) => item.focusProfileId === statement.values[0]);
          if (profile) profile.status = "superseded";
        } else if (statement.sql?.includes("insert into research_company_focus_profile_items")) {
          items.push(statement.values);
        }
      }
    },
  };
}

test("focus profile resolver rejects a cross-company typed reference before any public version is written", async () => {
  const db = focusDatabase({ facts: [] });
  await assert.rejects(
    createResearchCompanyFocusProfile(db, {
      focusProfileId: "focus:cross-company",
      companyId,
      asOf: 100,
      createdAt: 100,
      title: "不应写入",
      items: [{ role: "key_driver", targetKind: "operating_source_fact", targetId: "fact:belongs-to-another-company" }],
    }),
    /cross-company, personal, or lacks its evidence gate/,
  );
  assert.equal(db.batches.length, 0);
  assert.deepEqual(db.profiles, []);
});

test("focus profiles append immutable versions and supersede only the prior version status", async () => {
  const db = focusDatabase();
  const first = await createResearchCompanyFocusProfile(db, {
    focusProfileId: "focus:v1", companyId, asOf: 100, createdAt: 100, status: "draft", title: "第一版",
    items: [{ role: "key_driver", targetKind: "operating_source_fact", targetId: "fact:shared" }],
  });
  const second = await createResearchCompanyFocusProfile(db, {
    focusProfileId: "focus:v2", companyId, asOf: 200, createdAt: 200, status: "reviewed", title: "第二版",
    items: [{ role: "key_driver", targetKind: "operating_source_fact", targetId: "fact:shared" }],
  });

  assert.deepEqual(first, { state: "saved", focusProfileId: "focus:v1", version: 1, supersedesFocusProfileId: null });
  assert.deepEqual(second, { state: "saved", focusProfileId: "focus:v2", version: 2, supersedesFocusProfileId: "focus:v1" });
  assert.deepEqual(db.profiles.map((profile) => ({ id: profile.focusProfileId, version: profile.version, status: profile.status, supersedes: profile.supersedesFocusProfileId, title: profile.title })), [
    { id: "focus:v1", version: 1, status: "superseded", supersedes: null, title: "第一版" },
    { id: "focus:v2", version: 2, status: "reviewed", supersedes: "focus:v1", title: "第二版" },
  ]);
  const profileUpdates = db.batches.flat().filter((statement) => statement.sql?.includes("update research_company_focus_profile_versions"));
  assert.equal(profileUpdates.length, 1);
  assert.match(profileUpdates[0].sql, /set status='superseded'/);
  assert.doesNotMatch(profileUpdates[0].sql, /(title|as_of|epistemic_type|company_id)\s*=/);
});

test("private focus membership is owner-scoped and never appears in a public profile view", async () => {
  const membership = {
    membership_id: "membership:private", owner_key: "alice", company_id: companyId,
    status: "active", supersedes_membership_id: null, created_at: 100,
  };
  const db = focusDatabase({ membership });
  const ownerView = await loadResearchCompanyFocusProfile(db, { companyId, securityCode: "00700.HK", asOf: 100, ownerKey: "alice" });
  const publicView = await loadResearchCompanyFocusProfile(db, { companyId, securityCode: "00700.HK", asOf: 100 });

  assert.deepEqual(ownerView.membership, { membershipId: "membership:private", companyId, status: "active", supersedesMembershipId: null, createdAt: 100 });
  assert.equal(JSON.stringify(ownerView.membership).includes("alice"), false);
  assert.equal(Object.hasOwn(publicView, "membership"), false);
  assert.equal(JSON.stringify(publicView).includes("alice"), false);
});

test("focus endpoints are 404 for production writes and production reads ignore owner query data", async () => {
  for (const path of ["focus-membership", "focus-profiles"]) {
    const response = await researchRoutes.request(
      `http://example.test/research/company/00700.HK/${path}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      { LLM_RUNTIME: "production" },
    );
    assert.equal(response.status, 404, `${path} must be absent in production`);
  }

  let membershipQuery = false;
  const db = {
    prepare(sql) {
      return { bind() {
        if (sql.includes("from http_cache")) return { first: async () => null };
        if (sql.includes("insert into http_cache")) return { run: async () => ({ success: true }) };
        if (sql.includes("research_company_focus_memberships")) membershipQuery = true;
        if (sql.includes("research_listed_securities where security_code")) return { first: async () => ({ companyId, metadataJson: "{}" }), all: async () => ({ results: [] }) };
        if (sql.includes("from research_operating_companies where company_id")) return { first: async () => ({ companyId, canonicalName: "腾讯", reportingCurrency: "CNY", fiscalYearEnd: "12-31", identityStatus: "confirmed", metadataJson: "{}" }) };
        return { first: async () => null, all: async () => ({ results: [] }) };
      } };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    GubaCodeTable: { Data: [{ OuterCode: "HK00700", ShortName: "腾讯控股" }] },
  }), { status: 200 });
  try {
    const response = await researchRoutes.request("http://example.test/research/company/00700.HK/focus-profile?owner=alice", {}, { DB: db, LLM_RUNTIME: "production" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(membershipQuery, false);
    assert.equal(Object.hasOwn(payload.data, "membership"), false);
    assert.equal(JSON.stringify(payload.data).includes("alice"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("membership append returns an owner-redacted record", async () => {
  const statements = [];
  const db = {
    prepare(sql) { return { bind(...values) {
      if (sql.includes("from research_company_focus_memberships")) return { first: async () => null };
      return { run: async () => { statements.push({ sql, values }); } };
    } }; },
  };
  const result = await appendResearchCompanyFocusMembership(db, { membershipId: "membership:1", ownerKey: "alice", companyId, status: "active", createdAt: 100 });
  assert.equal(JSON.stringify(result.membership).includes("alice"), false);
  assert.equal(Object.hasOwn(result.membership, "ownerKey"), false);
  assert.deepEqual(result.membership, { membershipId: "membership:1", companyId, status: "active", supersedesMembershipId: null, createdAt: 100 });
  assert.equal(statements.length, 1);
});
