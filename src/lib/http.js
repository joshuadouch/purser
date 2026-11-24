// Routing, request context, redirects with flash messages and guards.
import { html } from "./html.js";
import { readSession, getCookie } from "./auth.js";
import { one, run } from "./db.js";
import { authPage } from "./ui.js";
import { nowIso } from "./util.js";

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, path, ...handlers) {
    const keys = [];
    const re = new RegExp(
      "^" + path.replace(/\/:(\w+)/g, (_, k) => (keys.push(k), "/([^/]+)")) + "/?$",
    );
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add("GET", p, ...h); }
  post(p, ...h) { this.add("POST", p, ...h); }
  match(method, path) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) {
        allowed = true;
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handlers: r.handlers, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

export const FLASH = "purser_f";

export function readFlash(req) {
  const v = getCookie(req, FLASH);
  if (!v) return null;
  try {
    return JSON.parse(atob(v));
  } catch {
    return null;
  }
}

const flashCookie = (msg, t) => `${FLASH}=${btoa(JSON.stringify({ m: msg, t }).replace(/[^\x00-\x7f]/g, ""))}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`;

export function redirect(to, msg, type = "ok", extraCookies = []) {
  const h = new Headers({ Location: to, "cache-control": "no-store" });
  if (msg) h.append("Set-Cookie", flashCookie(msg, type));
  for (const ck of extraCookies) h.append("Set-Cookie", ck);
  return new Response(null, { status: 303, headers: h });
}
export const back = (c, fallback, msg, type) => redirect(safeNext(c.form?.get?.("_back")) || fallback, msg, type);

export function safeNext(n) {
  return typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : null;
}

export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function notFound(c) {
  return withStatus(authPage(c, { title: "Not found", body: html`<p>We couldn't find that page.</p><p><a class="btn" href="/">Go to your dashboard</a></p>` }), 404);
}
export function forbidden(c, msg = "You don't have access to that.") {
  return withStatus(authPage(c, { title: "Not allowed", body: html`<p>${msg}</p><p><a class="btn" href="/">Go back</a></p>` }), 403);
}
export const withStatus = (res, status) => new Response(res.body, { status, headers: res.headers });

// Cross-site POSTs are refused outright; signed-in POSTs also need the session's CSRF token.
export function sameOrigin(c) {
  const site = c.req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.headers.get("origin");
  if (origin && origin !== c.url.origin) return false;
  return true;
}

export async function parseForm(c) {
  if (c.req.method !== "POST") return;
  const ct = c.req.headers.get("content-type") || "";
  if (ct.includes("form")) c.form = await c.req.formData();
  else c.form = new FormData();
}

export function csrfOk(c) {
  return c.req.method !== "POST" || (c.session && c.form?.get("_csrf") === c.session.csrf);
}

export async function requireClient(c) {
  const sess = await readSession(c.env, c.req, "client");
  if (!sess) return redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
  const client = await one(c.env, "SELECT * FROM clients WHERE id = ?", sess.subject_id);
  if (!client || client.status === "closed") return redirect("/login", "That account is closed.", "err");
  c.session = sess;
  c.client = client;
  c.actor = sess.staff_id
    ? { kind: "staff", id: sess.staff_id, name: `staff #${sess.staff_id} as client` }
    : { kind: "client", id: client.id, name: client.email };
  if (!csrfOk(c)) return forbidden(c, "That form expired. Go back, reload the page and try again.");
  const counts = await one(
    c.env,
    `SELECT (SELECT COUNT(*) FROM invoices WHERE client_id = ?1 AND status = 'unpaid') AS unpaid,
            (SELECT COUNT(*) FROM tickets WHERE client_id = ?1 AND status = 'answered') AS answered`,
    client.id,
  );
  c.counts = counts;
}

export async function requireStaff(c) {
  const sess = await readSession(c.env, c.req, "staff");
  if (!sess || sess.pending_2fa) return redirect(`/admin/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
  const staff = await one(c.env, "SELECT * FROM staff WHERE id = ? AND active = 1", sess.subject_id);
  if (!staff) return redirect("/admin/login");
  c.session = sess;
  c.staff = staff;
  c.actor = { kind: "staff", id: staff.id, name: staff.name || staff.email };
  if (!csrfOk(c)) return forbidden(c, "That form expired. Go back, reload the page and try again.");
  c.counts = await one(c.env, "SELECT COUNT(*) AS awaiting FROM tickets WHERE status IN ('open','customer-reply')");
}

export async function requireAdmin(c) {
  if (c.staff?.role !== "admin") return forbidden(c, "Only administrators can do that.");
}

export const touchLogin = (env, table, id) => run(env, `UPDATE ${table} SET last_login = ? WHERE id = ?`, nowIso(), id);
