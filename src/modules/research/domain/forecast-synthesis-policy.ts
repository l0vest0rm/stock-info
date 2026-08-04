const MARKET_CONSENSUS_TERM = /市场(?:一致预期|共识)/g;
const SAFE_NEGATION = /(?:非|并非|不是|不构成|不等于|不能称为|不可称为|不得称为)[^。；，,\n]{0,8}$/;

export function hasUnsafeMarketConsensusClaim(content: string): boolean {
  for (const match of content.matchAll(MARKET_CONSENSUS_TERM)) {
    const prefix = content.slice(Math.max(0, (match.index ?? 0) - 20), match.index);
    if (!SAFE_NEGATION.test(prefix)) return true;
  }
  return false;
}
