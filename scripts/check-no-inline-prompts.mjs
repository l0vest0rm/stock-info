#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const hardMarkers = [
  "你是严谨的投资研究员",
  "只使用本阶段允许的证据",
  "不以模型记忆填补缺口",
  "不得使用模型记忆",
  "<input_data>",
  "{{INPUT_DATA}}",
];

const softMarkers = [
  "只输出 JSON",
  "严格按输出",
  "只根据给定证据",
  "不得使用外部知识",
  "Only use",
  "Do not use model memory",
  "Return only",
];

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/check-no-inline-prompts.mjs [--root PATH]\n\nRejects prompt-like string literals embedded directly in source code. Markdown prompt sources under prompts/** and generated prompt-text files are allowed.");
  process.exit(0);
}

const scanRoot = resolve(root, args.root || ".");
const files = sourceFiles(scanRoot);
const violations = files.flatMap((file) => findViolations(file, scanRoot));
if (violations.length > 0) {
  console.error("Inline prompt literals are forbidden in source code. Move prompt content into prompts/**/*.md or another non-code prompt source:");
  for (const violation of violations) console.error(`- ${violation.file}:${violation.line}: ${violation.text}`);
  process.exitCode = 1;
} else {
  console.log(`No inline prompt literal found in ${files.length} source files.`);
}

function parseArgs(argv) {
  const parsed = { root: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") parsed.root = requiredValue(argv, ++index, arg);
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function sourceFiles(scanRoot) {
  const include = new Set([".mjs", ".cjs", ".js", ".ts", ".tsx", ".mts", ".cts"]);
  const excludedDirectories = new Set([".git", ".wrangler", "node_modules", "dist", "coverage", "data", "docs", "prompts", "tmp"]);
  const excludedFiles = new Set([
    "scripts/check-no-inline-prompts.mjs",
    "scripts/generated/prompt-text.mjs",
    "src/generated/prompt-text.ts",
  ]);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      const relativeFile = relative(scanRoot, file) || file;
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || relativeFile === "web/dist") continue;
        visit(file);
        continue;
      }
      if (!entry.isFile() || entry.name.includes(".test.")) continue;
      if (!include.has(extension(entry.name))) continue;
      if (excludedFiles.has(relativeFile)) continue;
      files.push(file);
    }
  };
  visit(scanRoot);
  return files.sort();
}

function findViolations(file, scanRoot) {
  const source = readFileSync(file, "utf8");
  if (!containsPromptMarker(source)) return [];
  const violations = [];
  for (const match of extractStringLiterals(source)) {
    const content = match.content;
    if (!isPromptLikeLiteral(content)) continue;
    violations.push({
      file: relative(scanRoot, file) || file,
      line: match.line,
      text: preview(content),
    });
  }
  return violations;
}

function containsPromptMarker(source) {
  return [...hardMarkers, ...softMarkers].some((marker) => source.includes(marker));
}

function isPromptLikeLiteral(content) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length < 40) return false;
  if (/\.(?:md|markdown|txt|json)$/i.test(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) return false;
  const hardCount = hardMarkers.filter((marker) => normalized.includes(marker)).length;
  const softCount = softMarkers.filter((marker) => normalized.includes(marker)).length;
  return hardCount >= 2 || (hardCount >= 1 && (softCount >= 1 || normalized.length >= 80));
}

function extractStringLiterals(source) {
  const literals = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length) {
        if (source[index] === "\n") line += 1;
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      const parsed = readQuotedLiteral(source, index, line, char);
      literals.push({ content: parsed.content, line });
      index = parsed.index;
      line = parsed.line;
      continue;
    }

    if (char === "`") {
      const parsed = readTemplateLiteral(source, index, line);
      literals.push({ content: parsed.content, line });
      index = parsed.index;
      line = parsed.line;
      continue;
    }

    index += 1;
  }

  return literals;
}

function readQuotedLiteral(source, start, startLine, quote) {
  let index = start + 1;
  let line = startLine;
  let content = "";

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1] ?? "";
      content += char + next;
      if (next === "\n") line += 1;
      index += 2;
      continue;
    }
    if (char === quote) return { content, index: index + 1, line };
    if (char === "\n") line += 1;
    content += char;
    index += 1;
  }

  return { content, index, line };
}

function readTemplateLiteral(source, start, startLine) {
  let index = start + 1;
  let line = startLine;
  let content = "";

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1] ?? "";
      content += char + next;
      if (next === "\n") line += 1;
      index += 2;
      continue;
    }
    if (char === "`") return { content, index: index + 1, line };
    if (char === "$" && source[index + 1] === "{") {
      const parsed = skipTemplateExpression(source, index + 2, line);
      content += "${...}";
      index = parsed.index;
      line = parsed.line;
      continue;
    }
    if (char === "\n") line += 1;
    content += char;
    index += 1;
  }

  return { content, index, line };
}

function skipTemplateExpression(source, start, startLine) {
  let index = start;
  let line = startLine;
  let depth = 1;

  while (index < source.length && depth > 0) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length) {
        if (source[index] === "\n") line += 1;
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      const parsed = readQuotedLiteral(source, index, line, char);
      index = parsed.index;
      line = parsed.line;
      continue;
    }

    if (char === "`") {
      const parsed = readTemplateLiteral(source, index, line);
      index = parsed.index;
      line = parsed.line;
      continue;
    }

    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    index += 1;
  }

  return { index, line };
}

function preview(content) {
  return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

function extension(name) {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}
