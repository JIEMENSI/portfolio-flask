import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../shared/types";
import { randomHex } from "../shared/ids";

const COOKIE_NAME = "__Host-admin_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string) => {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) throw new Error("INVALID_HEX");
  return Uint8Array.from(value.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16));
};

const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function verifyPassword(encoded: string | undefined, password: string): Promise<boolean> {
  if (!encoded) return false;
  const [scheme, iterationsText, saltHex, expected] = encoded.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2" || !saltHex || !expected || !Number.isInteger(iterations) || iterations < 100_000) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations }, key, 256
  );
  return safeEqual(hex(derived), expected.toLowerCase());
}

type AdminContext = Context<{ Bindings: Env }>;

async function findSession(context: AdminContext) {
  const token = getCookie(context, COOKIE_NAME);
  if (!token || !context.env.SESSION_PEPPER) return null;
  const tokenHash = await sha256(`${token}:${context.env.SESSION_PEPPER}`);
  return context.env.DB.prepare("SELECT id, csrf_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, new Date().toISOString()).first<{ id: string; csrf_hash: string }>();
}

export async function login(context: AdminContext): Promise<Response> {
  const body: { password?: string } = await context.req.json<{ password?: string }>().catch(() => ({}));
  if (!await verifyPassword(context.env.ADMIN_PASSWORD_HASH, body.password ?? "")) {
    return context.json({ error: "账号或密码错误" }, 401);
  }
  if (!context.env.SESSION_PEPPER) return context.json({ error: "服务未配置" }, 503);

  const token = randomHex(32);
  const csrfToken = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  await context.env.DB.prepare(`INSERT INTO admin_sessions
    (id, token_hash, csrf_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), await sha256(`${token}:${context.env.SESSION_PEPPER}`), await sha256(csrfToken),
      now.toISOString(), expires.toISOString(), now.toISOString()).run();
  setCookie(context, COOKIE_NAME, token, {
    httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_SECONDS
  });
  return context.json({ csrfToken });
}

export async function requireAdmin(context: AdminContext): Promise<{ id: string; csrf_hash: string } | Response> {
  const session = await findSession(context);
  return session ?? context.json({ error: "需要管理员登录" }, 401);
}

export async function requireCsrf(context: AdminContext, session: { csrf_hash: string }): Promise<Response | null> {
  const supplied = context.req.header("X-CSRF-Token");
  if (!supplied || !safeEqual(await sha256(supplied), session.csrf_hash)) {
    return context.json({ error: "CSRF验证失败" }, 403);
  }
  return null;
}

export async function logout(context: AdminContext): Promise<Response> {
  const session = await requireAdmin(context);
  if (session instanceof Response) return session;
  const csrfError = await requireCsrf(context, session);
  if (csrfError) return csrfError;
  await context.env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(session.id).run();
  deleteCookie(context, COOKIE_NAME, { path: "/", secure: true });
  return context.json({ ok: true });
}
