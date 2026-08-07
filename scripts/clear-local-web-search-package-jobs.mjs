#!/usr/bin/env node

import { executeLocalD1Sql } from "./lib/local-d1-sqlite.mjs";

const now = Date.now();
const databaseFile = executeLocalD1Sql(`
  update research_web_search_package_jobs
  set status='failed',
      last_error='local Worker restarted before this Web Search task finished; retry the package',
      completed_at=${now},
      updated_at=${now}
  where status in ('queued', 'running');
`, { requiredTable: "research_web_search_package_jobs" });

console.log(`Cleared unfinished local Web Search jobs: ${databaseFile}`);
