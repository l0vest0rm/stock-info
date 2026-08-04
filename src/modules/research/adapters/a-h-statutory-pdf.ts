import type { StatutoryDisclosureDocument, StatutoryDisclosureRegistry } from "../../../adapters/statutory-disclosures";
import type { FinancialStatutoryDisclosure } from "../domain/financial-statutory-verification";
import type { ResearchFinancialMetric, StandardizedResearchFinancialFact } from "../domain/research-financial-quality";

/**
 * This adapter is deliberately a PDF *field verifier*, not a financial
 * statement loader.  Eastmoney remains the selected structured source for A
 * and H shares.  A successful extraction returns one exact table label, PDF
 * page and current-period column so the comparison can be audited; an absent
 * table/field remains unverified instead of triggering another data vendor.
 */
export type StatutoryPdfPages = {
  pages: string[];
  extractionMethod: "pdf_text" | "local_pdf_conversion" | "knowledge_preprocessed_text";
  /** A converted Markdown blob may not retain original PDF page breaks. */
  pageNumbersReliable?: boolean;
};
export type StatutoryPdfTextLoader = (document: StatutoryDisclosureDocument) => Promise<StatutoryPdfPages>;

export type AhStatutoryFieldCollection = {
  provider: Extract<StatutoryDisclosureRegistry, "cninfo" | "hkex">;
  securityCode: string;
  normalizedFactId: string;
  disclosure: FinancialStatutoryDisclosure | null;
  reasonCodes: string[];
  metadata: Record<string, unknown>;
};

/**
 * A correction filing is deliberately opt-in.  The normal selector continues
 * to exclude correction-like titles, because a title alone cannot establish
 * that a document restates a particular financial statement.  This context
 * is supplied only after the separate local human-review ledger confirms the
 * relationship to an original official document.
 */
export type AhConfirmedStatutoryRestatementContext = {
  revisionReviewId: string;
  originalDocumentId: string;
  affectedScope: string;
};

export type AhStatutoryFieldCollectionOptions = {
  selectedDocumentId?: string;
  confirmedRestatement?: AhConfirmedStatutoryRestatementContext;
};

type StatementName = "income" | "balance" | "cashflow";
type MetricMapping = { statement: StatementName; labels: string[] };
type SourceMeasurement = {
  currency: "CNY" | "HKD" | "USD";
  reportedCurrency: string;
  reportedUnit: "thousand" | "million" | "billion";
  unitMultiplier: number;
};
type ExtractedFieldValue = { rawValue: number; value: number; measurement: SourceMeasurement | null };

const CN_MAPPINGS: Partial<Record<ResearchFinancialMetric, MetricMapping>> = {
  revenue: { statement: "income", labels: ["营业总收入", "营业收入"] },
  gross_profit: { statement: "income", labels: ["毛利"] },
  operating_profit: { statement: "income", labels: ["营业利润"] },
  net_profit: { statement: "income", labels: ["归属于母公司股东的净利润", "归属于母公司所有者的净利润", "归属于上市公司股东的净利润"] },
  operating_cash_flow: { statement: "cashflow", labels: ["经营活动产生的现金流量净额"] },
  capital_expenditure: { statement: "cashflow", labels: ["购建固定资产、无形资产和其他长期资产支付的现金"] },
  cash: { statement: "balance", labels: ["货币资金"] },
  total_equity: { statement: "balance", labels: ["所有者权益合计"] },
};

const HK_MAPPINGS: Partial<Record<ResearchFinancialMetric, MetricMapping>> = {
  revenue: { statement: "income", labels: ["Revenue", "Revenues"] },
  gross_profit: { statement: "income", labels: ["Gross profit"] },
  operating_profit: { statement: "income", labels: ["Operating profit", "Profit from operations"] },
  net_profit: { statement: "income", labels: ["Profit attributable to equity holders", "Equity holders of the Company", "Profit for the year"] },
  operating_cash_flow: { statement: "cashflow", labels: ["Net cash generated from operating activities", "Net cash flows generated from operating activities", "Net cash from operating activities"] },
  capital_expenditure: { statement: "cashflow", labels: ["Purchase of property, plant and equipment", "Purchases of property, plant and equipment"] },
  cash: { statement: "balance", labels: ["Cash and cash equivalents"] },
  total_equity: { statement: "balance", labels: ["Total equity"] },
};

