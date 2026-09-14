const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000;
export function randomId(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64Url(value);
}

export function bytesToBase64(value: Uint8Array): string {
  let text = "";
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text);
}

export function bytesToBase64Url(value: Uint8Array): string {
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const text = atob(padded);
  return Uint8Array.from(text, (byte) => byte.charCodeAt(0));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256(value: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key).buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password).buffer as ArrayBuffer, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [kind, iterationsText, saltText, hashText] = encoded.split("$");
  const iterations = Number(iterationsText);
  if (kind !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1) return false;
  try {
    const salt = base64ToBytes(saltText);
    const expected = base64ToBytes(hashText);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password).buffer as ArrayBuffer, "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

