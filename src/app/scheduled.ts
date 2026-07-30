import { syncProvisionalFinancialStatements } from "../modules/finance/application/sync-provisional-financial-statements";
import { syncMacroData } from "../modules/macro/application/sync-macro-data";
import type { Bindings } from "../types";

export const FINANCIAL_SYNC_CRON = "*/15 * * * *";
export const MACRO_SYNC_CRON = "17 * * * *";

export async function dispatchScheduledTask(event: ScheduledEvent, env: Bindings): Promise<void> {
  if (event.cron === FINANCIAL_SYNC_CRON) {
    await syncProvisionalFinancialStatements(env, event.scheduledTime);
    return;
  }
  if (event.cron === MACRO_SYNC_CRON) {
    await syncMacroData(env, event.scheduledTime);
    return;
  }
  throw new Error(`unsupported scheduled cron: ${event.cron}`);
}