const CN_STATEMENT_HEADERS: Record<StatementName, string[]> = {
  income: ["合并利润表"],
  balance: ["合并资产负债表"],
  cashflow: ["合并现金流量表"],
};
const HK_STATEMENT_HEADERS: Record<StatementName, string[]> = {
  income: ["Consolidated statement of profit or loss", "Consolidated income statement"],
  balance: ["Consolidated statement of financial position", "Consolidated balance sheet"],
  cashflow: ["Consolidated statement of cash flows", "Consolidated cash flow statement"],
};

export async function collectAhStatutoryPdfDisclosure(
  securityCode: string,
  fact: StandardizedResearchFinancialFact,
  documents: StatutoryDisclosureDocument[],
  loadPdfText: StatutoryPdfTextLoader,
  options: AhStatutoryFieldCollectionOptions = {},
): Promise<AhStatutoryFieldCollection> {
  const provider = providerForCode(securityCode);
  const base = { provider, securityCode, normalizedFactId: fact.id };
  if (options.confirmedRestatement && !options.selectedDocumentId) {
    throw new Error("confirmed statutory restatement requires an explicitly selected document");
  }
  const document = options.selectedDocumentId
    ? documents.find((item) => item.registry === provider && item.documentId === options.selectedDocumentId) ?? null
    : selectFiling(documents, provider, fact);
  if (!document) {
    return { ...base, disclosure: null, reasonCodes: ["statutory_filing_not_indexed"], metadata: { statutoryProvider: provider, fiscalYear: fact.period.fiscalYear, periodKind: fact.period.kind } };
  }
  const mapping = (provider === "cninfo" ? CN_MAPPINGS : HK_MAPPINGS)[fact.metric];
  if (!mapping) {
    return unavailable(base, document, ["statutory_metric_mapping_not_configured"], { fiscalYear: fact.period.fiscalYear, periodKind: fact.period.kind });
  }
  let source: StatutoryPdfPages;
  try {
    source = await loadPdfText(document);
  } catch (error) {
    return unavailable(base, document, ["statutory_document_text_unavailable"], { error: message(error), fiscalYear: fact.period.fiscalYear });
  }
  // Keep line boundaries: the local converter emits Markdown tables and a
  // line is the only reliable boundary between a statement row and a later
  // EPS/narrative mention of the same words.
  const pages = source.pages.map(normalizePdfText);
  const section = statementSection(pages, provider, mapping.statement);
  if (!section.text) {
    return unavailable(base, document, ["statutory_statement_table_not_found"], {
      extractionMethod: source.extractionMethod, statement: mapping.statement, scannedPages: pages.length,
    });
  }
  const hkexMeasurement = provider === "hkex" ? sourceMeasurement(pages.join("\n")) : null;
  const reportedAccountingStandard = provider === "hkex" ? hkexAccountingStandard(pages.join("\n")) : null;
  for (const label of mapping.labels) {
    let extracted = extractFieldValue(section.text, label, provider, fact, hkexMeasurement);
    if (!extracted) continue;
    if (provider === "hkex" && (!extracted.measurement || !reportedAccountingStandard)) continue;
    let predecessor: { document: StatutoryDisclosureDocument; extracted: ExtractedFieldValue; label: string } | null = null;
    if (requiresCninfoCumulativeBridge(provider, fact, mapping)) {
      const previousFact = precedingQuarterFact(fact);
      const previousDocument = previousFact ? selectFiling(documents, provider, previousFact) : null;
      if (!previousDocument) {
        return unavailable(base, document, ["statutory_predecessor_filing_not_indexed"], {
          extractionMethod: source.extractionMethod, statement: mapping.statement, matchedLabel: label,
          currentCumulativeValue: extracted.value, currentDocumentId: document.documentId,
          predecessorFiscalQuarter: previousFact?.period.fiscalQuarter ?? null,
        });
      }
      let previousSource: StatutoryPdfPages;
      try {
        previousSource = await loadPdfText(previousDocument);
      } catch (error) {
        return unavailable(base, document, ["statutory_predecessor_document_text_unavailable"], {
          extractionMethod: source.extractionMethod, statement: mapping.statement, matchedLabel: label,
          currentCumulativeValue: extracted.value, currentDocumentId: document.documentId,
          predecessorDocumentId: previousDocument.documentId, error: message(error),
        });
      }
      const previousPages = previousSource.pages.map(normalizePdfText);
      const previousSection = statementSection(previousPages, provider, mapping.statement);
      const previousMatch = previousSection.text
        ? mapping.labels.map((previousLabel) => ({ label: previousLabel, extracted: extractFieldValue(previousSection.text, previousLabel, provider, previousFact!, null) }))
          .find((candidate) => candidate.extracted !== null)
        : null;
      if (!previousMatch?.extracted) {
        return unavailable(base, document, ["statutory_predecessor_field_value_not_found"], {
          extractionMethod: source.extractionMethod, statement: mapping.statement, matchedLabel: label,
          currentCumulativeValue: extracted.value, currentDocumentId: document.documentId,
          predecessorDocumentId: previousDocument.documentId,
          predecessorStatementTableFound: Boolean(previousSection.text),
        });
      }
      predecessor = { document: previousDocument, extracted: previousMatch.extracted, label: previousMatch.label };
      extracted = {
        rawValue: extracted.rawValue - previousMatch.extracted.rawValue,
        value: extracted.value - previousMatch.extracted.value,
        measurement: null,
      };
    }
    const pageIndex = section.pageIndexes.find((index) => pages[index]?.includes(label)) ?? section.pageIndexes[0];
    let currency: "CNY" | "HKD" | "USD" = "CNY";
    let accountingStandard = "CAS";
    if (provider === "hkex") {
      // The guard above establishes both values; keeping this branch explicit
      // prevents a future provider from acquiring a hidden default basis.
      if (!extracted.measurement || !reportedAccountingStandard) continue;
      currency = extracted.measurement.currency;
      accountingStandard = reportedAccountingStandard;
    }
    return {
      ...base,
      disclosure: {
        provider,
        documentId: document.documentId,
        disclosureUrl: document.documentUrl,
        locator: `${source.pageNumbersReliable === false ? "text=converted_document" : `page=${pageIndex + 1}`}; statement=${mapping.statement}; label=${label}; column=current_period${predecessor ? `; period=standalone_quarter; formula=current_cumulative-prior_cumulative; prior_document=${predecessor.document.documentId}` : ""}`,
        publishedAt: document.publishedAt,
        reportDate: fact.period.endDate,
        value: extracted.value,
        basis: {
          id: `${currency}:${accountingStandard}:consolidated:${options.confirmedRestatement ? "restated" : "reported"}`,
          currency, accountingStandard, scope: "consolidated", revision: options.confirmedRestatement ? "restated" : "reported",
        },
        metadata: {
          registry: provider, sourceLocator: document.sourceLocator, title: document.title,
          extractionMethod: source.extractionMethod, statement: mapping.statement, matchedLabel: label, page: pageIndex + 1,
          ...(predecessor ? {
            periodAggregation: "standalone_quarter_from_cumulative_statutory_reports",
            formula: "current_cumulative-prior_cumulative",
            currentCumulativeValue: predecessor.extracted.value + extracted.value,
            predecessorCumulativeValue: predecessor.extracted.value,
            predecessorDocumentId: predecessor.document.documentId,
            predecessorDocumentUrl: predecessor.document.documentUrl,
            predecessorPublishedAt: predecessor.document.publishedAt,
            predecessorMatchedLabel: predecessor.label,
          } : {}),
          ...(extracted.measurement ? {
            reportedCurrency: extracted.measurement.reportedCurrency,
            reportedUnit: extracted.measurement.reportedUnit,
            unitMultiplier: extracted.measurement.unitMultiplier,
            rawReportedValue: extracted.rawValue,
            normalizedToBaseUnits: true,
          } : {}),
          ...(options.confirmedRestatement ? {
            statutoryRevisionReviewId: options.confirmedRestatement.revisionReviewId,
            originalDocumentId: options.confirmedRestatement.originalDocumentId,
            affectedScope: options.confirmedRestatement.affectedScope,
            revisionClassification: "confirmed_financial_restatement",
          } : {}),
        },
      },
      reasonCodes: [],
      metadata: { extractionMethod: source.extractionMethod, statement: mapping.statement, matchedLabel: label, scannedPages: pages.length,
        ...(predecessor ? {
          periodAggregation: "standalone_quarter_from_cumulative_statutory_reports",
          formula: "current_cumulative-prior_cumulative",
          predecessorDocumentId: predecessor.document.documentId,
          predecessorDocumentUrl: predecessor.document.documentUrl,
          predecessorMatchedLabel: predecessor.label,
        } : {}),
        ...(extracted.measurement ? { reportedCurrency: extracted.measurement.reportedCurrency, reportedUnit: extracted.measurement.reportedUnit, unitMultiplier: extracted.measurement.unitMultiplier, rawReportedValue: extracted.rawValue } : {}),
        ...(options.confirmedRestatement ? {
          statutoryRevisionReviewId: options.confirmedRestatement.revisionReviewId,
          originalDocumentId: options.confirmedRestatement.originalDocumentId,
          affectedScope: options.confirmedRestatement.affectedScope,
          revisionClassification: "confirmed_financial_restatement",
        } : {}),
      },
    };
  }
  const reasonCodes = provider === "hkex" && (!hkexMeasurement || !reportedAccountingStandard)
    ? [!hkexMeasurement ? "statutory_measurement_basis_not_found" : "statutory_accounting_standard_not_found"]
    : ["statutory_field_value_not_found"];
  return unavailable(base, document, reasonCodes, {
    extractionMethod: source.extractionMethod, statement: mapping.statement, labels: mapping.labels, scannedPages: pages.length,
  });
}

