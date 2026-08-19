import assert from "node:assert/strict";
import test from "node:test";

import { getSecurity, searchSecurities } from "./search-securities.ts";

class FakeD1 {
  statements = [];

  prepare(sql) {
    this.statements.push(sql);
    return {
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    };
  }
}

function eastmoneySuggestResponse() {
  return {
    GubaCodeTable: {
      Data: [
        { OuterCode: "SZ000001", ShortName: "平安银行" },
        { OuterCode: "USNVDA", ShortName: "英伟达" },
      ],
    },
  };
}

test("security discovery uses the upstream suggestion response without local security tables", async () => {
  const db = new FakeD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /searchadapter\.eastmoney\.com\/api\/suggest\/get/);
    return new Response(JSON.stringify(eastmoneySuggestResponse()), { status: 200 });
  };
  try {
    const results = await searchSecurities(db, "平安");
    assert.deepEqual(results.map((item) => item.code), ["000001.SZ", "NVDA.US"]);
    assert.equal((await getSecurity(db, "000001.SZ"))?.name, "平安银行");
    assert.ok(db.statements.every((sql) => !/\bsecurities\b|security_search_prefixes/i.test(sql)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
