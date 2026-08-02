import assert from "node:assert/strict";
import test from "node:test";
import { cookiePairFromSetCookie, mergeEastmoneyCookies } from "./eastmoney-cookie.mjs";

test("replaces Eastmoney identity cookies without discarding the browser session", () => {
  const refreshed = mergeEastmoneyCookies(
    "st_pvi=old-pvi; qgqp_b_id=old-qgqp; nid18=old-nid; nid18_create_time=1; st_sp=old-sp",
    "nid18=new-nid; nid18_create_time=2",
  );

  assert.equal(
    refreshed,
    "st_pvi=old-pvi; qgqp_b_id=old-qgqp; nid18=new-nid; nid18_create_time=2; st_sp=old-sp",
  );
});

test("uses only the cookie pair from a Set-Cookie response", () => {
  assert.equal(
    cookiePairFromSetCookie("nid18=new-nid; Path=/; HttpOnly; SameSite=None"),
    "nid18=new-nid",
  );
});
