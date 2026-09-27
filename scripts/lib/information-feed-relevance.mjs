import { createHash } from 'node:crypto';
import config from '../../config/information-feed-relevance.json' with { type: 'json' };

const pattern = (value) => new RegExp(value, 'iu');
const positive = config.positive.map((rule) => ({ code: rule.code, all: rule.all.map(pattern) }));
const negative = config.negative.map((rule) => ({ code: rule.code, title: pattern(rule.title), body: pattern(rule.body) }));
const strictNegative = new Set(['arts_obituary', 'humanitarian_relief']);
const quoteOnly = { ...config.quoteOnly, title: pattern(config.quoteOnly.title), body: pattern(config.quoteOnly.body),
  factCue: pattern(config.quoteOnly.factCue) };

export const INVESTMENT_RELEVANCE_VERSION = config.version;
export const investmentRelevanceEnabled = config.enabled === true;
export const investmentRelevanceBodyHash = (body) => createHash('sha256').update(body).digest('hex');

export function currentInvestmentGate(gate, { title, body }) {
  return gate?.policyVersion === INVESTMENT_RELEVANCE_VERSION && gate.title === title
    && gate.bodySha256 === investmentRelevanceBodyHash(body)
    && ['pass', 'reject'].includes(gate.effectiveDisposition)
    && Boolean(gate.reasonCodes?.includes('gate_disabled')) === !investmentRelevanceEnabled;
}

export function evaluateInvestmentRelevance({ title, body, kind = 'new', previousStoryRelevant = false }) {
  const heading = String(title || '').normalize('NFKC');
  const text = String(body || '').normalize('NFKC');
  const full = `${heading}\n${text}`;
  const result = (decision, reasonCodes, evidence = []) => ({ decision,
    effectiveDisposition: decision === 'reject' ? 'reject' : 'pass', reasonCodes, evidence,
    policyVersion: INVESTMENT_RELEVANCE_VERSION, title: String(title || ''),
    bodySha256: investmentRelevanceBodyHash(String(body || '')) });
  if (!heading || !text) return result('uncertain', ['missing_input']);
  if (kind === 'update' && previousStoryRelevant) return result('pass', ['relevant_story_update']);
  // These subjects often contain incidental words such as "获批" or "贸易".
  // Their narrow title/body templates take precedence over broad positive cues.
  for (const rule of negative) {
    if (strictNegative.has(rule.code) && rule.title.test(heading) && rule.body.test(text))
      return result('reject', [rule.code]);
  }
  const signals = positive.filter((rule) => rule.all.every((regex) => regex.test(full)));
  if (signals.length) return result('pass', signals.map((rule) => rule.code));
  // Long or mixed articles are not safe to reject using a short title template.
  if (text.length > 800) return result('uncertain', ['long_or_mixed_article']);
  for (const rule of negative) {
    if (rule.title.test(heading) && rule.body.test(text)) return result('reject', [rule.code]);
  }
  if (text.length <= quoteOnly.maxBodyLength && quoteOnly.title.test(heading) && quoteOnly.body.test(text)
    && !quoteOnly.factCue.test(full)) {
    return result('reject', ['quote_only']);
  }
  return result('uncertain', ['insufficient_evidence']);
}
