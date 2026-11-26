// First month free, for new customers only.
//
// Monthly: the order invoice is £0 ("First month free"), but nothing is set up
// until the customer saves a card with Stripe (Checkout in setup mode). The
// first real charge is the normal renewal a month later, on that card.
// Yearly: the first year runs 13 months, paid up front as usual.
//
// One free month per person: each one is recorded in free_months with the
// client, a normalised email, the website domain and (monthly) the card's
// Stripe fingerprint. Any match with a free month already used means the
// order goes ahead at the normal price instead.
import { one, run } from "./db.js";
import { addMonths, fmtDate, money } from "./util.js";

export const freeMonthOn = (s) => s.free_month === "1";

// Same person, different spelling: case, +tags, and Gmail's dots.
export function emailKey(email) {
  const [local = "", domain = ""] = String(email || "").trim().toLowerCase().split("@");
  let l = local.replace(/\+.*$/, "");
  let d = domain;
  if (d === "googlemail.com") d = "gmail.com";
  if (d === "gmail.com") l = l.replace(/\./g, "");
  return `${l}@${d}`;
}

const domainOf = (label) => {
  const d = String(label || "").trim().toLowerCase().replace(/^www\./, "");
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d) ? d : "";
};

// Why this order can't have the free month, or "" when it can. The final word
// is had() when the card is known: this check only decides what the order page
// and the first invoice show.
export async function freeMonthBlock(env, s, { product, cycle, client, email, label }) {
  if (!freeMonthOn(s)) return "off";
  if (!product || product.type !== "hosting") return "product";
  if (cycle === "monthly") {
    if (!s.stripe_secret_key) return "stripe";
  } else if (!(cycle === "annually" && s.free_month_annual === "1")) return "cycle";
  if (client) {
    // New customers only: anyone who has had a service set up isn't new.
    const had = await one(env, "SELECT id FROM services WHERE client_id = ? AND start_date IS NOT NULL LIMIT 1", client.id);
    if (had) return "customer";
  }
  if (await used(env, { clientId: client?.id, email: client?.email || email, domain: domainOf(label) })) return "used";
  const domain = domainOf(label);
  if (domain) {
    const hosted = await one(env, "SELECT id FROM services WHERE label = ? AND start_date IS NOT NULL LIMIT 1", domain);
    if (hosted) return "domain";
  }
  return "";
}

// Has a free month been used by this client, email, domain or card?
async function used(env, { clientId, email, domain, fingerprint, exceptId }) {
  const where = [];
  const params = [];
  if (clientId) where.push("client_id = ?"), params.push(clientId);
  if (email) where.push("email_key = ?"), params.push(emailKey(email));
  if (domain) where.push("domain = ?"), params.push(domain);
  if (fingerprint) where.push("card_fingerprint = ?"), params.push(fingerprint);
  if (!where.length) return null;
  return one(
    env,
    `SELECT * FROM free_months WHERE status = 'used' AND id != ? AND (${where.join(" OR ")}) LIMIT 1`,
    exceptId || 0, ...params,
  );
}

export async function recordFreeMonth(env, { client, serviceId, invoiceId, cycle, label, status = "pending" }) {
  await run(
    env,
    `INSERT INTO free_months (client_id, service_id, invoice_id, cycle, email_key, domain, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    client.id, serviceId, invoiceId, cycle, emailKey(client.email), domainOf(label), status, new Date().toISOString(),
  );
}

export const freeMonthFor = (env, invoiceId) => one(env, "SELECT * FROM free_months WHERE invoice_id = ? ORDER BY id DESC LIMIT 1", invoiceId);

// Called once the card is saved: says whether the free month still stands.
// Returns "" when it does, or the reason it doesn't.
export async function finalCheck(env, fm, card) {
  if (card?.funding === "prepaid") return "prepaid";
  const client = await one(env, "SELECT * FROM clients WHERE id = ?", fm.client_id);
  const hit = await used(env, { clientId: fm.client_id, email: client?.email, domain: fm.domain, fingerprint: card?.fingerprint, exceptId: fm.id });
  if (hit) return "used";
  const had = await one(env, "SELECT id FROM services WHERE client_id = ? AND id != ? AND start_date IS NOT NULL LIMIT 1", fm.client_id, fm.service_id);
  return had ? "customer" : "";
}

export const voidFreeMonths = (env, invoiceId, reason) =>
  run(env, "UPDATE free_months SET status = 'void', void_reason = ? WHERE invoice_id = ? AND status = 'pending'", reason, invoiceId);

export const REASONS = {
  used: "a free month has already been used with these details",
  customer: "the free month is for new customers",
  prepaid: "the free month needs a debit or credit card, not a prepaid card",
  domain: "this domain has been hosted with us before",
};

// Order-page wording.
export function offerLines(price, cycle, start) {
  if (cycle === "monthly") return { today: 0, then: `Free until ${fmtDate(addMonths(start, 1))}, then ${money(price)} a month. Cancel before then and you pay nothing.` };
  return { today: price, then: `13 months for the price of 12: your first year runs until ${fmtDate(addMonths(start, 13))}.` };
}
