#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const DEFAULT_MODEL = "gpt-5.6-luna";
export const DEFAULT_REASONING_EFFORT = "max";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const SUPPORTED_MODELS = new Set(["gpt-5.4-mini", "gpt-5.6-luna"]);
const SUPPORTED_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    baseUrl: String(process.env.STOCK_INFO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.slice(2).split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const key = name === "reasoningDepth" || name === "reasoning" ? "reasoningEffort" : name;
    if (!["model", "reasoningEffort", "baseUrl"].includes(key)) throw new Error(`unknown argument: --${rawName}`);
    const next = inlineValue ?? argv[++index];
    if (!next || next.startsWith("--")) throw new Error(`--${rawName} requires a value`);
    options[key] = next.trim();
  }
  if (positional.length !== 1 || !positional[0].trim()) throw new Error("usage: research:investment-analysis <stock-code> [--model MODEL] [--reasoning-effort DEPTH]");
  options.code = positional[0].trim().toUpperCase();
  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!options.baseUrl) throw new Error("--base-url must not be empty");
  if (!SUPPORTED_MODELS.has(options.model)) throw new Error(`unsupported model: ${options.model}`);
  if (!SUPPORTED_REASONING_EFFORTS.has(options.reasoningEffort)) throw new Error(`unsupported reasoning effort: ${options.reasoningEffort}`);
  return options;
}

export async function enqueueInvestmentAnalysis({ code, model = DEFAULT_MODEL, reasoningEffort = DEFAULT_REASONING_EFFORT, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/api/research/company/${encodeURIComponent(code)}/operating-analysis/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true, model, reasoningEffort }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || `HTTP ${response.status}`);
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return {
    queued: data.shouldStart === true,
    code,
    model,
    reasoningEffort,
    status: data.job?.status || (data.shouldStart === false ? "completed" : "queued"),
    jobId: data.job?.jobId || null,
    deduplicated: data.deduplicated === true,
  };
}

export function printHelp() {
  console.log(`Usage: npm run research:investment-analysis -- <stock-code> [options]

Options:
  --model MODEL                 Model for all staged calls (default: ${DEFAULT_MODEL})
  --reasoning-effort DEPTH     Reasoning depth (default: ${DEFAULT_REASONING_EFFORT})
  --reasoning-depth DEPTH      Alias for --reasoning-effort
  --base-url URL               Local stock-info URL (default: ${DEFAULT_BASE_URL})
  -h, --help                  Show this help

The command only enqueues the page/API job and exits; it does not wait for the
runner or report generation to finish.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  console.log(JSON.stringify(await enqueueInvestmentAnalysis(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
