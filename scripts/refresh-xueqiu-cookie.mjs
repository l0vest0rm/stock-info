#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { XUEQIU_KLINE_URL, cookieHeaderFromCdp, validateXueqiuKlineCookie } from "./lib/xueqiu-cookie.mjs";

// The apex API response issues anonymous .xueqiu.com cookies even when this
// route itself returns 404. Visiting a stock page in fresh headless Chrome no
// longer reliably initializes these cookies.
const XUEQIU_URL = "https://xueqiu.com/v5/stock/chart/kline.json";
const XUEQIU_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const XUEQIU_PAGE_TIMEOUT_MS = 60_000;
const XUEQIU_COOKIE_POLL_INTERVAL_MS = 2_000;
const XUEQIU_VALIDATION_RETRY_MS = 10_000;
const args = new Set(process.argv.slice(2));
const writeDevVars = args.has("--write-dev-vars");
if (args.has("--write-wrangler-vars")) throw new Error("Versioned Cookie vars are retired. Use --write-local-credential-store, then npm run deploy to upload the Worker secret.");
const writeLocalCredentialStore = args.has("--write-local-credential-store");
const validateLocalCredentialStore = args.has("--validate-local-credential-store");
const jsonOutput = args.has("--json");
const cdpUrl = process.env.XUEQIU_CDP_URL?.trim() || "http://127.0.0.1:9222";
// Xueqiu currently gives a fresh headless profile only an anti-bot cookie;
// visible Chrome establishes the same anonymous session as an incognito tab.
const headless = process.env.XUEQIU_CHROME_HEADLESS === "1";

