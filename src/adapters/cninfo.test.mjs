import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchCninfoCompanyResearch,
  supportsCninfoCompanyResearch,
} from "./cninfo.ts";

function uncachedDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
}

test("limits company research to Shenzhen and queries CNINFO's relation tab", async () => {
  assert.equal(supportsCninfoCompanyResearch("300476.SZ"), true);
  assert.equal(supportsCninfoCompanyResearch("600000.SH"), false);
  assert.equal(supportsCninfoCompanyResearch("430047.BJ"), false);

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/new/information/topSearch/query")) {
      return new Response(JSON.stringify([{ code: "300476", orgId: "9900024582" }]));
    }
    if (String(url).includes("/new/hisAnnouncement/query")) {
      return new Response(JSON.stringify({
        announcements: [{
          announcementId: "1225523576",
          announcementTitle: "300476<b>胜宏科技</b>投资者关系管理信息20260828",
          announcementTime: 1787880610000,
          announcementTypeName: null,
          adjunctUrl: "finalpage/2026-08-28/1225523576.PDF",
        }],
      }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const notices = await fetchCninfoCompanyResearch(uncachedDb(), "300476.SZ", 1, 30);
    assert.deepEqual(notices, [{
      artCode: "1225523576",
      title: "300476胜宏科技投资者关系管理信息20260828",
      noticeDate: "2026-08-28",
      noticeType: "公司调研",
      pdfUrl: "https://static.cninfo.com.cn/finalpage/2026-08-28/1225523576.PDF",
    }]);
    assert.equal(requests.length, 2);
    const relation = new URLSearchParams(String(requests[1].init.body));
    assert.equal(relation.get("stock"), "300476,9900024582");
    assert.equal(relation.get("tabName"), "relation");
    assert.equal(relation.get("column"), "szse");
    assert.equal(relation.get("plate"), "sz");
    assert.equal(relation.get("category"), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
