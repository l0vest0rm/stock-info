import { isSupportedCompanyCode, normalizeSupportedCompanyCode } from "../../../shared/codes";
import { externalHttpOptions } from "../../../shared/http";
import type { Bindings } from "../../../types";
import { searchSecurities } from "../../security/application/search-securities";

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

export async function refreshKnowledgeCompanyCodeMappings(
  env: Bindings,
  maxCompanies: number,
): Promise<MappingRefreshResult> {
  const candidates = await listUnmappedInformationEntities(env.DB, maxCompanies);
  const now = Date.now();
  const unmatchedCompanies: string[] = [];
  let matchedCompanies = 0;
  let mappedSecurities = 0;

  for (const companyName of candidates) {
    const matches = (await searchSecurities(env.DB, companyName, { httpOptions: externalHttpOptions(env) }))
      .filter((item) => normalizeComparableName(item.name) === normalizeComparableName(companyName))
      .map((item) => ({
        code: normalizeSupportedCompanyCode(item.code),
        securityName: item.name.trim(),
      }))
      .filter((item) => isSupportedCompanyCode(item.code));
    const uniqueMatches = uniqueMappings(matches);
    if (uniqueMatches.length === 0) {
      unmatchedCompanies.push(companyName);
      continue;
    }
    matchedCompanies += 1;
    mappedSecurities += uniqueMatches.length;
    await env.DB.batch(uniqueMatches.map((item) => env.DB.prepare(
      `insert into knowledge_company_code_mappings (company_name, code, security_name, source, matched_at, updated_at)
       values (?, ?, ?, 'security_search_exact', ?, ?)
       on conflict(company_name, code) do update set
         security_name=excluded.security_name,
         source=excluded.source,
         updated_at=excluded.updated_at`,
    ).bind(companyName, item.code, item.securityName, now, now)));
  }
  return { searchedCompanies: candidates.length, matchedCompanies, mappedSecurities, unmatchedCompanies };
}

export async function listKnowledgeCompanyCodeMappings(
  db: D1Database,
  companyNames: string[],
): Promise<KnowledgeCompanyCodeMapping[]> {
  const names = [...new Set(companyNames.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  const rows = await db.prepare(
    `select company_name, code, security_name
       from knowledge_company_code_mappings
      where company_name in (${placeholders})
      order by company_name, code`,
  ).bind(...names).all<{ company_name: string; code: string; security_name: string }>();
  return (rows.results ?? []).map((row) => ({
    companyName: row.company_name,
    code: row.code,
    securityName: row.security_name,
  }));
}

async function listUnmappedInformationEntities(db: D1Database, maxCompanies: number): Promise<string[]> {
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
       and not exists (
         select 1 from knowledge_company_code_mappings m
          where m.company_name = record.entity
       )
     group by record.entity
     order by count(*) desc, company_name asc
     limit ?`,
  ).bind(maxCompanies).all<{ company_name: string }>();
  return (rows.results ?? []).map((row) => row.company_name.trim()).filter(Boolean);
}

function normalizeComparableName(value: string): string {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase();
}

function uniqueMappings(items: Array<{ code: string; securityName: string }>): Array<{ code: string; securityName: string }> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.code || seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}
