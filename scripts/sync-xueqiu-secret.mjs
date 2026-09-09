#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { validateXueqiuKlineCookie } from "./lib/xueqiu-cookie.mjs";

// Invoked explicitly during a live release, never by a local scheduler.
const file = resolve(process.env.LOCAL_XUEQIU_CREDENTIAL_STORE || "data/local/runtime/xueqiu-credential.json");
const credential = JSON.parse(await readFile(file, "utf8"));
if (typeof credential.cookie !== "string" || !credential.cookie.trim()) throw new Error("Local Xueqiu credential is missing. Run npm run refresh:xueqiu-cookie first.");
await validateXueqiuKlineCookie(credential.cookie);
await new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "put", "XUEQIU_COOKIE", "--name", process.env.CF_WORKER_NAME || "stock-info"], { stdio: ["pipe", "inherit", "inherit"] });
  child.on("error", reject);
  child.stdin.on("error", reject);
  child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`Worker secret upload failed: ${code}`)));
  child.stdin.end(credential.cookie + "\n");
});
console.log("Validated Xueqiu credential uploaded as a Worker secret.");
