import { normalizeSecurityCode } from "../../../shared/codes";
import { cachedFetchJson, type ExternalHttpOptions } from "../../../shared/http";
import type { FinancialStatutoryDisclosure } from "../domain/financial-statutory-verification";
import type { ResearchFinancialMetric, StandardizedResearchFinancialFact } from "../domain/research-financial-quality";
import {
  acceptedUsFinancialPeriodEquivalenceForFact,
  type UsFinancialPeriodEquivalence,
} from "../domain/us-financial-period-equivalence";

/**
 * SEC's company-facts API is an evidence source, not a replacement financial
 * statement feed.  Yahoo remains the selected US structured source; this
 * adapter only returns a reproducible SEC field suitable for verification.
 */
const SEC_ORIGIN = "https://www.sec.gov";
const SEC_DATA_ORIGIN = "https://data.sec.gov";
const SEC_TICKERS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEC_COMPANY_FACTS_TTL_MS = 6 * 60 * 60 * 1000;
const SEC_SUBMISSIONS_TTL_MS = 24 * 60 * 60 * 1000;

export type SecCompanyFactsPoint = {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
  /** A dimensional fact is not a whole-company financial statement fact. */
  segment?: unknown;
};

export type SecCompanyFactConcept = {
  label?: string;
  description?: string;
  units?: Record<string, SecCompanyFactsPoint[]>;
};

export type SecCompanyFactsPayload = {
  cik?: number;
  entityName?: string;
  facts?: Record<string, Record<string, SecCompanyFactConcept>>;
};

export type SecRegistrantFiling = {
  accessionNumber: string;
  primaryDocument: string;
  filingDate: string;
  reportDate: string;
  form: string;
};

export type SecRegistrantXbrl = {
  securityCode: string;
  ticker: string;
  cik: string;
  entityName: string | null;
  companyFacts: SecCompanyFactsPayload;
  filingsByAccession: Map<string, SecRegistrantFiling>;
};

export type SecXbrlDisclosureCollection = {
  provider: "sec";
  securityCode: string;
  normalizedFactId: string;
  disclosure: FinancialStatutoryDisclosure | null;
  reasonCodes: string[];
  metadata: Record<string, unknown>;
};

type SecTickerRecord = { ticker?: string; cik_str?: number | string; title?: string };
type SecSubmissionsPayload = {
  cik?: string | number;
  filings?: { recent?: {
    accessionNumber?: string[];
    primaryDocument?: string[];
    filingDate?: string[];
    reportDate?: string[];
    form?: string[];
  } };
};

type MetricConcept = { namespace: "us-gaap" | "ifrs-full" | "dei"; name: string; instant: boolean };

