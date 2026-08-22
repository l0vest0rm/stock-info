import type { StatutoryDisclosureDocument } from "../../../adapters/statutory-disclosures";
import type { Bindings } from "../../../types";
import {
  collectAhStatutoryPdfDisclosure,
  type AhConfirmedStatutoryRestatementContext,
  type StatutoryPdfPages,
  type StatutoryPdfTextLoader,
} from "../adapters/a-h-statutory-pdf";
import { classifyResearchSecurity } from "../domain/research-identity";
import type { StandardizedResearchFinancialFact } from "../domain/research-financial-quality";
import { recordFinancialStatutoryVerification, type FinancialStatutoryVerificationRecord } from "./financial-statutory-verification";

export type AhStatutoryVerificationEnvironment = Pick<Bindings, "DB" | "KNOWLEDGE_CONTENT_BUCKET" | "KNOWLEDGE_REPORT_CONVERTER_URL">;
export type ProduceAhStatutoryVerificationsInput = {
  securityCode: string;
  normalizedFacts: StandardizedResearchFinancialFact[];
  documents: StatutoryDisclosureDocument[];
  observedAt?: number;
  createdAt?: number;
  absoluteTolerance?: number;
  relativeTolerance?: number;
  verificationIdForFact?: (fact: StandardizedResearchFinancialFact) => string;
  /**
   * A correction filing is selected by its immutable registry id only after a
   * local human review confirmed its relationship to an original filing.
   */
  selectedDocumentId?: string;
  confirmedRestatement?: AhConfirmedStatutoryRestatementContext;
  /** Tests and controlled import jobs may supply an audited text loader. */
  loadPdfText?: StatutoryPdfTextLoader;
};

export type ProducedAhStatutoryVerification = {
  collection: Awaited<ReturnType<typeof collectAhStatutoryPdfDisclosure>>;
  verification: FinancialStatutoryVerificationRecord;
};

/**
 * Appends A/H statutory field checks for already-normalized Eastmoney facts.
 * It never asks CNINFO/HKEX for structured statements and never routes an A/H
 * failure to any other provider.  A missing document/text/field becomes a
 * ledgered `unverified` observation with the exact available evidence.
 */
export async function produceAhStatutoryVerifications(
  env: AhStatutoryVerificationEnvironment,
  input: ProduceAhStatutoryVerificationsInput,
): Promise<ProducedAhStatutoryVerification[]> {
  const security = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" });
  if (security.market !== "a_share" && security.market !== "h_share") {
    throw new Error(`A/H statutory verification only supports A/H securities: ${security.code}`);
  }
  const expectedRegistry = security.market === "a_share" ? "cninfo" : "hkex";
  const documents = input.documents.filter((document) => document.registry === expectedRegistry && document.securityCode === security.code);
  if (input.confirmedRestatement && !input.selectedDocumentId) {
    throw new Error("confirmed statutory restatement requires selectedDocumentId");
  }
  if (input.selectedDocumentId && !documents.some((document) => document.documentId === input.selectedDocumentId)) {
    throw new Error("selected statutory restatement document is not an indexed official filing for this security");
  }
  const observedAt = input.observedAt ?? Date.now();
  const createdAt = input.createdAt ?? observedAt;
  const textLoader = input.loadPdfText ?? createStatutoryTextLoader(env);
  const sourceBindings = new Map<string, Record<string, unknown>>();
  const loadedText = new Map<string, Promise<StatutoryPdfPages>>();
  const result: ProducedAhStatutoryVerification[] = [];
  for (const fact of uniqueFacts(input.normalizedFacts)) {
    const collection = await collectAhStatutoryPdfDisclosure(security.code, fact, documents, async (document) => {
      let pending = loadedText.get(document.documentId);
      if (!pending) {
        pending = (async () => {
          const binding = await loadKnowledgeSourceBinding(env, document);
          sourceBindings.set(document.documentId, binding.metadata);
          return binding.pages ?? textLoader(document);
        })();
        loadedText.set(document.documentId, pending);
      }
      return pending;
    }, {
      selectedDocumentId: input.selectedDocumentId,
      confirmedRestatement: input.confirmedRestatement,
    });
    const documentId = collection.disclosure?.documentId ?? String(collection.metadata.documentId ?? "");
    const verification = await recordFinancialStatutoryVerification(env.DB, {
      verificationId: input.verificationIdForFact?.(fact) ?? crypto.randomUUID(),
      securityCode: security.code,
      normalizedFact: fact,
      statutoryDisclosure: collection.disclosure,
      statutoryCollectionReasonCodes: collection.reasonCodes,
      observedAt,
      createdAt,
      absoluteTolerance: input.absoluteTolerance,
      relativeTolerance: input.relativeTolerance,
      metadata: {
        ...collection.metadata,
        statutoryCollectionProvider: expectedRegistry,
        statutoryCollectionReasonCodes: collection.reasonCodes,
        ...(input.confirmedRestatement ? {
          statutoryRevision: {
            classification: "confirmed_financial_restatement",
            reviewId: input.confirmedRestatement.revisionReviewId,
            originalDocumentId: input.confirmedRestatement.originalDocumentId,
            affectedScope: input.confirmedRestatement.affectedScope,
          },
        } : {}),
        sourceBinding: documentId ? sourceBindings.get(documentId) ?? { status: "not_bound_to_knowledge_ledger" } : { status: "no_statutory_document" },
      },
    });
    result.push({ collection, verification });
  }
  return result;
}