function unavailable(
  base: Pick<AhStatutoryFieldCollection, "provider" | "securityCode" | "normalizedFactId">,
  document: StatutoryDisclosureDocument,
  reasonCodes: string[],
  metadata: Record<string, unknown>,
): AhStatutoryFieldCollection {
  return {
    ...base,
    disclosure: {
      provider: base.provider,
      documentId: document.documentId,
      disclosureUrl: document.documentUrl,
      locator: document.sourceLocator,
      publishedAt: document.publishedAt,
      reportDate: null,
      value: null,
      basis: null,
      metadata: { registry: base.provider, sourceLocator: document.sourceLocator, title: document.title, ...metadata },
    },
    reasonCodes,
    metadata: { documentId: document.documentId, documentUrl: document.documentUrl, ...metadata },
  };
}

function providerForCode(code: string): Extract<StatutoryDisclosureRegistry, "cninfo" | "hkex"> {
  if (/\.(SH|SZ|BJ)$/i.test(code)) return "cninfo";
  if (/\.HK$/i.test(code)) return "hkex";
  throw new Error(`A/H statutory PDF extraction does not support ${code}`);
}

function selectFiling(
  documents: StatutoryDisclosureDocument[],
  provider: Extract<StatutoryDisclosureRegistry, "cninfo" | "hkex">,
  fact: StandardizedResearchFinancialFact,
): StatutoryDisclosureDocument | null {
  const period = fact.period;
  return documents
    .filter((document) => document.registry === provider)
    .filter((document) => titleMatchesPeriod(document.title, provider, period.fiscalYear, period.kind, period.fiscalQuarter))
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || right.documentId.localeCompare(left.documentId))[0] ?? null;
}

