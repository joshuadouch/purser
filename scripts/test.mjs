// End-to-end checks without Cloudflare: npm test
// D1 runs on node:sqlite, R2 and email are in-memory fakes, and Stripe, Berth
// and Turnstile are answered by a fake fetch. Walks a client from sign-up to a
// paid, provisioned service, through renewal, overdue suspension and tickets,
// and renders every admin page.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";
import { resetMigrationState } from "../src/lib/migrations.js";
import { runDaily } from "../src/lib/cron.js";
import { loadSettings } from "../src/lib/settings.js";
import { hmacHex } from "../src/lib/util.js";
import { addDays, addMonths, parseMoney, money } from "../src/lib/util.js";
import { totpCode, verifyTotp, hashPassword, verifyPassword } from "../src/lib/auth.js";
import { formEncode } from "../src/lib/stripe.js";
import { esc, html } from "../src/lib/html.js";

// ---- unit checks ----------------------------------------------------------------
assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
assert.equal(addMonths("2026-11-24", 12), "2027-11-24");
assert.equal(parseMoney("£1,234.5"), 123450);
assert.equal(parseMoney("12"), 1200);
assert.equal(parseMoney("-3.05"), -305);
assert.equal(parseMoney("abc"), null);
assert.equal(money(123450), "£1,234.50");
assert.equal(String(html`<b>${"<x>"}</b>`), "<b>&lt;x&gt;</b>");
assert.equal(esc(`"'&`), "&quot;&#39;&amp;");
assert.equal(formEncode({ a: { b: [{ c: 1 }] }, d: "x" }).toString(), "a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x");
assert.ok(await verifyPassword("correct horse battery", await hashPassword("correct horse battery")));
assert.ok(!(await verifyPassword("wrong", await hashPassword("correct horse battery"))));
// RFC 6238 test vector (SHA-1, secret "12345678901234567890", T=59 -> 94287082, 6 digits = 287082)
assert.equal(await totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082");
assert.ok(await verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59000));

