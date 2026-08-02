export function mergeEastmoneyCookies(existingCookie, replacementCookie) {
  const values = new Map();
  const order = [];

  for (const cookie of [existingCookie, replacementCookie]) {
    for (const item of String(cookie ?? "").split(";")) {
      const separator = item.indexOf("=");
      if (separator <= 0) continue;
      const name = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      if (!name) continue;
      if (!values.has(name)) order.push(name);
      values.set(name, value);
    }
  }

  return order.map((name) => `${name}=${values.get(name)}`).join("; ");
}

export function cookiePairFromSetCookie(setCookie) {
  const pair = String(setCookie ?? "").split(";", 1)[0]?.trim() ?? "";
  return pair.includes("=") ? pair : "";
}