// This deliberately small mapping is explicit.  We never guess a custom tag
// or compose several balance-sheet tags into a "total debt" value.
const SEC_CONCEPTS: Partial<Record<ResearchFinancialMetric, MetricConcept[]>> = {
  revenue: [
    { namespace: "us-gaap", name: "RevenueFromContractWithCustomerExcludingAssessedTax", instant: false },
    { namespace: "us-gaap", name: "SalesRevenueNet", instant: false },
    { namespace: "us-gaap", name: "RevenueFromContractWithCustomerIncludingAssessedTax", instant: false },
    { namespace: "us-gaap", name: "Revenues", instant: false },
    { namespace: "ifrs-full", name: "Revenue", instant: false },
    { namespace: "ifrs-full", name: "RevenueFromContractsWithCustomers", instant: false },
  ],
  gross_profit: [{ namespace: "us-gaap", name: "GrossProfit", instant: false }, { namespace: "ifrs-full", name: "GrossProfit", instant: false }],
  operating_profit: [{ namespace: "us-gaap", name: "OperatingIncomeLoss", instant: false }, { namespace: "ifrs-full", name: "ProfitLossFromOperatingActivities", instant: false }],
  net_profit: [
    { namespace: "us-gaap", name: "NetIncomeLoss", instant: false },
    { namespace: "us-gaap", name: "ProfitLoss", instant: false },
    { namespace: "ifrs-full", name: "ProfitLoss", instant: false },
  ],
  operating_cash_flow: [{ namespace: "us-gaap", name: "NetCashProvidedByUsedInOperatingActivities", instant: false }, { namespace: "ifrs-full", name: "CashFlowsFromUsedInOperations", instant: false }],
  capital_expenditure: [{ namespace: "us-gaap", name: "PaymentsToAcquirePropertyPlantAndEquipment", instant: false }, { namespace: "ifrs-full", name: "PurchaseOfPropertyPlantAndEquipment", instant: false }],
  cash: [
    { namespace: "us-gaap", name: "CashAndCashEquivalentsAtCarryingValue", instant: true },
    { namespace: "us-gaap", name: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", instant: true },
    { namespace: "ifrs-full", name: "CashAndCashEquivalents", instant: true },
  ],
  total_debt: [{ namespace: "us-gaap", name: "LongTermDebtAndFinanceLeaseObligations", instant: true }],
  total_equity: [
    { namespace: "us-gaap", name: "StockholdersEquity", instant: true },
    { namespace: "us-gaap", name: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", instant: true },
    { namespace: "ifrs-full", name: "Equity", instant: true },
  ],
  diluted_weighted_average_shares: [{ namespace: "us-gaap", name: "WeightedAverageNumberOfDilutedSharesOutstanding", instant: false }],
};

/** Loads exactly the SEC ticker registry, company facts, and filing index. */
export async function loadSecRegistrantXbrl(
  db: D1Database,
  rawSecurityCode: string,
  httpOptions?: ExternalHttpOptions,
): Promise<SecRegistrantXbrl> {
  const securityCode = requireUsSecurity(rawSecurityCode);
  const ticker = securityCode.slice(0, -3);
  const registrant = await resolveSecRegistrant(db, ticker, httpOptions);
  const cik = padCik(registrant.cik);
  const [companyFacts, submissions] = await Promise.all([
    cachedFetchJson(
      db,
      `${SEC_DATA_ORIGIN}/api/xbrl/companyfacts/CIK${cik}.json`,
      secRequestInit(),
      SEC_COMPANY_FACTS_TTL_MS,
      // SEC companyfacts can exceed D1's safe value size for large issuers.
      // It is still fetched from the single official source; a future R2
      // source-cache can own large-object persistence without weakening this
      // adapter's no-fallback policy.
      { ...httpOptions, cacheKey: `sec.companyfacts.v1.${cik}`, cacheMaxBytes: 1_500_000 },
    ) as Promise<SecCompanyFactsPayload>,
    cachedFetchJson(
      db,
      `${SEC_DATA_ORIGIN}/submissions/CIK${cik}.json`,
      secRequestInit(),
      SEC_SUBMISSIONS_TTL_MS,
      // Large issuers' filing indexes can also exceed a D1 cache value.  The
      // index is required for the in-flight verification, but cache failure
      // must not turn an otherwise valid SEC response into a failed research
      // job.  As with companyfacts above, large-object persistence belongs in
      // a dedicated R2 contract rather than this small HTTP cache.
      { ...httpOptions, cacheKey: `sec.submissions.v1.${cik}`, cacheMaxBytes: 1_500_000 },
    ) as Promise<SecSubmissionsPayload>,
  ]);
  return {
    securityCode,
    ticker,
    cik,
    entityName: text(companyFacts.entityName) ?? text(registrant.title),
    companyFacts,
    filingsByAccession: indexSecFilings(submissions),
  };
}

/**
 * Selects one SEC XBRL fact for one already-normalized Yahoo primary fact.
 * An absent SEC concept/period is returned as an explicit non-disclosure;
 * callers must persist it as unverified, never try another data vendor.
 */
export function collectSecXbrlDisclosure(
  registrant: SecRegistrantXbrl,
  normalizedFact: StandardizedResearchFinancialFact,
  options: { periodEquivalences?: readonly UsFinancialPeriodEquivalence[] } = {},
): SecXbrlDisclosureCollection {
  if (registrant.securityCode !== requireUsSecurity(registrant.securityCode)) {
    throw new Error("SEC registrant security code is invalid");
  }
  const concepts = SEC_CONCEPTS[normalizedFact.metric] ?? [];
  const baseMetadata = {
    secCik: registrant.cik,
    secTicker: registrant.ticker,
    secEntityName: registrant.entityName,
    primaryFactId: normalizedFact.id,
    primarySourceType: normalizedFact.provenance.sourceType,
  };
  const periodEquivalence = acceptedUsFinancialPeriodEquivalenceForFact(options.periodEquivalences ?? [], normalizedFact);
  const hasAcceptedEquivalenceForPrimary = (options.periodEquivalences ?? []).some((item) => item.reviewDecision === "accepted" && item.primaryComparisonKey === normalizedFact.canonicalComparisonKey);
  const comparisonFact = periodEquivalence ? {
    ...normalizedFact,
    period: periodEquivalence.secPeriodStartDate
      ? { kind: normalizedFact.period.kind, startDate: periodEquivalence.secPeriodStartDate, endDate: periodEquivalence.secPeriodEndDate, fiscalYear: Number(periodEquivalence.secPeriodEndDate.slice(0, 4)), ...(normalizedFact.period.kind === "quarter" ? { fiscalQuarter: normalizedFact.period.fiscalQuarter } : {}) }
      : { kind: normalizedFact.period.kind, startDate: normalizedFact.period.startDate, endDate: periodEquivalence.secPeriodEndDate, fiscalYear: Number(periodEquivalence.secPeriodEndDate.slice(0, 4)), ...(normalizedFact.period.kind === "quarter" ? { fiscalQuarter: normalizedFact.period.fiscalQuarter } : {}) },
  } as StandardizedResearchFinancialFact : normalizedFact;
  if (hasAcceptedEquivalenceForPrimary && !periodEquivalence) {
    return unavailable(registrant, normalizedFact, ["sec_period_equivalence_mapping_incompatible"], baseMetadata);
  }
  for (const concept of concepts) {
    if (periodEquivalence && (concept.namespace !== periodEquivalence.secNamespace || concept.name !== periodEquivalence.secConcept)) continue;
    const definition = registrant.companyFacts.facts?.[concept.namespace]?.[concept.name];
    if (!definition) continue;
    const selected = periodEquivalence
      ? selectMappedSecPoint(definition, concept, comparisonFact, periodEquivalence)
      : selectSecPoint(definition, concept, comparisonFact);
    if (!selected) {
      if (periodEquivalence) return unavailable(registrant, normalizedFact, ["sec_period_equivalence_mapping_does_not_match_filing"], {
        ...baseMetadata, periodEquivalenceId: periodEquivalence.periodEquivalenceId,
      });
      continue;
    }
    if (periodEquivalence && !matchesPeriodEquivalence(periodEquivalence, concept, selected.point, selected.unit)) {
      return unavailable(registrant, normalizedFact, ["sec_period_equivalence_mapping_does_not_match_filing"], {
        ...baseMetadata, periodEquivalenceId: periodEquivalence.periodEquivalenceId,
      });
    }
    const filing = selected.point.accn ? registrant.filingsByAccession.get(selected.point.accn) : undefined;
    const disclosureUrl = filing ? filingDocumentUrl(registrant.cik, filing) : null;
    if (!filing || !disclosureUrl) {
      return unavailable(registrant, normalizedFact, ["sec_filing_document_not_resolved"], {
        ...baseMetadata,
        secNamespace: concept.namespace,
        secConcept: concept.name,
        secAccession: selected.point.accn ?? null,
      });
    }
    const value = numberOrNull(selected.point.val);
    if (value === null) {
      return unavailable(registrant, normalizedFact, ["sec_xbrl_value_missing"], {
        ...baseMetadata,
        secNamespace: concept.namespace,
        secConcept: concept.name,
        secAccession: filing.accessionNumber,
      });
    }
    const unit = selected.unit.toUpperCase();
    const accountingStandard = concept.namespace === "us-gaap" ? "US_GAAP" : concept.namespace === "ifrs-full" ? "IFRS" : "US_SEC_DEI";
    const basis = {
      // The fact unit is retained in metadata.  The financial-basis currency
      // remains the reporting currency so share-count facts do not pretend
      // that "shares" is a reporting currency.
      id: `${normalizedFact.basis.currency}:${accountingStandard}:consolidated:reported`,
      currency: isCurrencyUnit(unit) ? unit : normalizedFact.basis.currency,
      accountingStandard,
      scope: "consolidated",
      revision: "reported",
    };
    const locator = `${concept.namespace}:${concept.name} unit=${selected.unit} start=${selected.point.start ?? "instant"} end=${selected.point.end ?? ""} accession=${filing.accessionNumber}`;
    return {
      provider: "sec",
      securityCode: registrant.securityCode,
      normalizedFactId: normalizedFact.id,
      disclosure: {
        provider: "sec",
        documentId: filing.accessionNumber,
        disclosureUrl,
        locator,
        publishedAt: filing.filingDate,
        reportDate: selected.point.end ?? filing.reportDate,
        value,
        basis,
        metadata: {
          secCik: registrant.cik,
          secTicker: registrant.ticker,
          secNamespace: concept.namespace,
          secConcept: concept.name,
          secUnit: selected.unit,
          secForm: selected.point.form ?? filing.form,
          secFiled: selected.point.filed ?? filing.filingDate,
          secFiscalYear: selected.point.fy ?? null,
          secFiscalPeriod: selected.point.fp ?? null,
          secFrame: selected.point.frame ?? null,
          selection: selected.selection,
          ...(periodEquivalence ? {
            periodEquivalenceId: periodEquivalence.periodEquivalenceId,
            periodEquivalenceRuleVersion: "us-financial-period-equivalence.v1",
            yahooPrimaryPeriod: normalizedFact.period,
            secEquivalentPeriod: { startDate: periodEquivalence.secPeriodStartDate, endDate: periodEquivalence.secPeriodEndDate },
          } : {}),
        },
      },
      reasonCodes: [],
      metadata: { ...baseMetadata, secNamespace: concept.namespace, secConcept: concept.name, selection: selected.selection,
        ...(periodEquivalence ? { periodEquivalenceId: periodEquivalence.periodEquivalenceId, periodEquivalenceRuleVersion: "us-financial-period-equivalence.v1" } : {}),
      },
    };
  }
  // DEI EntityCommonStockSharesOutstanding is a dated basic outstanding-share
  // fact, not a fully diluted share count.  It belongs in the security market
  // structure ledger after document review; treating it as `diluted_shares`
  // would let a per-share valuation pass on the wrong denominator.
  const hasAnyConcept = concepts.some((concept) => Boolean(registrant.companyFacts.facts?.[concept.namespace]?.[concept.name]));
  return unavailable(
    registrant,
    normalizedFact,
    [hasAnyConcept ? "sec_xbrl_period_not_available" : normalizedFact.metric === "diluted_shares" ? "sec_xbrl_diluted_share_concept_not_safe" : "sec_xbrl_concept_not_available"],
    baseMetadata,
  );
}

export async function fetchSecXbrlDisclosure(
  db: D1Database,
  rawSecurityCode: string,
  normalizedFact: StandardizedResearchFinancialFact,
  httpOptions?: ExternalHttpOptions,
): Promise<SecXbrlDisclosureCollection> {
  const registrant = await loadSecRegistrantXbrl(db, rawSecurityCode, httpOptions);
  return collectSecXbrlDisclosure(registrant, normalizedFact);
}

function matchesPeriodEquivalence(
  mapping: UsFinancialPeriodEquivalence,
  concept: MetricConcept,
  point: SecCompanyFactsPoint,
  unit: string,
): boolean {
  return concept.namespace === mapping.secNamespace
    && concept.name === mapping.secConcept
    && unit.toUpperCase() === mapping.secUnit.toUpperCase()
    && (point.start ?? null) === mapping.secPeriodStartDate
    && point.end === mapping.secPeriodEndDate
    && point.accn === mapping.secAccession
    && point.form === mapping.secForm;
}

/** The accepted review pins an accession, so a later amended/comparative SEC
 * fact cannot silently replace it just because it has the same end date. */
function selectMappedSecPoint(
  definition: SecCompanyFactConcept,
  concept: MetricConcept,
  fact: StandardizedResearchFinancialFact,
  mapping: UsFinancialPeriodEquivalence,
): { point: SecCompanyFactsPoint; unit: string; selection: string } | null {
  const candidates: Array<{ point: SecCompanyFactsPoint; unit: string }> = [];
  for (const [unit, points] of Object.entries(definition.units ?? {})) {
    if (!isExpectedUnit(unit, concept, fact.metric)) continue;
    for (const point of points ?? []) {
      if (!isEligiblePoint(point, concept, fact) || !matchesPeriodEquivalence(mapping, concept, point, unit)) continue;
      candidates.push({ point, unit });
    }
  }
  candidates.sort((left, right) => compareSecPoints(left.point, right.point));
  const selected = candidates[0];
  return selected ? { ...selected, selection: "SEC fact matched an accepted Yahoo-to-SEC period equivalence and pinned filing" } : null;
}

function unavailable(
  registrant: SecRegistrantXbrl,
  normalizedFact: StandardizedResearchFinancialFact,
  reasonCodes: string[],
  metadata: Record<string, unknown>,
): SecXbrlDisclosureCollection {
  return {
    provider: "sec",
    securityCode: registrant.securityCode,
    normalizedFactId: normalizedFact.id,
    disclosure: null,
    reasonCodes,
    metadata,
  };
}

async function resolveSecRegistrant(
  db: D1Database,
  ticker: string,
  httpOptions?: ExternalHttpOptions,
): Promise<{ ticker: string; cik: string | number; title?: string }> {
  const payload = await cachedFetchJson(
    db,
    `${SEC_ORIGIN}/files/company_tickers.json`,
    secRequestInit(),
    SEC_TICKERS_TTL_MS,
    { ...httpOptions, cacheKey: "sec.company-tickers.v1" },
  ) as Record<string, SecTickerRecord>;
  const candidates = tickerCandidates(ticker);
  const record = Object.values(payload).find((item) => candidates.has(String(item.ticker ?? "").trim().toUpperCase()));
  const cik = record?.cik_str;
  if (!record || cik === undefined || cik === null || !String(cik).trim()) {
    throw new Error(`SEC registrant CIK was not found for ${ticker}`);
  }
  return { ticker: String(record.ticker ?? ticker).trim().toUpperCase(), cik, title: text(record.title) ?? undefined };
}

function selectSecPoint(
  definition: SecCompanyFactConcept,
  concept: MetricConcept,
  normalizedFact: StandardizedResearchFinancialFact,
): { point: SecCompanyFactsPoint; unit: string; selection: string } | null {
  const candidates: Array<{ point: SecCompanyFactsPoint; unit: string }> = [];
  for (const [unit, points] of Object.entries(definition.units ?? {})) {
    if (!isExpectedUnit(unit, concept, normalizedFact.metric)) continue;
    for (const point of points ?? []) {
      if (!isEligiblePoint(point, concept, normalizedFact)) continue;
      candidates.push({ point, unit });
    }
  }
  candidates.sort((left, right) => compareSecPoints(left.point, right.point));
  const selected = candidates[0];
  if (!selected) return null;
  return {
    ...selected,
    selection: concept.instant ? "SEC instant fact matched exact end date" : "SEC duration fact matched exact end date and expected duration",
  };
}

function isExpectedUnit(unit: string, concept: MetricConcept, metric: ResearchFinancialMetric): boolean {
  const upper = unit.toUpperCase();
  if (metric === "diluted_weighted_average_shares" || metric === "diluted_shares") return upper === "SHARES";
  return (concept.namespace === "us-gaap" || concept.namespace === "ifrs-full") && isCurrencyUnit(upper);
}

function isEligiblePoint(point: SecCompanyFactsPoint, concept: MetricConcept, fact: StandardizedResearchFinancialFact): boolean {
  if (numberOrNull(point.val) === null || point.segment !== undefined || point.end !== fact.period.endDate || !isSecStatementForm(point.form, fact.period.kind)) return false;
  if (concept.instant) return !point.start;
  if (!point.start) return false;
  const days = elapsedDays(point.start, point.end);
  if (fact.period.kind === "quarter") return days >= 70 && days <= 115;
  return days >= 280 && days <= 390;
}

function compareSecPoints(left: SecCompanyFactsPoint, right: SecCompanyFactsPoint): number {
  // The most recently filed value is authoritative when an amendment/revision
  // replaces an earlier figure for the same reported context.
  return String(right.filed ?? "").localeCompare(String(left.filed ?? ""))
    || String(right.accn ?? "").localeCompare(String(left.accn ?? ""));
}

function indexSecFilings(payload: SecSubmissionsPayload): Map<string, SecRegistrantFiling> {
  const recent = payload.filings?.recent;
  const result = new Map<string, SecRegistrantFiling>();
  for (let index = 0; index < (recent?.accessionNumber?.length ?? 0); index += 1) {
    const accessionNumber = text(recent?.accessionNumber?.[index]);
    const primaryDocument = text(recent?.primaryDocument?.[index]);
    const filingDate = date(recent?.filingDate?.[index]);
    const reportDate = date(recent?.reportDate?.[index]);
    const form = text(recent?.form?.[index]);
    if (!accessionNumber || !primaryDocument || !filingDate || !reportDate || !form) continue;
    result.set(accessionNumber, { accessionNumber, primaryDocument, filingDate, reportDate, form });
  }
  return result;
}

function filingDocumentUrl(cik: string, filing: SecRegistrantFiling): string | null {
  const accession = filing.accessionNumber.replace(/-/g, "");
  if (!/^\d+$/.test(accession) || !/^[A-Za-z0-9._-]+\.(?:htm|html|xhtml)$/i.test(filing.primaryDocument)) return null;
  return `${SEC_ORIGIN}/Archives/edgar/data/${String(Number(cik))}/${accession}/${encodeURIComponent(filing.primaryDocument)}`;
}

function secRequestInit(): RequestInit {
  // SEC asks automated clients to identify their application and contact.
  // This is an identification header, never a credential or LLM setting.
  return { headers: { Accept: "application/json", "User-Agent": "stock-info/0.1 research@stock-info.local" } };
}

function requireUsSecurity(rawSecurityCode: string): string {
  const code = normalizeSecurityCode(rawSecurityCode);
  if (!/^[A-Z0-9.-]+\.US$/.test(code)) throw new Error(`SEC XBRL verification only supports US securities: ${rawSecurityCode}`);
  return code;
}

function tickerCandidates(ticker: string): Set<string> {
  const normalized = ticker.trim().toUpperCase();
  return new Set([normalized, normalized.replace(/\./g, "-"), normalized.replace(/-/g, ".")]);
}

function padCik(value: string | number): string {
  const digits = String(value).trim();
  if (!/^\d{1,10}$/.test(digits)) throw new Error(`invalid SEC CIK: ${value}`);
  return digits.padStart(10, "0");
}

function isSecStatementForm(form: string | undefined, kind: "annual" | "quarter"): boolean {
  const normalized = String(form ?? "").toUpperCase();
  return kind === "annual"
    ? /^(10-K|20-F)(?:\/A)?$/.test(normalized)
    : /^(10-Q|6-K)(?:\/A)?$/.test(normalized);
}

function isCurrencyUnit(unit: string): boolean {
  return /^[A-Z]{3}$/.test(unit) && unit !== "SHARES";
}

function elapsedDays(start: string, end: string): number {
  const startAt = Date.parse(`${start}T00:00:00Z`);
  const endAt = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(startAt) && Number.isFinite(endAt) ? (endAt - startAt) / 86_400_000 : -1;
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function date(value: unknown): string | null {
  const result = text(value);
  return result && /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}
