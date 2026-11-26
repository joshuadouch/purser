// Admin settings: company, billing rules, Stripe, Berth, support departments and staff.
import { html } from "../lib/html.js";
import { all, insert, one, run, update } from "../lib/db.js";
import { redirect, requireAdmin, requireStaff } from "../lib/http.js";
import { adminPage, badge, csrf, field, icon } from "../lib/ui.js";
import { SECRET_KEYS, saveSettings } from "../lib/settings.js";
import { baseUrl, log } from "../lib/billing.js";
import { berth, berthPlans } from "../lib/berth.js";
import { stripe } from "../lib/stripe.js";
import { sendEmail } from "../lib/email.js";
import { sendStaffLink } from "./public.js";
import { ago, clean, int, isEmail, nowIso } from "../lib/util.js";

const TABS = [["general", "Company"], ["brands", "Brands"], ["billing", "Billing"], ["payments", "Stripe"], ["berth", "Berth"], ["support", "Support"], ["staff", "Staff"]];

const secretField = (c, name, label, hint) =>
  field({
    label, name, type: "password", autocomplete: "off",
    placeholder: c.s[name] ? (c.env[name.toUpperCase()] ? "set as a Worker secret" : "saved, leave blank to keep") : "",
    hint, disabled: Boolean(c.env[name.toUpperCase()]),
  });

