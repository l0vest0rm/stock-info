import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Cron } from "croner";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { dispatchScheduledTask } from "../../app/scheduled";
import { reconcileMacroAnalysis } from "../../modules/macro/application/macro-analysis";
import { reconcileCompanyReportDiscoveries } from "../../modules/company/application/company-reports";
import { reconcileResearchResults } from "../../modules/research/application/reconcile-research-results";
import { createLocalBindings } from "./local-bindings";

const configPath = resolve(process.env.LOCAL_CRON_CONFIG || "wrangler.jsonc");
const once = process.argv.includes("--once");
const bindings = createLocalBindings();

export type LocalCronScheduler = {
  stop(): void;
  readonly expressions: string[];
};

export async function startLocalCronScheduler(options: { configPath?: string; runOnce?: boolean; onEvent?: (event: string, details: Record<string, unknown>) => void } = {}): Promise<LocalCronScheduler> {
  const schedulerConfigPath = options.configPath || configPath;
  const expressions = await loadCronExpressions(schedulerConfigPath);
  const event = options.onEvent || ((name, details) => console.log(`[local-cron ${new Date().toISOString()}] ${name} ${JSON.stringify(details)}`));
  if (options.runOnce ?? once) {
    await Promise.all(expressions.map(async (cron) => {
      const startedAt = Date.now();
      await dispatchScheduledTask({ cron, scheduledTime: startedAt } as ScheduledEvent, bindings);
      event("completed", { cron, duration_ms: Date.now() - startedAt });
    }));
    await reconcileTaskdReports(event);
    return { expressions, stop() {} };
  }
  const jobs = expressions.map((cron) => new Cron(cron, {
    timezone: "UTC",
    catch: (error) => event("failed", { cron, error: error instanceof Error ? error.message : String(error) }),
  }, () => {
    const startedAt = Date.now();
    void dispatchScheduledTask({ cron, scheduledTime: startedAt } as ScheduledEvent, bindings)
      .then(() => event("completed", { cron, duration_ms: Date.now() - startedAt }))
      .catch((error) => event("failed", { cron, duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }));
  }));
  for (const [index, job] of jobs.entries()) event("scheduled", { cron: expressions[index], timezone: "UTC", next: job.nextRun()?.toISOString() ?? null });
  // This local lifecycle, unlike Worker cron, may inspect taskd. It runs even
  // with no page open and never submits model work. Serialize polling ticks.
  let reconciling = false;
  let stopped = false;
  const reconcile = async () => {
    if (stopped || reconciling || bindings.LLM_RUNTIME !== "local") return;
    reconciling = true;
    try {
      await reconcileTaskdReports(event);
    } catch (error) {
      event("taskd-reconcile-failed", { error: String(error) });
    } finally { reconciling = false; }
  };
  const timer = setInterval(() => { void reconcile(); }, 15_000);
  timer.unref();
  void reconcile();
  return { expressions, stop() { stopped = true; clearInterval(timer); for (const job of jobs) job.stop(); } };
}

async function reconcileTaskdReports(event: (event: string, details: Record<string, unknown>) => void): Promise<void> {
  const [research, macro, reportDiscovery] = await Promise.all([
    reconcileResearchResults(bindings, (code, error) => event("research-reconcile-failed", { code, error: String(error) })),
    reconcileMacroAnalysis(bindings).catch((error) => {
      event("macro-reconcile-failed", { error: String(error) });
      return false;
    }),
    reconcileCompanyReportDiscoveries(bindings, (code, error) => event("company-report-discovery-reconcile-failed", { code, error: String(error) })),
  ]);
  if (research.inspected) event("research-reconciled", research);
  if (macro) event("macro-reconciled", { inspected: 1 });
  if (reportDiscovery.inspected) event("company-report-discovery-reconciled", reportDiscovery);
}

async function main(): Promise<void> {
  const scheduler = await startLocalCronScheduler();
  if (once) return;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { scheduler.stop(); process.exit(0); });
}

if (require.main === module) {
  void main().catch((error) => { console.error("local cron failed", error); process.exitCode = 1; });
}

async function loadCronExpressions(path: string): Promise<string[]> {
  const errors: ParseError[] = [];
  const config = parse(await readFile(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Invalid JSONC in ${path}: ${errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")}`);
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons) || !crons.every((cron) => typeof cron === "string" && cron.trim())) throw new Error(`No valid triggers.crons entries found in ${path}`);
  return [...new Set(crons.map((cron) => cron.trim()))];
}
