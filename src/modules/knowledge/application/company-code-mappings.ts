import type { Database } from "../../../platform/contracts";
import { isSupportedCompanyCode, normalizeSupportedCompanyCode } from "../../../shared/codes";
import { searchSecurities } from "../../security/application/search-securities";
import bundledMappingFile from "../../../../config/knowledge-company-code-mappings.json";

export type KnowledgeCompanyCodeMapping = {
  companyName: string;
  code: string;
  securityName: string;
};

type MappingRefreshResult = {
  searchedCompanies: number;
  matchedCompanies: number;
  mappedSecurities: number;
  unmatchedCompanies: string[];
};

type MappingFile = {
  version: 1;
  mappings: KnowledgeCompanyCodeMapping[];
};

type ResolveOptions = {
  search?: (companyName: string) => Promise<KnowledgeCompanyCodeMapping[]>;
  file?: string;
};

const DEFAULT_MAPPING_FILE = "config/knowledge-company-code-mappings.json";
const bundledMappings = normalizeMappings(Array.isArray((bundledMappingFile as { mappings?: unknown }).mappings)
  ? (bundledMappingFile as { mappings: unknown[] }).mappings
  : []);
let writeQueue = Promise.resolve();

/** Local exact company-name-to-security mappings, persisted only by Node. */
export async function resolveKnowledgeCompanyCodeMappings(
  db: Database,
  companyNames: string[],
  options: ResolveOptions = {},
): Promise<KnowledgeCompanyCodeMapping[]> {
  const names = uniqueCompanyNames(companyNames);
  if (names.length === 0) return [];
  const file = options.file ?? resolveLocalMappingFile();
  if (!file) return selectMappings(groupMappings(bundledMappings), names);
  const cached = await readMappingFile(file);
  const cachedByCompany = groupMappings(cached.mappings);
  const missing = names.filter((companyName) => !cachedByCompany.has(companyName));
  if (missing.length === 0) return selectMappings(cachedByCompany, names);

  const search = options.search ?? ((companyName: string) => searchExactCompanyMappings(db, companyName));
  const discovered = (await Promise.all(missing.map(async (companyName) => {
    try {
      return await search(companyName);
    } catch (error) {
      console.warn(JSON.stringify({ event: "knowledge_company_code_mapping_search_failed", companyName, error: error instanceof Error ? error.message : String(error) }));
      return [];
    }
  }))).flat();
  const validDiscovered = normalizeMappings(discovered);
  if (validDiscovered.length > 0) await persistMappings(file, validDiscovered);
  return selectMappings(groupMappings([...cached.mappings, ...validDiscovered]), names);
}

export async function refreshKnowledgeCompanyCodeMappings(
  db: Database,
  maxCompanies: number,
): Promise<MappingRefreshResult> {
  const candidates = await listInformationEntities(db, maxCompanies);
  const mappings = await resolveKnowledgeCompanyCodeMappings(db, candidates);
  const mappedCompanies = new Set(mappings.map((item) => item.companyName));
  return {
    searchedCompanies: candidates.length,
    matchedCompanies: mappedCompanies.size,
    mappedSecurities: mappings.length,
    unmatchedCompanies: candidates.filter((companyName) => !mappedCompanies.has(companyName)),
  };
}

export function hasExactKnowledgeCompanyCodeMapping(
  mappings: KnowledgeCompanyCodeMapping[],
  companyName: string,
  code: string,
): boolean {
  const expectedCompanyName = String(companyName || "").trim();
  const expectedCode = normalizeSupportedCompanyCode(code);
  return mappings.some((mapping) => mapping.companyName === expectedCompanyName && mapping.code === expectedCode);
}

export async function filterExactCompanyCodeMappedRows<T extends { entity: string }>(
  db: Database,
  rows: T[],
  code: string,
): Promise<T[]> {
  const mappings = await resolveKnowledgeCompanyCodeMappings(db, rows.map((row) => row.entity));
  return rows.filter((row) => hasExactKnowledgeCompanyCodeMapping(mappings, row.entity, code));
}

async function listInformationEntities(db: Database, maxCompanies: number): Promise<string[]> {
  const rows = await db.prepare(
    `with current_results as (
      select v.doc_id, r.result_id
        from knowledge_document_versions v
        join knowledge_document_results r on r.result_id = (
          select r2.result_id from knowledge_document_results r2
           where r2.version_id = v.version_id
           order by r2.created_at desc, r2.result_id desc limit 1
        )
       where v.version_id = (
         select v2.version_id from knowledge_document_versions v2
          where v2.doc_id = v.doc_id
          order by v2.created_at desc, v2.version_id desc limit 1
       )
    )
    select record.entity as company_name
      from current_results
      join knowledge_information_records record on record.result_id = current_results.result_id
     where trim(coalesce(record.entity, '')) != ''
     group by record.entity
     order by count(*) desc, company_name asc
     limit ?`,
  ).bind(maxCompanies).all<{ company_name: string }>();
  return uniqueCompanyNames((rows.results ?? []).map((row) => row.company_name));
}

