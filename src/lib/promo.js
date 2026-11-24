// Discount codes: checked on the order page, applied to the order's first
// invoice, and (for recurring codes) to the service's renewal price too.
import { all, one } from "./db.js";
import { CYCLES, money, today } from "./util.js";

export const normCode = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40);

const listOf = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// Pence off an amount. Never more than the amount itself.
export function discountOn(promo, amount) {
  if (amount <= 0) return 0;
  const off = promo.kind === "fixed" ? promo.value : Math.round((amount * Math.min(100, Math.max(0, promo.value))) / 100);
  return Math.min(amount, Math.max(0, off));
}

export function describePromo(p) {
  const what = p.kind === "fixed" ? `${money(p.value)} off` : `${p.value}% off`;
  return `${what} ${p.recurring ? "every invoice" : "your first invoice"}`;
}

// Finds a code that may be used for this order. Returns { promo } or { error }.
export async function checkPromo(env, raw, { product, cycle, clientId }) {
  const code = normCode(raw);
  if (!code) return { error: "Enter a discount code." };
  const p = await one(env, "SELECT * FROM promo_codes WHERE code = ?", code);
  const bad = { error: `“${code}” isn't a valid discount code.` };
  if (!p || !p.active) return bad;
  if (p.expires && p.expires < today()) return { error: `“${code}” has expired.` };
  const products = listOf(p.product_ids);
  if (product && products.length && !products.includes(String(product.id))) return { error: `“${code}” can't be used on ${product.name}.` };
  const cycles = listOf(p.cycles);
  if (cycle && cycles.length && !cycles.includes(cycle)) {
    return { error: `“${code}” only works when paying ${cycles.map((c) => CYCLES[c]?.label.toLowerCase() || c).join(" or ")}.` };
  }
  if (p.max_uses > 0 || (p.once_per_client && clientId)) {
    const used = await all(
      env,
      `SELECT r.client_id FROM promo_redemptions r LEFT JOIN services s ON s.id = r.service_id
       WHERE r.promo_id = ? AND (s.id IS NULL OR s.status != 'cancelled')`,
      p.id,
    );
    if (p.max_uses > 0 && used.length >= p.max_uses) return { error: `“${code}” has been fully used.` };
    if (p.once_per_client && clientId && used.some((u) => u.client_id === clientId)) return { error: `You've already used “${code}”.` };
  }
  return { promo: p };
}
