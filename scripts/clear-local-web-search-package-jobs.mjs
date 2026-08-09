#!/usr/bin/env node

import { executeLocalD1Sql } from "./lib/local-d1-sqlite.mjs";

const now = Date.now();
const databaseFile = executeLocalD1Sql(`
  update research_web_search_package_jobs
  set status='queued',
      lease_owner=null,
      lease_until=null,
      last_error='local runner lease expired; retrying with a new attempt',
      updated_at=${now}
  where status='running' and lease_until<${now};
`, { requiredTable: "research_web_search_package_jobs" });

console.log(`Requeued only expired local Web Search leases: ${databaseFile}`);
