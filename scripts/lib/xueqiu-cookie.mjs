export function cookieHeaderFromCdp(cookies) {
  return cookies
    .filter((cookie) => typeof cookie?.name === "string" && typeof cookie?.value === "string")
    .filter((cookie) => String(cookie.domain ?? "").replace(/^\./, "").endsWith("xueqiu.com"))
    .map((cookie) => [cookie.name.trim(), cookie.value.trim()])
    .filter(([name]) => name)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
