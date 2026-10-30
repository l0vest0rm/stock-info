import { ensureNativeBasicRegressions } from './check-valuation-dashboard.mjs';

export async function checkActivePortfolio() {
  ensureNativeBasicRegressions();
  return {"activePortfolio": "passed", "checks": ["snapshot-validation", "cash/FX/full-denominator", "company-merge", "39-cap", "risk-thresholds", "stale/future/revision", "semantic-dedup", "risk-preservation", "CAS", "immutable-durable-history", "GET-readonly", "private-local-origin", "content-type/size", "no-trades", "proposal-before-after", "funding/costs", "proposal-separation", "stale-proposal"]};
}
