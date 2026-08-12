import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { executeLocalD1SqlFile, queryExistingLocalD1Sql, resolveExistingLocalD1Database, resolveLocalD1Database } from "./local-d1-sqlite.mjs";

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

test("local D1 resolver uses the explicit Node local database path", () => {
  const fixture = createFixture();
  try {
    const second = join(fixture.dir, "legacy-state/second.sqlite");
    mkdirSync(dirname(second), { recursive: true });
    execFileSync("sqlite3", [second, "create table knowledge_docs (id text primary key);"]);
    assert.equal(resolveLocalD1Database({ root: fixture.dir, requiredTable: "knowledge_docs" }), fixture.database);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local SQLite resolver honors an absolute LOCAL_DB_PATH override", () => {
  const fixture = createFixture();
  try {
    const override = join(fixture.dir, "override.sqlite");
    execFileSync("sqlite3", [override, "create table knowledge_docs (id text primary key);"]);
    assert.equal(
      resolveLocalD1Database({ root: fixture.dir, env: { LOCAL_DB_PATH: override }, requiredTable: "knowledge_docs" }),
      override
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local SQLite resolver reports a configured database that does not exist", () => {
  const fixture = createFixture();
  try {
    const missing = join(fixture.dir, "missing.sqlite");
    assert.throws(
      () => resolveLocalD1Database({ root: fixture.dir, env: { LOCAL_DB_PATH: missing }, requiredTable: "knowledge_docs" }),
      new RegExp(`does not exist: ${escapeRegExp(missing)}`)
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local SQLite resolver reports a required table that is missing", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => resolveLocalD1Database({ root: fixture.dir, requiredTable: "knowledge_filtered_docs" }),
      new RegExp(`missing table knowledge_filtered_docs: ${escapeRegExp(fixture.database)}`)
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local SQLite resolver can open an existing database without a sentinel table", () => {
  const fixture = createFixture();
  try {
    assert.equal(resolveExistingLocalD1Database({ root: fixture.dir }), fixture.database);
    assert.deepEqual(queryExistingLocalD1Sql("select name from sqlite_master where type='table' order by name;", { root: fixture.dir }), [
      { name: "knowledge_docs" },
    ]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-d1-test-"));
  const stateDir = join(dir, "data/local");
  mkdirSync(stateDir, { recursive: true });
  const database = join(stateDir, "stock-info.sqlite");
  execFileSync("sqlite3", [database, "create table knowledge_docs (id text primary key);"]);
  return { dir, stateDir, database };
}

function query(database, sql) {
  return execFileSync("sqlite3", ["-batch", database, sql], { encoding: "utf8" }).trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
