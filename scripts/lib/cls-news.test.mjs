import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClsRollListUrl,
  clsRequestSign,
  fetchClsRollPage,
  mapClsTelegraphItem,
  stableKnowledgeDocId,
} from "./cls-news.mjs";

test("CLS request signing matches the live web client", () => {
  const params = {
    app: "CailianpressWeb",
    name: "telegraph",
    os: "web",
    sv: "8.7.9",
  };
  assert.equal(clsRequestSign(params), "6c73b056a64891cdc257dcf1914464ad");

  const url = buildClsRollListUrl({ lastTime: 1785563390, pageSize: 20 });
  assert.equal(url.pathname, "/v1/roll/get_roll_list");
  assert.equal(url.searchParams.get("sign"), clsRequestSign({
    app: "CailianpressWeb",
    last_time: "1785563390",
    os: "web",
    refresh_type: "1",
    rn: "20",
    sv: "8.7.9",
  }));
  assert.throws(() => buildClsRollListUrl({ lastTime: 1785563390, pageSize: 100 }), /between 1 and 50/);
});

test("CLS telegraph mapping preserves content, time, subjects and stocks", () => {
  const item = {
    id: 2443259,
    title: "上汽通用五菱7月全球销量120050辆",
    brief: "财联社8月1日电，上汽通用五菱公布7月销量。",
    content: "【上汽通用五菱7月全球销量120050辆】财联社8月1日电，7月新能源销量72695辆。",
    ctime: 1785561444,
    author: "财联社记者",
    level: "C",
    subjects: [{ subject_id: 1090, subject_name: "汽车大新闻" }],
    stock_list: [{ name: "上汽集团", StockID: "sh600104" }],
  };
  const doc = mapClsTelegraphItem(item, "2026-08-01T06:00:00.000Z");
  assert.equal(doc.docId, stableKnowledgeDocId("cls_telegraph|2443259"));
  assert.equal(doc.sourceType, "web_news");
  assert.equal(doc.sourceName, "财联社");
  assert.equal(doc.publishedAt, "2026-08-01T05:17:24.000Z");
  assert.equal(doc.url, "https://www.cls.cn/detail/2443259");
  assert.match(doc.markdown, /新能源销量72695辆/);
  assert.deepEqual(doc.tags, ["财联社电报", "汽车大新闻"]);
  assert.deepEqual(doc.metadata.stockNames, ["上汽集团"]);
  assert.deepEqual(doc.metadata.stockCodes, ["sh600104"]);
});

test("CLS fetch rejects a successful HTTP response with an unexpected schema", async () => {
  await assert.rejects(
    fetchClsRollPage({
      lastTime: 1785563390,
      pageSize: 20,
      fetchImpl: async () => new Response(JSON.stringify({ errno: 0, data: {} }), { status: 200 }),
    }),
    /unexpected payload/,
  );
});
