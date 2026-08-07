#!/usr/bin/env node

// Local-only orchestration for incremental research inputs. It deliberately
// calls explicit local write endpoints; production page reads never invoke it.
//
// The refresh has one complete source-bound path: bootstrap indexes official
// filings; selected current filings are imported to the local knowledge
// ledger; the remote model extracts only constrained evidence; then the
// dependency read models rebuild.  A previous version only did the first and
// last steps, leaving a newly indexed report invisible to every research tab.
import refreshConfig from "../config/research-auto-input-refresh.json" with { type: "json" };

const baseUrl = String(process.env.STOCK_INFO_LOCAL_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const codes = process.argv.slice(2).map((value) => value.trim().toUpperCase()).filter(Boolean);
if (!codes.length) throw new Error("usage: npm run research:refresh-inputs -- 600519.SH 601088.SH 00700.HK AAPL.US");

const results = [];
for (const code of codes) {
  const bootstrap = await request(`/research/company/${encodeURIComponent(code)}/bootstrap`, { method: "POST" });
  const financialStatutoryVerification = await request(`/research/company/${encodeURIComponent(code)}/financial-statutory-verifications/refresh`, { method: "POST" });
  const statutoryDocuments = await request(`/research/company/${encodeURIComponent(code)}/statutory-disclosures`);
  const selectedDocuments = selectCurrentDocuments(statutoryDocuments.items || []);
  const filingSteps = [];
  for (const document of selectedDocuments) {
    const documentId = encodeURIComponent(document.documentId);
    try {
      const imported = await request(`/research/company/${encodeURIComponent(code)}/statutory-disclosures/${documentId}/import-local`, { method: "POST" });
      const extracted = await request(`/research/company/${encodeURIComponent(code)}/statutory-disclosures/${documentId}/auto-insights`, { method: "POST" });
      filingSteps.push({ documentId: document.documentId, title: document.title, kind: document.kind, status: "processed", imported, extracted });
    } catch (error) {
      // Keep a document-level failure visible while allowing the rest of the
      // issuer's independent official filings to continue. The non-zero exit
      // at the end makes a partial source run impossible to mistake for a
      // complete refresh.
      filingSteps.push({ documentId: document.documentId, title: document.title, kind: document.kind, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Filing extraction may have just created management guidance or an
  // issuer-explicit scenario for a period whose statutory actual already
  // exists. Run this only after every selected filing has been processed so
  // that the same refresh creates all eligible automatic calibrations.
  const automaticFormalActuals = await request(`/research/company/${encodeURIComponent(code)}/formal-actuals/sync-auto`, { method: "POST" });
  // This reads only saved research-report candidates.  It may enter a source
  // forecast only when the document metadata explicitly binds the exact
  // original carrier, independent-origin group, model lineage and measurement
  // contract; otherwise it saves the machine-readable block reason.
  const automaticThirdPartyForecasts = await request(`/research/company/${encodeURIComponent(code)}/third-party-forecasts/sync-auto`, { method: "POST" });
  const industrySourceSeries = await request(`/research/company/${encodeURIComponent(code)}/sync-industry-source-series`, { method: "POST" });
  const rebuild = await request(`/research/company/${encodeURIComponent(code)}/rebuild-auto-filing-inputs`, { method: "POST" });
  results.push({ code, bootstrap, financialStatutoryVerification, automaticFormalActuals, selectedDocuments: selectedDocuments.map(({ documentId, title, kind }) => ({ documentId, title, kind })), filingSteps, automaticThirdPartyForecasts, industrySourceSeries, rebuild });
}
console.log(JSON.stringify({ baseUrl, results }, null, 2));
if (results.some((result) => result.filingSteps.some((step) => step.status === "failed"))) process.exitCode = 1;

async function request(path, init) {
  const response = await fetch(`${baseUrl}/api${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(`${path}: ${body?.msg || response.status}`);
  return body.data;
}

function selectCurrentDocuments(documents) {
  const rules = refreshConfig.documentSelection;
  const byKind = new Map();
  for (const document of documents) {
    const kind = classifyDocument(document, rules);
    if (!kind) continue;
    const existing = byKind.get(kind) || [];
    existing.push({ ...document, kind });
    byKind.set(kind, existing);
  }
  const selected = [];
  for (const [kind, limit] of Object.entries(rules.limits)) {
    const entries = (byKind.get(kind) || [])
      .sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")) || String(right.documentId || "").localeCompare(String(left.documentId || "")))
      .slice(0, limit);
    selected.push(...entries);
  }
  return selected;
}

function classifyDocument(document, rules) {
  const label = `${document.title || ""} ${document.documentType || ""}`.toLowerCase();
  for (const [kind, patterns] of Object.entries(rules.patterns)) {
    if (patterns.some((pattern) => new RegExp(pattern, "i").test(label))) return kind;
  }
  return null;
}