/**
 * Eastmoney's A-share statement table is already quarterized, whereas the
 * CNINFO interim, nine-month and annual statements are year-to-date flows.
 * A direct comparison would manufacture a conflict for every Q2--Q4 flow
 * field.  Balance-sheet facts are point-in-time values and must never enter
 * this bridge.
 */
function requiresCninfoCumulativeBridge(
  provider: "cninfo" | "hkex",
  fact: StandardizedResearchFinancialFact,
  mapping: MetricMapping,
): boolean {
  return provider === "cninfo"
    && fact.period.kind === "quarter"
    && (fact.period.fiscalQuarter ?? 1) > 1
    && (mapping.statement === "income" || mapping.statement === "cashflow");
}

function precedingQuarterFact(fact: StandardizedResearchFinancialFact): StandardizedResearchFinancialFact | null {
  if (fact.period.kind !== "quarter" || !fact.period.fiscalQuarter || fact.period.fiscalQuarter <= 1) return null;
  const fiscalQuarter = (fact.period.fiscalQuarter - 1) as 1 | 2 | 3;
  const month = String(fiscalQuarter * 3).padStart(2, "0");
  const endDate = `${fact.period.fiscalYear}-${month}-${fiscalQuarter === 1 ? "31" : "30"}`;
  return {
    ...fact,
    period: {
      kind: "quarter",
      fiscalYear: fact.period.fiscalYear,
      fiscalQuarter,
      startDate: `${fact.period.fiscalYear}-${String((fiscalQuarter - 1) * 3 + 1).padStart(2, "0")}-01`,
      endDate,
    },
  };
}

