#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { createHash } from "node:crypto";
import { cookieHeaderFromCdp, validateXueqiuKlineCookie } from "./lib/xueqiu-cookie.mjs";

const XUEQIU_URL = "https://xueqiu.com/S/SH600519";
const XUEQIU_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const XUEQIU_PAGE_TIMEOUT_MS = 60_000;
const XUEQIU_SETTLE_DELAY_MS = 3_000;
const args = new Set(process.argv.slice(2));
const writeDevVars = args.has("--write-dev-vars");
const writeWranglerVars = args.has("--write-wrangler-vars");
const writeLocalCredentialStore = args.has("--write-local-credential-store");
const jsonOutput = args.has("--json");
const cdpUrl = process.env.XUEQIU_CDP_URL?.trim() || "http://127.0.0.1:9222";

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
    "--headless=new",
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
    await cdp.command("Page.navigate", { url: XUEQIU_URL });
    await waitForDocumentBody(cdp);
    await sleep(XUEQIU_SETTLE_DELAY_MS);
    const pageUrl = await cdp.evaluateString("location.href");
    const result = await cdp.command("Network.getCookies", { urls: [XUEQIU_URL, pageUrl] });
    return cookieHeaderFromCdp(Array.isArray(result.cookies) ? result.cookies : []);
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

  async evaluateString(expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    const value = result.result?.value;
    return typeof value === "string" ? value : "";
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

async function updateWranglerVars(cookie) {
  const path = join(process.cwd(), "wrangler.jsonc");
  const text = await readFile(path, "utf8");
  const edits = modify(text, ["vars", "XUEQIU_COOKIE"], cookie, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  await writeFile(path, applyEdits(text, edits));
}

async function updateLocalCredentialStore(cookie) {
  const path = resolve(process.env.LOCAL_XUEQIU_CREDENTIAL_STORE || "data/local/runtime/xueqiu-credential.json");
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ cookie, updatedAt: Date.now() })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return path;
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
  const session = await openCdpSession(cdpUrl);
  try {
    const cookie = await fetchXueqiuCookie(session.endpoint);
    if (!cookie) {
      throw new Error("CDP returned no Xueqiu cookies; sign in to Xueqiu or check the configured Chrome session");
    }
    const validation = await validateXueqiuKlineCookie(cookie);
    let localCredentialStore = null;
    if (writeDevVars) {
      await updateDevVars(cookie);
    }
    if (writeWranglerVars) {
      await updateWranglerVars(cookie);
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
        writtenToWranglerVars: writeWranglerVars,
        localCredentialStore,
      })}\n`);
    } else {
      process.stdout.write(
        `Xueqiu cookie validated against K-line (rows=${validation.rowCount}, fingerprint=${cookieFingerprint(cookie)}).${
          !writeDevVars && !writeWranglerVars && !writeLocalCredentialStore ? " Re-run with --write-local-credential-store for local Node, and/or --write-dev-vars / --write-wrangler-vars to stage configuration." : ""
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

await main();
