import test from "node:test";
import assert from "node:assert/strict";

import {
  downloadPdfBytes,
} from "./eastmoney-report-content.mjs";

test("rejects an EdgeOne HTML block page instead of caching it as a PDF", async () => {
  await assert.rejects(
    () => downloadPdfBytes("https://pdf.dfcfw.com/pdf/H3_AP202607301827474173_1.pdf", {
      fetchImpl: async () => new Response("<html>请求已被站点的安全策略拦截。</html>", {
        status: 567,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    }),
    /status=567 contentType=text\/html.*安全策略拦截/
  );
});

test("rejects a successful HTML response that is not a PDF", async () => {
  await assert.rejects(
    () => downloadPdfBytes("https://pdf.dfcfw.com/pdf/H3_AP202607301827474173_1.pdf", {
      fetchImpl: async () => new Response("<html>blocked</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    }),
    /returned non-PDF/
  );
});

test("accepts a real PDF payload", async () => {
  const bytes = await downloadPdfBytes("https://pdf.dfcfw.com/pdf/H3_AP202607301827474173_1.pdf", {
    fetchImpl: async () => new Response(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1000)]), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }),
  });
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
});
