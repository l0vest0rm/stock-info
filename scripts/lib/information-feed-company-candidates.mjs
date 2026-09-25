/** Build a bounded candidate set from the shared alias index, not final tags. */
export function feedCompanyCandidates(aliases, title, body, { limit = 60, excludedMappings = [] } = {}) {
  const content = `${title || ''}\n${body || ''}`.toLowerCase();
  const excluded = new Set(excludedMappings.map((item) => `${item.code}|${item.name}`.toLowerCase()));
  const seen = new Set();
  const candidates = [];
  for (const item of [...aliases].sort((a, b) =>
    String(b.alias || '').length - String(a.alias || '').length || String(a.alias || '').localeCompare(String(b.alias || '')))) {
    const alias = String(item.alias || '').trim();
    const code = String(item.code || '').trim();
    // Bare quote-like numbers also occur as prices, counts and dates.
    if (alias.length < 2 || /^\d{5,6}$/.test(alias) || !code || seen.has(code)
      || excluded.has(`${code}|${item.name || ''}`.toLowerCase())
      || !content.includes(alias.toLowerCase())) continue;
    seen.add(code);
    candidates.push({ tagId: `company:${code}`, name: item.name || alias, matchedAlias: alias });
    if (candidates.length >= limit) break;
  }
  return candidates;
}
