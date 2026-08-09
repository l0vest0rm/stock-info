import assert from "node:assert/strict";
import test from "node:test";
import {
  cookieHeaderFromCdp,
  createXueqiuKlineValidationRequest,
  validateXueqiuKlineCookie,
} from "./xueqiu-cookie.mjs";

test("keeps only usable Xueqiu CDP cookies", () => {
  assert.equal(
    cookieHeaderFromCdp([
      { name: "z", value: "last", domain: ".xueqiu.com" },
      { name: "xq_a_token", value: "token", domain: "xueqiu.com" },
      { name: "foreign", value: "skip", domain: "example.com" },
      { name: "", value: "skip", domain: "xueqiu.com" },
    ]),
    "xq_a_token=token; z=last",
  );
});

test("validates a candidate cookie with the Worker K-line request profile", async () => {
  let observed;
  const result = await validateXueqiuKlineCookie("xq_a_token=token", {
    now: new Date("2026-08-09T00:00:00.000Z"),
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ data: { item: [[1, 2, 3]] } }), { status: 200 });
    },
  });
  const request = createXueqiuKlineValidationRequest("xq_a_token=token", new Date("2026-08-09T00:00:00.000Z"));
  assert.equal(observed.url, request.url);
  assert.equal(observed.init.headers.Cookie, "xq_a_token=token");
  assert.equal(observed.init.headers.Referer, "https://xueqiu.com/");
  assert.equal(result.rowCount, 1);
});

test("rejects a candidate cookie when Xueqiu returns its authentication error", async () => {
  await assert.rejects(
    () => validateXueqiuKlineCookie("xq_a_token=token", {
      fetchImpl: async () => new Response(JSON.stringify({
        error_code: "400016",
        error_description: "请刷新页面或者重新登录帐号后再试",
      }), { status: 200 }),
    }),
    /Xueqiu cookie validation rejected/,
  );
});
