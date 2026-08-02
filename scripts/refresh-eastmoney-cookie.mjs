#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { cookiePairFromSetCookie, mergeEastmoneyCookies } from "./lib/eastmoney-cookie.mjs";

const QUOTE_URL = "https://quote.eastmoney.com/sz300308.html";
const QUOTE_REFERER = "https://quote.eastmoney.com/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const args = new Set(process.argv.slice(2));
const writeDevVars = args.has("--write-dev-vars");
const writeWranglerVars = args.has("--write-wrangler-vars");
const jsonOutput = args.has("--json");

const existingCookie = await readExistingEastmoneyCookie();
if (!existingCookie) {
  throw new Error("EASTMONEY_COOKIE is required before refreshing the Eastmoney browser session");
}
const setCookies = await requestEastmoneyCookieRefresh(existingCookie);
const refreshedPairs = setCookies.map(cookiePairFromSetCookie).filter(Boolean);
const cookie = mergeEastmoneyCookies(existingCookie, refreshedPairs.join("; "));
if (writeDevVars) {
  await updateDevVars(cookie);
}
if (writeWranglerVars) {
  await updateWranglerVars(cookie);
}
if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify({ cookie, names: refreshedPairs.map((value) => value.split("=", 1)[0]), issuedBy: QUOTE_URL, writtenToDevVars: writeDevVars, writtenToWranglerVars: writeWranglerVars })}\n`,
  );
} else if (!writeDevVars && !writeWranglerVars) {
  process.stdout.write(`EASTMONEY_COOKIE=${JSON.stringify(cookie)}\n`);
} else {
  const targets = [
    writeDevVars ? ".dev.vars" : "",
    writeWranglerVars ? "wrangler.jsonc" : "",
  ].filter(Boolean);
  process.stderr.write(`Updated ${targets.join(" and ")}\n`);
}

async function requestEastmoneyCookieRefresh(existingCookie) {
  const response = await fetch(QUOTE_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Cookie: existingCookie,
      Referer: QUOTE_REFERER,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Eastmoney quote page failed: status=${response.status}`);
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error("Eastmoney quote page returned no Set-Cookie; keeping the existing browser session");
  }
  return setCookies;
}

async function readExistingEastmoneyCookie() {
  const devVarsCookie = await readDevVarsCookie();
  if (devVarsCookie) return devVarsCookie;

  const wranglerText = await readFile(join(process.cwd(), "wrangler.jsonc"), "utf8");
  const wrangler = parse(wranglerText);
  return typeof wrangler.vars?.EASTMONEY_COOKIE === "string" ? wrangler.vars.EASTMONEY_COOKIE : "";
}

async function readDevVarsCookie() {
  try {
    const text = await readFile(join(process.cwd(), ".dev.vars"), "utf8");
    const value = text.match(/^EASTMONEY_COOKIE=(.*)$/m)?.[1]?.trim();
    if (!value) return "";
    return value.startsWith('"') ? JSON.parse(value) : value;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function updateDevVars(cookie) {
  const path = join(process.cwd(), ".dev.vars");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const line = `EASTMONEY_COOKIE=${JSON.stringify(cookie)}`;
  const next = /^EASTMONEY_COOKIE=.*$/m.test(text)
    ? text.replace(/^EASTMONEY_COOKIE=.*$/m, line)
    : `${text.trimEnd()}${text.trim() ? "\n" : ""}${line}\n`;
  await writeFile(path, next, { mode: 0o600 });
}

async function updateWranglerVars(cookie) {
  const path = join(process.cwd(), "wrangler.jsonc");
  const text = await readFile(path, "utf8");
  const edits = modify(text, ["vars", "EASTMONEY_COOKIE"], cookie, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  await writeFile(path, applyEdits(text, edits));
}
