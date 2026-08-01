import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const migration = new URL("../../../../migrations/0019_situation_awareness.sql", import.meta.url);
const knowledgeImportMigration = new URL("../../../../migrations/0020_situation_knowledge_imports.sql", import.meta.url);

test("situation storage deduplicates source evidence and preserves an append-only disposition history", () => {
  const directory = mkdtempSync(join(tmpdir(), "situation-storage-"));
  const database = join(directory, "situation.sqlite");
  try {
    execute(database, readFileSync(migration));
    execute(database, `
      pragma foreign_keys = on;
      insert into situation_sources (source_id, name, kind, updated_at) values ('news', 'News', 'scheduled_search', 100);
      insert into situation_evidence
        (evidence_id, source_id, external_id, url, title, published_at, fetched_at, content_hash, evidence_grade, created_at)
      values ('e1', 'news', 'n1', 'https://example.test/1', 'A', 100, 101, 'hash-1', 'single_source_lead', 101);
      insert into situation_action_candidates
        (candidate_id, owner_key, as_of, action_type, target_type, target_id, priority, status, prerequisites_json, proposed_plan_json, invalidations_json, evidence_json, rule_version, created_at, updated_at)
      values ('c1', 'local', 101, 'review', 'company', '600519.SH', 80, 'open', '[]', '{}', '[]', '["e1"]', 'v1', 101, 101);
      insert into situation_candidate_dispositions (disposition_id, candidate_id, owner_key, disposition, created_at)
      values ('d1', 'c1', 'local', 'deferred', 102), ('d2', 'c1', 'local', 'researching', 103);
    `);
    assert.throws(() => execute(database, `insert into situation_evidence
      (evidence_id, source_id, external_id, url, title, published_at, fetched_at, content_hash, evidence_grade, created_at)
      values ('e2', 'news', 'n1', 'https://example.test/2', 'B', 102, 102, 'hash-2', 'single_source_lead', 102);`), /UNIQUE constraint failed/);
    assert.equal(query(database, "select count(*) from situation_candidate_dispositions where candidate_id='c1'"), "2");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("situation snapshots retain point-in-time rows instead of overwriting older as-of states", () => {
  const directory = mkdtempSync(join(tmpdir(), "situation-storage-"));
  const database = join(directory, "situation.sqlite");
  try {
    execute(database, readFileSync(migration));
    execute(database, `
      insert into situation_snapshots (snapshot_id, as_of, scope_type, scope_id, state, confidence, summary_json, rule_version, created_at)
      values ('s1', 100, 'market', 'cn', 'watch', .4, '{"evidence":"e1"}', 'v1', 100),
             ('s2', 200, 'market', 'cn', 'needs_attention', .8, '{"evidence":"e2"}', 'v1', 200);
    `);
    assert.equal(query(database, "select state from situation_snapshots where scope_type='market' and scope_id='cn' and as_of<=150 order by as_of desc limit 1"), "watch");
    assert.equal(query(database, "select state from situation_snapshots where scope_type='market' and scope_id='cn' and as_of<=250 order by as_of desc limit 1"), "needs_attention");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("knowledge intake records preserve a source-scope cursor and evidence linkage", () => {
  const directory = mkdtempSync(join(tmpdir(), "situation-storage-"));
  const database = join(directory, "situation.sqlite");
  try {
    execute(database, readFileSync(migration));
    execute(database, readFileSync(knowledgeImportMigration));
    execute(database, `
      pragma foreign_keys = on;
      insert into situation_sources (source_id, name, kind, updated_at) values ('knowledge:selected-feed', 'Knowledge', 'knowledge_inbox', 100);
      insert into situation_evidence
        (evidence_id, source_id, url, title, published_at, fetched_at, content_hash, evidence_grade, created_at)
      values ('evidence-1', 'knowledge:selected-feed', 'https://example.test/report', 'Report', 100, 101, 'hash-knowledge-1', 'single_source_lead', 101);
      insert into situation_knowledge_imports
        (source_scope, doc_id, status, evidence_id, first_seen_at, updated_at)
      values ('knowledge_docs', 'doc-1', 'imported', 'evidence-1', 101, 101);
    `);
    assert.equal(query(database, "select evidence_id from situation_knowledge_imports where source_scope='knowledge_docs' and doc_id='doc-1'"), "evidence-1");
    assert.throws(() => execute(database, `insert into situation_knowledge_imports
      (source_scope, doc_id, status, first_seen_at, updated_at) values ('unknown', 'doc-2', 'imported', 1, 1);`), /CHECK constraint failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function execute(database, sql) { execFileSync("sqlite3", ["-batch", database], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
function query(database, sql) { return execFileSync("sqlite3", ["-batch", database, sql], { encoding: "utf8" }).trim(); }
