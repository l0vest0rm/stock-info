import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSyncLedgerEntries,
  compactSyncLedger,
  knowledgeImportFingerprint,
  loadSyncLedger,
  syncStateFor,
} from "./knowledge-import-sync.mjs";

test("import fingerprint ignores regenerated source bookkeeping", () => {
  const original = {
    docId: "doc-1",
    title: "same title",
    markdown: "same body",
    publishedAt: "2026-07-13T00:00:00Z",
    fetchedAt: "2026-07-13T01:00:00Z",
    metadata: {
      inputFile: "old.json",
      inputRelativeFile: "2026-07-13/old.json",
      originalFile: "old.json",
      processedAt: "2026-07-13T01:00:00Z",
      sourceMtimeMs: 100,
      sourceSize: 200,
      stockCodes: ["600000.SH"],
    },
  };
  const regenerated = {
    ...original,
    fetchedAt: "2026-07-14T01:00:00Z",
    metadata: {
      ...original.metadata,
      inputFile: "new.json",
      inputRelativeFile: "2026-07-14/new.json",
      originalFile: "new.json",
      processedAt: "2026-07-14T01:00:00Z",
      sourceMtimeMs: 300,
      sourceSize: 400,
    },
  };

  assert.equal(knowledgeImportFingerprint(original), knowledgeImportFingerprint(regenerated));
  assert.notEqual(
    knowledgeImportFingerprint(original),
    knowledgeImportFingerprint({ ...regenerated, title: "changed title" })
  );
});

test("filtered fingerprint ignores volatile fields inside nested doc", () => {
  const first = {
    file: "old.json",
    doc: {
      docId: "doc-2",
      title: "same",
      publishedAt: "2026-07-13T00:00:00Z",
      fetchedAt: "2026-07-13T01:00:00Z",
      metadata: { inputRelativeFile: "old.json", sourceMtimeMs: 1, sourceSize: 2 },
    },
    filter: { score: 1, reasons: ["keyword"] },
  };
  const second = {
    ...first,
    file: "new.json",
    doc: {
      ...first.doc,
      fetchedAt: "2026-07-14T01:00:00Z",
      metadata: { inputRelativeFile: "new.json", sourceMtimeMs: 3, sourceSize: 4 },
    },
  };

  assert.equal(knowledgeImportFingerprint(first), knowledgeImportFingerprint(second));
  assert.notEqual(
    knowledgeImportFingerprint(first),
    knowledgeImportFingerprint({ ...second, filter: { score: 0, reasons: ["changed"] } })
  );
});

test("import fingerprint keeps fetched time when it is the only document time", () => {
  const first = { docId: "doc-3", title: "same", fetchedAt: "2026-07-13T01:00:00Z" };
  const second = { ...first, fetchedAt: "2026-07-14T01:00:00Z" };
  assert.notEqual(knowledgeImportFingerprint(first), knowledgeImportFingerprint(second));
});

test("sync ledger compaction keeps the latest entry per target and doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-sync-test-"));
  const file = join(dir, "sync.jsonl");
  try {
    appendSyncLedgerEntries(file, [
      entry({ target: "local", docId: "doc-1", importedAt: "old" }),
      entry({ target: "remote", docId: "doc-1", importedAt: "remote" }),
      entry({ target: "local", docId: "doc-1", importedAt: "new" }),
      entry({ target: "local", docId: "doc-2", importedAt: "two" }),
    ]);

    const result = compactSyncLedger(file);
    const loaded = loadSyncLedger(file);
    const local = syncStateFor(loaded.entries, {
      scope: "knowledge_docs",
      target: "local",
      database: "stock_info",
    });

    assert.deepEqual(result.beforeLines, 4);
    assert.deepEqual(result.afterLines, 3);
    assert.equal(local.get("doc-1").importedAt, "new");
    assert.equal(local.get("doc-2").importedAt, "two");
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync ledger reports malformed state instead of silently reimporting", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-sync-test-"));
  const file = join(dir, "sync.jsonl");
  try {
    writeFileSync(file, `${JSON.stringify(entry({ docId: "doc-1" }))}\n{broken\n`);
    assert.throws(() => loadSyncLedger(file), /sync\.jsonl:2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(overrides = {}) {
  return {
    scope: "knowledge_docs",
    target: "local",
    database: "stock_info",
    docId: "doc-1",
    hasD1: true,
    ...overrides,
  };
}
