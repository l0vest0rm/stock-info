export function shouldSearchYahoo(q: string): boolean {
  const trimmed = q.trim();
  return Boolean(trimmed) && !/^\d+$/u.test(trimmed) && !containsHan(trimmed);
}

function containsHan(value: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value);
}