function createStatutoryTextLoader(env: AhStatutoryVerificationEnvironment): StatutoryPdfTextLoader {
  return async (document) => {
    const converterUrl = String(env.KNOWLEDGE_REPORT_CONVERTER_URL ?? "").trim();
    if (converterUrl) {
      const converted = await fetch(converterUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ docId: `statutory_${document.registry}_${document.documentId}`, url: document.documentUrl }),
      });
      const text = (await converted.text()).trim();
      if (converted.ok && text) {
        return {
          // PyMuPDF's text fallback uses form-feed separators; Markdown output
          // does not promise them, so page evidence is marked reliable only
          // when that boundary is actually present.
          pages: text.split("\f").filter(Boolean), extractionMethod: "local_pdf_conversion", pageNumbersReliable: text.includes("\f"),
        } satisfies StatutoryPdfPages;
      }
      throw new Error(`local statutory PDF conversion failed: documentId=${document.documentId} status=${converted.status} body=${text.slice(0, 240)}`);
    }
    const response = await fetch(document.documentUrl, {
      headers: {
        Referer: document.registry === "cninfo" ? "https://www.cninfo.com.cn/" : "https://www1.hkexnews.hk/",
        "User-Agent": "Mozilla/5.0 (compatible; stock-info-worker/0.1; +https://workers.cloudflare.com/)",
      },
      signal: AbortSignal.timeout(45_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || !new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF")) {
      throw new Error(`${document.registry} statutory PDF request failed: documentId=${document.documentId} status=${response.status}`);
    }
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
    const pdf = await getDocument({ data: bytes }).promise;
    // Financial statements should occur near the beginning of a statutory
    // report.  The ceiling prevents one enormous filing from turning a local
    // research click into an unbounded Worker job; the collection metadata
    // records the scanned page count so this is never mistaken for coverage.
    const pageLimit = Math.min(pdf.numPages, 260);
    const pages = await Promise.all(Array.from({ length: pageLimit }, async (_, index) => {
      const page = await pdf.getPage(index + 1);
      const text = await page.getTextContent();
      return text.items.map((part) => ("str" in part ? part.str : "")).join(" ");
    }));
    if (!pages.some((page) => page.trim())) throw new Error(`${document.registry} statutory PDF has no extractable text: documentId=${document.documentId}`);
    return { pages, extractionMethod: "pdf_text", pageNumbersReliable: true } satisfies StatutoryPdfPages;
  };
}

type KnowledgeSourceBinding = { metadata: Record<string, unknown>; pages: StatutoryPdfPages | null };

/**
 * If the filing already passed the information-preprocessing pipeline, prefer
 * that source-bound text. The verification record retains its document/result
 * identity either way, so an auditor can distinguish converted ledger text
 * from a direct immutable-PDF extraction.
 */
async function loadKnowledgeSourceBinding(
  env: AhStatutoryVerificationEnvironment,
  document: StatutoryDisclosureDocument,
): Promise<KnowledgeSourceBinding> {
  let row: { docId: string; contentPreview: string | null; contentKey: string | null; resultId: string | null; resultOutcome: string | null } | null;
  try {
    row = await env.DB.prepare(`select d.doc_id as docId, d.content_preview as contentPreview,
      c.content_key as contentKey, r.result_id as resultId, r.outcome as resultOutcome
    from knowledge_docs d
    left join knowledge_doc_content_refs c on c.doc_id=d.doc_id
    left join knowledge_document_versions v on v.doc_id=d.doc_id
    left join knowledge_document_results r on r.version_id=v.version_id
    where d.url=? order by r.created_at desc, v.created_at desc limit 1`)
    .bind(document.documentUrl).first<{ docId: string; contentPreview: string | null; contentKey: string | null; resultId: string | null; resultOutcome: string | null }>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|does not exist|not found/i.test(message)) {
      return { metadata: { status: "knowledge_ledger_unavailable" }, pages: null };
    }
    throw error;
  }
  if (!row) return { metadata: { status: "not_bound_to_knowledge_ledger" }, pages: null };
  const metadata = {
    status: "bound_to_knowledge_ledger", knowledgeDocId: row.docId, knowledgeResultId: row.resultId,
    knowledgeResultOutcome: row.resultOutcome, knowledgeContentKey: row.contentKey,
  };
  if (row.contentKey && env.KNOWLEDGE_CONTENT_BUCKET) {
    const object = await env.KNOWLEDGE_CONTENT_BUCKET.get(row.contentKey);
    if (object) {
      const text = (await object.text()).trim();
      if (text) return { metadata, pages: { pages: [text], extractionMethod: "knowledge_preprocessed_text" } };
    }
  }
  // A preview alone is usable only when it contains a whole converted table;
  // otherwise it is evidence of binding but cannot honestly be called a field
  // extraction source.
  if (row.contentPreview && /合并(利润表|资产负债表|现金流量表)|consolidated statement/i.test(row.contentPreview)) {
    return { metadata, pages: { pages: [row.contentPreview], extractionMethod: "knowledge_preprocessed_text" } };
  }
  return { metadata, pages: null };
}

function uniqueFacts(facts: StandardizedResearchFinancialFact[]): StandardizedResearchFinancialFact[] {
  const comparisonKeys = new Set<string>();
  return facts.filter((fact) => {
    if (!fact.id.trim()) throw new Error("A/H statutory verification requires a primary fact id");
    const comparisonKey = String(fact.canonicalComparisonKey ?? "").trim();
    if (!comparisonKey) throw new Error("A/H statutory verification requires a canonical comparison key");
    if (comparisonKeys.has(comparisonKey)) return false;
    comparisonKeys.add(comparisonKey);
    return true;
  });
}