function titleMatchesPeriod(title: string, provider: "cninfo" | "hkex", fiscalYear: number, kind: "annual" | "quarter", quarter?: number): boolean {
  const normalized = title.toLowerCase().replace(/\s+/g, " ");
  if (provider === "cninfo") {
    if (!normalized.includes(String(fiscalYear))) return false;
    // CNINFO commonly lists a same-day "披露的提示性公告" ahead of the
    // actual report.  It is evidence of release timing, not the financial
    // statement, and must never be selected just because its title shares the
    // reporting-period words.
    const excluded = /摘要|英文版|更正|取消|提示性公告|披露的提示/;
    if (kind === "annual") return /年度报告/.test(title) && !excluded.test(title);
    const token = quarter === 1 ? /(?:第一|一)季度报告/ : quarter === 2 ? /半年度报告/ : quarter === 3 ? /(?:第三|三)季度报告/ : /年度报告/;
    // CNINFO uses both Chinese-number and Arabic-ordinal naming conventions
    // (for example “一季度报告” and “第一季度报告”) for the same filing.
    // Treating the former as absent breaks the auditable Q2/Q4 flow bridge.
    return token.test(title) && !excluded.test(title);
  }
  if (!normalized.includes(String(fiscalYear))) return false;
  if (kind === "annual") return /annual report|financial statements.*year ended|results announcement.*year ended/.test(normalized);
  const token = quarter === 1 ? /first quarterly|1st quarter|three months ended/ : quarter === 2 ? /interim report|half[- ]year|six months ended/ : quarter === 3 ? /third quarterly|3rd quarter|nine months ended/ : /annual report|year ended/;
  return token.test(normalized);
}

