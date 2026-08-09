import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const gate = join(root, "scripts/check-no-wrangler-local.mjs");

test("Wrangler local gate rejects a controlled executable violation", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-wrangler-local-gate-"));
  try {
    writeFileSync(join(fixture, "violation.mjs"), "execFileSync('wrangler', ['d1', 'execute', 'stock_info', '--local']);\n");
    assert.throws(
      () => execFileSync(process.execPath, [gate, "--root", fixture], { encoding: "utf8", stdio: "pipe" }),
      (error) => {
        assert.match(String(error.stderr || ""), /Wrangler --local is forbidden/);
        return true;
      }
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Wrangler local gate allows an explicit remote command", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-wrangler-remote-gate-"));
  try {
    writeFileSync(join(fixture, "remote.mjs"), "execFileSync('wrangler', ['d1', 'execute', 'stock_info', '--remote']);\n");
    execFileSync(process.execPath, [gate, "--root", fixture], { encoding: "utf8", stdio: "pipe" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
