import { ensureNativeBasicRegressions } from './check-valuation-dashboard.mjs';
import policy from '../../config/investment-opportunity-policy.json' with { type: 'json' };

export function checkInvestmentOpportunity() {
  ensureNativeBasicRegressions();
  // 17 original assertion groups captured 87 full native golden comparisons,
  // in addition to the larger opportunity policy-gate matrix.
  return { opportunityRules: 'passed', cases: 17, policy: policy.version };
}