function statementSection(pages: string[], provider: "cninfo" | "hkex", statement: StatementName): { text: string; pageIndexes: number[] } {
  const headers = (provider === "cninfo" ? CN_STATEMENT_HEADERS : HK_STATEMENT_HEADERS)[statement];
  const start = pages.findIndex((page) => headers.some((header) => page.toLowerCase().includes(header.toLowerCase())));
  if (start < 0) return { text: "", pageIndexes: [] };
  // Four pages cover the common consolidated tables and remain bounded even
  // for very long annual reports.  We stop before a parent-company table.
  const indexes: number[] = [];
  for (let index = start; index < Math.min(pages.length, start + 4); index += 1) {
    if (index > start && (provider === "cninfo" ? /母公司(资产负债表|利润表|现金流量表)/ : /company statement|parent company/).test(pages[index])) break;
    indexes.push(index);
  }
  // A converter may put a whole report into one Markdown "page".  Start at
  // the selected statement heading so a preceding highlights table cannot be
  // mistaken for the financial-statement table.
  const firstPage = pages[start] ?? "";
  const firstOffset = headers
    .map((header) => firstPage.toLowerCase().indexOf(header.toLowerCase()))
    .filter((offset) => offset >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  return { text: [firstPage.slice(firstOffset), ...indexes.slice(1).map((index) => pages[index])].join("\n"), pageIndexes: indexes };
}

function extractFieldValue(
  text: string,
  label: string,
  provider: "cninfo" | "hkex",
  fact: StandardizedResearchFinancialFact,
  measurement: SourceMeasurement | null,
): ExtractedFieldValue | null {
  const rawValue = markdownTableValue(text, label, fact, provider === "hkex")
    ?? valueAfterLabel(text, label, provider === "hkex");
  if (rawValue === null) return null;
  // CNINFO values retain their primary-report base unit behavior.  HKEX has
  // no safe default: its reported currency and scale must be visible in the
  // selected filing before an amount can be compared to Eastmoney base units.
  return { rawValue, value: measurement ? rawValue * measurement.unitMultiplier : rawValue, measurement };
}

function markdownTableValue(text: string, label: string, fact: StandardizedResearchFinancialFact, caseInsensitive: boolean): number | null {
  const table = firstMarkdownTable(text);
  if (!table) return null;
  const rows = table.split("\n").filter((line) => /^\s*\|/.test(line) && !/^\s*\|\s*[-: ]+\|/.test(line))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map(cleanCell));
  if (!rows.length) return null;
  const needle = comparable(label, caseInsensitive);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowLabel = comparable(row[0] ?? "", caseInsensitive);
    if (!matchesStatementLabel(rowLabel, needle, caseInsensitive)) continue;
    // Tencent reports attributable profit as a two-line hierarchy.  The same
    // phrase occurs later in the EPS heading, so accept the child row only
    // immediately below the actual "Attributable to:" statement row.
    if (caseInsensitive && needle === comparable("Equity holders of the Company", true)
      && !comparable(rows[index - 1]?.[0] ?? "", true).includes("attributable to")) continue;
    if ((row[0] ?? "").includes("<br>")) {
      const compressed = compressedTableValue(row, needle, caseInsensitive);
      if (compressed !== null) return compressed;
      continue;
    }
    const current = currentColumnValue(row, fact.period.fiscalYear);
    if (current !== null) return current;
    // A revenue heading may have no value while the total row below is a
    // note-number row.  Select that immediate statement total, never a value
    // outside the Markdown table.
    if (caseInsensitive && /^revenues?$/.test(rowLabel)) {
      for (const next of rows.slice(index + 1, Math.min(rows.length, index + 8))) {
        if (/cost of revenues?/.test(comparable(next[0] ?? "", true))) break;
        if (!comparable(next[0] ?? "", true)) {
          const total = currentColumnValue(next, fact.period.fiscalYear);
          if (total !== null) return total;
        }
      }
    }
  }
  // Some converter tables store all labels in one cell and all values in the
  // adjacent cell, separated by <br>.  Pair the nth label with the nth
  // current-period amount after the explicitly reported unit marker.
  for (const row of rows) {
    const compressed = compressedTableValue(row, needle, caseInsensitive);
    if (compressed !== null) return compressed;
  }
  return null;
}

function compressedTableValue(row: string[], needle: string, caseInsensitive: boolean): number | null {
  const labels = splitBreaks(row[0] ?? "");
  const labelIndex = labels.findIndex((item) => matchesStatementLabel(comparable(item, caseInsensitive), needle, caseInsensitive));
  if (labelIndex < 0 || row.length < 2) return null;
  const values = splitBreaks(row[1] ?? "");
  const unitIndex = values.map((value) => value.toLowerCase()).reduce((found, value, index) => found >= 0 || !/(?:rmb|cny|hkd|hk\$|usd|us\$).*?(?:thousand|million|billion)/i.test(value) ? found : index, -1);
  if (unitIndex < 0) return null;
  const amountTokens = values.slice(unitIndex + 1).map(numberFromText).filter((value): value is number => value !== null);
  return amountTokens[labelIndex * 2] ?? null;
}

function firstMarkdownTable(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*\|/.test(line));
  if (start < 0) return null;
  const table: string[] = [];
  for (const line of lines.slice(start)) {
    if (!/^\s*\|/.test(line)) break;
    table.push(line);
  }
  return table.length ? table.join("\n") : null;
}

function currentColumnValue(row: string[], fiscalYear: number): number | null {
  const yearColumn = row.findIndex((cell) => new RegExp(`\\b${fiscalYear}\\b`).test(cell));
  if (yearColumn > 0) return numberFromText(row[yearColumn]);
  // Values are normally in the third column, while the second column is an
  // optional note number.  Prefer a grouped amount, then the first number in
  // data columns; it keeps note "2" from becoming revenue.
  const cells = row.slice(1);
  const grouped = cells.map(numberFromText).find((value, index) => value !== null && /[,.]/.test(cells[index] ?? ""));
  return grouped ?? cells.map(numberFromText).find((value) => value !== null) ?? null;
}

