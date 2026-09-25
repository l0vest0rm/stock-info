import { createHash } from 'node:crypto';

export const FEED_DEDUPE_VERSION = 'feed-dedupe-v3';

export function canonicalFeedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    // Tencent's SPA article identifier lives in the fragment, not the path.
    if (!/(?:^|[?&])id=/.test(url.hash)) url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|from|source|spm|ref|fbclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

export function normalizedFeedBody(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function feedBodyHash(value) {
  return createHash('sha256').update(comparisonBody(value)).digest('hex');
}

function comparisonBody(value) {
  return normalizedFeedBody(value)
    .replace(/^来源[:：][^\n]{1,40}\n+/u, '')
    .replace(/^[\p{L}]{2,20}(?:新闻)?(?=\d{1,2}月\d{1,2}日(?:电|消息))/u, '')
    .replace(/^\d{1,2}月\d{1,2}日电[,，]?\s*/u, '')
    .replace(/(?:\n\s*)?【来源[:：][^】]{1,40}】\s*$/u, '')
    .replace(/(?:\n\s*)?(?:美股频道更多[^\n]*|责任编辑[:：][^\n]{1,40})\s*$/u, '')
    .trim();
}

export function feedShingleSketch(value) {
  const tokens = shingles(value);
  const result = Array(8).fill(0xffffffff);
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    for (let seed = 0; seed < result.length; seed += 1) {
      const hash = digest.readUInt32BE(seed * 4);
      if (hash < result[seed]) result[seed] = hash;
    }
  }
  return result;
}

export function sketchesOverlap(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 8 || right.length !== 8) return true;
  return left.some((value, index) => value === right[index]);
}

function compact(value) {
  return comparisonBody(value).replace(/[^\p{L}\p{N}%]+/gu, '').toLowerCase();
}

function shingles(value) {
  const body = compact(value);
  const width = Math.min(5, body.length);
  const result = new Set();
  for (let i = 0; i <= body.length - width; i += 1) result.add(body.slice(i, i + width));
  return result;
}

function similarity(left, right) {
  const a = shingles(left), b = shingles(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function protectedTokens(value) {
  const text = comparisonBody(value);
  const patterns = [
    /(?:\d{4}[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?|\d+(?:\.\d+)?\s*(?:亿元|万元|万股|亿股|%|％|元|美元|港元|吨|GW|MW|GWh|年|月|日|季度))/giu,
    /(?:预计|预期|预测|计划|拟|已|实现|完成|未|不|否认|撤回|取消|下调|上调|获批|开工|投产|停产|终止)/gu,
    /\b(?:sh|sz|bj|hk|us)?\d{5,6}\b/giu,
  ];
  return patterns.map((pattern) => [...new Set(text.match(pattern) || [])].sort().join('|')).join('\n');
}

function paragraphs(value) {
  return normalizedFeedBody(value).split(/\n\s*\n|(?<=[。！？!?])(?=\S)/u).map((part) => part.trim()).filter((part) => Boolean(compact(part)));
}

/** Conservative, deterministic classification. Never uses a model or semantic labels. */
export function classifyFeedCandidate(incoming, candidate) {
  const body = normalizedFeedBody(incoming.body);
  const previous = normalizedFeedBody(candidate.body);
  if (!body || !previous) return { kind: 'new', similarity: 0, delta: '' };
  if (feedBodyHash(body) === feedBodyHash(previous)) return { kind: 'repeat', similarity: 1, delta: '' };
  if (compact(body) && compact(body) === compact(previous)) return { kind: 'repeat', similarity: 1, delta: '' };
  const sameIdentity = incoming.sourceKey === candidate.sourceKey && (
    (incoming.sourceItemId && candidate.sourceItemId
      ? incoming.sourceItemId === candidate.sourceItemId
      : canonicalFeedUrl(incoming.url) && canonicalFeedUrl(incoming.url) === canonicalFeedUrl(candidate.url))
  );
  const incomingCodes = new Set(incoming.entityCodes || []);
  const candidateCodes = new Set(candidate.entityCodes || []);
  if (incomingCodes.size && candidateCodes.size && ![...incomingCodes].some((code) => candidateCodes.has(code))) {
    return { kind: 'new', similarity: 0, delta: '' };
  }
  const score = similarity(body, previous);
  const short = Math.min(compact(body).length, compact(previous).length) < 120;
  const sameProtected = protectedTokens(body) === protectedTokens(previous);
  const oldParts = new Set(paragraphs(previous).map(compact));
  const deltaParts = paragraphs(body).filter((part) => !oldParts.has(compact(part)));
  const delta = deltaParts.join('\n\n');
  const deltaRatio = compact(delta).length / Math.max(1, compact(body).length);
  if (sameIdentity && delta && compact(body).includes(compact(previous))) {
    return { kind: 'update', similarity: score, delta };
  }
  // Short dispatches are too easy to collapse accidentally: only exact bodies repeat.
  if (!short && sameProtected && score >= 0.94 && (deltaRatio <= 0.08 ||
    (score >= 0.985 && paragraphs(body).length === paragraphs(previous).length
      && Math.abs(compact(body).length - compact(previous).length) / compact(body).length <= 0.02))) {
    return { kind: 'repeat', similarity: score, delta: '' };
  }
  // Different publishers can report nearly identical prose with conflicting
  // amounts, dates or factual status. Without a shared source identity we
  // cannot prove that one is a revision of the other; keep both visible.
  if (!sameIdentity && !sameProtected) return { kind: 'new', similarity: score, delta: '' };
  // A changed source version or a near-identical long report is an update only
  // when its unchanged body still proves the relationship. Otherwise keep both.
  if (delta && !short && score >= (sameIdentity ? 0.72 : 0.88) && deltaRatio <= 0.35) {
    return { kind: 'update', similarity: score, delta };
  }
  if (sameIdentity && delta && short && (score >= 0.6 ||
    (compact(incoming.title) && compact(incoming.title) === compact(candidate.title)
      && Math.min(compact(body).length, compact(previous).length) >= 8))) {
    return { kind: 'update', similarity: score, delta };
  }
  return { kind: 'new', similarity: score, delta: '' };
}

export function classifyFeedItem(incoming, candidates) {
  let best = { kind: 'new', similarity: 0, delta: '', candidate: null };
  for (const candidate of candidates) {
    const result = classifyFeedCandidate(incoming, candidate);
    if (result.kind === 'repeat') return { ...result, candidate };
    if (result.kind === 'update' && (best.kind !== 'update' || result.similarity > best.similarity)) {
      best = { ...result, candidate };
    }
  }
  return best;
}
