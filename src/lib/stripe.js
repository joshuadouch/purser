// Minimal Stripe client over fetch (no SDK), plus webhook signature checks.
import { hmacHex, safeEqual } from "./util.js";

export class StripeError extends Error {
  constructor(message, data) {
    super(message);
    this.data = data;
  }
}

// Stripe wants application/x-www-form-urlencoded with a[b][0]=c style keys.
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? formEncode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(s, method, path, params, idempotencyKey) {
  if (!s.stripe_secret_key) throw new StripeError("Stripe is not set up yet");
  const url = new URL("https://api.stripe.com/v1" + path);
  const init = {
    method,
    headers: { Authorization: `Bearer ${s.stripe_secret_key}`, "Stripe-Version": "2024-06-20" },
  };
  if (params && method === "GET") for (const [k, v] of formEncode(params)) url.searchParams.append(k, v);
  else if (params) {
    init.body = formEncode(params).toString();
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (idempotencyKey) init.headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new StripeError(data?.error?.message || `Stripe answered ${r.status}`, data?.error);
  return data;
}

// Verifies the Stripe-Signature header (t=...,v1=...) against the raw body.
export async function verifyStripeSignature(secret, header, body, toleranceSec = 300, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  const sigs = header.split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  return sigs.some((sig) => safeEqual(sig, expected));
}

export function cardLabel(pm) {
  const c = pm?.card;
  if (!c) return pm?.type ? pm.type.replace(/_/g, " ") : "Saved payment method";
  const brand = c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : "Card";
  return `${brand} ending ${c.last4}, expires ${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}`;
}