// ---- fakes -------------------------------------------------------------------------
function d1(db) {
  const mk = (sql, params = []) => ({
    bind: (...p) => mk(sql, p),
    async first(col) {
      const r = db.prepare(sql).get(...params);
      return r ? (col ? r[col] : { ...r }) : null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params).map((r) => ({ ...r })) };
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
    },
    _exec() {
      return db.prepare(sql).all(...params);
    },
  });
  return {
    prepare: (sql) => mk(sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s._exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const mails = [];
class FakeEmailMessage {
  constructor(from, to, raw) {
    Object.assign(this, { from, to, raw });
  }
}
const qpDecode = (s) => s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const lastMailTo = (to) => [...mails].reverse().find((m) => m.to === to);
const linkIn = (m, re) => {
  const hit = qpDecode(m.raw).match(re);
  assert.ok(hit, `no link ${re} in mail to ${m.to}`);
  return hit[0];
};

const r2 = new Map();
const FILES = {
  async put(k, stream, opts) {
    const buf = Buffer.from(await new Response(stream).arrayBuffer());
    r2.set(k, { buf, type: opts?.httpMetadata?.contentType });
  },
  async get(k) {
    const o = r2.get(k);
    return o ? { body: o.buf } : null;
  },
};

const env = {
  DB: d1(new DatabaseSync(":memory:")),
  FILES,
  MAILER: { send: async (m) => mails.push(m) },
  __EmailMessage: FakeEmailMessage,
  PUBLIC_URL: "https://clientarea.test",
  ADMIN_EMAIL: "owner@purser.test",
};
const ctx = { waitUntil: (p) => p.catch((e) => console.error("waitUntil", e)) };

// Fake Stripe and Berth.
const calls = [];
const berthAccounts = new Map();
const berthPlansPushed = new Map();
let piCounter = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = init.method || "GET";
  const body = init.body ? String(init.body) : "";
  calls.push({ host: url.host, path: url.pathname, method, body });
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
  if (url.host === "api.stripe.com") {
    const p = url.pathname;
    if (p === "/v1/customers" && method === "POST") return j({ id: "cus_test1" });
    if (p.startsWith("/v1/customers/")) return j({ id: "cus_test1" });
    if (p === "/v1/checkout/sessions" && method === "POST") return j({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
    if (p.startsWith("/v1/payment_intents/") && method === "GET") return j({ id: p.split("/").pop(), payment_method: "pm_card_1" });
    if (p.startsWith("/v1/payment_methods/")) return j({ id: "pm_card_1", type: "card", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } });
    if (p === "/v1/payment_intents" && method === "POST") {
      const params = new URLSearchParams(body);
      return j({ id: `pi_auto_${++piCounter}`, status: "succeeded", amount: Number(params.get("amount")), amount_received: Number(params.get("amount")) });
    }
    if (p === "/v1/refunds") return j({ id: "re_1" });
    if (p === "/v1/webhook_endpoints" && method === "GET") return j({ data: [] });
    if (p === "/v1/webhook_endpoints") return j({ id: "we_1", secret: "whsec_new" });
    return j({ error: { message: `unmocked ${method} ${p}` } }, 400);
  }
  if (url.host === "berth.test") {
    const p = url.pathname.replace("/api/provision", "");
    const auth = (init.headers || {}).Authorization;
    if (auth !== "Bearer berth_tok.secret") return j({ error: "bad token" }, 401);
    if (p === "/plans") return j([{ id: "pl1", name: "Starter" }, { id: "pl2", name: "Pro" }]);
    if (p.startsWith("/plans/") && method === "PUT") {
      const b = JSON.parse(body);
      if (b.memory_mb && b.memory_mb < 32) return j({ error: "PHP memory must be at least 32 MB" }, 400);
      berthPlansPushed.set(decodeURIComponent(p.slice(7)), b);
      return j({ id: "plx", ...b });
    }
    if (p === "/accounts" && method === "POST") {
      const b = JSON.parse(body);
      if ([...berthAccounts.values()].some((a) => a.external_id === b.external_id)) return j({ error: "exists", account_id: "acc1" }, 409);
      const acc = { id: `acc${berthAccounts.size + 1}`, email: b.email, plan_id: b.plan, external_id: b.external_id, suspended: false, users: [{ username: "alice" }], sites: [] };
      berthAccounts.set(acc.id, acc);
      return j({ account: acc, username: "alice", password: "GeneratedPw123", login_url: "https://berth.test/login" }, 201);
    }
    const m = p.match(/^\/accounts\/([^/]+)(\/[\w-]+)?$/);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      const acc = ref.startsWith("ext:") ? [...berthAccounts.values()].find((a) => a.external_id === ref.slice(4)) : berthAccounts.get(ref);
      if (!acc) return j({ error: "not found" }, 404);
      if (m[2] === "/suspend") return (acc.suspended = true), j(acc);
      if (m[2] === "/unsuspend") return (acc.suspended = false), j(acc);
      if (m[2] === "/login-link") return j({ url: "https://berth.test/sso/abc" });
      if (m[2] === "/password") return j({ username: "alice", password: "NewPw456" });
      if (method === "PATCH") return Object.assign(acc, JSON.parse(body)), j(acc);
      if (method === "DELETE") return acc.sites.length ? j({ error: "has sites" }, 409) : (berthAccounts.delete(acc.id), j({ status: "deleted" }));
      return j(acc);
    }
  }
  return j({ error: `unmocked ${url}` }, 500);
};

// ---- a tiny browser ----------------------------------------------------------------
function browser() {
  const jar = new Map();
  const req = async (method, path, form, extraHeaders = {}) => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9", ...extraHeaders });
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body;
    if (form) {
      headers.set("origin", "https://clientarea.test");
      headers.set("sec-fetch-site", "same-origin");
      if (form instanceof FormData) body = form;
      else {
        body = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) body.append(k, v);
      }
    }
    const res = await worker.fetch(new Request(`https://clientarea.test${path}`, { method, headers, body }), env, ctx);
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [kv, ...attrs] = sc.split(";");
      const [k, v] = kv.split("=");
      if (/max-age=0/i.test(attrs.join(";"))) jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    res.text_ = await res.text();
    return res;
  };
  const b = {
    jar,
    get: (p) => req("GET", p),
    post: (p, f, h) => req("POST", p, f || {}, h),
    async csrf(path) {
      const r = await b.get(path);
      const m = r.text_.match(/name="_csrf" value="([^"]+)"/);
      assert.ok(m, `no csrf on ${path} (${r.status})`);
      return m[1];
    },
    async submit(pagePath, action, fields = {}) {
      const _csrf = await b.csrf(pagePath);
      return b.post(action, { _csrf, ...fields });
    },
  };
  return b;
}

