// Admin: dashboard, clients, services, activity, email log and own account.
import { html, raw, textBlock } from "../lib/html.js";
import { all, insert, one, run, update } from "../lib/db.js";
import { createSession, hashPassword, newTotpSecret, passwordProblem, verifyPassword, verifyTotp } from "../lib/auth.js";
import { notFound, redirect, requireAdmin, requireStaff } from "../lib/http.js";
import { adminPage, badge, csrf, cycleLabel, dateCell, empty, field, icon, invoiceBadge, pager, pageOffset, priceLabel, stat } from "../lib/ui.js";
import {
  addCredit, baseUrl, createInvoice, getService, log, placeOrder, productCycles, productPrice, provisionService, suspendService,
  terminateService, unsuspendService,
} from "../lib/billing.js";
import { accountRef, berth, berthReady, externalId } from "../lib/berth.js";
import { sendReset } from "./public.js";
import { CYCLES, addDays, ago, clean, cycleEnd, fmtDate, fmtDateTime, fullName, int, isEmail, money, nowIso, parseMoney, today } from "../lib/util.js";

export default function (r) {
  const S = requireStaff;
  const A = requireAdmin;

  r.get("/admin", S, async (c) => {
    const t = today();
    const monthStart = t.slice(0, 8) + "01";
    const [k, overdue, awaiting, problems, recent] = await Promise.all([
      one(
        c.env,
        `SELECT
          (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE gateway != 'credit' AND created_at >= ?1) AS income_month,
          (SELECT COALESCE(SUM(total - paid),0) FROM invoices WHERE status = 'unpaid') AS outstanding,
          (SELECT COALESCE(SUM(total - paid),0) FROM invoices WHERE status = 'unpaid' AND due < ?2) AS overdue,
          (SELECT COUNT(*) FROM services WHERE status = 'active') AS active,
          (SELECT COUNT(*) FROM clients WHERE status = 'active') AS clients,
          (SELECT COALESCE(SUM(CASE cycle WHEN 'monthly' THEN price WHEN 'quarterly' THEN price / 3.0 WHEN 'annually' THEN price / 12.0 ELSE 0 END),0)
             FROM services WHERE status IN ('active','suspended') AND cancel_at_end = 0) AS mrr`,
        monthStart, t,
      ),
      all(c.env, "SELECT i.*, cl.email, cl.company FROM invoices i JOIN clients cl ON cl.id = i.client_id WHERE i.status = 'unpaid' AND i.due < ? ORDER BY i.due LIMIT 8", t),
      all(c.env, "SELECT t.*, cl.email FROM tickets t JOIN clients cl ON cl.id = t.client_id WHERE t.status IN ('open','customer-reply') ORDER BY CASE t.priority WHEN 'high' THEN 0 ELSE 1 END, t.updated_at LIMIT 8"),
      all(c.env, "SELECT s.*, p.name AS product_name, cl.email FROM services s JOIN products p ON p.id = s.product_id JOIN clients cl ON cl.id = s.client_id WHERE (s.provision_error IS NOT NULL AND s.status = 'active') OR (s.cancel_at_end = 1 AND s.status = 'active') ORDER BY s.next_due LIMIT 8"),
      all(c.env, "SELECT * FROM activity ORDER BY id DESC LIMIT 10"),
    ]);
    const setup = [];
    if (!c.s.stripe_secret_key) setup.push(["Connect Stripe to take card payments", "/admin/settings?tab=payments"]);
    else if (!c.s.stripe_webhook_secret) setup.push(["Create the Stripe webhook so payments are recorded", "/admin/settings?tab=payments"]);
    if (!berthReady(c.s)) setup.push(["Connect Berth so hosting orders are set up automatically", "/admin/settings?tab=berth"]);
    if (!(await one(c.env, "SELECT COUNT(*) AS n FROM products")).n) setup.push(["Add your first product", "/admin/products/new"]);
    if (!c.s.company_address) setup.push(["Add your business address for invoices", "/admin/settings"]);
    return adminPage(c, {
      title: "Dashboard", active: "home",
      body: html`
      <section class="hero"><div><h2>${c.s.company_name}</h2><p>${k.clients} client${k.clients === 1 ? "" : "s"} · ${k.active} active service${k.active === 1 ? "" : "s"} · ${money(Math.round(k.mrr))} a month recurring</p></div>
        <a class="btn btn-light" href="/admin/clients/new">${icon("plus")} New client</a></section>
      ${setup.length ? html`<section class="card setup"><div class="card-head"><h3>Finish setting up</h3></div><div class="list">${setup.map(([l, h]) => html`<a class="row" href="${h}"><div>${l}</div><span>→</span></a>`)}</div></section>` : ""}
      <div class="stats">
        ${stat("pound", "green", "Income this month", money(k.income_month), "card, bank and other payments", "/admin/transactions")}
        ${stat("file", "amber", "Outstanding", money(k.outstanding), `${money(k.overdue)} overdue`, "/admin/invoices?status=unpaid")}
        ${stat("help", "teal", "Tickets waiting", awaiting.length, "open or customer reply", "/admin/tickets")}
        ${stat("server", "purple", "Active services", k.active, `${money(Math.round(k.mrr))} MRR`, "/admin/services")}
      </div>
      <div class="cols">
        <section class="card"><div class="card-head"><h3>Tickets waiting</h3><a href="/admin/tickets">All tickets</a></div>
          ${awaiting.length ? html`<div class="list">${awaiting.map((t) => html`<a class="row" href="/admin/tickets/${t.id}"><div><b>${t.subject}</b><small>${t.email} · ${ago(t.updated_at)}</small></div>${badge(t.status)}</a>`)}</div>` : empty("Nobody's waiting on you.")}</section>
        <section class="card"><div class="card-head"><h3>Overdue invoices</h3><a href="/admin/invoices?status=overdue">All overdue</a></div>
          ${overdue.length ? html`<div class="list">${overdue.map((i) => html`<a class="row" href="/admin/invoices/${i.id}"><div><b>${i.number}</b><small>${i.company || i.email} · due ${fmtDate(i.due)}</small></div><b>${money(i.total - i.paid)}</b></a>`)}</div>` : empty("Nothing overdue.")}</section>
      </div>
      ${problems.length ? html`<section class="card"><div class="card-head"><h3>Needs attention</h3></div><div class="list">${problems.map((s) => html`<a class="row" href="/admin/services/${s.id}"><div><b>${s.product_name}${s.label ? ` · ${s.label}` : ""}</b><small>${s.email} · ${s.provision_error ? `set-up failed: ${s.provision_error}` : `cancels ${fmtDate(s.next_due)}`}</small></div>${s.provision_error ? badge("failed") : badge("cancelled", "Cancelling")}</a>`)}</div></section>` : ""}
      <section class="card"><div class="card-head"><h3>Recent activity</h3><a href="/admin/activity">All activity</a></div>${activityList(recent)}</section>`,
    });
  });

  // ---- clients -----------------------------------------------------------------
  r.get("/admin/clients", S, async (c) => {
    const q = clean(c.url.searchParams.get("q"), 100);
    const like = `%${q}%`;
    const where = q ? "WHERE email LIKE ?1 OR first_name LIKE ?1 OR last_name LIKE ?1 OR company LIKE ?1 OR (first_name || ' ' || last_name) LIKE ?1" : "";
    const params = q ? [like] : [];
    const total = (await one(c.env, `SELECT COUNT(*) AS n FROM clients ${where}`, ...params)).n;
    const rows = await all(
      c.env,
      `SELECT c.*, (SELECT COUNT(*) FROM services s WHERE s.client_id = c.id AND s.status = 'active') AS active,
        (SELECT COALESCE(SUM(total - paid),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'unpaid') AS owed
       FROM clients c ${where} ORDER BY c.id DESC LIMIT 50 OFFSET ${pageOffset(c, 50)}`,
      ...params,
    );
    return adminPage(c, {
      title: "Clients", active: "clients",
      topActions: html`<a class="btn btn-primary btn-sm" href="/admin/clients/new">${icon("plus")}<span class="hide-sm">New client</span></a>`,
      body: html`<form class="search" method="get"><input type="search" name="q" value="${q}" placeholder="Search by name, company or email"><button class="btn">Search</button></form>
      <section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Client</th><th class="hide-sm">Services</th><th class="num">Owes</th><th class="hide-sm">Since</th><th>Status</th></tr></thead><tbody>
      ${rows.map((x) => html`<tr data-href="/admin/clients/${x.id}"><td><a href="/admin/clients/${x.id}"><b>${x.company || fullName(x)}</b></a><small class="block muted">${x.email}</small></td><td class="hide-sm">${x.active}</td><td class="num">${x.owed ? money(x.owed) : "—"}</td><td class="hide-sm">${dateCell(x.created_at)}</td><td>${badge(x.status)}</td></tr>`)}
      </tbody></table>${pager(c, total, 50)}` : empty(q ? "No clients match that." : "No clients yet.")}</section>`,
    });
  });

  const clientForm = (c, x = {}) => html`
    ${field({ label: "First name", name: "first_name", value: x.first_name, required: true })}
    ${field({ label: "Last name", name: "last_name", value: x.last_name })}
    ${field({ label: "Email", name: "email", type: "email", value: x.email, required: true, wide: true })}
    ${field({ label: "Company", name: "company", value: x.company, optional: true, wide: true })}
    ${field({ label: "Address", name: "address1", value: x.address1, wide: true })}
    ${field({ label: "Address line 2", name: "address2", value: x.address2, optional: true, wide: true })}
    ${field({ label: "Town or city", name: "city", value: x.city })}
    ${field({ label: "County", name: "region", value: x.region, optional: true })}
    ${field({ label: "Postcode", name: "postcode", value: x.postcode })}
    ${field({ label: "Country", name: "country", value: x.country || "United Kingdom" })}
    ${field({ label: "Phone", name: "phone", value: x.phone, optional: true })}
    ${field({ label: "VAT number", name: "vat_number", value: x.vat_number, optional: true })}
    <div class="wide">${field({ label: "Private notes", name: "notes", type: "textarea", rows: 3, value: x.notes, optional: true, hint: "Only staff see these." })}</div>
    ${field({ type: "checkbox", name: "tax_exempt", value: x.tax_exempt, label: "Don't charge tax" })}
    ${field({ type: "checkbox", name: "auto_charge", value: x.auto_charge ?? 1, label: "Charge saved card automatically" })}`;

  const clientFields = (f) => {
    const o = {};
    for (const k of ["first_name", "last_name", "company", "address1", "address2", "city", "region", "postcode", "country", "phone", "vat_number"]) o[k] = clean(f.get(k), 200);
    o.notes = clean(f.get("notes"), 5000);
    o.tax_exempt = f.get("tax_exempt") === "1" ? 1 : 0;
    o.auto_charge = f.get("auto_charge") === "1" ? 1 : 0;
    return o;
  };

  r.get("/admin/clients/new", S, (c) =>
    adminPage(c, {
      title: "New client", active: "clients",
      body: html`<section class="card narrow"><form method="post" class="grid2">${csrf(c)}${clientForm(c)}
        <div class="wide">${field({ type: "checkbox", name: "send_welcome", value: 1, label: "Email them a link to set their password" })}</div>
        <div class="wide"><button class="btn btn-primary">Create client</button></div></form></section>`,
    }),
  );

  r.post("/admin/clients/new", S, async (c) => {
    const email = clean(c.form.get("email"), 254).toLowerCase();
    if (!isEmail(email)) return redirect("/admin/clients/new", "Enter a valid email.", "err");
    if (await one(c.env, "SELECT id FROM clients WHERE email = ?", email)) return redirect("/admin/clients/new", "A client with that email exists.", "err");
    const o = { ...clientFields(c.form), email, email_verified: 0, created_at: nowIso() };
    const keys = Object.keys(o);
    const id = await insert(c.env, `INSERT INTO clients (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => o[k]));
    await log(c.env, c.actor, id, "client.created", email);
    const client = await one(c.env, "SELECT * FROM clients WHERE id = ?", id);
    if (c.form.get("send_welcome") === "1") await sendWelcome(c, client);
    return redirect(`/admin/clients/${id}`, "Client created.");
  });

  r.get("/admin/clients/:id", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ?", Number(c.params.id));
    if (!x) return notFound(c);
    const tab = c.url.searchParams.get("tab") || "summary";
    const [services, invoices, tickets, credit, activity] = await Promise.all([
      all(c.env, "SELECT s.*, p.name AS product_name FROM services s JOIN products p ON p.id = s.product_id WHERE s.client_id = ? ORDER BY s.status IN ('terminated','cancelled'), s.id DESC", x.id),
      all(c.env, "SELECT * FROM invoices WHERE client_id = ? ORDER BY id DESC LIMIT 100", x.id),
      all(c.env, "SELECT * FROM tickets WHERE client_id = ? ORDER BY updated_at DESC LIMIT 50", x.id),
      all(c.env, "SELECT * FROM credit_log WHERE client_id = ? ORDER BY id DESC LIMIT 50", x.id),
      all(c.env, "SELECT * FROM activity WHERE client_id = ? ORDER BY id DESC LIMIT 50", x.id),
    ]);
    const owed = invoices.filter((i) => i.status === "unpaid").reduce((a, i) => a + i.total - i.paid, 0);
    const tabs = [["summary", "Summary"], ["details", "Details"], ["invoices", `Invoices (${invoices.length})`], ["tickets", `Tickets (${tickets.length})`], ["credit", "Credit"], ["activity", "Activity"]];
    let body;
    if (tab === "details") {
      body = html`<section class="card narrow"><form method="post" class="grid2">${csrf(c)}${clientForm(c, x)}
        <div class="wide"><button class="btn btn-primary">Save</button></div></form></section>`;
    } else if (tab === "invoices") {
      body = html`<section class="card"><div class="card-head"><h3>Invoices</h3><a class="btn btn-sm" href="/admin/invoices/new?client=${x.id}">${icon("plus")} New invoice</a></div>${invoiceTable(invoices)}</section>`;
    } else if (tab === "tickets") {
      body = html`<section class="card"><div class="card-head"><h3>Tickets</h3><a class="btn btn-sm" href="/admin/tickets/new?client=${x.id}">${icon("plus")} New ticket</a></div>
      ${tickets.length ? html`<div class="list">${tickets.map((t) => html`<a class="row" href="/admin/tickets/${t.id}"><div><b>${t.subject}</b><small>#${t.id} · ${ago(t.updated_at)}</small></div>${badge(t.status)}</a>`)}</div>` : empty("No tickets.")}</section>`;
    } else if (tab === "credit") {
      body = html`<div class="cols"><section class="card"><div class="card-head"><h3>Credit balance</h3><b>${money(x.credit)}</b></div>
        ${credit.length ? html`<div class="list">${credit.map((l) => html`<div class="row"><div>${l.description}<small>${fmtDateTime(l.created_at)}</small></div><b class="${l.amount < 0 ? "neg" : "pos"}">${money(l.amount)}</b></div>`)}</div>` : empty("No credit history.")}</section>
        <section class="card"><div class="card-head"><h3>Add or remove credit</h3></div><form method="post" action="/admin/clients/${x.id}/credit" class="stack">${csrf(c)}
          ${field({ label: "Amount", name: "amount", type: "money", required: true, hint: "Use a minus sign to remove credit." })}
          ${field({ label: "Reason", name: "description", required: true })}
          <button class="btn btn-primary">Save</button></form></section></div>`;
    } else if (tab === "activity") {
      body = html`<section class="card">${activityList(activity)}</section>`;
    } else {
      body = html`<div class="cols cols-wide"><div>
        <section class="card"><div class="card-head"><h3>Services</h3><a class="btn btn-sm" href="/admin/clients/${x.id}/services/new">${icon("plus")} Add service</a></div>
          ${services.length ? html`<table class="table"><thead><tr><th>Service</th><th class="hide-sm">Price</th><th class="hide-sm">Next due</th><th>Status</th></tr></thead><tbody>${services.map((s) => html`<tr data-href="/admin/services/${s.id}"><td><a href="/admin/services/${s.id}"><b>${s.product_name}</b></a><small class="block muted">${s.label}</small></td><td class="hide-sm">${priceLabel(s.price, s.cycle)}</td><td class="hide-sm">${s.next_due ? dateCell(s.next_due) : "—"}</td><td>${badge(s.status)}</td></tr>`)}</tbody></table>` : empty("No services.")}
        </section>
        <section class="card"><div class="card-head"><h3>Recent invoices</h3><a href="?tab=invoices">All</a></div>${invoiceTable(invoices.slice(0, 5))}</section>
      </div><aside>
        <section class="card"><div class="card-head"><h3>${x.company || fullName(x)}</h3>${badge(x.status)}</div>
          <dl class="dl dl-tight"><dt>Email</dt><dd>${x.email} ${x.email_verified ? "" : html`<small class="muted">(unconfirmed)</small>`}</dd>${x.phone ? html`<dt>Phone</dt><dd>${x.phone}</dd>` : ""}
          <dt>Owes</dt><dd>${money(owed)}</dd><dt>Credit</dt><dd>${money(x.credit)}</dd><dt>Card</dt><dd>${x.stripe_pm_label || "none"}${x.stripe_pm && !x.auto_charge ? " (not auto-charged)" : ""}</dd>
          <dt>Last sign-in</dt><dd>${x.last_login ? ago(x.last_login) : "never"}</dd><dt>Client since</dt><dd>${fmtDate(x.created_at)}</dd></dl>
          ${x.notes ? html`<div class="note">${textBlock(x.notes)}</div>` : ""}
        </section>
        <section class="card"><div class="actions-col">
          <form method="post" action="/admin/clients/${x.id}/impersonate" target="_blank">${csrf(c)}<button class="btn btn-block">${icon("external")} Log in as client</button></form>
          <form method="post" action="/admin/clients/${x.id}/reset">${csrf(c)}<button class="btn btn-block">${icon("key")} ${x.password_hash ? "Email password reset" : "Email set-password link"}</button></form>
          <a class="btn btn-block" href="/admin/invoices/new?client=${x.id}">${icon("file")} New invoice</a>
          <a class="btn btn-block" href="/admin/tickets/new?client=${x.id}">${icon("help")} New ticket</a>
          <form method="post" action="/admin/clients/${x.id}/status" data-confirm="${x.status === "active" ? "Close this account? They won't be able to sign in." : "Reopen this account?"}">${csrf(c)}<button class="btn btn-block ${x.status === "active" ? "btn-danger-ghost" : ""}">${x.status === "active" ? "Close account" : "Reopen account"}</button></form>
        </div></section>
      </aside></div>`;
    }
    return adminPage(c, {
      title: x.company || fullName(x), active: "clients",
      body: html`<div class="tabs">${tabs.map(([k, l]) => html`<a class="${tab === k ? "on" : ""}" href="?tab=${k}">${l}</a>`)}</div>${body}`,
    });
  });

  r.post("/admin/clients/:id", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ?", Number(c.params.id));
    if (!x) return notFound(c);
    const o = clientFields(c.form);
    const email = clean(c.form.get("email"), 254).toLowerCase();
    if (!isEmail(email)) return redirect(`/admin/clients/${x.id}?tab=details`, "Enter a valid email.", "err");
    if (email !== x.email.toLowerCase()) {
      if (await one(c.env, "SELECT id FROM clients WHERE email = ? AND id != ?", email, x.id)) return redirect(`/admin/clients/${x.id}?tab=details`, "Another client has that email.", "err");
      o.email = email;
    }
    await update(c.env, "clients", x.id, o);
    await log(c.env, c.actor, x.id, "client.updated", "Details edited by staff");
    return redirect(`/admin/clients/${x.id}?tab=details`, "Saved.");
  });

  r.post("/admin/clients/:id/credit", S, async (c) => {
    const id = Number(c.params.id);
    const amount = parseMoney(c.form.get("amount"));
    const desc = clean(c.form.get("description"), 200);
    if (!amount || !desc) return redirect(`/admin/clients/${id}?tab=credit`, "Enter an amount and reason.", "err");
    const x = await one(c.env, "SELECT credit FROM clients WHERE id = ?", id);
    if (x.credit + amount < 0) return redirect(`/admin/clients/${id}?tab=credit`, "That would take the balance below zero.", "err");
    await addCredit(c.env, id, amount, desc, c.actor);
    return redirect(`/admin/clients/${id}?tab=credit`, "Credit updated.");
  });

  r.post("/admin/clients/:id/impersonate", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ? AND status = 'active'", Number(c.params.id));
    if (!x) return notFound(c);
    await log(c.env, c.actor, x.id, "client.impersonated", `by ${c.staff.email}`);
    const ck = await createSession(c.env, c.req, "client", x.id, { staffId: c.staff.id });
    return redirect("/", null, "ok", [ck]);
  });

  r.post("/admin/clients/:id/reset", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ?", Number(c.params.id));
    if (!x) return notFound(c);
    if (x.password_hash) await sendReset(c, x);
    else await sendWelcome(c, x);
    await log(c.env, c.actor, x.id, "client.reset_sent");
    return redirect(`/admin/clients/${x.id}`, `Sent to ${x.email}.`);
  });

  r.post("/admin/clients/:id/status", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ?", Number(c.params.id));
    if (!x) return notFound(c);
    const status = x.status === "active" ? "closed" : "active";
    await update(c.env, "clients", x.id, { status });
    if (status === "closed") await run(c.env, "DELETE FROM sessions WHERE kind = 'client' AND subject_id = ?", x.id);
    await log(c.env, c.actor, x.id, `client.${status}`);
    return redirect(`/admin/clients/${x.id}`, status === "closed" ? "Account closed. Their services are untouched." : "Account reopened.");
  });

  // ---- services ------------------------------------------------------------------
  r.get("/admin/services", S, async (c) => {
    const status = c.url.searchParams.get("status") || "active";
    const where = status === "all" ? "" : "WHERE s.status = ?";
    const p = status === "all" ? [] : [status];
    const total = (await one(c.env, `SELECT COUNT(*) AS n FROM services s ${where}`, ...p)).n;
    const rows = await all(
      c.env,
      `SELECT s.*, p.name AS product_name, cl.email, cl.company, cl.first_name, cl.last_name FROM services s JOIN products p ON p.id = s.product_id JOIN clients cl ON cl.id = s.client_id ${where} ORDER BY s.next_due IS NULL, s.next_due LIMIT 50 OFFSET ${pageOffset(c, 50)}`,
      ...p,
    );
    const tabs = ["active", "pending", "suspended", "cancelled", "terminated", "all"];
    return adminPage(c, {
      title: "Services", active: "services",
      body: html`<div class="tabs">${tabs.map((t) => html`<a class="${status === t ? "on" : ""}" href="?status=${t}">${t[0].toUpperCase() + t.slice(1)}</a>`)}</div>
      <section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Service</th><th>Client</th><th class="hide-sm">Price</th><th class="hide-sm">Next due</th><th>Status</th></tr></thead><tbody>
      ${rows.map((s) => html`<tr data-href="/admin/services/${s.id}"><td><a href="/admin/services/${s.id}"><b>${s.product_name}</b></a><small class="block muted">${s.label}</small></td><td>${s.company || fullName(s)}<small class="block muted">${s.email}</small></td><td class="hide-sm">${priceLabel(s.price, s.cycle)}</td><td class="hide-sm">${s.next_due ? dateCell(s.next_due) : "—"}</td><td>${badge(s.status)}${s.provision_error ? html` ${badge("failed", "Set-up failed")}` : ""}${s.cancel_at_end ? html` <span class="badge b-grey">Cancelling</span>` : ""}</td></tr>`)}
      </tbody></table>${pager(c, total, 50)}` : empty("No services here.")}</section>`,
    });
  });

  r.get("/admin/clients/:id/services/new", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ?", Number(c.params.id));
    if (!x) return notFound(c);
    const products = await all(c.env, "SELECT * FROM products ORDER BY sort, id");
    if (!products.length) return redirect("/admin/products/new", "Add a product first.", "err");
    return adminPage(c, {
      title: `Add service for ${x.company || fullName(x)}`, active: "clients",
      body: html`<section class="card narrow"><form method="post" class="stack">${csrf(c)}
        ${field({ label: "Product", name: "product", type: "select", options: products.map((p) => [p.id, `${p.name}${p.visible ? "" : " (hidden)"}`]) })}
        <div class="grid2">
          ${field({ label: "Billing cycle", name: "cycle", type: "select", value: "monthly", options: Object.entries(CYCLES).map(([k, v]) => [k, v.label]) })}
          ${field({ label: "Price", name: "price", type: "money", hint: "Blank uses the product's price for that cycle." })}
        </div>
        ${field({ label: "Domain or label", name: "label", optional: true })}
        ${field({
          label: "How to start it", name: "mode", type: "select", value: "invoice",
          options: [
            ["invoice", "Send an invoice now; set it up when it's paid"],
            ["existing", "Existing customer: active now, first invoice on the date below"],
            ["free", "Set it up now with no invoice"],
          ],
        })}
        ${field({ label: "Next due date", name: "next_due", type: "date", value: addDays(today(), 30), hint: "For existing customers: when their next invoice falls due." })}
        <div class="grid2">
          ${field({ type: "checkbox", name: "provision", value: 1, label: "Create a Berth account when it goes active" })}
          ${field({ label: "Or link an existing Berth account ID", name: "berth_account", optional: true })}
        </div>
        <button class="btn btn-primary">Add service</button></form></section>`,
    });
  });

  r.post("/admin/clients/:id/services/new", S, async (c) => {
    const x = await one(c.env, "SELECT * FROM clients WHERE id = ?", Number(c.params.id));
    const p = await one(c.env, "SELECT * FROM products WHERE id = ?", int(c.form.get("product")));
    if (!x || !p) return notFound(c);
    const cycle = CYCLES[c.form.get("cycle")] ? c.form.get("cycle") : "monthly";
    let price = parseMoney(c.form.get("price"));
    if (price === null) price = productPrice(p, cycle);
    if (price === null) return redirect(`/admin/clients/${x.id}/services/new`, `${p.name} has no ${CYCLES[cycle].label.toLowerCase()} price. Enter one.`, "err");
    const label = clean(c.form.get("label"), 120);
    const mode = c.form.get("mode");
    const linkAcc = clean(c.form.get("berth_account"), 100);
    const wantProvision = c.form.get("provision") === "1" && !linkAcc && p.type === "hosting";
    if (mode === "invoice") {
      const product = { ...p, price_monthly: null, price_quarterly: null, price_annually: null, price_once: null, [`price_${cycle}`]: price };
      const { serviceId, invoice } = await placeOrder(c.env, c.s, x, product, { cycle, label, actor: c.actor, ctx: c.ctx });
      if (linkAcc) await update(c.env, "services", serviceId, { berth_account: linkAcc });
      if (!wantProvision && !linkAcc && p.type === "hosting") await update(c.env, "services", serviceId, { notes: "Not provisioned automatically" });
      return redirect(`/admin/invoices/${invoice.id}`, "Service added and invoice sent.");
    }
    const nextDue = cycle === "once" ? null : /^\d{4}-\d{2}-\d{2}$/.test(c.form.get("next_due") || "") ? c.form.get("next_due") : cycleEnd(today(), cycle);
    const id = await insert(
      c.env, "INSERT INTO services (client_id, product_id, label, cycle, price, status, start_date, next_due, berth_account, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      x.id, p.id, label, cycle, price, "active", today(), nextDue, linkAcc || null, nowIso(),
    );
    await log(c.env, c.actor, x.id, "service.added", `${p.name}${label ? ` (${label})` : ""} added by staff`);
    if (linkAcc && berthReady(c.s)) {
      try {
        await berth(c.s, "PATCH", `/accounts/${encodeURIComponent(linkAcc)}`, { external_id: externalId(id) });
        const acc = await berth(c.s, "GET", `/accounts/${encodeURIComponent(linkAcc)}`);
        await update(c.env, "services", id, { berth_username: acc?.users?.[0]?.username || null });
      } catch (e) {
        await update(c.env, "services", id, { provision_error: `Linking failed: ${e.message}` });
      }
    } else if (wantProvision) {
      await provisionService(c.env, c.s, await getService(c.env, id), c.actor);
    }
    return redirect(`/admin/services/${id}`, "Service added.");
  });

  r.get("/admin/services/:id", S, async (c) => {
    const s = await getService(c.env, Number(c.params.id));
    if (!s) return notFound(c);
    const [x, products, invoices] = await Promise.all([
      one(c.env, "SELECT * FROM clients WHERE id = ?", s.client_id),
      all(c.env, "SELECT * FROM products ORDER BY sort, id"),
      all(c.env, "SELECT DISTINCT i.* FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id WHERE it.service_id = ? ORDER BY i.id DESC", s.id),
    ]);
    let acc = null;
    let accErr = null;
    if (s.berth_account && berthReady(c.s)) {
      try {
        acc = await berth(c.s, "GET", `/accounts/${accountRef(s)}`);
      } catch (e) {
        accErr = e.message;
      }
    }
    const hosting = s.product_type === "hosting";
    return adminPage(c, {
      title: `${s.product_name}${s.label ? ` · ${s.label}` : ""}`, active: "services",
      body: html`
      <section class="hero hero-sm"><div><h2>${s.product_name}</h2><p>${s.label || "No label"} · <a href="/admin/clients/${x.id}">${x.company || fullName(x)}</a></p></div><div>${badge(s.status)}</div></section>
      ${s.provision_error ? html`<div class="notice notice-err">${icon("alert")}<span>${s.provision_error}</span></div>` : ""}
      ${s.cancel_at_end ? html`<div class="notice">${icon("alert")}<span>The client asked to cancel at the end of the term (${fmtDate(s.next_due)})${s.cancel_reason ? `: “${s.cancel_reason}”` : ""}.</span></div>` : ""}
      <div class="cols cols-wide"><div>
        <section class="card"><div class="card-head"><h3>Service</h3></div>
        <form method="post" class="grid2">${csrf(c)}
          ${field({ label: "Product", name: "product", type: "select", value: s.product_id, options: products.map((p) => [p.id, p.name]), hint: hosting ? "Changing a hosting product also changes the Berth plan." : null })}
          ${field({ label: "Domain or label", name: "label", value: s.label })}
          ${field({ label: "Billing cycle", name: "cycle", type: "select", value: s.cycle, options: Object.entries(CYCLES).map(([k, v]) => [k, v.label]) })}
          ${field({ label: "Recurring price", name: "price", type: "money", value: s.price })}
          ${field({ label: "Next due", name: "next_due", type: "date", value: s.next_due || "" })}
          ${field({ label: "Status", name: "status", type: "select", value: s.status, options: ["pending", "active", "suspended", "cancelled", "terminated"].map((v) => [v, v[0].toUpperCase() + v.slice(1)]), hint: "Changing this here doesn't touch Berth. Use the buttons for that." })}
          ${field({ label: "Berth account ID", name: "berth_account", value: s.berth_account || "", optional: true })}
          ${field({ type: "checkbox", name: "cancel_at_end", value: s.cancel_at_end, label: "Cancel at end of term" })}
          <div class="wide">${field({ label: "Notes", name: "notes", type: "textarea", rows: 3, value: s.notes, optional: true })}</div>
          <div class="wide"><button class="btn btn-primary">Save</button></div>
        </form></section>
        <section class="card"><div class="card-head"><h3>Invoices</h3></div>${invoiceTable(invoices)}</section>
      </div><aside>
        ${hosting ? html`<section class="card"><div class="card-head"><h3>Berth</h3>${acc ? (acc.suspended ? badge("suspended") : badge("active")) : ""}</div>
          ${s.berth_account
            ? html`<dl class="dl dl-tight"><dt>Account</dt><dd><code>${s.berth_account}</code></dd>${s.berth_username ? html`<dt>Username</dt><dd><code>${s.berth_username}</code></dd>` : ""}
              ${acc ? html`<dt>Plan</dt><dd>${acc.plan?.name || acc.plan_id || "none"}</dd><dt>Sites</dt><dd>${(acc.sites || []).length}</dd>` : ""}</dl>
              ${accErr ? html`<p class="small err">${accErr}</p>` : ""}`
            : html`<p class="muted small">No Berth account yet.</p>`}
          <div class="actions-col">
            ${!s.berth_account && ["active", "suspended"].includes(s.status) ? html`<form method="post" action="/admin/services/${s.id}/act">${csrf(c)}<button class="btn btn-primary btn-block" name="do" value="provision">Create Berth account</button></form>` : ""}
            ${s.berth_account ? html`<form method="post" action="/admin/services/${s.id}/act" target="_blank">${csrf(c)}<button class="btn btn-block" name="do" value="login">${icon("external")} Open in Berth as client</button></form>` : ""}
            ${s.berth_account && hosting ? html`<form method="post" action="/admin/services/${s.id}/act">${csrf(c)}<button class="btn btn-block" name="do" value="plan">Push plan to Berth</button></form>` : ""}
          </div></section>` : ""}
        <section class="card"><div class="card-head"><h3>Actions</h3></div><div class="actions-col">
          ${s.status === "pending" ? html`<form method="post" action="/admin/services/${s.id}/act" data-confirm="Activate without payment?">${csrf(c)}<button class="btn btn-block" name="do" value="activate">Activate now</button></form>` : ""}
          ${s.status === "active" ? html`<form method="post" action="/admin/services/${s.id}/act" class="stack-sm">${csrf(c)}<input name="reason" placeholder="Reason (optional)"><button class="btn btn-block" name="do" value="suspend">Suspend</button></form>` : ""}
          ${s.status === "suspended" ? html`<form method="post" action="/admin/services/${s.id}/act">${csrf(c)}<button class="btn btn-block" name="do" value="unsuspend">Unsuspend</button></form>` : ""}
          ${["active", "suspended"].includes(s.status) && s.cycle !== "once" ? html`<form method="post" action="/admin/services/${s.id}/act" data-confirm="Raise the next renewal invoice now?">${csrf(c)}<button class="btn btn-block" name="do" value="invoice">Invoice next period now</button></form>` : ""}
          ${s.status !== "terminated" ? html`<details class="danger-zone"><summary>Terminate</summary><form method="post" action="/admin/services/${s.id}/act" class="stack-sm" data-confirm="Terminate this service? This can't be undone.">${csrf(c)}
            ${hosting && s.berth_account ? field({ type: "checkbox", name: "delete_sites", label: "Also delete its sites in Berth (after a final backup)" }) : ""}
            <button class="btn btn-danger btn-block" name="do" value="terminate">Terminate service</button></form></details>` : ""}
        </div></section>
      </aside></div>`,
    });
  });

  r.post("/admin/services/:id", S, async (c) => {
    const s = await getService(c.env, Number(c.params.id));
    if (!s) return notFound(c);
    const f = c.form;
    const product = await one(c.env, "SELECT * FROM products WHERE id = ?", int(f.get("product")));
    const nd = f.get("next_due");
    const o = {
      product_id: product?.id ?? s.product_id,
      label: clean(f.get("label"), 120),
      cycle: CYCLES[f.get("cycle")] ? f.get("cycle") : s.cycle,
      price: parseMoney(f.get("price")) ?? s.price,
      next_due: /^\d{4}-\d{2}-\d{2}$/.test(nd || "") ? nd : null,
      status: ["pending", "active", "suspended", "cancelled", "terminated"].includes(f.get("status")) ? f.get("status") : s.status,
      berth_account: clean(f.get("berth_account"), 100) || null,
      cancel_at_end: f.get("cancel_at_end") === "1" ? 1 : 0,
      notes: clean(f.get("notes"), 5000),
    };
    await update(c.env, "services", s.id, o);
    let msg = "Saved.";
    if (product && product.id !== s.product_id && product.type === "hosting" && s.berth_account && berthReady(c.s)) {
      try {
        await berth(c.s, "PATCH", `/accounts/${accountRef({ ...s, berth_account: o.berth_account })}`, { plan: product.berth_plan || "" });
        msg = "Saved, and the Berth plan changed.";
      } catch (e) {
        msg = `Saved, but Berth refused the plan change: ${e.message}`;
      }
    }
    await log(c.env, c.actor, s.client_id, "service.edited", `#${s.id}`);
    return redirect(`/admin/services/${s.id}`, msg, msg.includes("refused") ? "err" : "ok");
  });

  r.post("/admin/services/:id/act", S, async (c) => {
    const s = await getService(c.env, Number(c.params.id));
    if (!s) return notFound(c);
    const back = `/admin/services/${s.id}`;
    try {
      switch (c.form.get("do")) {
        case "provision":
          return (await provisionService(c.env, c.s, s, c.actor)) ? redirect(back, "Berth account created and the client emailed.") : redirect(back, "Set-up failed. See the message above.", "err");
        case "login": {
          const link = await berth(c.s, "POST", `/accounts/${accountRef(s)}/login-link`);
          await log(c.env, c.actor, s.client_id, "service.panel_login", "staff opened Berth as client");
          return redirect(link.url);
        }
        case "plan":
          await berth(c.s, "PATCH", `/accounts/${accountRef(s)}`, { plan: s.berth_plan || "" });
          return redirect(back, `Berth plan set to ${s.berth_plan || "none"}.`);
        case "activate": {
          const start = today();
          await update(c.env, "services", s.id, { status: "active", start_date: start, next_due: cycleEnd(start, s.cycle) });
          await log(c.env, c.actor, s.client_id, "service.activated", "by staff without payment");
          if (s.product_type === "hosting" && !s.berth_account) await provisionService(c.env, c.s, await getService(c.env, s.id), c.actor);
          return redirect(back, "Activated.");
        }
        case "suspend":
          await suspendService(c.env, c.s, s, clean(c.form.get("reason"), 200) || "Suspended by staff", c.actor);
          return redirect(back, "Suspended.");
        case "unsuspend":
          await unsuspendService(c.env, c.s, s, c.actor);
          return redirect(back, "Unsuspended.");
        case "invoice": {
          if (!s.next_due) return redirect(back, "Set a next due date first.", "err");
          const dupe = await one(c.env, "SELECT i.number FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE it.service_id = ? AND it.period_start = ? AND i.status != 'cancelled'", s.id, s.next_due);
          if (dupe) return redirect(back, `Already invoiced on ${dupe.number}.`, "err");
          const end = cycleEnd(s.next_due, s.cycle);
          const inv = await createInvoice(c.env, c.s, s.client_id, [{
            service_id: s.id, kind: "service", amount: s.price, period_start: s.next_due, period_end: end,
            description: `${s.product_name}${s.label ? ` - ${s.label}` : ""} (${fmtDate(s.next_due)} to ${fmtDate(addDays(end, -1))})`,
          }], { due: s.next_due, actor: c.actor, ctx: c.ctx });
          return redirect(`/admin/invoices/${inv.id}`, "Invoice raised and emailed.");
        }
        case "terminate": {
          const note = await terminateService(c.env, c.s, s, c.actor, { deleteSites: c.form.get("delete_sites") === "1" });
          return redirect(back, `Terminated.${note}`);
        }
      }
    } catch (e) {
      return redirect(back, e.message, "err");
    }
    return redirect(back);
  });

  // ---- activity & email log ----------------------------------------------------
  r.get("/admin/activity", S, async (c) => {
    const total = (await one(c.env, "SELECT COUNT(*) AS n FROM activity")).n;
    const rows = await all(c.env, `SELECT a.*, cl.email FROM activity a LEFT JOIN clients cl ON cl.id = a.client_id ORDER BY a.id DESC LIMIT 100 OFFSET ${pageOffset(c, 100)}`);
    return adminPage(c, { title: "Activity", active: "activity", body: html`<section class="card">${activityList(rows, true)}${pager(c, total, 100)}</section>` });
  });

  r.get("/admin/emails", S, async (c) => {
    const total = (await one(c.env, "SELECT COUNT(*) AS n FROM email_log")).n;
    const rows = await all(c.env, `SELECT * FROM email_log ORDER BY id DESC LIMIT 100 OFFSET ${pageOffset(c, 100)}`);
    return adminPage(c, {
      title: "Email log", active: "emails",
      body: html`<section class="card">${rows.length ? html`<table class="table"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
      ${rows.map((e) => html`<tr><td class="nowrap">${fmtDateTime(e.at)}</td><td>${e.client_id ? html`<a href="/admin/clients/${e.client_id}">${e.to_addr}</a>` : e.to_addr}</td><td>${e.subject}${e.error ? html`<small class="block err">${e.error}</small>` : ""}</td><td>${badge(e.status)}</td></tr>`)}
      </tbody></table>${pager(c, total, 100)}` : empty("No emails sent yet.")}</section>`,
    });
  });

  // ---- my account -----------------------------------------------------------------
  r.get("/admin/me", S, async (c) => {
    const st = c.staff;
    const pendingSecret = c.url.searchParams.get("setup2fa") === "1" && !st.totp_secret ? newTotpSecret() : null;
    const issuer = encodeURIComponent(c.s.company_name);
    return adminPage(c, {
      title: "My account", active: "me",
      body: html`<div class="cols">
      <section class="card"><div class="card-head"><h3>Profile</h3></div><form method="post" class="stack">${csrf(c)}
        ${field({ label: "Name", name: "name", value: st.name, required: true, hint: "Clients see this on your ticket replies." })}
        ${field({ label: "Email", name: "email", type: "email", value: st.email, required: true })}
        ${field({ label: "Ticket signature", name: "signature", type: "textarea", rows: 3, value: st.signature, optional: true })}
        ${field({ label: "Current password", name: "current", type: "password", autocomplete: "current-password", required: true })}
        ${field({ label: "New password", name: "password", type: "password", autocomplete: "new-password", optional: true })}
        <button class="btn btn-primary">Save</button></form></section>
      <section class="card"><div class="card-head"><h3>Two-step sign-in</h3>${st.totp_secret ? badge("active", "On") : badge("closed", "Off")}</div>
        ${st.totp_secret
          ? html`<p class="muted">You're asked for a code from your authenticator app when you sign in.</p><form method="post" action="/admin/me/2fa" class="stack">${csrf(c)}${field({ label: "Current code", name: "code", inputmode: "numeric", required: true })}<button class="btn btn-danger-ghost" name="do" value="off">Turn off</button></form>`
          : pendingSecret
            ? html`<p>Add this key to your authenticator app (1Password, Google Authenticator...), or open the link on your phone.</p>
              <p><code class="secret" data-copy>${pendingSecret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
              <p><a href="otpauth://totp/${issuer}:${encodeURIComponent(st.email)}?secret=${pendingSecret}&issuer=${issuer}">Open in authenticator app</a></p>
              <form method="post" action="/admin/me/2fa" class="stack">${csrf(c)}<input type="hidden" name="secret" value="${pendingSecret}">${field({ label: "Code from the app", name: "code", inputmode: "numeric", required: true })}<button class="btn btn-primary" name="do" value="on">Turn on</button></form>`
            : html`<p class="muted">Protect your admin account with a code from an authenticator app.</p><a class="btn btn-primary" href="?setup2fa=1">Set up</a>`}
      </section></div>`,
    });
  });

  r.post("/admin/me", S, async (c) => {
    const st = c.staff;
    if (!(await verifyPassword(c.form.get("current") || "", st.password_hash))) return redirect("/admin/me", "Your current password isn't right.", "err");
    const o = { name: clean(c.form.get("name"), 80), signature: clean(c.form.get("signature"), 1000) };
    const email = clean(c.form.get("email"), 254).toLowerCase();
    if (isEmail(email) && email !== st.email) {
      if (await one(c.env, "SELECT id FROM staff WHERE email = ? AND id != ?", email, st.id)) return redirect("/admin/me", "Someone else uses that email.", "err");
      o.email = email;
    }
    if (c.form.get("password")) {
      const err = passwordProblem(c.form.get("password"));
      if (err) return redirect("/admin/me", err, "err");
      o.password_hash = await hashPassword(c.form.get("password"));
    }
    await update(c.env, "staff", st.id, o);
    return redirect("/admin/me", "Saved.");
  });

  r.post("/admin/me/2fa", S, async (c) => {
    const st = c.staff;
    if (c.form.get("do") === "on") {
      const secret = c.form.get("secret") || "";
      if (!/^[A-Z2-7]{32}$/.test(secret) || !(await verifyTotp(secret, c.form.get("code")))) return redirect("/admin/me?setup2fa=1", "That code didn't match. Scan the new key and try again.", "err");
      await update(c.env, "staff", st.id, { totp_secret: secret });
      await log(c.env, c.actor, null, "staff.2fa_on");
      return redirect("/admin/me", "Two-step sign-in is on.");
    }
    if (!(await verifyTotp(st.totp_secret, c.form.get("code")))) return redirect("/admin/me", "That code didn't match.", "err");
    await update(c.env, "staff", st.id, { totp_secret: null });
    await log(c.env, c.actor, null, "staff.2fa_off");
    return redirect("/admin/me", "Two-step sign-in is off.");
  });
}

export function invoiceTable(rows) {
  if (!rows.length) return empty("No invoices.");
  return html`<table class="table"><thead><tr><th>Invoice</th><th class="hide-sm">Date</th><th class="hide-sm">Due</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
  ${rows.map((i) => html`<tr data-href="/admin/invoices/${i.id}"><td><a href="/admin/invoices/${i.id}"><b>${i.number}</b></a></td><td class="hide-sm">${dateCell(i.issued)}</td><td class="hide-sm">${dateCell(i.due)}</td><td class="num">${money(i.total)}</td><td>${invoiceBadge(i)}</td></tr>`)}
  </tbody></table>`;
}

const ACTIONS = {
  "invoice.created": "created an invoice", "invoice.cancelled": "cancelled invoice", "payment.received": "recorded a payment",
  "payment.failed": "card payment failed", "credit.added": "added credit", "credit.removed": "removed credit",
  "service.activated": "activated", "service.provisioned": "set up in Berth", "service.provision_failed": "Berth set-up failed",
  "service.suspended": "suspended", "service.unsuspended": "unsuspended", "service.terminated": "terminated",
  "order.placed": "placed an order", "client.login": "signed in", "staff.login": "signed in", "client.registered": "registered",
  "ticket.opened": "opened ticket", "ticket.replied": "replied to ticket", "ticket.closed": "closed ticket",
};

function activityList(rows, withClient) {
  if (!rows.length) return empty("Nothing yet.");
  return html`<div class="list">${rows.map(
    (a) => html`<div class="row act"><span class="dot dot-${a.actor_kind}"></span><div><b>${a.actor_name}</b> ${ACTIONS[a.action] || a.action.replace(/[._]/g, " ")}${a.detail ? html` <span class="muted">${a.detail}</span>` : ""}
      ${withClient && a.client_id ? html`<small><a href="/admin/clients/${a.client_id}">${a.email || `client #${a.client_id}`}</a></small>` : ""}</div><time class="muted small nowrap" title="${fmtDateTime(a.at)}">${ago(a.at)}</time></div>`,
  )}</div>`;
}

async function sendWelcome(c, client) {
  const { makeToken } = await import("../lib/auth.js");
  const { sendEmail } = await import("../lib/email.js");
  const t = await makeToken(c.env, "reset", client.id, 72);
  await sendEmail(c.env, c.s, {
    to: client.email, clientId: client.id,
    subject: `Your ${c.s.company_name} client area`,
    lines: [
      `Hi ${client.first_name || "there"},`,
      `We've set up an account for you in our client area, where you can see your services and invoices, pay online and get support.`,
      { button: { label: "Set your password", url: `${baseUrl(c.env)}/reset/${t}` } },
      "The link works for 3 days. After that, use “Forgotten your password?” on the sign-in page.",
    ],
  });
}
