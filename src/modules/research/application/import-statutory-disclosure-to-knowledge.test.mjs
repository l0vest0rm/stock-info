import assert from "node:assert/strict";
import test from "node:test";

import { importIndexedStatutoryDisclosureToKnowledge } from "./import-statutory-disclosure-to-knowledge.ts";

const indexed = {
  registry: "cninfo", securityCode: "300308.SZ", documentId: "1225445769", title: "股份回购公告",
  publishedAt: "2026-07-29", documentUrl: "https://static.cninfo.com.cn/finalpage/2026-07-29/1225445769.pdf",
  documentType: "公告", sourceLocator: "CNINFO announcementId=1225445769", indexedAt: 100,
};

function database({ row = indexed, existing = null } = {}) {
  const queries = [];
  const writes = [];
  return {
    queries, writes,
    prepare(sql) {
      return { bind(...values) {
        if (sql.includes("from research_statutory_disclosure_documents")) {
          queries.push({ sql, values }); return { first: async () => row };
        }
        if (sql === "select doc_id from knowledge_docs where doc_id=?") {
          queries.push({ sql, values }); return { first: async () => existing };
        }
        return { sql, values };
      } };
    },
    async batch(statements) { writes.push(...statements); },
  };
}

function contentBucket() {
  const writes = [];
  return { writes, async put(key, value, options) { writes.push({ key, value, options }); } };
}

test("indexed statutory import only accepts the stored official URL and creates an immutable knowledge source ready for explicit processing", async () => {
  const db = database();
  const bucket = contentBucket();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("# 公告\n\n公司计划回购股份。", { status: 200, headers: { "content-type": "text/markdown" } });
  };
  try {
    const output = await importIndexedStatutoryDisclosureToKnowledge({ DB: db, KNOWLEDGE_CONTENT_BUCKET: bucket, KNOWLEDGE_REPORT_CONVERTER_URL: "http://127.0.0.1:8788/__convert-report" }, "300308.sz", indexed.documentId, 123);
    assert.equal(output.created, true);
    assert.equal(output.processing.status, "not_started");
    assert.equal(output.processing.documentId, output.knowledgeDocumentId);
    assert.match(output.knowledgeDocumentId, /^statutory-[a-f0-9]{48}$/);
    assert.match(output.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:8788/__convert-report");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      docId: "statutory_cninfo_300308_SZ_1225445769",
      url: indexed.documentUrl,
    });
    assert.equal(db.queries[0].values[0], "300308.SZ");
    assert.equal(db.queries[0].values[1], indexed.documentId);
    const sql = db.writes.map((item) => item.sql).join("\n");
    assert.match(sql, /insert into knowledge_docs/);
    assert.match(sql, /insert into knowledge_doc_content_refs/);
    assert.doesNotMatch(sql, /knowledge_local_content_cache/);
    assert.match(sql, /knowledge_doc_security_links/);
    assert.equal(bucket.writes.length, 1);
    assert.equal(bucket.writes[0].key, output.contentKey);
    assert.equal(bucket.writes[0].value, "# 公告\n\n公司计划回购股份。");
    assert.doesNotMatch(sql, /research_(operating_model|operating_driver|market_space|valuation)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a poisoned indexed URL is rejected before contacting a converter or writing any knowledge record", async () => {
  const db = database({ row: { ...indexed, documentUrl: "https://untrusted.example/filing.pdf" } });
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(
      () => importIndexedStatutoryDisclosureToKnowledge({ DB: db, KNOWLEDGE_CONTENT_BUCKET: contentBucket(), KNOWLEDGE_REPORT_CONVERTER_URL: "http://127.0.0.1:8788/__convert-report" }, "300308.SZ", indexed.documentId),
      /not an allowlisted CNINFO HTTPS PDF/,
    );
    assert.equal(called, false);
    assert.equal(db.writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an already materialized hash-specific source is not rewritten", async () => {
  const db = database({ existing: { doc_id: "existing" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("# 公告\n\n公司计划回购股份。", { status: 200 });
  try {
    const bucket = contentBucket();
    const output = await importIndexedStatutoryDisclosureToKnowledge({ DB: db, KNOWLEDGE_CONTENT_BUCKET: bucket, KNOWLEDGE_REPORT_CONVERTER_URL: "http://127.0.0.1:8788/__convert-report" }, "300308.SZ", indexed.documentId);
    assert.equal(output.created, false);
    assert.equal(db.writes.length, 0);
    assert.equal(bucket.writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