const ok200 = (r, what) => assert.equal(r.status, 200, `${what}: ${r.status} ${r.text_?.slice(0, 300)}`);
const see = (r, where) => (r.status === 303 ? r.headers.get("location") : assert.fail(`${where}: expected redirect, got ${r.status} ${r.text_.slice(0, 400)}`));

// ---- admin set-up ----------------------------------------------------------------------
const admin = browser();
let r = await admin.get("/admin/login");
ok200(r, "setup page");
assert.match(r.text_, /Email the set-up link/);
r = await admin.post("/admin/setup");
assert.equal(see(r, "setup"), "/admin/login");
const setupLink = linkIn(lastMailTo("owner@purser.test"), /https:\/\/clientarea\.test\/admin\/reset\/[\w-]+/);
r = await admin.post(new URL(setupLink).pathname, { password: "owner-password-1" });
assert.equal(see(r, "set pw"), "/admin/login");
r = await admin.post("/admin/login", { email: "owner@purser.test", password: "wrong-password" });
assert.equal(see(r, "bad login"), "/admin/login");
r = await admin.post("/admin/login", { email: "owner@purser.test", password: "owner-password-1" });
assert.equal(see(r, "login"), "/admin");
ok200(await admin.get("/admin"), "admin dashboard");

// Cross-site POSTs are blocked even with a session.
r = await admin.post("/admin/settings", { tab: "general" }, { "sec-fetch-site": "cross-site" });
assert.equal(r.status, 403);
// POST without the CSRF token is refused.
r = await admin.post("/admin/settings", { tab: "general", company_name: "x" });
assert.equal(r.status, 403);

// Settings: company, Stripe, Berth.
r = await admin.submit("/admin/settings", "/admin/settings", { tab: "general", company_name: "Ratlan Hosting", company_address: "1 High St\nWinchester", allow_registration: "1", brand_color: "#5b3df5" });
assert.equal(see(r, "settings"), "/admin/settings?tab=general");
r = await admin.submit("/admin/settings?tab=payments", "/admin/settings", { tab: "payments", stripe_secret_key: "sk_test_123", currency: "GBP" });
see(r, "stripe key");
r = await admin.submit("/admin/settings?tab=payments", "/admin/settings/stripe-webhook");
see(r, "webhook");
r = await admin.submit("/admin/settings?tab=berth", "/admin/settings", { tab: "berth", berth_url: "https://berth.test/", berth_token: "berth_tok.secret", berth_panel_name: "Berth" });
see(r, "berth");
r = await admin.get("/admin/settings?tab=berth");
assert.match(r.text_, /Connected\. Berth has 2 plans/);
let s = await loadSettings(env);
assert.equal(s.stripe_webhook_secret, "whsec_new");
assert.equal(s.berth_url, "https://berth.test");
// A blank secret keeps the saved one.
await admin.submit("/admin/settings?tab=payments", "/admin/settings", { tab: "payments", stripe_secret_key: "", currency: "GBP" });
assert.equal((await loadSettings(env)).stripe_secret_key, "sk_test_123");

