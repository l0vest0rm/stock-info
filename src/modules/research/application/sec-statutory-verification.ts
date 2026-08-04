import { externalHttpOptions } from "../../../shared/http";
import type { Bindings } from "../../../types";
import {
  collectSecXbrlDisclosure,
  loadSecRegistrantXbrl,
  type SecXbrlDisclosureCollection,
} from "../adapters/sec-xbrl";
import { recordFinancialStatutoryVerification, type FinancialStatutoryVerificationRecord } from "./financial-statutory-verification";
import type { StandardizedResearchFinancialFact } from "../domain/research-financial-quality";
import type { UsFinancialPeriodEquivalence } from "../domain/us-financial-period-equivalence";

export type SecStatutoryVerificationEnvironment = Pick<
  Bindings,
  "DB" | "HTTP_PROXY_URL" | "HTTP_PROXY_RELAY_URL" | "HTTP_PROXY_DOMAINS" | "HTTP_DOMAIN_CONCURRENCY" | "HTTP_REQUEST_TIMEOUT_MS"
>;

export type ProduceSecStatutoryVerificationsInput = {
  securityCode: string;
  normalizedFacts: StandardizedResearchFinancialFact[];
  observedAt?: number;
  createdAt?: number;
  absoluteTolerance?: number;
  relativeTolerance?: number;
  /** Explicit local-review mappings only; absent mappings never trigger date tolerance. */
  periodEquivalences?: readonly UsFinancialPeriodEquivalence[];
  /** The caller can supply stable ids when replaying an audited local job. */
  verificationIdForFact?: (fact: StandardizedResearchFinancialFact) => string;
};

export type ProducedSecStatutoryVerification = {
  collection: SecXbrlDisclosureCollection;
  verification: FinancialStatutoryVerificationRecord;
};

/**
 * Production-ready SEC verification producer.  It loads SEC once per issuer,
 * extracts each selected field, and appends (never updates) every comparison.
 * It does not load Yahoo itself and has no non-SEC fallback: callers supply
 * the already-normalized primary facts selected by the source policy.
 */
export async function produceSecStatutoryVerifications(
  env: SecStatutoryVerificationEnvironment,
  input: ProduceSecStatutoryVerificationsInput,
): Promise<ProducedSecStatutoryVerification[]> {
  const observedAt = input.observedAt ?? Date.now();
  const createdAt = input.createdAt ?? observedAt;
  const registrant = await loadSecRegistrantXbrl(env.DB, input.securityCode, externalHttpOptions(env));
  const facts = uniqueFacts(input.normalizedFacts);
  const result: ProducedSecStatutoryVerification[] = [];
  for (const fact of facts) {
    const collection = collectSecXbrlDisclosure(registrant, fact, { periodEquivalences: input.periodEquivalences });
    const verification = await recordFinancialStatutoryVerification(env.DB, {
      verificationId: input.verificationIdForFact?.(fact) ?? crypto.randomUUID(),
      securityCode: registrant.securityCode,
      normalizedFact: fact,
      statutoryDisclosure: collection.disclosure,
      statutoryCollectionReasonCodes: collection.reasonCodes,
      observedAt,
      createdAt,
      absoluteTolerance: input.absoluteTolerance,
      relativeTolerance: input.relativeTolerance,
      metadata: {
        ...collection.metadata,
        secCollectionReasonCodes: collection.reasonCodes,
        statutoryCollectionProvider: "sec",
      },
    });
    result.push({ collection, verification });
  }
  return result;
}

function uniqueFacts(facts: StandardizedResearchFinancialFact[]): StandardizedResearchFinancialFact[] {
  const comparisonKeys = new Set<string>();
  return facts.filter((fact) => {
    if (!fact.id.trim()) throw new Error("SEC verification requires a primary fact id");
    const comparisonKey = String(fact.canonicalComparisonKey ?? "").trim();
    if (!comparisonKey) throw new Error("SEC verification requires a canonical comparison key");
    if (comparisonKeys.has(comparisonKey)) return false;
    comparisonKeys.add(comparisonKey);
    return true;
  });
}
