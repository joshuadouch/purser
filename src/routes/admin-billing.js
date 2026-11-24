// Admin: invoices, payments, transactions and products.
import { html, raw } from "../lib/html.js";
import { all, insert, one, run, update } from "../lib/db.js";
import { notFound, redirect, requireAdmin, requireStaff } from "../lib/http.js";
import { adminPage, badge, csrf, dateCell, empty, field, icon, pager, pageOffset } from "../lib/ui.js";
import {
  addCredit, applyCredit, cancelInvoice, chargeSavedCard, createInvoice, emailInvoice, getClient, getInvoice, getItems, log,
  recalcInvoice, recordPayment,
} from "../lib/billing.js";
import { invoicePage } from "./client.js";
import { stripe } from "../lib/stripe.js";
import { berthPlans, berthReady } from "../lib/berth.js";
import { CYCLES, clean, fmtDateTime, fullName, int, money, nowIso, parseMoney, today } from "../lib/util.js";

export default function (r) {
  const S = requireStaff;
  const A = requireAdmin;

  r.get("/admin/invoices", S, async (c) => {
    const status = c.url.searchParams.get("status") || "unpaid";
    const t = today();
    const where = {
      unpaid: ["WHERE i.status = 'unpaid'", []],
      overdue: ["WHERE i.status = 'unpaid' AND i.due < ?", [t]],
      paid: ["WHERE i.status = 'paid'", []],
      cancelled: ["WHERE i.status IN ('cancelled','refunded')", []],
      all: ["", []],
    }[status] || ["", []];
    const total = (await one(c.env, `SELECT COUNT(*) AS n FROM invoices i ${where[0]}`, ...where[1])).n;
    const sum = (await one(c.env, `SELECT COALESCE(SUM(i.total - i.paid),0) AS s FROM invoices i ${where[0]}`, ...where[1])).s;
    const rows = await all(
      c.env,
      `SELECT i.*, cl.email, cl.company, cl.first_name, cl.last_name FROM invoices i JOIN clients cl ON cl.id = i.client_id ${where[0]}
       ORDER BY ${status === "unpaid" || status === "overdue" ? "i.due ASC" : "i.id DESC"} LIMIT 50 OFFSET ${pageOffset(c, 50)}`,
      ...where[1],
    );
    const tabs = [["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["cancelled", "Cancelled"], ["all", "All"]];
    return adminPage(c, {
      title: "Invoices", active: "invoices",
      topActions: html`<a class="btn btn-primary btn-sm" href="/admin/invoices/new">${icon("plus")}<span class="hide-sm">New invoice</span></a>`,
      body: html`<div class="tabs">${tabs.map(([k, l]) => html`<a class="${status === k ? "on" : ""}" href="?status=${k}">${l}</a>`)}</div>
      ${["unpaid", "overdue"].includes(status) ? html`<p class="muted">${money(sum)} outstanding on ${total} invoice${total === 1 ? "" : "s"}.</p>` : ""}
      <section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Invoice</th><th>Client</th><th class="hide-sm">Due</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${rows.map((i) => html`<tr data-href="/admin/invoices/${i.id}"><td><a href="/admin/invoices/${i.id}"><b>${i.number}</b></a>${i.charge_error ? html`<small class="block err">card failed</small>` : ""}</td><td>${i.company || fullName(i)}<small class="block muted">${i.email}</small></td><td class="hide-sm">${dateCell(i.due)}</td><td class="num">${money(i.total)}${i.paid && i.status === "unpaid" ? html`<small class="block muted">${money(i.total - i.paid)} left</small>` : ""}</td><td>${statusOf(i)}</td></tr>`)}
      </tbody></table>${pager(c, total, 50)}` : empty("No invoices here.")}</section>`,
    });
  });

  r.get("/admin/invoices/new", S, async (c) => {
    const clientId = int(c.url.searchParams.get("client"));
    const client = clientId ? await getClient(c.env, clientId) : null;
    const clients = client ? [] : await all(c.env, "SELECT id, email, company FROM clients WHERE status = 'active' ORDER BY email LIMIT 1000");
    const rows = [0, 1, 2, 3, 4];
    return adminPage(c, {
      title: "New invoice", active: "invoices",
      body: html`<section class="card narrow"><form method="post" class="stack">${csrf(c)}
        ${client ? html`<input type="hidden" name="client" value="${client.id}"><p><b>For:</b> ${client.company || fullName(client)} (${client.email})</p>` : field({ label: "Client", name: "client", type: "select", options: clients.map((x) => [x.id, `${x.email}${x.company ? ` (${x.company})` : ""}`]) })}
        <div class="lines">${rows.map((i) => html`<div class="line">${field({ label: i ? "" : "Description", name: `desc_${i}`, required: i === 0 })}${field({ label: i ? "" : "Amount", name: `amt_${i}`, type: "money", required: i === 0 })}</div>`)}</div>
        <div class="grid2">${field({ label: "Due date", name: "due", type: "date", value: today() })}${field({ type: "checkbox", name: "email", value: 1, label: "Email it to the client" })}</div>
        ${field({ label: "Notes on the invoice", name: "notes", type: "textarea", rows: 2, optional: true })}
        <button class="btn btn-primary">Create invoice</button></form></section>`,
    });
  });

  r.post("/admin/invoices/new", S, async (c) => {
    const client = await getClient(c.env, int(c.form.get("client")));
    if (!client) return redirect("/admin/invoices/new", "Pick a client.", "err");
    const items = [];
    for (let i = 0; i < 5; i++) {
      const d = clean(c.form.get(`desc_${i}`), 300);
      const a = parseMoney(c.form.get(`amt_${i}`));
      if (d && a !== null) items.push({ description: d, amount: a, kind: "custom" });
    }
    if (!items.length) return redirect(`/admin/invoices/new?client=${client.id}`, "Add at least one line with an amount.", "err");
    const due = /^\d{4}-\d{2}-\d{2}$/.test(c.form.get("due") || "") ? c.form.get("due") : today();
    const inv = await createInvoice(c.env, c.s, client.id, items, { due, notes: clean(c.form.get("notes"), 2000), email: c.form.get("email") === "1", actor: c.actor, ctx: c.ctx });
    return redirect(`/admin/invoices/${inv.id}`, "Invoice created.");
  });

  r.get("/admin/invoices/:id", S, async (c) => {
    const inv = await getInvoice(c.env, Number(c.params.id));
    if (!inv) return notFound(c);
    const [items, client, txns] = await Promise.all([
      getItems(c.env, inv.id),
      getClient(c.env, inv.client_id),
      all(c.env, "SELECT t.*, s.name AS staff_name FROM transactions t LEFT JOIN staff s ON s.id = t.staff_id WHERE t.invoice_id = ? ORDER BY t.id", inv.id),
    ]);
    const owed = inv.total - inv.paid;
    const unpaid = inv.status === "unpaid";
    const panel = html`<div class="cols no-print">
      <section class="card"><div class="card-head"><h3>${client.company || fullName(client)}</h3><a href="/admin/clients/${client.id}">Open client</a></div>
        <dl class="dl dl-tight"><dt>Email</dt><dd>${client.email}</dd><dt>Credit</dt><dd>${money(client.credit)}</dd><dt>Card</dt><dd>${client.stripe_pm_label || "none"}</dd>
        ${inv.charge_error ? html`<dt>Last charge</dt><dd class="err">${inv.charge_error}</dd>` : ""}</dl>
        <div class="btn-row">
          <form method="post" action="/admin/invoices/${inv.id}/act">${csrf(c)}<button class="btn btn-sm" name="do" value="email">${icon("mail")} Email invoice</button></form>
          ${unpaid && client.credit > 0 ? html`<form method="post" action="/admin/invoices/${inv.id}/act">${csrf(c)}<button class="btn btn-sm" name="do" value="credit">Apply ${money(Math.min(client.credit, owed))} credit</button></form>` : ""}
          ${unpaid && client.stripe_pm ? html`<form method="post" action="/admin/invoices/${inv.id}/act" data-confirm="Charge ${money(owed)} to ${client.stripe_pm_label}?">${csrf(c)}<button class="btn btn-sm" name="do" value="charge">${icon("card")} Charge card now</button></form>` : ""}
          ${unpaid ? html`<form method="post" action="/admin/invoices/${inv.id}/act" data-confirm="Cancel this invoice?">${csrf(c)}<button class="btn btn-sm btn-danger-ghost" name="do" value="cancel">Cancel invoice</button></form>` : ""}
        </div>
      </section>
      ${unpaid ? html`<section class="card"><div class="card-head"><h3>Record a payment</h3></div><form method="post" action="/admin/invoices/${inv.id}/payment" class="stack">${csrf(c)}
        <div class="grid2">${field({ label: "Amount", name: "amount", type: "money", value: owed, required: true })}${field({ label: "Method", name: "gateway", type: "select", options: [["bank", "Bank transfer"], ["cash", "Cash"], ["stripe", "Stripe (taken elsewhere)"], ["other", "Other"]] })}</div>
        ${field({ label: "Reference", name: "reference", optional: true })}
        <button class="btn btn-primary">Record payment</button></form></section>` : ""}
    </div>
    ${unpaid ? html`<section class="card no-print"><div class="card-head"><h3>Edit lines</h3></div>
      <form method="post" action="/admin/invoices/${inv.id}/items" class="stack">${csrf(c)}
        ${items.map((it) => html`<div class="line">${field({ label: "", name: `desc_${it.id}`, value: it.description })}${field({ label: "", name: `amt_${it.id}`, type: "money", value: it.amount })}<label class="check small"><input type="checkbox" name="del_${it.id}" value="1"> <span>Remove</span></label></div>`)}
        <div class="line">${field({ label: "", name: "desc_new", placeholder: "Add a line" })}${field({ label: "", name: "amt_new", type: "money" })}</div>
        <div class="grid2">${field({ label: "Due date", name: "due", type: "date", value: inv.due })}${field({ label: "Notes", name: "notes", value: inv.notes, optional: true })}</div>
        <button class="btn">Save changes</button></form></section>` : ""}
    ${txns.length ? html`<section class="card no-print"><div class="card-head"><h3>Payments</h3></div><table class="table"><thead><tr><th>When</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${txns.map((t) => html`<tr><td class="nowrap">${fmtDateTime(t.created_at)}</td><td>${t.gateway}${t.staff_name ? html`<small class="block muted">by ${t.staff_name}</small>` : ""}</td><td><code class="small">${t.reference || ""}</code>${t.notes ? html`<small class="block muted">${t.notes}</small>` : ""}</td><td class="num ${t.amount < 0 ? "neg" : ""}">${money(t.amount)}</td>
      <td>${t.amount > 0 && t.gateway === "stripe" && t.reference?.startsWith("pi_") && c.staff.role === "admin" ? html`<form method="post" action="/admin/invoices/${inv.id}/refund" class="inline" data-confirm="Refund this payment through Stripe?">${csrf(c)}<input type="hidden" name="txn" value="${t.id}"><input name="amount" class="w-sm" placeholder="${(t.amount / 100).toFixed(2)}" title="Blank refunds all of it"><button class="btn btn-sm">Refund</button></form>` : ""}</td></tr>`)}
    </tbody></table></section>` : ""}`;
    return adminPage(c, { title: `Invoice ${inv.number}`, active: "invoices", body: invoicePage(c, inv, items, true, panel) });
  });

  r.post("/admin/invoices/:id/payment", S, async (c) => {
    const inv = await getInvoice(c.env, Number(c.params.id));
    if (!inv) return notFound(c);
    const amount = parseMoney(c.form.get("amount"));
    if (!amount || amount <= 0) return redirect(`/admin/invoices/${inv.id}`, "Enter an amount.", "err");
    const gateway = ["bank", "cash", "stripe", "other"].includes(c.form.get("gateway")) ? c.form.get("gateway") : "other";
    const res = await recordPayment(c.env, c.s, { invoiceId: inv.id, amount, gateway, reference: clean(c.form.get("reference"), 120) || null, actor: c.actor, ctx: c.ctx });
    return redirect(`/admin/invoices/${inv.id}`, res.duplicate ? "A payment with that reference is already recorded." : "Payment recorded.", res.duplicate ? "err" : "ok");
  });

  r.post("/admin/invoices/:id/act", S, async (c) => {
    const inv = await getInvoice(c.env, Number(c.params.id));
    if (!inv) return notFound(c);
    const back = `/admin/invoices/${inv.id}`;
    const client = await getClient(c.env, inv.client_id);
    switch (c.form.get("do")) {
      case "email":
        return (await emailInvoice(c.env, c.s, inv, client)) ? redirect(back, `Emailed to ${client.email}.`) : redirect(back, "The email didn't send. See the email log.", "err");
      case "credit": {
        const used = await applyCredit(c.env, c.s, inv, client.credit, c.actor, c.ctx);
        return redirect(back, used ? `${money(used)} credit applied.` : "No credit applied.");
      }
      case "charge": {
        const r2 = await chargeSavedCard(c.env, c.s, { ...inv, charge_attempts: 0 }, client, c.ctx);
        return redirect(back, r2.ok ? (r2.pending ? "Payment is processing." : "Card charged.") : `Charge failed: ${r2.error}`, r2.ok ? "ok" : "err");
      }
      case "cancel":
        await cancelInvoice(c.env, c.s, inv, c.actor);
        return redirect(back, "Invoice cancelled.");
    }
    return redirect(back);
  });

  r.post("/admin/invoices/:id/items", S, async (c) => {
    const inv = await getInvoice(c.env, Number(c.params.id));
    if (!inv || inv.status !== "unpaid") return redirect(`/admin/invoices/${c.params.id}`, "Only unpaid invoices can be changed.", "err");
    const f = c.form;
    for (const it of await getItems(c.env, inv.id)) {
      if (f.get(`del_${it.id}`) === "1") {
        await run(c.env, "DELETE FROM invoice_items WHERE id = ?", it.id);
        continue;
      }
      const amt = parseMoney(f.get(`amt_${it.id}`));
      await update(c.env, "invoice_items", it.id, { description: clean(f.get(`desc_${it.id}`), 300) || it.description, amount: amt ?? it.amount });
    }
    const d = clean(f.get("desc_new"), 300);
    const a = parseMoney(f.get("amt_new"));
    if (d && a !== null) await insert(c.env, "INSERT INTO invoice_items (invoice_id, kind, description, amount) VALUES (?,?,?,?)", inv.id, "custom", d, a);
    const due = f.get("due");
    await update(c.env, "invoices", inv.id, { due: /^\d{4}-\d{2}-\d{2}$/.test(due || "") ? due : inv.due, notes: clean(f.get("notes"), 2000) });
    await recalcInvoice(c.env, c.s, inv.id);
    await log(c.env, c.actor, inv.client_id, "invoice.edited", inv.number);
    return redirect(`/admin/invoices/${inv.id}`, "Invoice updated.");
  });

  r.post("/admin/invoices/:id/refund", S, A, async (c) => {
    const inv = await getInvoice(c.env, Number(c.params.id));
    const t = await one(c.env, "SELECT * FROM transactions WHERE id = ? AND invoice_id = ?", int(c.form.get("txn")), inv?.id);
    if (!inv || !t || t.gateway !== "stripe") return notFound(c);
    const amount = parseMoney(c.form.get("amount")) ?? t.amount;
    if (amount <= 0 || amount > t.amount) return redirect(`/admin/invoices/${inv.id}`, "That's more than the payment.", "err");
    try {
      const rf = await stripe(c.s, "POST", "/refunds", { payment_intent: t.reference, amount }, `purser-refund-${t.id}-${amount}`);
      await insert(
        c.env, "INSERT INTO transactions (client_id, invoice_id, gateway, reference, amount, notes, staff_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
        inv.client_id, inv.id, "stripe", rf.id, -amount, `Refund of ${t.reference}`, c.staff.id, nowIso(),
      );
      await run(c.env, "UPDATE invoices SET paid = paid - ? WHERE id = ?", amount, inv.id);
      if (amount >= inv.paid) await update(c.env, "invoices", inv.id, { status: "refunded" });
      await log(c.env, c.actor, inv.client_id, "payment.refunded", `${money(amount)} on ${inv.number}`);
      return redirect(`/admin/invoices/${inv.id}`, `Refunded ${money(amount)}. It can take 5 to 10 days to reach the client.`);
    } catch (e) {
      return redirect(`/admin/invoices/${inv.id}`, `Stripe refused the refund: ${e.message}`, "err");
    }
  });

  r.get("/admin/transactions", S, async (c) => {
    const total = (await one(c.env, "SELECT COUNT(*) AS n FROM transactions")).n;
    const rows = await all(
      c.env,
      `SELECT t.*, i.number, cl.email, cl.company FROM transactions t LEFT JOIN invoices i ON i.id = t.invoice_id JOIN clients cl ON cl.id = t.client_id ORDER BY t.id DESC LIMIT 100 OFFSET ${pageOffset(c, 100)}`,
    );
    return adminPage(c, {
      title: "Transactions", active: "transactions",
      body: html`<section class="card">${rows.length ? html`<table class="table"><thead><tr><th>When</th><th>Client</th><th>Invoice</th><th class="hide-sm">Method</th><th class="num">Amount</th></tr></thead><tbody>
      ${rows.map((t) => html`<tr><td class="nowrap">${fmtDateTime(t.created_at)}</td><td><a href="/admin/clients/${t.client_id}">${t.company || t.email}</a></td><td>${t.invoice_id ? html`<a href="/admin/invoices/${t.invoice_id}">${t.number}</a>` : ""}</td><td class="hide-sm">${t.gateway}</td><td class="num ${t.amount < 0 ? "neg" : ""}">${money(t.amount)}</td></tr>`)}
      </tbody></table>${pager(c, total, 100)}` : empty("No payments yet.")}</section>`,
    });
  });

  // ---- products ------------------------------------------------------------------
  r.get("/admin/products", S, A, async (c) => {
    const rows = await all(c.env, "SELECT p.*, (SELECT COUNT(*) FROM services s WHERE s.product_id = p.id AND s.status IN ('active','suspended')) AS used FROM products p ORDER BY sort, id");
    return adminPage(c, {
      title: "Products", active: "products",
      topActions: html`<a class="btn btn-primary btn-sm" href="/admin/products/new">${icon("plus")}<span class="hide-sm">New product</span></a>`,
      body: html`<section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Product</th><th class="hide-sm">Type</th><th>Prices</th><th class="hide-sm">In use</th><th></th></tr></thead><tbody>
      ${rows.map((p) => html`<tr data-href="/admin/products/${p.id}"><td><a href="/admin/products/${p.id}"><b>${p.name}</b></a>${p.slug ? html`<small class="block muted">/order/${p.slug}</small>` : ""}${p.berth_plan ? html`<small class="block muted">Berth plan: ${p.berth_plan}</small>` : ""}</td><td class="hide-sm">${p.type === "hosting" ? "Hosting (Berth)" : "Other"}</td>
      <td>${Object.keys(CYCLES).filter((k) => p[`price_${k}`] !== null).map((k) => html`<span class="nowrap">${money(p[`price_${k}`])}${CYCLES[k].per}</span> `)}</td><td class="hide-sm">${p.used}</td><td>${p.visible ? "" : badge("closed", "Hidden")}</td></tr>`)}
      </tbody></table>` : empty("No products yet. Add the hosting plans you sell.", html`<a class="btn btn-primary btn-sm" href="/admin/products/new">Add a product</a>`)}</section>`,
    });
  });

  const productForm = async (c, p) => {
    let plans = [];
    let planErr = null;
    if (berthReady(c.s)) {
      try {
        plans = await berthPlans(c.s);
      } catch (e) {
        planErr = e.message;
      }
    }
    return html`<section class="card narrow"><form method="post" class="stack">${csrf(c)}
      <div class="grid2">
        ${field({ label: "Name", name: "name", value: p.name, required: true })}
        ${field({ label: "Web address name", name: "slug", value: p.slug, optional: true, placeholder: "starter", hint: html`Lets the website link to <code>/order/${p.slug || "starter"}</code>. Lowercase letters, numbers and dashes.` })}
      </div>
      ${field({ label: "Description", name: "description", type: "textarea", rows: 5, value: p.description, hint: "Shown on the order page. One feature per line works well." })}
      <div class="grid2">
        ${field({ label: "Type", name: "type", type: "select", value: p.type || "hosting", options: [["hosting", "Hosting (creates a Berth account)"], ["other", "Other (set up by hand)"]] })}
        ${plans.length
          ? field({ label: "Berth plan", name: "berth_plan", type: "select", value: p.berth_plan, options: [["", "No plan (no limits)"], ...plans.map((x) => [x.name, x.name])] })
          : field({ label: "Berth plan name", name: "berth_plan", value: p.berth_plan, optional: true, hint: planErr ? `Couldn't load plans: ${planErr}` : "Connect Berth in Settings to pick from a list." })}
      </div>
      <fieldset><legend>Prices <small class="muted">leave blank for cycles you don't offer</small></legend><div class="grid4">
        ${field({ label: "Monthly", name: "price_monthly", type: "money", value: p.price_monthly })}
        ${field({ label: "Quarterly", name: "price_quarterly", type: "money", value: p.price_quarterly })}
        ${field({ label: "Annually", name: "price_annually", type: "money", value: p.price_annually })}
        ${field({ label: "One-off", name: "price_once", type: "money", value: p.price_once })}
      </div></fieldset>
      <div class="grid2">${field({ label: "Set-up fee", name: "setup_fee", type: "money", value: p.setup_fee || "" })}${field({ label: "Sort order", name: "sort", type: "number", value: p.sort ?? 0 })}</div>
      ${field({ type: "checkbox", name: "needs_domain", value: p.needs_domain ?? 1, label: "Ask for a domain name when ordering" })}
      ${field({ type: "checkbox", name: "visible", value: p.visible ?? 1, label: "Show on the order page" })}
      <div class="btn-row"><button class="btn btn-primary">Save product</button>${p.id ? html`<a class="btn" href="/admin/products">Cancel</a>` : ""}</div>
    </form></section>`;
  };

  const productFields = (f) => ({
    name: clean(f.get("name"), 120),
    slug: clean(f.get("slug"), 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || null,
    description: clean(f.get("description"), 4000),
    type: f.get("type") === "other" ? "other" : "hosting",
    berth_plan: clean(f.get("berth_plan"), 100),
    price_monthly: parseMoney(f.get("price_monthly")),
    price_quarterly: parseMoney(f.get("price_quarterly")),
    price_annually: parseMoney(f.get("price_annually")),
    price_once: parseMoney(f.get("price_once")),
    setup_fee: parseMoney(f.get("setup_fee")) ?? 0,
    sort: int(f.get("sort"), 0),
    needs_domain: f.get("needs_domain") === "1" ? 1 : 0,
    visible: f.get("visible") === "1" ? 1 : 0,
  });

  r.get("/admin/products/new", S, A, async (c) => adminPage(c, { title: "New product", active: "products", body: await productForm(c, {}) }));

  r.post("/admin/products/new", S, A, async (c) => {
    const o = productFields(c.form);
    if (!o.name) return redirect("/admin/products/new", "Give it a name.", "err");
    if (o.slug && (await one(c.env, "SELECT id FROM products WHERE slug = ?", o.slug))) return redirect("/admin/products/new", "Another product already uses that web address name.", "err");
    if (![o.price_monthly, o.price_quarterly, o.price_annually, o.price_once].some((x) => x !== null)) return redirect("/admin/products/new", "Enter at least one price.", "err");
    o.created_at = nowIso();
    const keys = Object.keys(o);
    await insert(c.env, `INSERT INTO products (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => o[k]));
    return redirect("/admin/products", "Product added.");
  });

  r.get("/admin/products/:id", S, A, async (c) => {
    const p = await one(c.env, "SELECT * FROM products WHERE id = ?", Number(c.params.id));
    if (!p) return notFound(c);
    return adminPage(c, { title: p.name, active: "products", body: await productForm(c, p) });
  });

  r.post("/admin/products/:id", S, A, async (c) => {
    const p = await one(c.env, "SELECT * FROM products WHERE id = ?", Number(c.params.id));
    if (!p) return notFound(c);
    const o = productFields(c.form);
    if (!o.name) return redirect(`/admin/products/${p.id}`, "Give it a name.", "err");
    if (o.slug && (await one(c.env, "SELECT id FROM products WHERE slug = ? AND id != ?", o.slug, p.id))) return redirect(`/admin/products/${p.id}`, "Another product already uses that web address name.", "err");
    await update(c.env, "products", p.id, o);
    return redirect("/admin/products", "Saved. Existing services keep their own price.");
  });
}

function statusOf(i) {
  if (i.status === "unpaid" && i.due < today()) return badge("overdue");
  return badge(i.status);
}
