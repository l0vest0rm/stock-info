import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const gate = join(root, "scripts/check-no-new-tables.mjs");

test("approved authentication migration introduces only the two approved account tables", () => {
  const sql = readFileSync(join(root, "migrations/0139_auth_accounts.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables, ["auth_sessions", "users"]);
  const approved = JSON.parse(readFileSync(join(root, "scripts/check-no-new-tables-allowlist.json"), "utf8"));
  for (const table of tables) assert.ok(approved.includes(table));
  assert.match(sql, /reset_token_hash TEXT/);
  assert.match(sql, /reset_expires_at_ms INTEGER/);
});

test("new-table gate rejects a migration that creates an unapproved table", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-new-table-gate-"));
  try {
    mkdirSync(join(fixture, "migrations"), { recursive: true });
    writeFileSync(join(fixture, "allowlist.json"), JSON.stringify(["existing_table"], null, 2));
    writeFileSync(
      join(fixture, "migrations", "0001_add_table.sql"),
      "create table if not exists unexpected_table (\n  id text primary key\n);\n"
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [gate, "--root", fixture, "--allowlist", "allowlist.json"], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      (error) => {
        assert.match(String(error.stderr || ""), /New database tables require explicit user approval first/);
        assert.match(String(error.stderr || ""), /unexpected_table/);
        return true;
      }
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("new-table gate allows migrations that only touch approved tables", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-approved-table-gate-"));
  try {
    mkdirSync(join(fixture, "migrations"), { recursive: true });
    writeFileSync(join(fixture, "allowlist.json"), JSON.stringify(["approved_table"], null, 2));
    writeFileSync(
      join(fixture, "migrations", "0001_update_table.sql"),
      "create table if not exists approved_table (\n  id text primary key\n);\n"
    );
    execFileSync(process.execPath, [gate, "--root", fixture, "--allowlist", "allowlist.json"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