export default function (r) {
  const S = requireStaff;
  const A = requireAdmin;

  r.get("/admin/settings", S, A, async (c) => {
    const tab = c.url.searchParams.get("tab") || "general";
    const s = c.s;
    let body;
    if (tab === "billing") {
      body = form(c, tab, html`
        <div class="grid2">
          ${field({ label: "Invoice number prefix", name: "invoice_prefix", value: s.invoice_prefix })}
          ${field({ label: "Next invoice number", name: "next_invoice_number", type: "number", value: s.next_invoice_number })}
          ${field({ label: "Raise renewal invoices", name: "invoice_days_before", type: "number", value: s.invoice_days_before, hint: "Days before the due date." })}
          ${field({ label: "Payment terms for manual invoices", name: "payment_terms_days", type: "number", value: s.payment_terms_days, hint: "Days after the invoice date." })}
          ${field({ label: "Reminder before due", name: "reminder_before_days", type: "number", value: s.reminder_before_days, hint: "Days before. 0 for none." })}
          ${field({ label: "Overdue reminders", name: "overdue_reminders", value: s.overdue_reminders, hint: "Days after due, comma separated." })}
          ${field({ label: "Suspend after", name: "suspend_after_days", type: "number", value: s.suspend_after_days, hint: "Days overdue. 0 never suspends." })}
          ${field({ label: "Terminate after", name: "terminate_after_days", type: "number", value: s.terminate_after_days, hint: "Days overdue. Deletes the Berth account and its sites (after a backup). 0 never terminates." })}
          ${field({ label: "Retry failed card payments every", name: "auto_charge_retry_days", type: "number", value: s.auto_charge_retry_days, hint: "Days. Tried 3 times at most." })}
        </div>
        ${field({ type: "checkbox", name: "auto_apply_credit", value: s.auto_apply_credit, label: "Use a client's credit on new invoices automatically" })}
        <fieldset><legend>Tax</legend><div class="grid3">
          ${field({ type: "checkbox", name: "tax_enabled", value: s.tax_enabled, label: "Charge tax" })}
          ${field({ label: "Name", name: "tax_label", value: s.tax_label })}
          ${field({ label: "Rate (%)", name: "tax_rate", type: "number", step: "0.01", value: s.tax_rate })}
        </div></fieldset>
        ${field({ label: "Bank transfer details", name: "bank_details", type: "textarea", rows: 4, value: s.bank_details, optional: true, hint: "Shown on unpaid invoices. Leave blank to hide bank transfer." })}`);
    } else if (tab === "payments") {
      const webhookUrl = `${baseUrl(c.env)}/webhooks/stripe`;
      body = html`${form(c, tab, html`
        <p class="muted">Card payments use Stripe Checkout. Use a restricted or secret key from <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">Stripe → Developers → API keys</a>.</p>
        ${secretField(c, "stripe_secret_key", "Secret key", "Starts with sk_live_ or rk_live_ (sk_test_ for testing).")}
        ${secretField(c, "stripe_webhook_secret", "Webhook signing secret", "Filled in for you by the button below.")}
        ${field({ label: "Currency", name: "currency", type: "select", value: s.currency, options: [["GBP", "GBP (£)"], ["EUR", "EUR (€)"], ["USD", "USD ($)"]] })}`)}
      <section class="card narrow"><div class="card-head"><h3>Webhook</h3>${s.stripe_webhook_secret ? badge("active", "Set") : badge("pending", "Not set")}</div>
        <p class="small">Stripe tells us about payments at <code>${webhookUrl}</code>.</p>
        <form method="post" action="/admin/settings/stripe-webhook">${csrf(c)}<button class="btn" ${s.stripe_secret_key ? "" : "disabled"}>${s.stripe_webhook_secret ? "Recreate webhook" : "Create webhook in Stripe"}</button></form>
      </section>`;
    } else if (tab === "berth") {
      let status = "";
      if (s.berth_url && s.berth_token) {
        try {
          const plans = await berthPlans(s);
          status = html`<div class="notice">${icon("check")}<span>Connected. Berth has ${plans.length} plan${plans.length === 1 ? "" : "s"}: ${plans.map((p) => p.name).join(", ") || "none yet"}.</span></div>`;
        } catch (e) {
          status = html`<div class="notice notice-err">${icon("alert")}<span>Couldn't talk to Berth: ${e.message}</span></div>`;
        }
      }
      body = html`${status}${form(c, tab, html`
        <p class="muted">Paid hosting orders create a Berth account automatically. In Berth go to <b>Settings → API tokens</b> and make a <b>Provisioning</b> token.</p>
        ${field({ label: "Berth address", name: "berth_url", value: s.berth_url, placeholder: "https://panel.example.net", hint: "Must be reachable from the internet (Cloudflare's servers call it)." })}
        ${secretField(c, "berth_token", "Provisioning token", "Starts with berth_.")}
        ${field({ label: "What clients call it", name: "berth_panel_name", value: s.berth_panel_name, hint: "Used on the “Log in to …” button." })}`)}`;
    } else if (tab === "support") {
      const depts = await all(c.env, "SELECT d.*, (SELECT COUNT(*) FROM tickets t WHERE t.department_id = d.id) AS n FROM departments d ORDER BY sort, id");
      body = html`${form(c, tab, html`
        ${field({ label: "Close answered tickets after", name: "ticket_autoclose_days", type: "number", value: s.ticket_autoclose_days, hint: "Days with no client reply. 0 never closes them." })}
        ${field({ label: "Staff notification email", name: "admin_notify_email", type: "email", value: s.admin_notify_email, hint: "New orders, tickets and problems go here, unless a department has its own address." })}`)}
      <section class="card narrow"><div class="card-head"><h3>Departments</h3></div>
        ${depts.map((d) => html`<form method="post" action="/admin/settings/departments" class="dept">${csrf(c)}<input type="hidden" name="id" value="${d.id}">
          <div class="grid3">${field({ label: "Name", name: "name", value: d.name })}${field({ label: "Email new tickets to", name: "email", type: "email", value: d.email, optional: true })}${field({ label: "Order", name: "sort", type: "number", value: d.sort })}</div>
          ${field({ label: "Description", name: "description", value: d.description, optional: true })}
          <div class="btn-row">${field({ type: "checkbox", name: "visible", value: d.visible, label: "Clients can pick it" })}<button class="btn btn-sm">Save</button>${d.n ? "" : html`<button class="btn btn-sm btn-danger-ghost" name="delete" value="1">Delete</button>`}</div></form>`)}
        <form method="post" action="/admin/settings/departments" class="dept">${csrf(c)}<div class="grid3">${field({ label: "New department", name: "name", placeholder: "Name" })}${field({ label: "Email", name: "email", type: "email", optional: true })}<div class="field"><label>&nbsp;</label><button class="btn btn-sm">Add</button></div></div><input type="hidden" name="visible" value="1"></form>
      </section>`;
    } else if (tab === "brands") {
      const brands = await all(c.env, "SELECT b.*, (SELECT COUNT(*) FROM clients WHERE brand = b.slug) AS n FROM brands b ORDER BY name");
      const brandForm = (b = {}) => html`<form method="post" action="/admin/settings/brands" class="stack">${csrf(c)}<input type="hidden" name="old_slug" value="${b.slug || ""}">
        <div class="grid3">${field({ label: "Name", name: "name", value: b.name, required: true })}${field({ label: "Link code", name: "slug", value: b.slug, required: true, hint: b.slug ? html`Links use <code>?brand=${b.slug}</code>` : "Lower case, e.g. purehost." })}${field({ label: "Button colour", name: "brand_color", type: "color", value: b.brand_color || s.brand_color })}</div>
        <div class="grid2">${field({ label: "Website", name: "site_url", type: "url", value: b.site_url, required: true, hint: "Visitors coming from here get this brand too." })}${field({ label: "Logo", name: "logo_url", value: b.logo_url, optional: true })}
        ${field({ label: "Favicon (SVG)", name: "icon_url", value: b.icon_url, optional: true, hint: "favicon-32.png and apple-touch-icon.png sit next to it." })}${field({ label: "Extra stylesheet", name: "stylesheet", value: b.stylesheet, optional: true, hint: "Loaded after the main styles; sets fonts and colours." })}
        ${field({ label: "Own client area address", name: "host", value: b.host, optional: true, placeholder: "clientarea.example.com", hint: "A hostname routed to this Worker. Visits there always get this brand." })}${field({ label: "Control panel address", name: "panel_url", value: b.panel_url, optional: true, placeholder: "https://controlpanel.example.com", hint: "Berth's address for this brand's customers." })}
        ${field({ label: "Get started link", name: "plans_url", value: b.plans_url, optional: true })}${field({ label: "Terms link", name: "terms_url", value: b.terms_url, optional: true })}
        ${field({ label: "Email sender name", name: "mail_from_name", value: b.mail_from_name, optional: true })}${field({ label: "Email logo (PNG)", name: "email_mark", value: b.email_mark, optional: true })}
        ${field({ label: "Website menu", name: "site_links", type: "textarea", rows: 5, value: b.site_links, optional: true, hint: "One Label|URL per line." })}${field({ label: "Footer links", name: "footer_links", type: "textarea", rows: 5, value: b.footer_links, optional: true })}</div>
        <div class="btn-row">${field({ type: "checkbox", name: "active", value: b.slug ? b.active : 1, label: "Active" })}<button class="btn btn-primary btn-sm">${b.slug ? "Save" : "Add brand"}</button>${b.slug ? html`<small class="muted">${b.n} client${b.n === 1 ? "" : "s"}</small>` : ""}</div></form>`;
      body = html`<section class="card narrow"><p class="muted">A brand is another shop front for this client area. Its customers see its name, logo, colours and website links here and in their emails. Billing, Stripe and Berth are shared. Link to the client area with <code>?brand=code</code> on the address; new clients keep the brand they signed up under.</p></section>
        ${brands.map((b) => html`<section class="card narrow"><div class="card-head"><h3>${b.name}</h3>${b.active ? badge("active", "Active") : badge("cancelled", "Off")}</div>${brandForm(b)}</section>`)}
        <section class="card narrow"><div class="card-head"><h3>New brand</h3></div>${brandForm()}</section>`;
    } else if (tab === "staff") {
      const staff = await all(c.env, "SELECT * FROM staff ORDER BY id");
      body = html`<section class="card narrow"><div class="card-head"><h3>Staff</h3></div>
        <div class="list">${staff.map((st) => html`<div class="row"><div><b>${st.name || st.email}</b><small>${st.email} · ${st.role}${st.totp_secret ? " · 2FA on" : ""} · ${st.last_login ? `last in ${ago(st.last_login)}` : "never signed in"}</small></div>
          ${st.id === c.staff.id ? badge("active", "You") : html`<form method="post" action="/admin/settings/staff" class="inline">${csrf(c)}<input type="hidden" name="id" value="${st.id}">
            ${st.active ? html`<button class="btn btn-sm" name="do" value="reset">Send reset</button><button class="btn btn-sm" name="do" value="role">${st.role === "admin" ? "Make support" : "Make admin"}</button><button class="btn btn-sm btn-danger-ghost" name="do" value="disable">Disable</button>` : html`<button class="btn btn-sm" name="do" value="enable">Enable</button>`}</form>`}</div>`)}</div>
      </section>
      <section class="card narrow"><div class="card-head"><h3>Add staff</h3></div><form method="post" action="/admin/settings/staff" class="stack">${csrf(c)}
        <div class="grid3">${field({ label: "Name", name: "name", required: true })}${field({ label: "Email", name: "email", type: "email", required: true })}${field({ label: "Role", name: "role", type: "select", options: [["support", "Support (tickets, clients, invoices)"], ["admin", "Admin (everything)"]] })}</div>
        <button class="btn btn-primary" name="do" value="add">Add and email an invite</button></form></section>`;
    } else {
      body = html`${form(c, "general", html`
        ${field({ label: "Business name", name: "company_name", value: s.company_name, required: true })}
        ${field({ label: "Address", name: "company_address", type: "textarea", rows: 4, value: s.company_address, hint: "Printed on invoices." })}
        <div class="grid2">
          ${field({ label: "Contact email", name: "company_email", type: "email", value: s.company_email, optional: true, hint: "Replies to our emails go here." })}
          ${field({ label: "VAT number", name: "company_vat", value: s.company_vat, optional: true })}
          ${field({ label: "Email sender name", name: "mail_from_name", value: s.mail_from_name, optional: true, hint: "Defaults to the business name." })}
          ${field({ label: "Brand colour", name: "brand_color", type: "color", value: s.brand_color })}
          ${field({ label: "Terms of service link", name: "terms_url", type: "url", value: s.terms_url, optional: true, hint: "Clients agree to it when they register." })}
        </div>
        ${field({ type: "checkbox", name: "allow_registration", value: s.allow_registration, label: "Let new clients create an account (and order without one)" })}
        <fieldset><legend>Website <small class="muted">the client area wears your website's header and footer</small></legend><div class="stack">
          ${field({ label: "Website address", name: "site_url", type: "url", value: s.site_url, optional: true, placeholder: "https://example.net", hint: "Leave blank for the plain sidebar layout." })}
          ${field({ label: "Logo", name: "logo_url", value: s.logo_url, optional: true, hint: "An image address, e.g. /brand/logo.svg. Blank shows the business name." })}
          <div class="grid2">
            ${field({ label: "Menu links", name: "site_links", type: "textarea", rows: 6, value: s.site_links, hint: "One per line: Label|/path or Label|https://…" })}
            ${field({ label: "Footer links", name: "footer_links", type: "textarea", rows: 6, value: s.footer_links, hint: "Same format." })}
          </div>
        </div></fieldset>
        <fieldset><legend>Turnstile <small class="muted">bot check on sign-in and sign-up</small></legend><div class="grid2">
          ${field({ label: "Site key", name: "turnstile_site_key", value: s.turnstile_site_key, optional: true })}
          ${secretField(c, "turnstile_secret", "Secret key")}
        </div></fieldset>`)}
      <section class="card narrow"><div class="card-head"><h3>Test email</h3></div><form method="post" action="/admin/settings/test-email" class="btn-row">${csrf(c)}<button class="btn">${icon("mail")} Send a test to ${c.staff.email}</button></form></section>`;
    }
    return adminPage(c, {
      title: "Settings", active: "settings",
      body: html`<div class="tabs">${TABS.map(([k, l]) => html`<a class="${tab === k ? "on" : ""}" href="?tab=${k}">${l}</a>`)}</div>${body}`,
    });
  });

  const FIELDS = {
    general: ["company_name", "company_address", "company_email", "company_vat", "mail_from_name", "brand_color", "terms_url", "turnstile_site_key", "turnstile_secret", "site_url", "logo_url", "site_links", "footer_links"],
    billing: ["invoice_prefix", "next_invoice_number", "invoice_days_before", "payment_terms_days", "reminder_before_days", "overdue_reminders", "suspend_after_days", "terminate_after_days", "auto_charge_retry_days", "tax_label", "tax_rate", "bank_details"],
    payments: ["stripe_secret_key", "stripe_webhook_secret", "currency"],
    berth: ["berth_url", "berth_token", "berth_panel_name"],
    support: ["ticket_autoclose_days", "admin_notify_email"],
  };
  const CHECKS = { general: ["allow_registration"], billing: ["auto_apply_credit", "tax_enabled"] };

  r.post("/admin/settings", S, A, async (c) => {
    const tab = c.form.get("tab");
    if (!FIELDS[tab]) return redirect("/admin/settings");
    const values = {};
    for (const k of FIELDS[tab]) {
      const v = c.form.get(k);
      if (v === null) continue;
      if (SECRET_KEYS.includes(k) && !String(v).trim()) continue; // blank keeps the saved secret
      values[k] = clean(v, 4000);
    }
    for (const k of CHECKS[tab] || []) values[k] = c.form.get(k) === "1" ? "1" : "0";
    if (values.berth_url) values.berth_url = values.berth_url.replace(/\/+$/, "");
    if (values.berth_url && !/^https?:\/\//.test(values.berth_url)) return redirect(`/admin/settings?tab=${tab}`, "The Berth address should start with https://", "err");
    if (values.next_invoice_number && !/^\d+$/.test(values.next_invoice_number)) return redirect(`/admin/settings?tab=${tab}`, "The next invoice number must be a number.", "err");
    if (values.site_url) values.site_url = values.site_url.replace(/\/+$/, "");
    if (values.site_url && !/^https?:\/\//.test(values.site_url)) return redirect(`/admin/settings?tab=${tab}`, "The website address should start with https://", "err");
    if (values.brand_color && !/^#[0-9a-f]{6}$/i.test(values.brand_color)) delete values.brand_color;
    await saveSettings(c.env, values);
    await log(c.env, c.actor, null, "settings.saved", tab);
    return redirect(`/admin/settings?tab=${tab}`, "Settings saved.");
  });

  r.post("/admin/settings/brands", S, A, async (c) => {
    const f = c.form;
    const back = "/admin/settings?tab=brands";
    const old = clean(f.get("old_slug"), 40);
    const o = { slug: clean(f.get("slug"), 40).toLowerCase(), name: clean(f.get("name"), 80), active: f.get("active") === "1" ? 1 : 0 };
    for (const k of ["host", "panel_url", "site_url", "logo_url", "icon_url", "stylesheet", "brand_color", "plans_url", "terms_url", "mail_from_name", "email_mark"]) o[k] = clean(f.get(k), 500);
    for (const k of ["site_links", "footer_links"]) o[k] = clean(f.get(k), 4000);
    o.site_url = o.site_url.replace(/\/+$/, "");
    o.host = o.host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    o.panel_url = o.panel_url.replace(/\/+$/, "");
    if (o.host && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(o.host)) return redirect(back, "The client area address should be a hostname like clientarea.example.com.", "err");
    if (o.panel_url && !/^https?:\/\//.test(o.panel_url)) return redirect(back, "The control panel address should start with https://", "err");
    if (!/^[a-z0-9-]{2,40}$/.test(o.slug)) return redirect(back, "The link code can only use a-z, 0-9 and dashes.", "err");
    if (!o.name || !/^https?:\/\//.test(o.site_url)) return redirect(back, "A brand needs a name and a website address starting with https://", "err");
    if (!/^#[0-9a-f]{6}$/i.test(o.brand_color)) o.brand_color = "";
    if (o.slug !== old && (await one(c.env, "SELECT slug FROM brands WHERE slug = ?", o.slug))) return redirect(back, "Another brand uses that link code.", "err");
    const cols = Object.keys(o);
    if (old) {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE brands SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE slug = ?`).bind(...cols.map((k) => o[k]), old),
        c.env.DB.prepare("UPDATE clients SET brand = ? WHERE brand = ?").bind(o.slug, old),
      ]);
    } else {
      await run(c.env, `INSERT INTO brands (${cols.join(", ")}, created_at) VALUES (${cols.map(() => "?").join(", ")}, ?)`, ...cols.map((k) => o[k]), nowIso());
    }
    await log(c.env, c.actor, null, "settings.brand", o.slug);
    return redirect(back, "Brand saved.");
  });

  r.post("/admin/settings/stripe-webhook", S, A, async (c) => {
    try {
      const url = `${baseUrl(c.env)}/webhooks/stripe`;
      const existing = await stripe(c.s, "GET", "/webhook_endpoints", { limit: 100 });
      for (const w of existing.data || []) if (w.url === url) await stripe(c.s, "DELETE", `/webhook_endpoints/${w.id}`);
      const wh = await stripe(c.s, "POST", "/webhook_endpoints", {
        url,
        enabled_events: ["checkout.session.completed", "checkout.session.async_payment_succeeded", "payment_intent.succeeded", "charge.dispute.created"],
        description: "Purser client area",
      });
      await saveSettings(c.env, { stripe_webhook_secret: wh.secret });
      await log(c.env, c.actor, null, "settings.stripe_webhook", wh.id);
      return redirect("/admin/settings?tab=payments", "Webhook created and its secret saved.");
    } catch (e) {
      return redirect("/admin/settings?tab=payments", `Stripe said: ${e.message}`, "err");
    }
  });

  r.post("/admin/settings/departments", S, A, async (c) => {
    const f = c.form;
    const id = int(f.get("id"));
    const o = { name: clean(f.get("name"), 80), email: clean(f.get("email"), 254), description: clean(f.get("description"), 200), sort: int(f.get("sort"), 0), visible: f.get("visible") === "1" ? 1 : 0 };
    if (o.email && !isEmail(o.email)) return redirect("/admin/settings?tab=support", "That email doesn't look right.", "err");
    if (id && f.get("delete") === "1") {
      const used = await one(c.env, "SELECT COUNT(*) AS n FROM tickets WHERE department_id = ?", id);
      if (used.n) return redirect("/admin/settings?tab=support", "That department has tickets. Hide it instead.", "err");
      await run(c.env, "DELETE FROM departments WHERE id = ?", id);
      return redirect("/admin/settings?tab=support", "Department deleted.");
    }
    if (!o.name) return redirect("/admin/settings?tab=support", "Give the department a name.", "err");
    if (id) await update(c.env, "departments", id, o);
    else await insert(c.env, "INSERT INTO departments (name, email, description, sort, visible) VALUES (?,?,?,?,?)", o.name, o.email, o.description, o.sort, o.visible);
    return redirect("/admin/settings?tab=support", "Saved.");
  });

  r.post("/admin/settings/staff", S, A, async (c) => {
    const f = c.form;
    const back = "/admin/settings?tab=staff";
    if (f.get("do") === "add") {
      const email = clean(f.get("email"), 254).toLowerCase();
      if (!isEmail(email)) return redirect(back, "Enter a valid email.", "err");
      if (await one(c.env, "SELECT id FROM staff WHERE email = ?", email)) return redirect(back, "They're already staff.", "err");
      const id = await insert(c.env, "INSERT INTO staff (email, name, role, created_at) VALUES (?,?,?,?)", email, clean(f.get("name"), 80), f.get("role") === "admin" ? "admin" : "support", nowIso());
      await sendStaffLink(c, { id, email }, true);
      await log(c.env, c.actor, null, "staff.added", email);
      return redirect(back, `Invite sent to ${email}.`);
    }
    const st = await one(c.env, "SELECT * FROM staff WHERE id = ?", int(f.get("id")));
    if (!st || st.id === c.staff.id) return redirect(back);
    switch (f.get("do")) {
      case "reset":
        await sendStaffLink(c, st, false);
        return redirect(back, `Reset link sent to ${st.email}.`);
      case "role":
        await update(c.env, "staff", st.id, { role: st.role === "admin" ? "support" : "admin" });
        return redirect(back, "Role changed.");
      case "disable":
        await update(c.env, "staff", st.id, { active: 0 });
        await run(c.env, "DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ?", st.id);
        return redirect(back, "Disabled.");
      case "enable":
        await update(c.env, "staff", st.id, { active: 1 });
        return redirect(back, "Enabled.");
    }
    return redirect(back);
  });

  r.post("/admin/settings/test-email", S, A, async (c) => {
    const ok = await sendEmail(c.env, c.s, { to: c.staff.email, subject: "Test email from the client area", lines: ["If you can read this, email sending works."] });
    return redirect("/admin/settings", ok ? `Sent to ${c.staff.email}.` : "It didn't send. See the email log for why.", ok ? "ok" : "err");
  });
}

function form(c, tab, inner) {
  return html`<section class="card narrow"><form method="post" action="/admin/settings" class="stack">${csrf(c)}<input type="hidden" name="tab" value="${tab}">${inner}<div><button class="btn btn-primary">Save</button></div></form></section>`;
}
