import assert from "node:assert/strict";
import test from "node:test";
import { cookieHeaderFromCdp } from "./xueqiu-cookie.mjs";

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