// Product.
r = await admin.get("/admin/products/new");
assert.match(r.text_, /<option value="Starter"/);
r = await admin.submit("/admin/products/new", "/admin/products/new", {
  name: "Starter hosting", description: "1 website\nFree SSL", type: "hosting", berth_plan: "Starter",
  price_monthly: "5", price_annually: "50", setup_fee: "", sort: "1", needs_domain: "1", visible: "1",
});
assert.equal(see(r, "product"), "/admin/products");

// ---- a client signs up and orders ----------------------------------------------------------
const alice = browser();
r = await alice.post("/register", { first_name: "Alice", last_name: "Smith", email: "Alice@Example.com", address1: "2 Low St", city: "Winchester", postcode: "SO23 1AA", country: "United Kingdom", password: "alice-password-1", terms: "1" });
assert.equal(see(r, "register"), "/");
r = await alice.get("/");
ok200(r, "client dashboard");
assert.match(r.text_, /Good (morning|afternoon|evening), Alice/);
const verify = linkIn(lastMailTo("alice@example.com"), /https:\/\/clientarea\.test\/verify\/[\w-]+/);
see(await alice.get(new URL(verify).pathname), "verify");

r = await alice.get("/order");
assert.match(r.text_, /Starter hosting/);
r = await alice.get("/order/1");
// The client area wears the website's header, menu and footer.
assert.match(r.text_, /class="site-head"/);
assert.match(r.text_, /href="https:\/\/ratlan\.net\/hosting\/"/);
assert.match(r.text_, /class="acct-tabs"/);
// Ordering goes straight to card payment.
r = await alice.submit("/order/1", "/order/1", { cycle: "monthly", label: "https://Alice-Shop.co.uk/" });
assert.equal(see(r, "order"), "https://checkout.stripe.test/cs_test_1");
const invId = (await env.DB.prepare("SELECT MAX(id) AS id FROM invoices").first()).id;
const invPath = `/invoices/${invId}`;
r = await alice.get(invPath);
ok200(r, "invoice page");
assert.match(r.text_, /£5\.00 to pay/);
assert.match(r.text_, /alice-shop\.co\.uk/);

// Pay by card: redirected to Stripe Checkout.
r = await alice.submit(invPath, `${invPath}/pay`, { save_card: "1" });
assert.equal(see(r, "pay"), "https://checkout.stripe.test/cs_test_1");

