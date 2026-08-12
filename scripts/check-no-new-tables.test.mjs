import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const gate = join(root, "scripts/check-no-new-tables.mjs");

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
