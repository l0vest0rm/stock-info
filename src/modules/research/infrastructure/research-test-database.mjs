import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** Real SQLite exercises JSON predicates and atomic compare-and-swap writes. */
export class ResearchTestDatabase {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(readFileSync("migrations/0117_create_kv_cache.sql", "utf8"));
  }
  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    return { bind: (...args) => ({
      first: async () => statement.get(...args) ?? null,
      all: async () => ({ results: statement.all(...args), success: true }),
      run: async () => ({ success: true, meta: { changes: Number(statement.run(...args).changes) } }),
    }) };
  }
}