async function openCdpSession(endpoint) {
  if (await isCdpReady(endpoint)) {
    return { endpoint, close: async () => {} };
  }
  const profileDir = await mkdtemp(join(tmpdir(), "stock-info-xueqiu-cdp-"));
  const port = new URL(endpoint).port || "9222";
  const chromePath = process.env.XUEQIU_CHROME_PATH?.trim()
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    ...(headless ? ["--headless=new"] : []),
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--lang=${XUEQIU_ACCEPT_LANGUAGE}`,
    "--ignore-certificate-errors",
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
  ], { stdio: "ignore" });
  try {
    await waitForCdp(endpoint, child);
  } catch (error) {
    child.kill();
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
  return {
    endpoint,
    close: async () => {
      child.kill();
      await waitForChildExit(child);
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function isCdpReady(endpoint) {
  try {
    const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(endpoint, child) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isCdpReady(endpoint)) return;
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became ready: exit=${child.exitCode}`);
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for Chrome CDP at ${endpoint}`);
}

async function fetchXueqiuCookie(endpoint) {
  const targetResponse = await fetch(new URL("/json/new?about:blank", endpoint), { method: "PUT" });
  if (!targetResponse.ok) {
    throw new Error(`CDP could not create Xueqiu target: status=${targetResponse.status}`);
  }
  const target = await targetResponse.json();
  const webSocketDebuggerUrl = typeof target.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : "";
  if (!webSocketDebuggerUrl) {
    throw new Error("CDP target did not provide a debugger WebSocket URL");
  }
  const cdp = new CdpConnection(webSocketDebuggerUrl);
  try {
    await cdp.command("Network.enable", {});
    await cdp.command("Page.enable", {});
    await cdp.command("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
    await cdp.command("Network.setExtraHTTPHeaders", {
      headers: { "Accept-Language": XUEQIU_ACCEPT_LANGUAGE },
    });
    const navigation = await cdp.command("Page.navigate", { url: XUEQIU_URL });
    if (navigation.errorText) throw new Error(`CDP Xueqiu navigation failed: ${navigation.errorText}`);
    await waitForDocumentBody(cdp);
    const deadline = Date.now() + XUEQIU_PAGE_TIMEOUT_MS;
    let cookie = "";
    let lastValidatedCookie = "";
    let lastValidationAt = 0;
    let lastValidationError = "no API-scoped Xueqiu cookies";
    while (Date.now() < deadline) {
      // Request cookies for the API origin, not the page origin: host-only
      // www.xueqiu.com cookies must not be sent to stock.xueqiu.com.
      const result = await cdp.command("Network.getCookies", { urls: [XUEQIU_KLINE_URL] });
      cookie = cookieHeaderFromCdp(Array.isArray(result.cookies) ? result.cookies : []);
      if (cookie && (cookie !== lastValidatedCookie || Date.now() - lastValidationAt >= XUEQIU_VALIDATION_RETRY_MS)) {
        lastValidatedCookie = cookie;
        lastValidationAt = Date.now();
        try {
          const validation = await validateXueqiuKlineCookie(cookie);
          return { cookie, validation };
        } catch (error) {
          lastValidationError = error instanceof Error ? error.message : String(error);
        }
      }
      await sleep(XUEQIU_COOKIE_POLL_INTERVAL_MS);
    }
    const names = new Set(cookie.split(/;\s*/).map((part) => part.split("=", 1)[0]));
    const expected = ["xq_a_token", "xq_r_token", "device_id"];
    const pageCookies = await cdp.command("Network.getCookies", { urls: [XUEQIU_URL] });
    const pageCookieNames = [...new Set((pageCookies.cookies ?? []).map((item) => item.name))].sort();
    throw new Error(`CDP Xueqiu anonymous K-line session was not usable within 60 seconds (${expected.map((name) => `${name}=${names.has(name) ? "present" : "missing"}`).join(", ")}; page_cookie_names=${pageCookieNames.join(",") || "none"}): ${lastValidationError}`);
  } finally {
    cdp.close();
    if (typeof target.id === "string") {
      await fetch(new URL(`/json/close/${target.id}`, endpoint)).catch(() => undefined);
    }
  }
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message ?? "unknown error"}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  async command(method, params) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForDocumentBody(cdp) {
  const deadline = Date.now() + XUEQIU_PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await cdp.command("Runtime.evaluate", {
      expression: "Boolean(document.body)",
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await sleep(200);
  }
  throw new Error("timed out waiting for Xueqiu document body");
}

async function updateDevVars(cookie) {
  const path = join(process.cwd(), ".dev.vars");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = putDevVar(text, "XUEQIU_COOKIE", cookie);
  await writeFile(path, next);
}

function putDevVar(text, key, value) {
  const line = `${key}=${JSON.stringify(value)}`;
  return new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}

async function updateLocalCredentialStore(cookie) {
  const path = localCredentialStorePath();
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ cookie, updatedAt: Date.now() })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return path;
}

function localCredentialStorePath() {
  return resolve(process.env.LOCAL_XUEQIU_CREDENTIAL_STORE || "data/local/runtime/xueqiu-credential.json");
}

/**
 * Validate the persisted local Node credential without opening or connecting to
 * Chrome. The returned value deliberately contains only the fingerprint, never
 * the credential itself, so it is safe to use as CLI JSON output.
 */
export async function validateLocalXueqiuCredentialStore({
  credentialStorePath = localCredentialStorePath(),
  validateCookie = validateXueqiuKlineCookie,
} = {}) {
  let text;
  try {
    text = await readFile(credentialStorePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`local Xueqiu credential store does not exist: ${credentialStorePath}`);
    }
    throw error;
  }

  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    throw new Error(`local Xueqiu credential store contains invalid JSON: ${credentialStorePath}`);
  }
  const cookie = typeof stored?.cookie === "string" ? stored.cookie.trim() : "";
  if (!cookie) {
    throw new Error(`local Xueqiu credential store has no usable cookie: ${credentialStorePath}`);
  }

  const validation = await validateCookie(cookie);
  return {
    source: "local-credential-store",
    cookieFingerprint: cookieFingerprint(cookie),
    validation: { endpoint: "xueqiu-kline", rowCount: validation.rowCount },
    writtenToDevVars: false,
    writtenToWranglerVars: false,
    localCredentialStore: credentialStorePath,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main() {
  if (validateLocalCredentialStore) {
    if (writeDevVars || writeLocalCredentialStore) {
      throw new Error("--validate-local-credential-store cannot be combined with credential write options");
    }
    const result = await validateLocalXueqiuCredentialStore();
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        `Local Xueqiu credential store validated against K-line (rows=${result.validation.rowCount}, fingerprint=${result.cookieFingerprint}).\n`,
      );
    }
    return;
  }
  const session = await openCdpSession(cdpUrl);
  try {
    const { cookie, validation } = await fetchXueqiuCookie(session.endpoint);
    let localCredentialStore = null;
    if (writeDevVars) {
      await updateDevVars(cookie);
    }
    if (writeLocalCredentialStore) {
      localCredentialStore = await updateLocalCredentialStore(cookie);
    }
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({
        source: "cdp",
        cookieFingerprint: cookieFingerprint(cookie),
        validation: { endpoint: "xueqiu-kline", rowCount: validation.rowCount },
        writtenToDevVars: writeDevVars,
        writtenToWranglerVars: false,
        localCredentialStore,
      })}\n`);
    } else {
      process.stdout.write(
        `Xueqiu cookie validated against K-line (rows=${validation.rowCount}, fingerprint=${cookieFingerprint(cookie)}).${
          !writeDevVars && !writeLocalCredentialStore ? " Re-run with --write-local-credential-store for local Node, and/or --write-dev-vars; npm run deploy uploads the production secret." : ""
        }\n`,
      );
    }
  } finally {
    await session.close();
  }
}

function cookieFingerprint(cookie) {
  return createHash("sha256").update(cookie).digest("hex").slice(0, 16);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