function sourceMeasurement(text: string): SourceMeasurement | null {
  const match = text.match(/\b(RMB|CNY|HKD|HK\$|USD|US\$)\s*(?:in\s*)?(?:['’]\s*)?(thousand|thousands|million|millions|billion|billions)\b/i);
  if (!match) return null;
  const token = match[1].toUpperCase();
  const currency = token === "RMB" || token === "CNY" ? "CNY" : token === "HKD" || token === "HK$" ? "HKD" : "USD";
  const unit = match[2].toLowerCase().replace(/s$/, "") as SourceMeasurement["reportedUnit"];
  const unitMultiplier = unit === "thousand" ? 1_000 : unit === "million" ? 1_000_000 : 1_000_000_000;
  return { currency, reportedCurrency: match[1], reportedUnit: unit, unitMultiplier };
}

function hkexAccountingStandard(text: string): "IFRS" | null {
  return /\bIFRS\b|International Financial Reporting Standards/i.test(text) ? "IFRS" : null;
}

function valueAfterLabel(text: string, label: string, caseInsensitive: boolean): number | null {
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  const needle = caseInsensitive ? label.toLowerCase() : label;
  let index = haystack.indexOf(needle);
  while (index >= 0 && labelOccurrenceIsDifferentMetric(haystack, index, needle, caseInsensitive)) {
    index = haystack.indexOf(needle, index + needle.length);
  }
  if (index < 0) return null;
  // PDF text keeps table columns in reading order.  The first numeric token
  // following an exact line label is the current-period column.  A bounded
  // window prevents a label in a note from borrowing an unrelated value.
  const tail = text.slice(index + label.length, index + label.length + 180)
    .replace(/[−–—]/g, "-")
    .replace(/\(\s*/g, "-")
    .replace(/\s*\)/g, "");
  const match = tail.match(/-?\s*\d{1,3}(?:\s*,\s*\d{3})+(?:\.\d+)?|-?\s*\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(/[\s,]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function cleanCell(value: string): string { return value.replace(/<br\s*\/?>/gi, "<br>").replace(/\*+/g, "").trim(); }
function splitBreaks(value: string): string[] { return value.split(/<br\s*\/?>/i).map(cleanCell).filter(Boolean); }
function comparable(value: string, caseInsensitive: boolean): string { const normalized = value.replace(/\*+/g, "").replace(/\s+/g, " ").trim(); return caseInsensitive ? normalized.toLowerCase() : normalized; }
function matchesStatementLabel(rowLabel: string, needle: string, caseInsensitive: boolean): boolean {
  const index = rowLabel.indexOf(needle);
  return index >= 0
    && !labelOccurrenceIsDifferentMetric(rowLabel, index, needle, caseInsensitive)
    // “归属于母公司所有者权益合计” is a different equity scope from
    // “所有者权益合计”; accepting it silently drops non-controlling interests.
    && !(needle === "所有者权益合计" && rowLabel.includes("归属于母公司"));
}
function labelOccurrenceIsDifferentMetric(text: string, index: number, needle: string, caseInsensitive: boolean): boolean {
  return labelContinuationIsDifferentMetric(text.slice(index + needle.length), caseInsensitive)
    // “归属于母公司所有者权益合计” is a different equity scope from
    // “所有者权益合计”; accepting it silently drops non-controlling interests.
    || (needle === "所有者权益合计" && text.slice(Math.max(0, index - 12), index).includes("归属于母公司"));
}
function labelContinuationIsDifferentMetric(rest: string, caseInsensitive: boolean): boolean {
  const next = rest.trimStart();
  return caseInsensitive
    ? /^(?:margin|ratio|\%)/.test(next)
    : /^(?:率|%)/.test(next);
}
function numberFromText(value: string): number | null {
  const match = value.replace(/[−–—]/g, "-").replace(/\(\s*/g, "-").replace(/\s*\)/g, "").match(/-?\s*\d{1,3}(?:\s*,\s*\d{3})+(?:\.\d+)?|-?\s*\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0].replace(/[\s,]/g, ""));
  return Number.isFinite(number) ? number : null;
}
function normalizePdfText(value: string): string { return value.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim(); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
