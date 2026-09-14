import { Hono } from "hono";
import type { AppEnv, Bindings } from "../../types";
import { hashPassword, randomId, sha256, verifyPassword } from "./crypto";
import { sendResetEmail } from "./mail";
import { isLocalDevelopmentRuntime } from "../../shared/request";

const COOKIE = "tinfo_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_MS = 10 * 60 * 1000;
type User = { id: string; email: string };
const localLimits = new Map<string, { count: number; expires: number }>();

export function safeReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/";
  const url = new URL(value, "https://tinfo.cc");
  return url.origin === "https://tinfo.cc" && url.pathname !== "/login.html" ? url.pathname + url.search + url.hash : "/";
}

function sessionToken(request: Request): string {
  return request.headers.get("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
}

function cookie(request: Request, token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_MS / 1000 : 0}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

export async function currentUser(request: Request, env: Bindings): Promise<User | null> {
  const token = sessionToken(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare(`SELECT u.id, u.email FROM users u JOIN auth_sessions s ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at_ms > ? AND s.revoked_at_ms IS NULL AND u.disabled_at_ms IS NULL`)
    .bind(await sha256(token), Date.now()).first<User>();
}

export function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  return new Response(null, { status: 302, headers: {
    location: `/login.html?returnTo=${encodeURIComponent(url.pathname + url.search)}`,
    "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

async function limit(request: Request, env: Bindings, reset: boolean): Promise<boolean> {
  const limiter = reset ? env.AUTH_RESET_LIMITER : env.AUTH_LOGIN_LIMITER;
  const key = request.headers.get("cf-connecting-ip") || "local";
  if (env.APP_RUNTIME !== "node") {
    if (!limiter) throw new Error("Authentication rate limiter is not configured");
    return (await limiter.limit({ key })).success;
  }
  const timestamp = Date.now();
  for (const [id, value] of localLimits) if (value.expires <= timestamp) localLimits.delete(id);
  const id = `${reset}:${key}`;
  const value = localLimits.get(id) || { count: 0, expires: timestamp + 60_000 };
  value.count += 1;
  localLimits.set(id, value);
  return value.count <= (reset ? 3 : 30);
}

export const authRoutes = new Hono<AppEnv>();
authRoutes.use("/auth/*", async (c, next) => {
  if (isLocalDevelopmentRuntime(c.env)) return c.json({ error: "登录仅在生产环境提供" }, 404);
  await next();
});
authRoutes.use("/auth/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method === "POST") {
    const origin = c.req.header("origin");
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "请求来源无效" }, 403);
    if (!c.req.header("content-type")?.includes("application/json")) return c.json({ error: "需要 JSON 请求" }, 415);
    if (Number(c.req.header("content-length") || 0) > 8192) return c.json({ error: "请求过大" }, 413);
    if (c.req.path !== "/api/auth/logout" && !await limit(c.req.raw, c.env, c.req.path.endsWith("/password-reset/request"))) return c.json({ error: "操作太频繁，请稍后再试" }, 429);
  }
  await next();
});

authRoutes.get("/auth/me", async (c) => c.json({ user: await currentUser(c.req.raw, c.env) }));
authRoutes.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 6 || password.length > 1024) return c.json({ error: "请输入有效邮箱和至少 6 位密码" }, 400);
  let user = await c.env.DB.prepare("SELECT id, email, password_hash, disabled_at_ms FROM users WHERE email = ?").bind(email)
    .first<User & { password_hash: string; disabled_at_ms: number | null }>();
  if (!user) {
    if (body.password_confirmation === undefined) return c.json({ requires_password_confirmation: true });
    if (typeof body.password_confirmation !== "string" || body.password_confirmation !== password) return c.json({ error: "两次输入的密码不一致" }, 400);
    const timestamp = Date.now();
    const row = { id: crypto.randomUUID(), email, password_hash: await hashPassword(password), disabled_at_ms: null };
    const inserted = await c.env.DB.prepare("INSERT OR IGNORE INTO users(id, email, password_hash, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, row.email, row.password_hash, timestamp, timestamp).run();
    if (!inserted.meta.changes) return c.json({ error: "该邮箱已注册，请登录" }, 409);
    user = row;
  } else if (user.disabled_at_ms !== null || !await verifyPassword(password, user.password_hash)) {
    return c.json({ error: "邮箱或密码错误，请重试" }, 401);
  }
  const token = randomId();
  const timestamp = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND (expires_at_ms <= ? OR revoked_at_ms IS NOT NULL)").bind(user.id, timestamp),
    c.env.DB.prepare("INSERT INTO auth_sessions(token_hash, user_id, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?)").bind(await sha256(token), user.id, timestamp + SESSION_MS, timestamp),
  ]);
  c.header("Set-Cookie", cookie(c.req.raw, token));
  return c.json({ user: { id: user.id, email: user.email } });
});

authRoutes.post("/auth/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(sessionToken(c.req.raw))).run();
  c.header("Set-Cookie", cookie(c.req.raw, ""));
  return c.json({ ok: true });
});

authRoutes.post("/auth/password-reset/request", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  if (!c.env.MAIL_SMTP_HOST || !c.env.MAIL_SMTP_USERNAME || !c.env.MAIL_SMTP_PASSWORD || !c.env.MAIL_FROM_EMAIL) return c.json({ error: "邮件服务暂不可用，请稍后重试" }, 503);
  const user = await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ? AND disabled_at_ms IS NULL").bind(email).first<User>();
  if (user) {
    const token = randomId();
    const tokenHash = await sha256(token);
    await c.env.DB.prepare("UPDATE users SET reset_token_hash = ?, reset_expires_at_ms = ? WHERE id = ?").bind(tokenHash, Date.now() + RESET_MS, user.id).run();
    try { await sendResetEmail(c.env, user.email, token); }
    catch {
      await c.env.DB.prepare("UPDATE users SET reset_token_hash = NULL, reset_expires_at_ms = NULL WHERE id = ? AND reset_token_hash = ?").bind(user.id, tokenHash).run();
      console.error("Password reset email delivery failed");
      return c.json({ error: "邮件发送失败，请稍后重试" }, 503);
    }
  }
  return c.json({ ok: true });
});

authRoutes.post("/auth/password-reset/confirm", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  const password = String(body.password || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || password.length < 6 || password.length > 1024) return c.json({ error: "重置链接或密码无效" }, 400);
  const hash = await sha256(token);
  const passwordHash = await hashPassword(password);
  const timestamp = Date.now();
  // A single transaction serializes confirmation, expiry and concurrent requests.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM auth_sessions WHERE user_id IN
      (SELECT id FROM users WHERE reset_token_hash = ? AND reset_expires_at_ms > ? AND disabled_at_ms IS NULL)`).bind(hash, timestamp),
    c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at_ms = ?, reset_token_hash = NULL, reset_expires_at_ms = NULL
      WHERE reset_token_hash = ? AND reset_expires_at_ms > ? AND disabled_at_ms IS NULL`).bind(passwordHash, timestamp, hash, timestamp),
  ]);
  if (!results[1].meta.changes) return c.json({ error: "重置链接已失效，请重新申请" }, 400);
  c.header("Set-Cookie", cookie(c.req.raw, ""));
  return c.json({ ok: true });
});
