import { one, run } from "./db.js";
import { b64url, nowIso, randomToken, safeEqual, sha256 } from "./util.js";

const enc = new TextEncoder();
const ITER = 100000; // the most PBKDF2 iterations Workers allows

export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(pw, salt, ITER);
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== "string") return false;
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2") return false;
  const bits = await pbkdf2(pw, unb64url(salt), Number(iter));
  return safeEqual(b64url(bits), hash);
}

async function pbkdf2(pw, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

function unb64url(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const passwordProblem = (pw) =>
  typeof pw !== "string" || pw.length < 10 ? "Use at least 10 characters for your password." : pw.length > 200 ? "That password is too long." : null;

// ---- sessions ----------------------------------------------------------------

export const COOKIE = { client: "purser_c", staff: "purser_a" };
const LIFETIME = { client: 30 * 86400, staff: 12 * 3600 };

export async function createSession(env, req, kind, subjectId, extra = {}) {
  const token = randomToken();
  const expires = new Date(Date.now() + LIFETIME[kind] * 1000).toISOString();
  await run(
    env,
    "INSERT INTO sessions (id, kind, subject_id, csrf, staff_id, pending_2fa, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?,?,?,?,?)",
    await sha256(token), kind, subjectId, randomToken(18), extra.staffId ?? null, extra.pending2fa ? 1 : 0, nowIso(), expires,
    req.headers.get("cf-connecting-ip"), (req.headers.get("user-agent") || "").slice(0, 200),
  );
  return cookie(COOKIE[kind], token, LIFETIME[kind]);
}

export async function readSession(env, req, kind) {
  const token = getCookie(req, COOKIE[kind]);
  if (!token) return null;
  const id = await sha256(token);
  const s = await one(env, "SELECT * FROM sessions WHERE id = ? AND kind = ?", id, kind);
  if (!s || s.expires_at < nowIso()) return null;
  return s;
}

export async function destroySession(env, session, kind) {
  if (session) await run(env, "DELETE FROM sessions WHERE id = ?", session.id);
  return cookie(COOKIE[kind], "", 0);
}

export const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export function getCookie(req, name) {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

// ---- one-time tokens (password reset, email verification, staff setup) -----

export async function makeToken(env, kind, subjectId, hours = 24) {
  const t = randomToken(24);
  await run(
    env, "INSERT INTO tokens (id, kind, subject_id, expires_at) VALUES (?,?,?,?)",
    await sha256(t), kind, subjectId, new Date(Date.now() + hours * 3600000).toISOString(),
  );
  return t;
}

export async function peekToken(env, kind, t) {
  if (!t) return null;
  const row = await one(env, "SELECT * FROM tokens WHERE id = ? AND kind = ?", await sha256(t), kind);
  if (!row || row.used || row.expires_at < nowIso()) return null;
  return row;
}

export async function useToken(env, kind, t) {
  const row = await peekToken(env, kind, t);
  if (!row) return null;
  const r = await run(env, "UPDATE tokens SET used = 1 WHERE id = ? AND used = 0", row.id);
  return r.meta.changes ? row : null;
}

// ---- brute force protection -------------------------------------------------

export async function tooManyAttempts(env, key, limit = 8, minutes = 15) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const r = await one(env, "SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?", key, since);
  return r.n >= limit;
}
export const recordAttempt = (env, key) => run(env, "INSERT INTO login_attempts (key, at) VALUES (?, ?)", key, nowIso());
export const clearAttempts = (env, key) => run(env, "DELETE FROM login_attempts WHERE key = ?", key);

// ---- Turnstile ---------------------------------------------------------------

export async function turnstileOk(s, form, req) {
  if (!s.turnstile_secret || !s.turnstile_site_key) return true;
  const token = form.get("cf-turnstile-response");
  if (!token) return false;
  const body = new FormData();
  body.append("secret", s.turnstile_secret);
  body.append("response", token);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}

// ---- TOTP (RFC 6238) for staff two-factor -------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s) {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export async function totpCode(secret, counter) {
  const key = await crypto.subtle.importKey("raw", b32decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter);
  new DataView(msg).setUint32(0, Math.floor(counter / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}

export async function verifyTotp(secret, code, now = Date.now()) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  const c = Math.floor(now / 30000);
  for (const d of [-1, 0, 1]) if (safeEqual(await totpCode(secret, c + d), code)) return true;
  return false;
}
