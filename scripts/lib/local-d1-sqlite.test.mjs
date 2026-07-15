import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeLocalD1SqlFile, resolveLocalD1Database } from "./local-d1-sqlite.mjs";

test("local D1 executor commits a SQL file as one transaction", () => {
  const fixture = createFixture();
  try {
    const sqlFile = join(fixture.dir, "import.sql");
    writeFileSync(sqlFile, "insert into knowledge_docs values ('one');\ninsert into knowledge_docs values ('two');\n");

    executeLocalD1SqlFile(sqlFile, { root: fixture.dir, requiredTable: "knowledge_docs" });

    assert.equal(query(fixture.database, "select count(*) from knowledge_docs;"), "2");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local D1 executor rolls back the whole SQL file on failure", () => {
  const fixture = createFixture();
  try {
    const sqlFile = join(fixture.dir, "broken.sql");
    writeFileSync(sqlFile, "insert into knowledge_docs values ('one');\ninsert into missing_table values ('broken');\n");

    assert.throws(
      () => executeLocalD1SqlFile(sqlFile, { root: fixture.dir, requiredTable: "knowledge_docs" }),
      /sqlite3/
    );
    assert.equal(query(fixture.database, "select count(*) from knowledge_docs;"), "0");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local D1 resolver fails visibly when more than one database matches", () => {
  const fixture = createFixture();
  try {
    const second = join(fixture.stateDir, "second.sqlite");
    execFileSync("sqlite3", [second, "create table knowledge_docs (id text primary key);"]);
    assert.throws(
      () => resolveLocalD1Database({ root: fixture.dir, requiredTable: "knowledge_docs" }),
      /found 2/
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-d1-test-"));
  const stateDir = join(dir, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  mkdirSync(stateDir, { recursive: true });
  const database = join(stateDir, "fixture.sqlite");
  execFileSync("sqlite3", [database, "create table knowledge_docs (id text primary key);"]);
  return { dir, stateDir, database };
}

function query(database, sql) {
  return execFileSync("sqlite3", ["-batch", database, sql], { encoding: "utf8" }).trim();
}
