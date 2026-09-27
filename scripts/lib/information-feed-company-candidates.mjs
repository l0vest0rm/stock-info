/** Build a bounded candidate set from stock names and real aliases, not final tags. */
export function feedCompanyCandidates(aliases, title, body, { limit = 60, excludedMappings = [] } = {}) {
  const content = `${title || ''}\n${body || ''}`.toLowerCase();
  const excluded = new Set(excludedMappings.map((item) => `${item.code}|${item.name}`.toLowerCase()));
  const seen = new Set();
  const candidates = [];
  const byCode = new Map(aliases.map((item) => [String(item.code || '').toLowerCase(), item]));
  for (const mention of content.matchAll(/(?<![a-z0-9.])(?:[a-z0-9]+(?:\.[a-z0-9]+)*\.(?:sh|sz|bj|hk|us|ks|kq|t))(?![a-z0-9.])/g)) {
    const item = byCode.get(mention[0]);
    if (!item) continue;
    const code = String(item.code || '').trim();
    if (!code || seen.has(code) || excluded.has(`${code}|${item.name || ''}`.toLowerCase())) continue;
    seen.add(code);
    candidates.push({ tagId: `company:${code}`, name: item.name || code, matchedAlias: mention[0] });
    if (candidates.length >= limit) return candidates;
  }
  for (const item of [...aliases].sort((a, b) =>
    String(b.alias || '').length - String(a.alias || '').length || String(a.alias || '').localeCompare(String(b.alias || '')))) {
    const alias = String(item.alias || '').trim();
    const code = String(item.code || '').trim();
    // Bare quote-like numbers also occur as prices, counts and dates.
    if (alias.length < 2 || isDerivedCodeAlias(alias, code) || !code || seen.has(code)
      || excluded.has(`${code}|${item.name || ''}`.toLowerCase())
      || !content.includes(alias.toLowerCase())) continue;
    seen.add(code);
    candidates.push({ tagId: `company:${code}`, name: item.name || alias, matchedAlias: alias });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

function isDerivedCodeAlias(alias, code) {
  const value = alias.toLowerCase();
  const identity = code.toLowerCase();
  const firstDot = identity.indexOf('.');
  const lastDot = identity.lastIndexOf('.');
  return value === identity
    || (firstDot > 0 && value === identity.slice(0, firstDot))
    || (lastDot > 0 && value === identity.slice(0, lastDot));
}
