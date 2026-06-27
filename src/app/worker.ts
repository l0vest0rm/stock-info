import { createRouter } from "./router";
import { runScheduled } from "./scheduled";

const app = createRouter();

export default {
  fetch: app.fetch,
  scheduled: runScheduled,
};
