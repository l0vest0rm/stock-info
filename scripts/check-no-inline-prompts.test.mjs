import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const gate = join(root, "scripts/check-no-inline-prompts.mjs");

test("inline prompt gate rejects a controlled source-code violation", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-inline-prompt-gate-"));
  try {
    writeFileSync(join(fixture, "violation.mjs"), "const instructions = '你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。';\n");
    assert.throws(
      () => execFileSync(process.execPath, [gate, "--root", fixture], { encoding: "utf8", stdio: "pipe" }),
      (error) => {
        assert.match(String(error.stderr || ""), /Inline prompt literals are forbidden/);
        return true;
      }
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("inline prompt gate allows prompt markdown sources and generated prompt code", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-inline-prompt-allow-"));
  try {
    mkdirSync(join(fixture, "prompts", "research"), { recursive: true });
    mkdirSync(join(fixture, "src", "generated"), { recursive: true });
    mkdirSync(join(fixture, "scripts", "generated"), { recursive: true });
    writeFileSync(join(fixture, "prompts", "research", "system.md"), "你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。\n");
    writeFileSync(join(fixture, "src", "generated", "prompt-text.ts"), "export const PROMPT = '你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。';\n");
    writeFileSync(join(fixture, "scripts", "generated", "prompt-text.mjs"), "export const PROMPT = '你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。';\n");
    writeFileSync(join(fixture, "reader.mjs"), "export const promptPath = 'prompts/research/system.md';\n");
    execFileSync(process.execPath, [gate, "--root", fixture], { encoding: "utf8", stdio: "pipe" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("inline prompt gate allows ordinary source strings", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-inline-prompt-normal-"));
  try {
    writeFileSync(join(fixture, "normal.mjs"), "export const label = '研究工具';\nexport const url = 'https://example.test';\n");
    execFileSync(process.execPath, [gate, "--root", fixture], { encoding: "utf8", stdio: "pipe" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("inline prompt gate ignores comments that mention prompt markers", () => {
  const fixture = mkdtempSync(join(tmpdir(), "stock-info-inline-prompt-comments-"));
  try {
    writeFileSync(join(fixture, "comment-only.mjs"), "// 你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。\nexport const ok = true;\n");
    execFileSync(process.execPath, [gate, "--root", fixture], { encoding: "utf8", stdio: "pipe" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
