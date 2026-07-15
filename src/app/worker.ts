import { createRouter } from "./router";
import { syncProvisionalFinancialStatements } from "../modules/finance/application/sync-provisional-financial-statements";
import type { Bindings } from "../types";

const app = createRouter();

export default {
  fetch: app.fetch,
  scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(syncProvisionalFinancialStatements(env, event.scheduledTime));
  },
};
