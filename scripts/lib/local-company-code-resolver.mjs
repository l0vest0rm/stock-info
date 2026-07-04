#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function loadLocalCompanyCodeResolver(projectRoot) {
  const dbPath = discoverLocalD1Path(projectRoot);
  if (!dbPath) {
    return {
      dbPath: "",
      loaded: false,
      resolveByName() {
        return "";
      },
    };
  }

  try {
    const output = execFileSync(
      "sqlite3",
      [
        dbPath,
        `select code, alias
           from (
             select code, name as alias, updated_at
               from securities
              where type = 'stock'
             union all
             select code, alias, updated_at
               from knowledge_stock_aliases
           )
          where (
              code like '%.SH'
              or code like '%.SZ'
              or code like '%.BJ'
              or code like '%.HK'
              or code like '%.US'
            )
            and trim(coalesce(alias, '')) != ''
          order by updated_at desc`,
      ],
      { encoding: "utf8" }
    );
    const aliasMap = buildAliasMap(output);
    return {
      dbPath,
      loaded: true,
      resolveByName(name) {
        const candidates = aliasCandidates(name);
        for (const candidate of candidates) {
          const resolved = aliasMap.get(candidate);
          if (typeof resolved === "string" && resolved) {
            return resolved;
          }
        }
        return "";
      },
    };
  } catch {
    return {
      dbPath,
      loaded: false,
      resolveByName() {
        return "";
      },
    };
  }
}

function discoverLocalD1Path(projectRoot) {
  const override = String(process.env.KNOWLEDGE_LOCAL_D1_SQLITE || "").trim();
  if (override) {
    const absolute = resolve(projectRoot, override);
    return existsSync(absolute) ? absolute : "";
  }
  const dir = resolve(projectRoot, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(dir)) {
    return "";
  }
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(dir, name))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || "";
}

function buildAliasMap(output) {
  const aliasMap = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [code, aliasValue] = trimmed.split("|");
    if (!code || !aliasValue) continue;
    for (const alias of aliasCandidates(aliasValue)) {
      const existing = aliasMap.get(alias);
      if (!existing) {
        aliasMap.set(alias, code);
        continue;
      }
      if (existing !== code) {
        aliasMap.set(alias, null);
      }
    }
  }
  return aliasMap;
}

function aliasCandidates(name) {
  const raw = normalizeAlias(name);
  const base = normalizeAlias(securityBaseName(name));
  const short = normalizeAlias(stripSecuritySuffix(securityBaseName(name)));
  return [...new Set([raw, base, short].filter(Boolean))];
}

function normalizeAlias(value) {
  return String(value || "").trim().toLowerCase();
}

function securityBaseName(name) {
  return String(name || "")
    .trim()
    .replace(/\.(SH|SZ|US|HK|BJ|PT)$/i, "")
    .replace(/-(SW|W|B|S|R)$/i, "")
    .trim();
}

function stripSecuritySuffix(name) {
  return String(name || "")
    .replace(/(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$/u, "")
    .trim();
}
