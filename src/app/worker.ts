import { createRouter } from "./router";
import { dispatchScheduledTask } from "./scheduled";
import type { Bindings } from "../types";

const app = createRouter();

export default {
  fetch: app.fetch,
  scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchScheduledTask(event, env));
  },
};
