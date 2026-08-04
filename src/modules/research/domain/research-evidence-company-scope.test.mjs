import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("database triggers preserve confirmed-security company scope for operating and industry evidence writes", () => {
  const migration = readFileSync(resolve(process.cwd(), "migrations/0080_research_evidence_company_scope.sql"), "utf8");
  assert.match(migration, /research_industry_kpi_driver_binding_security_company_before_insert/);
  assert.match(migration, /security\.mapping_status='confirmed'/);
  assert.match(migration, /security\.company_id=exposure\.company_id/);
  assert.match(migration, /research_operating_source_fact_security_company_before_insert/);
  assert.match(migration, /security\.company_id=new\.operating_company_id/);
});