// Stripe calls the webhook (signed).
const webhook = async (event, secret = "whsec_new") => {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(secret, `${t}.${payload}`);
  return worker.fetch(new Request("https://clientarea.test/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": `t=${t},v1=${sig}` } }), env, ctx);
};
const session = {
  id: "cs_test_1", object: "checkout.session", mode: "payment", payment_status: "paid", status: "complete", amount_total: 500,
  payment_intent: "pi_first", metadata: { purser_invoice: String(invId), purser_client: "1", save_card: "1" },
};
assert.equal((await webhook({ type: "checkout.session.completed", data: { object: session } }, "whsec_wrong")).status, 400);
assert.equal((await webhook({ type: "checkout.session.completed", data: { object: session } })).status, 200);
// Stripe retries and the PaymentIntent event arrives too: still one payment.
assert.equal((await webhook({ type: "checkout.session.completed", data: { object: session } })).status, 200);
assert.equal((await webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_first", amount_received: 500, metadata: { purser_invoice: String(invId) } } } })).status, 200);
await new Promise((res) => setTimeout(res, 20));

const q = (sql, ...p) => env.DB.prepare(sql).bind(...p).first();
let inv = await q("SELECT * FROM invoices WHERE id = ?", invId);
assert.equal(inv.status, "paid");
assert.equal(inv.paid, 500);
assert.equal((await q("SELECT COUNT(*) AS n FROM transactions")).n, 1);
let svc = await q("SELECT * FROM services WHERE id = 1");
assert.equal(svc.status, "active");
assert.equal(svc.berth_account, "acc1");
assert.equal(svc.berth_username, "alice");
assert.equal(berthAccounts.get("acc1").plan_id, "Starter");
assert.equal(berthAccounts.get("acc1").external_id, "purser-1");
const client = await q("SELECT * FROM clients WHERE id = 1");
assert.equal(client.stripe_pm, "pm_card_1");
assert.match(client.stripe_pm_label, /Visa ending 4242/);
assert.ok(lastMailTo("alice@example.com").raw.includes("hosting is ready"), "welcome email");

// Client area shows the service and can open Berth.
r = await alice.get("/services/1");
ok200(r, "service page");
assert.match(r.text_, /Log in to Berth/);
r = await alice.submit("/services/1", "/services/1/panel");
assert.equal(see(r, "panel"), "https://berth.test/sso/abc");
// Another client can't see it.
const bob = browser();
see(await bob.post("/register", { first_name: "Bob", last_name: "B", email: "bob@example.com", address1: "x", city: "y", postcode: "z", password: "bob-password-12", terms: "1" }), "bob");
assert.equal((await bob.get("/services/1")).status, 404);
assert.equal((await bob.get(invPath)).status, 404);

// ---- renewal, auto-charge, overdue suspension ------------------------------------------------
s = await loadSettings(env);
const today = new Date().toISOString().slice(0, 10);
const renew = addDays(today, 3);
await env.DB.prepare("UPDATE services SET next_due = ? WHERE id = 1").bind(renew).run();
let report = await runDaily(env, s, ctx, renew);
assert.equal(report.invoices, 1, JSON.stringify(report));
// The saved card was charged on the due date.
inv = await q("SELECT * FROM invoices WHERE id != ? ORDER BY id DESC", invId);
assert.equal(inv.status, "paid", JSON.stringify(report));
svc = await q("SELECT * FROM services WHERE id = 1");
assert.equal(svc.next_due, addMonths(renew, 1));
// Running again doesn't double-invoice.
report = await runDaily(env, s, ctx, renew);
assert.equal(report.invoices, 0);

// Without a card: overdue invoice -> suspended in Berth -> paid -> back on.
await env.DB.prepare("UPDATE clients SET stripe_pm = NULL WHERE id = 1").run();
const due = svc.next_due;
const late = new Date(Date.parse(due) + 8 * 86400000).toISOString().slice(0, 10);
report = await runDaily(env, s, ctx, late);
assert.equal(report.invoices, 1);
assert.equal(report.suspensions, 1, JSON.stringify(report));
svc = await q("SELECT * FROM services WHERE id = 1");
assert.equal(svc.status, "suspended");
assert.equal(berthAccounts.get("acc1").suspended, true);
const overdue = await q("SELECT * FROM invoices WHERE status = 'unpaid' AND client_id = 1");
assert.ok(overdue.reminder_stage >= 2, "overdue reminder sent");
// Admin records a bank payment.
r = await admin.submit(`/admin/invoices/${overdue.id}`, `/admin/invoices/${overdue.id}/payment`, { amount: "5.00", gateway: "bank", reference: "BACS-1" });
see(r, "bank payment");
svc = await q("SELECT * FROM services WHERE id = 1");
assert.equal(svc.status, "active");
assert.equal(berthAccounts.get("acc1").suspended, false);
// Same reference twice is refused.
r = await admin.submit(`/admin/invoices/${overdue.id}`, `/admin/invoices/${overdue.id}/payment`, { amount: "5.00", gateway: "bank", reference: "BACS-1" });

// Credit: admin adds £20; next manual invoice of £12 is paid from credit automatically.
r = await admin.submit("/admin/clients/1?tab=credit", "/admin/clients/1/credit", { amount: "20", description: "Goodwill" });
see(r, "credit");
r = await admin.submit("/admin/invoices/new?client=1", "/admin/invoices/new", { client: "1", desc_0: "Plugin install", amt_0: "12", due: today, email: "1" });
const manual = Number(see(r, "manual invoice").split("/").pop());
assert.equal((await q("SELECT status FROM invoices WHERE id = ?", manual)).status, "paid");
assert.equal((await q("SELECT credit FROM clients WHERE id = 1")).credit, 800);

// Tax applies when switched on.
await admin.submit("/admin/settings?tab=billing", "/admin/settings", { tab: "billing", tax_enabled: "1", tax_label: "VAT", tax_rate: "20", invoice_prefix: "INV-", next_invoice_number: "2000", invoice_days_before: "7", payment_terms_days: "14", reminder_before_days: "3", overdue_reminders: "1,3,7", suspend_after_days: "7", terminate_after_days: "0", auto_charge_retry_days: "3", bank_details: "Sort code 00-00-00" });
r = await admin.submit("/admin/invoices/new?client=2", "/admin/invoices/new", { client: "2", desc_0: "Design work", amt_0: "100", due: today });
const taxed = await q("SELECT * FROM invoices WHERE id = ?", Number(see(r, "taxed").split("/").pop()));
assert.equal(taxed.number, "INV-2000");
assert.equal(taxed.tax, 2000);
assert.equal(taxed.total, 12000);
r = await bob.get(`/invoices/${taxed.id}`);
assert.match(r.text_, /VAT at 20%/);
assert.match(r.text_, /Sort code 00-00-00/);

// ---- cancellation at end of term ---------------------------------------------------------------
r = await alice.submit("/services/1", "/services/1/cancel", { reason: "Moving on" });
see(r, "cancel");
svc = await q("SELECT * FROM services WHERE id = 1");
assert.equal(svc.cancel_at_end, 1);
report = await runDaily(env, s, ctx, svc.next_due);
assert.equal((await q("SELECT status FROM services WHERE id = 1")).status, "cancelled");
assert.ok(!berthAccounts.has("acc1"), "empty Berth account removed");

// ---- tickets ---------------------------------------------------------------------------------------
const fd = new FormData();
fd.append("_csrf", await alice.csrf("/tickets/new"));
fd.append("department", "1");
fd.append("subject", "Site is down <script>");
fd.append("body", "Help!\nhttps://alice-shop.co.uk shows an error");
fd.append("priority", "high");
fd.append("files", new File(["hello"], "error.txt", { type: "text/plain" }));
r = await alice.post("/tickets/new", fd);
const tPath = see(r, "ticket");
r = await alice.get(tPath);
ok200(r, "ticket page");
assert.ok(!r.text_.includes("<script>"), "subject escaped");
assert.match(r.text_, /error\.txt/);
const fileHref = r.text_.match(/href="(\/tickets\/\d+\/files\/\d+)"/)[1];
r = await alice.get(fileHref);
assert.equal(r.text_, "hello");
assert.match(r.headers.get("content-disposition"), /attachment/);
assert.equal((await bob.get(tPath)).status, 404);
assert.equal((await bob.get(fileHref)).status, 404);
const tid = tPath.split("/").pop();
r = await admin.submit(`/admin/tickets/${tid}`, `/admin/tickets/${tid}/reply`, { body: "Internal: check logs", internal: "1", status: "answered" });
see(r, "note");
r = await alice.get(tPath);
assert.ok(!r.text_.includes("check logs"), "internal notes hidden from client");
r = await admin.submit(`/admin/tickets/${tid}`, `/admin/tickets/${tid}/reply`, { body: "Fixed it, try now.", status: "answered" });
see(r, "reply");
await new Promise((res) => setTimeout(res, 20));
assert.ok(qpDecode(lastMailTo("alice@example.com").raw).includes("Fixed it, try now."));
assert.equal((await q("SELECT status FROM tickets WHERE id = ?", tid)).status, "answered");

// ---- every admin page renders -------------------------------------------------------------------------
for (const p of [
  "/admin", "/admin/clients", "/admin/clients?q=alice", "/admin/clients/new", "/admin/clients/1", "/admin/clients/1?tab=details",
  "/admin/clients/1?tab=invoices", "/admin/clients/1?tab=tickets", "/admin/clients/1?tab=credit", "/admin/clients/1?tab=activity",
  "/admin/clients/1/services/new", "/admin/services", "/admin/services?status=all", "/admin/services/1", "/admin/tickets",
  "/admin/tickets?view=all", "/admin/tickets/new", `/admin/tickets/${tid}`, "/admin/invoices", "/admin/invoices?status=all",
  `/admin/invoices/${invId}`, `/admin/invoices/${taxed.id}`, "/admin/invoices/new", "/admin/transactions", "/admin/products",
  "/admin/products/1", "/admin/products/new", "/admin/settings", "/admin/settings?tab=billing", "/admin/settings?tab=payments",
  "/admin/settings?tab=berth", "/admin/settings?tab=support", "/admin/settings?tab=staff", "/admin/activity", "/admin/emails",
  "/admin/me", "/admin/me?setup2fa=1",
]) ok200(await admin.get(p), p);
for (const p of ["/", "/services", "/invoices", "/tickets", "/tickets/new", "/order", "/account", "/account/payment", "/account/security"]) ok200(await alice.get(p), p);

// Existing customer added by staff, linked to an existing Berth account.
berthAccounts.set("acc9", { id: "acc9", users: [{ username: "carol" }], sites: ["carol.test"], suspended: false });
r = await admin.submit("/admin/clients/new", "/admin/clients/new", { first_name: "Carol", email: "carol@example.com", country: "United Kingdom", auto_charge: "1" });
const carolId = Number(see(r, "new client").split("/").pop());
r = await admin.submit(`/admin/clients/${carolId}/services/new`, `/admin/clients/${carolId}/services/new`, { product: "1", cycle: "annually", price: "", label: "carol.test", mode: "existing", next_due: "2027-03-01", berth_account: "acc9" });
const carolSvc = Number(see(r, "existing service").split("/").pop());
svc = await q("SELECT * FROM services WHERE id = ?", carolSvc);
assert.equal(svc.status, "active");
assert.equal(svc.price, 5000);
assert.equal(svc.berth_username, "carol");
assert.equal(berthAccounts.get("acc9").external_id, `purser-${carolSvc}`);
ok200(await admin.get(`/admin/services/${carolSvc}`), "linked service");

// Impersonation, then the client signs out back to admin.
r = await admin.submit(`/admin/clients/${carolId}`, `/admin/clients/${carolId}/impersonate`);
assert.equal(see(r, "impersonate"), "/");
r = await admin.get("/");
assert.match(r.text_, /Signed in as carol@example\.com from the admin area/);

// Not signed in: client pages redirect, admin pages redirect.
const anon = browser();
assert.match(see(await anon.get("/invoices"), "anon"), /^\/login\?next=/);
assert.match(see(await anon.get("/admin/clients"), "anon admin"), /^\/admin\/login\?next=/);
assert.equal((await anon.get("/nope")).status, 404);
// A support-role staff member can't open settings.
await env.DB.prepare("INSERT INTO staff (email, name, password_hash, role, created_at) VALUES ('sup@purser.test','Sup',?, 'support', 'x')").bind(await hashPassword("support-password")).run();
const sup = browser();
see(await sup.post("/admin/login", { email: "sup@purser.test", password: "support-password" }), "support login");
assert.equal((await sup.get("/admin/settings")).status, 403);
ok200(await sup.get("/admin/tickets"), "support tickets");

// ---- ordering from the website without an account --------------------------------------------
r = await admin.submit("/admin/products/new", "/admin/products/new", {
  name: "Plus", slug: "Plus", description: "5 websites\n30 GB storage", type: "hosting", berth_plan: "Starter",
  price_monthly: "2.99", price_annually: "29.90", setup_fee: "", sort: "2", needs_domain: "1", visible: "1",
});
assert.equal(see(r, "slug product"), "/admin/products");
assert.ok(!berthPlansPushed.size, "no limits, nothing sent");
// Limits on a product are sent to Berth as a plan.
const plusId = (await env.DB.prepare("SELECT id FROM products WHERE slug = 'plus'").first()).id;
r = await admin.submit(`/admin/products/${plusId}`, `/admin/products/${plusId}`, {
  name: "Plus", slug: "plus", description: "5 websites", type: "hosting", berth_plan: "Plus", price_monthly: "2.99", price_annually: "29.90",
  sort: "2", needs_domain: "1", visible: "1", lim_max_sites: "5", lim_disk_mb: "30720", lim_memory_mb: "384", lim_ram_mb: "2048", lim_dns_zones: "", lim_allow_shell: "1",
});
see(r, "limits");
assert.deepEqual(berthPlansPushed.get("Plus"), {
  name: "Plus", max_sites: 5, disk_mb: 30720, dns_zones: 0, cpu_percent: 0, ram_mb: 2048, max_processes: 0,
  max_domains: 0, memory_mb: 384, workers: 0, upload_mb: 0, db_connections: 0, allow_shell: true, no_sftp: false,
});
r = await admin.get(`/admin/products/${plusId}`);
assert.match(r.text_, /name="lim_ram_mb" type="number" value="2048"/);
berthPlansPushed.clear();
r = await admin.submit("/admin/products", "/admin/products/push-berth");
assert.match(see(r, "push all"), /\/admin\/products/);
assert.ok(berthPlansPushed.has("Plus"));
r = await admin.submit("/admin/products/new", "/admin/products/new", { name: "Dupe", slug: "plus", price_monthly: "1", type: "other" });
assert.match(see(r, "dupe slug"), /products\/new/);
const guest = browser();
r = await guest.get("/order/plus?cycle=annually");
ok200(r, "guest order page");
assert.match(r.text_, /class="site-head"/);
assert.match(r.text_, /£29\.90/);
assert.match(r.text_, /value="annually" checked/);
assert.match(r.text_, /name="first_name"/);
assert.match(r.text_, /17% less than monthly/);
ok200(await guest.get("/order"), "guest catalogue");
const guestForm = { cycle: "annually", label: "www.dana.dev", first_name: "Dana", last_name: "C", email: "dana@example.com", address1: "3 Mid St", city: "Romsey", postcode: "SO51 1AA", password: "dana-password-1", save_card: "1" };
r = await guest.post("/order/plus", guestForm);
assert.match(see(r, "guest no terms"), /\/order\/plus\?cycle=annually/);
r = await guest.post("/order/plus", { ...guestForm, terms: "1" });
assert.equal(see(r, "guest order"), "https://checkout.stripe.test/cs_test_1");
const webClient = await env.DB.prepare("SELECT * FROM clients WHERE email = 'dana@example.com'").first();
const webSvc = await env.DB.prepare("SELECT s.*, p.slug FROM services s JOIN products p ON p.id = s.product_id WHERE s.client_id = ?").bind(webClient.id).first();
assert.equal(webSvc.slug, "plus");
assert.equal(webSvc.label, "dana.dev");
assert.equal(webSvc.price, 2990);
assert.equal(webSvc.cycle, "annually");
r = await guest.get("/");
ok200(r, "guest is signed in after ordering");
assert.match(r.text_, /Dana/);
// Someone who already has an account is sent to sign in.
r = await browser().post("/order/plus", { ...guestForm, terms: "1" });
assert.match(see(r, "existing email"), /^\/login\?next=/);
// Sign-in page uses the website layout too, staff sign-in doesn't.
assert.match((await browser().get("/login")).text_, /class="site-foot"/);
assert.doesNotMatch((await browser().get("/admin/login")).text_, /class="site-foot"/);

// Migrations are idempotent.
resetMigrationState();
ok200(await alice.get("/"), "after re-migrate");

console.log(`ok: ${mails.length} emails, ${calls.length} outbound calls`);
