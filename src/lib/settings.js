import { all, run } from "./db.js";

// Every setting with its default. Secrets can also come from Worker secrets
// (env var of the same name in upper case), which win over the stored value.
export const DEFAULTS = {
  company_name: "Ratlan",
  // The public website the client area sits inside. When set, client pages and
  // sign-in use the website's header and footer instead of the admin-style sidebar.
  site_url: "https://ratlan.net",
  // Website menu, one "Label|URL" per line. Relative URLs are on site_url.
  site_links: "Hosting|/hosting/\nWordPress|/wordpress/\nEmail|/email/\nFree migration|/migrations/\nHelp|/contact/",
  // Footer links, same format.
  footer_links: "Terms|/legal/terms/\nPrivacy|/legal/privacy/\nAcceptable use|/legal/acceptable-use/\nHelp|/contact/",
  logo_url: "/brand/logo.svg",
  // Where "Get started" goes for signed-out visitors. Relative URLs are on site_url.
  plans_url: "/hosting/#plans",
  company_address: "",
  company_email: "",
  company_vat: "",
  brand_color: "#d93a12",
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
  // First month free for new customers (src/lib/freemonth.js). Monthly orders
  // pay nothing today but must save a card; yearly orders get 13 months.
  free_month: "0",
  free_month_annual: "1",
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
  terms_url: "https://ratlan.net/legal/terms/",
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