async function searchExactCompanyMappings(db: Database, companyName: string): Promise<KnowledgeCompanyCodeMapping[]> {
  const matches = (await searchSecurities(db, companyName))
    .filter((item) => normalizeComparableName(item.name) === normalizeComparableName(companyName))
    .map((item) => ({
      companyName,
      code: normalizeSupportedCompanyCode(item.code),
      securityName: item.name.trim(),
    }));
  return normalizeMappings(matches);
}

function resolveLocalMappingFile(): string | null {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path) return null;
  const configured = String(getProcessEnv().LOCAL_KNOWLEDGE_COMPANY_CODE_MAPPINGS_PATH || "").trim();
  return path.resolve(getProcessCwd(), configured || DEFAULT_MAPPING_FILE);
}

async function readMappingFile(file: string): Promise<MappingFile> {
  const fs = getNodeBuiltin("node:fs/promises");
  if (!fs) return { version: 1, mappings: [] };
  try {
    const parsed = JSON.parse(String(await fs.readFile(file, "utf8") || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Number((parsed as { version?: unknown }).version) !== 1 || !Array.isArray((parsed as { mappings?: unknown }).mappings)) {
      throw new Error("expected { version: 1, mappings: [] }");
    }
    return { version: 1, mappings: normalizeMappings((parsed as { mappings: unknown[] }).mappings) };
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") return { version: 1, mappings: [] };
    throw new Error(`invalid local company-code mapping file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function persistMappings(file: string, discovered: KnowledgeCompanyCodeMapping[]): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const fs = getNodeBuiltin("node:fs/promises");
    const path = getNodeBuiltin("node:path");
    if (!fs || !path) return;
    const current = await readMappingFile(file);
    const mappings = normalizeMappings([...current.mappings, ...discovered]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${getProcessId()}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, mappings }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  return writeQueue;
}

function normalizeMappings(items: unknown[]): KnowledgeCompanyCodeMapping[] {
  const seen = new Set<string>();
  const mappings: KnowledgeCompanyCodeMapping[] = [];
  for (const item of items) {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const companyName = String(raw.companyName || raw.company_name || "").trim();
    const code = normalizeSupportedCompanyCode(String(raw.code || ""));
    const securityName = String(raw.securityName || raw.security_name || "").trim();
    const key = `${companyName}\u0000${code}`;
    if (!companyName || !securityName || !isSupportedCompanyCode(code) || seen.has(key)) continue;
    seen.add(key);
    mappings.push({ companyName, code, securityName });
  }
  return mappings.sort((left, right) => left.companyName.localeCompare(right.companyName) || left.code.localeCompare(right.code));
}

function groupMappings(mappings: KnowledgeCompanyCodeMapping[]): Map<string, KnowledgeCompanyCodeMapping[]> {
  const grouped = new Map<string, KnowledgeCompanyCodeMapping[]>();
  for (const mapping of mappings) {
    const values = grouped.get(mapping.companyName) ?? [];
    values.push(mapping);
    grouped.set(mapping.companyName, values);
  }
  return grouped;
}

function selectMappings(grouped: Map<string, KnowledgeCompanyCodeMapping[]>, names: string[]): KnowledgeCompanyCodeMapping[] {
  return names.flatMap((companyName) => grouped.get(companyName) ?? []);
}

function uniqueCompanyNames(items: string[]): string[] {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeComparableName(value: string): string {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase();
}

function getNodeBuiltin(name: string): any | null {
  const processObject = (globalThis as { process?: { getBuiltinModule?: (moduleName: string) => unknown } }).process;
  return processObject?.getBuiltinModule?.(name) ?? null;
}

function getProcessCwd(): string {
  const processObject = (globalThis as { process?: { cwd?: () => string } }).process;
  return processObject?.cwd?.() || ".";
}

function getProcessEnv(): Record<string, string | undefined> {
  const processObject = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processObject?.env ?? {};
}

function getProcessId(): number {
  const processObject = (globalThis as { process?: { pid?: number } }).process;
  return Number(processObject?.pid || 0);
}
