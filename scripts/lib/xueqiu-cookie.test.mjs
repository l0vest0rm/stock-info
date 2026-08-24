import assert from "node:assert/strict";
import test from "node:test";
import {
  cookieHeaderFromCdp,
  createXueqiuKlineValidationRequest,
  validateXueqiuKlineCookie,
} from "./xueqiu-cookie.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLocalXueqiuCredentialStore } from "../refresh-xueqiu-cookie.mjs";

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

test("validates the persisted local credential through the K-line validator without returning its cookie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-info-xueqiu-credential-test-"));
  const credentialStorePath = join(directory, "xueqiu-credential.json");
  const cookie = "xq_a_token=private-token";
  await writeFile(credentialStorePath, `${JSON.stringify({ cookie, updatedAt: 1 })}\n`, "utf8");

  let observedCookie;
  const result = await validateLocalXueqiuCredentialStore({
    credentialStorePath,
    validateCookie: async (value) => {
      observedCookie = value;
      return { rowCount: 7 };
    },
  });

  assert.equal(observedCookie, cookie);
  assert.deepEqual(result.validation, { endpoint: "xueqiu-kline", rowCount: 7 });
  assert.equal(result.source, "local-credential-store");
  assert.equal(result.localCredentialStore, credentialStorePath);
  assert.equal(JSON.stringify(result).includes(cookie), false);
  assert.equal(result.writtenToDevVars, false);
  assert.equal(result.writtenToWranglerVars, false);
});

test("rejects a local credential store that has no usable cookie before validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-info-xueqiu-credential-test-"));
  const credentialStorePath = join(directory, "xueqiu-credential.json");
  await writeFile(credentialStorePath, "{}\n", "utf8");

  await assert.rejects(
    () => validateLocalXueqiuCredentialStore({ credentialStorePath }),
    /local Xueqiu credential store has no usable cookie/,
  );
});
