export function isLocalHostHeader(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
}
