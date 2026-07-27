#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";

const WEBREPORT_URL = "https://anonflow2.eastmoney.com/backend/api/webreport";
const QUOTE_REFERER = "https://quote.eastmoney.com/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const ST_NVI_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const args = new Set(process.argv.slice(2));
const writeDevVars = args.has("--write-dev-vars");
const writeWranglerVars = args.has("--write-wrangler-vars");
const jsonOutput = args.has("--json");

const stNvi = generateStNvi();
const report = await requestEastmoneyIdentity(stNvi);
if (report.returnCode !== "0" || !report.data?.nid) {
  throw new Error(
    `Eastmoney webreport rejected the generated identity: returnCode=${report.returnCode ?? "unknown"}`,
  );
}

const cookie = `nid18=${report.data.nid}; nid18_create_time=${Date.now()}`;
if (writeDevVars) {
  await updateDevVars(cookie);
}
if (writeWranglerVars) {
  await updateWranglerVars(cookie);
}
if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify({ cookie, names: ["nid18", "nid18_create_time"], issuedBy: WEBREPORT_URL, writtenToDevVars: writeDevVars, writtenToWranglerVars: writeWranglerVars })}\n`,
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

async function requestEastmoneyIdentity(stNvi) {
  const profile = {
    userAgent: USER_AGENT,
    osPlatform: "MacOS",
    osversion: "Mac OS X 10.15.7",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    screenResolution: "1470X956",
  };
  const response = await fetch(WEBREPORT_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json;charset=UTF-8",
      Cookie: `st_nvi=${stNvi}`,
      Origin: "https://quote.eastmoney.com",
      Referer: QUOTE_REFERER,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      osPlatform: profile.osPlatform,
      sourceType: "WEB",
      osversion: profile.osversion,
      language: profile.language,
      timezone: profile.timezone,
      webDeviceInfo: {
        screenResolution: profile.screenResolution,
        userAgent: profile.userAgent,
        canvasKey: fingerprintKey(profile, "canvas"),
        webglKey: fingerprintKey(profile, "webgl"),
        fontKey: fingerprintKey(profile, "font"),
        audioKey: fingerprintKey(profile, "audio"),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Eastmoney webreport failed: status=${response.status}`);
  }
  return response.json();
}

function generateStNvi() {
  const bytes = randomBytes(21);
  let value = "";
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value += ST_NVI_ALPHABET[bytes[index] & 63];
  }
  return `${value}${sha256(value).slice(0, 4)}`;
}

function fingerprintKey(profile, kind) {
  return sha256(JSON.stringify({ kind, ...profile })).slice(0, 32);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
