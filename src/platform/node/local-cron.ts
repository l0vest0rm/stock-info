import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Cron } from "croner";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { dispatchScheduledTask } from "../../app/scheduled";
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
  return { expressions, stop() { for (const job of jobs) job.stop(); } };
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
