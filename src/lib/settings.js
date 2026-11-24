import { all, run } from "./db.js";

// Every setting with its default. Secrets can also come from Worker secrets
// (env var of the same name in upper case), which win over the stored value.
export const DEFAULTS = {
  company_name: "Ratlan",
  company_address: "",
  company_email: "",
  company_vat: "",
  brand_color: "#5b3df5",
  currency: "GBP",
  tax_enabled: "0",
  tax_rate: "20",
  tax_label: "VAT",
  invoice_prefix: "INV-",
  next_invoice_number: "1001",
  invoice_days_before: "7",
  payment_terms_days: "0",
  reminder_before_days: "3",
  overdue_reminders: "1,3,7",
  suspend_after_days: "7",
  terminate_after_days: "0",
  auto_charge_retry_days: "3",
  auto_apply_credit: "1",
  bank_details: "",
  allow_registration: "1",
  ticket_autoclose_days: "7",
  admin_notify_email: "",
  mail_from_name: "",
  stripe_secret_key: "",
  stripe_webhook_secret: "",
  berth_url: "",
  berth_token: "",
  berth_panel_name: "control panel",
  turnstile_site_key: "",
  turnstile_secret: "",
  terms_url: "",
};

export const SECRET_KEYS = ["stripe_secret_key", "stripe_webhook_secret", "berth_token", "turnstile_secret"];

export async function loadSettings(env) {
  const rows = await all(env, "SELECT key, value FROM settings");
  const s = { ...DEFAULTS };
  for (const r of rows) s[r.key] = r.value;
  for (const k of SECRET_KEYS) {
    const v = env[k.toUpperCase()];
    if (v) s[k] = v;
  }
  if (env.TURNSTILE_SITE_KEY && !s.turnstile_site_key) s.turnstile_site_key = env.TURNSTILE_SITE_KEY;
  if (env.ADMIN_EMAIL && !s.admin_notify_email) s.admin_notify_email = env.ADMIN_EMAIL;
  return s;
}

export async function saveSettings(env, values) {
  const stmts = Object.entries(values)
    .filter(([k]) => k in DEFAULTS)
    .map(([k, v]) =>
      env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, String(v ?? "")),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

// Hands out invoice numbers without gaps or repeats, even with concurrent requests.
export async function nextInvoiceNumber(env, s) {
  await run(env, "INSERT OR IGNORE INTO settings (key, value) VALUES ('next_invoice_number', ?)", s.next_invoice_number);
  const row = await env.DB.prepare(
    "UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'next_invoice_number' RETURNING CAST(value AS INTEGER) - 1 AS n",
  ).first();
  return `${s.invoice_prefix}${row.n}`;
}

export const isSet = (s, k) => Boolean(s[k] && String(s[k]).trim());
