// The client area: dashboard, services, invoices, ordering and account pages.
import { html, raw, textBlock } from "../lib/html.js";
import { all, one, run, update } from "../lib/db.js";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/auth.js";
import { json, notFound, optionalClient, redirect, requireClient } from "../lib/http.js";
import { badge, clientPage, publicPage, csrf, cycleLabel, dateCell, empty, field, icon, invoiceBadge, priceLabel, stat } from "../lib/ui.js";
import {
  applyCredit, checkoutForCard, checkoutForInvoice, getInvoice, getItems, getService, handleCheckoutSession, log, notifyAdmin,
  placeOrder, productCycles, productPrice, baseUrl,
} from "../lib/billing.js";
import { accountRef, berth, berthReady } from "../lib/berth.js";
import { stripe } from "../lib/stripe.js";
import { CYCLES, clean, fmtDate, fullName, money, nowIso, today } from "../lib/util.js";
import { accountFields, signUp } from "../lib/signup.js";
import { checkPromo, describePromo, discountOn, normCode } from "../lib/promo.js";

export default function (r) {
  const C = requireClient;

  r.get("/", C, async (c) => {
    const cl = c.client;
    const [services, invoices, tickets] = await Promise.all([
      all(c.env, "SELECT s.*, p.name AS product_name FROM services s JOIN products p ON p.id = s.product_id WHERE s.client_id = ? AND s.status IN ('active','suspended','pending') ORDER BY s.id DESC LIMIT 6", cl.id),
      all(c.env, "SELECT * FROM invoices WHERE client_id = ? AND status = 'unpaid' ORDER BY due", cl.id),
      all(c.env, "SELECT * FROM tickets WHERE client_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 5", cl.id),
    ]);
    const owed = invoices.reduce((a, i) => a + i.total - i.paid, 0);
    const hour = new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" });
    const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const active = services.filter((s) => s.status === "active").length;
    return clientPage(c, {
      title: "Dashboard", active: "home",
      body: html`
      <section class="hero">
        <div><h2>${greet}, ${cl.first_name || cl.company || "there"}</h2>
        <p>${active} active service${active === 1 ? "" : "s"}${owed ? html` · ${money(owed)} to pay` : " · nothing to pay"}</p></div>
        ${invoices.length ? html`<a class="btn btn-light" href="/invoices/${invoices[0].id}">Pay ${money(owed)}</a>` : html`<a class="btn btn-light" href="/tickets/new">${icon("help")} Get help</a>`}
      </section>
      ${!cl.email_verified ? html`<div class="notice">${icon("mail")}<span>Please confirm your email address. <form method="post" action="/account/verify" class="inline">${csrf(c)}<button class="link">Send the link again</button></form></span></div>` : ""}
      <div class="stats">
        ${stat("server", "purple", "Services", active, `${services.length} in total`, "/services")}
        ${stat("file", "amber", "To pay", money(owed), invoices.length ? `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"}` : "all paid up", "/invoices")}
        ${stat("help", "teal", "Support", tickets.length, "open tickets", "/tickets")}
        ${stat("wallet", "pink", "Credit", money(cl.credit), cl.stripe_pm_label || "no saved card", "/account/payment")}
      </div>
      <div class="cols">
        <section class="card">
          <div class="card-head"><h3>Your services</h3><a href="/services">All services</a></div>
          ${services.length ? html`<div class="list">${services.map((s) => html`<a class="row" href="/services/${s.id}"><div><b>${s.product_name}</b><small>${s.label || cycleLabel(s.cycle)}</small></div><div class="row-end">${s.next_due ? html`<small class="muted hide-sm">Renews ${fmtDate(s.next_due)}</small>` : ""}${badge(s.status)}</div></a>`)}</div>` : empty("You don't have any services yet.", html`<a class="btn btn-primary btn-sm" href="/order">Browse plans</a>`)}
        </section>
        <section class="card">
          <div class="card-head"><h3>Unpaid invoices</h3><a href="/invoices">All invoices</a></div>
          ${invoices.length ? html`<div class="list">${invoices.map((i) => html`<a class="row" href="/invoices/${i.id}"><div><b>${i.number}</b><small>Due ${fmtDate(i.due)}</small></div><div class="row-end"><b>${money(i.total - i.paid)}</b>${invoiceBadge(i)}</div></a>`)}</div>` : empty("You're all paid up.")}
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Support tickets</h3><a href="/tickets/new" class="btn btn-sm">${icon("plus")} New ticket</a></div>
        ${tickets.length ? html`<div class="list">${tickets.map((t) => html`<a class="row" href="/tickets/${t.id}"><div><b>${t.subject}</b><small>#${t.id} · updated ${fmtDate(t.updated_at)}</small></div>${badge(t.status)}</a>`)}</div>` : empty("No open tickets. If you need a hand, we're here.")}
      </section>`,
    });
  });

  // ---- services ---------------------------------------------------------------
  r.get("/services", C, async (c) => {
    const rows = await all(c.env, "SELECT s.*, p.name AS product_name FROM services s JOIN products p ON p.id = s.product_id WHERE s.client_id = ? ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, s.id DESC", c.client.id);
    return clientPage(c, {
      title: "Services", active: "services",
      body: html`<section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Service</th><th class="hide-sm">Billing</th><th class="hide-sm">Next due</th><th>Status</th></tr></thead><tbody>
        ${rows.map((s) => html`<tr data-href="/services/${s.id}"><td><a href="/services/${s.id}"><b>${s.product_name}</b></a><small class="block muted">${s.label}</small></td><td class="hide-sm">${priceLabel(s.price, s.cycle)}</td><td class="hide-sm">${s.next_due ? dateCell(s.next_due) : "—"}</td><td>${badge(s.status)}${s.cancel_at_end ? html` <span class="badge b-grey">Cancelling</span>` : ""}</td></tr>`)}
      </tbody></table>` : empty("No services yet.", html`<a class="btn btn-primary btn-sm" href="/order">Order something</a>`)}</section>`,
    });
  });

  const myService = async (c) => {
    const s = await getService(c.env, Number(c.params.id));
    return s && s.client_id === c.client.id ? s : null;
  };

  r.get("/services/:id", C, async (c) => {
    const s = await myService(c);
    if (!s) return notFound(c);
    const invoices = await all(c.env, "SELECT DISTINCT i.* FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id WHERE it.service_id = ? ORDER BY i.id DESC LIMIT 12", s.id);
    const panel = s.product_type === "hosting" && s.berth_account && berthReady(c.s);
    return clientPage(c, {
      title: s.product_name, active: "services",
      body: html`
      <section class="hero hero-sm"><div><h2>${s.product_name}</h2><p>${s.label || cycleLabel(s.cycle)}</p></div><div>${badge(s.status)}</div></section>
      ${s.status === "suspended" ? html`<div class="notice notice-err">${icon("alert")}<span>This service is suspended${s.suspend_reason ? `: ${s.suspend_reason}` : ""}. ${s.suspend_reason.startsWith("Overdue") ? "Paying the overdue invoice turns it back on straight away." : "Open a ticket if you need help."}</span></div>` : ""}
      ${s.status === "pending" ? html`<div class="notice">${icon("alert")}<span>This order is waiting for payment. It's set up as soon as the invoice is paid.</span></div>` : ""}
      <div class="cols">
        <section class="card">
          <div class="card-head"><h3>Details</h3></div>
          <dl class="dl">
            <dt>Product</dt><dd>${s.product_name}</dd>
            ${s.label ? html`<dt>Domain</dt><dd>${s.label}</dd>` : ""}
            <dt>Price</dt><dd>${priceLabel(s.price, s.cycle)}</dd>
            <dt>Billing</dt><dd>${cycleLabel(s.cycle)}</dd>
            ${s.start_date ? html`<dt>Started</dt><dd>${fmtDate(s.start_date)}</dd>` : ""}
            ${s.next_due ? html`<dt>Next due</dt><dd>${fmtDate(s.next_due)}</dd>` : ""}
            ${s.berth_username ? html`<dt>Panel username</dt><dd><code>${s.berth_username}</code></dd>` : ""}
          </dl>
        </section>
        <section class="card">
          <div class="card-head"><h3>Manage</h3></div>
          <div class="actions-col">
            ${panel && s.status === "active" ? html`<form method="post" action="/services/${s.id}/panel" target="_blank">${csrf(c)}<button class="btn btn-primary btn-block">${icon("external")} Log in to ${c.s.berth_panel_name}</button></form>
            <form method="post" action="/services/${s.id}/password" data-confirm="Make a new control panel password? The old one stops working.">${csrf(c)}<button class="btn btn-block">${icon("key")} New control panel password</button></form>` : ""}
            <a class="btn btn-block" href="/tickets/new?service=${s.id}">${icon("help")} Get help with this service</a>
            ${["active", "suspended"].includes(s.status) && s.cycle !== "once"
              ? s.cancel_at_end
                ? html`<div class="muted small">Cancelling on ${fmtDate(s.next_due)}${s.cancel_reason ? ` (${s.cancel_reason})` : ""}.</div><form method="post" action="/services/${s.id}/cancel">${csrf(c)}<input type="hidden" name="undo" value="1"><button class="btn btn-block">Keep this service</button></form>`
                : html`<details class="danger-zone"><summary>Cancel this service</summary>
                  <form method="post" action="/services/${s.id}/cancel" class="stack">${csrf(c)}
                  <p class="small muted">It stays on until ${fmtDate(s.next_due)}, then stops. You won't be billed again.${s.product_type === "hosting" ? " Download anything you want to keep before then." : ""}</p>
                  ${field({ label: "Why are you leaving?", name: "reason", optional: true })}
                  <button class="btn btn-danger btn-block">Cancel at end of term</button></form></details>`
              : ""}
          </div>
        </section>
      </div>
      <section class="card"><div class="card-head"><h3>Invoices for this service</h3></div>
      ${invoices.length ? html`<div class="list">${invoices.map((i) => html`<a class="row" href="/invoices/${i.id}"><div><b>${i.number}</b><small>${fmtDate(i.issued)}</small></div><div class="row-end"><b>${money(i.total)}</b>${invoiceBadge(i)}</div></a>`)}</div>` : empty("No invoices yet.")}</section>`,
    });
  });

  r.post("/services/:id/panel", C, async (c) => {
    const s = await myService(c);
    if (!s?.berth_account || s.status !== "active") return notFound(c);
    try {
      const link = await berth(c.s, "POST", `/accounts/${accountRef(s)}/login-link`);
      await log(c.env, c.actor, c.client.id, "service.panel_login", s.label || s.product_name);
      return redirect(link.url);
    } catch (e) {
      return redirect(`/services/${s.id}`, `Couldn't open the control panel: ${e.message}`, "err");
    }
  });

  r.post("/services/:id/password", C, async (c) => {
    const s = await myService(c);
    if (!s?.berth_account || s.status !== "active") return notFound(c);
    try {
      const out = await berth(c.s, "POST", `/accounts/${accountRef(s)}/password`);
      await log(c.env, c.actor, c.client.id, "service.password_reset", s.label || s.product_name);
      return clientPage(c, {
        title: "New password", active: "services",
        body: html`<section class="card narrow"><div class="card-head"><h3>Your new control panel password</h3></div>
          <p>Copy it now: we don't keep a copy and won't show it again.</p>
          <dl class="dl"><dt>Username</dt><dd><code>${out.username}</code></dd><dt>Password</dt><dd><code class="secret" data-copy>${out.password}</code></dd></dl>
          <p><a class="btn" href="/services/${s.id}">Done</a></p></section>`,
      });
    } catch (e) {
      return redirect(`/services/${s.id}`, `Couldn't reset the password: ${e.message}`, "err");
    }
  });

  r.post("/services/:id/cancel", C, async (c) => {
    const s = await myService(c);
    if (!s || !["active", "suspended"].includes(s.status)) return notFound(c);
    if (c.form.get("undo") === "1") {
      await update(c.env, "services", s.id, { cancel_at_end: 0, cancel_reason: "" });
      await log(c.env, c.actor, c.client.id, "service.cancel_withdrawn", s.label || s.product_name);
      return redirect(`/services/${s.id}`, "Great, the service will carry on as normal.");
    }
    const reason = clean(c.form.get("reason"), 300);
    await update(c.env, "services", s.id, { cancel_at_end: 1, cancel_reason: reason });
    await log(c.env, c.actor, c.client.id, "service.cancel_requested", `${s.label || s.product_name}${reason ? `: ${reason}` : ""}`);
    await notifyAdmin(c.env, c.s, `Cancellation: ${s.product_name}${s.label ? ` (${s.label})` : ""}`, [
      `${c.client.email} asked to cancel at the end of the term (${fmtDate(s.next_due)}).`, ...(reason ? [{ quote: reason }] : []),
      { button: { label: "Open service", url: `${baseUrl(c.env)}/admin/services/${s.id}` } },
    ]);
    return redirect(`/services/${s.id}`, `Done. It stays on until ${fmtDate(s.next_due)} and won't renew.`);
  });

  // ---- invoices ----------------------------------------------------------------
  r.get("/invoices", C, async (c) => {
    const rows = await all(c.env, "SELECT * FROM invoices WHERE client_id = ? ORDER BY id DESC LIMIT 200", c.client.id);
    return clientPage(c, {
      title: "Invoices", active: "invoices",
      body: html`<section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Invoice</th><th class="hide-sm">Date</th><th class="hide-sm">Due</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${rows.map((i) => html`<tr data-href="/invoices/${i.id}"><td><a href="/invoices/${i.id}"><b>${i.number}</b></a></td><td class="hide-sm">${dateCell(i.issued)}</td><td class="hide-sm">${dateCell(i.due)}</td><td class="num">${money(i.total)}</td><td>${invoiceBadge(i)}</td></tr>`)}
      </tbody></table>` : empty("No invoices yet.")}</section>`,
    });
  });

  const myInvoice = async (c) => {
    const i = await getInvoice(c.env, Number(c.params.id));
    return i && i.client_id === c.client.id ? i : null;
  };

  r.get("/invoices/:id", C, async (c) => {
    let inv = await myInvoice(c);
    if (!inv) return notFound(c);
    // Back from Stripe Checkout: settle straight away rather than wait for the webhook.
    const sid = c.url.searchParams.get("checkout");
    if (sid && /^cs_[\w]+$/.test(sid) && c.s.stripe_secret_key) {
      try {
        const session = await stripe(c.s, "GET", `/checkout/sessions/${sid}`);
        if (Number(session.metadata?.purser_invoice) === inv.id) await handleCheckoutSession(c.env, c.s, session, c.ctx);
      } catch (e) {
        console.error("checkout return", e);
      }
      inv = await getInvoice(c.env, inv.id);
      return inv.status === "paid"
        ? redirect(`/invoices/${inv.id}`, "Thanks! Your payment went through.")
        : redirect(`/invoices/${inv.id}`, "Thanks. Your payment is processing and this page will update once it clears.");
    }
    return invoicePage(c, inv, await getItems(c.env, inv.id), false);
  });

  r.post("/invoices/:id/pay", C, async (c) => {
    const inv = await myInvoice(c);
    if (!inv || inv.status !== "unpaid") return redirect(`/invoices/${c.params.id}`);
    try {
      const url = await checkoutForInvoice(c.env, c.s, c.client, inv, { saveCard: c.form.get("save_card") === "1" });
      return redirect(url);
    } catch (e) {
      return redirect(`/invoices/${inv.id}`, `Card payments aren't working right now: ${e.message}`, "err");
    }
  });

  r.post("/invoices/:id/credit", C, async (c) => {
    const inv = await myInvoice(c);
    if (!inv || inv.status !== "unpaid") return redirect(`/invoices/${c.params.id}`);
    const used = await applyCredit(c.env, c.s, inv, c.client.credit, c.actor, c.ctx);
    return redirect(`/invoices/${inv.id}`, used ? `${money(used)} of credit applied.` : "No credit to apply.", used ? "ok" : "err");
  });

  // ---- ordering ------------------------------------------------------------------
  // Open to everyone: the website's plan buttons link straight here
  // (/order/<slug>?cycle=monthly|annually). Guests create their account on the
  // same page, then go straight to card payment.
  const O = optionalClient;
  const findProduct = (c, ref) =>
    one(c.env, "SELECT * FROM products WHERE visible = 1 AND (slug = ? OR CAST(id AS TEXT) = ?)", String(ref).toLowerCase(), String(ref));
  const features = (p) => String(p.description || "").split("\n").map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  const perLong = { monthly: "month", quarterly: "quarter", annually: "year" };

  r.get("/order", O, async (c) => {
    const products = await all(c.env, "SELECT * FROM products WHERE visible = 1 ORDER BY sort, id");
    return publicPage(c, {
      title: "Order", active: "order",
      body: products.length
        ? html`<div class="products">${products.map((p) => {
            const cycles = productCycles(p);
            const cheapest = cycles[0];
            const f = features(p);
            return html`<section class="card product"><h3>${p.name}</h3>
              <div class="price">${cheapest ? priceLabel(productPrice(p, cheapest), cheapest) : ""}</div>
              ${f.length > 1 ? html`<ul class="feat">${f.map((x) => html`<li>${icon("check")}<span>${x}</span></li>`)}</ul>` : html`<div class="product-desc">${textBlock(p.description)}</div>`}
              ${p.setup_fee ? html`<p class="small muted">Plus ${money(p.setup_fee)} set-up</p>` : ""}
              <a class="btn btn-primary btn-block" href="/order/${p.slug || p.id}">Choose ${p.name}</a></section>`;
          })}</div>`
        : html`<section class="card">${empty("There's nothing to order online right now. Open a ticket and we'll help.")}</section>`,
    });
  });

  r.get("/order/:id", O, async (c) => {
    const p = await findProduct(c, c.params.id);
    if (!p) return notFound(c);
    const cycles = productCycles(p);
    const want = c.url.searchParams.get("cycle");
    const picked = cycles.includes(want) ? want : cycles[0];
    const f = features(p);
    const guest = !c.client;
    const canRegister = c.s.allow_registration === "1";
    const next = encodeURIComponent(c.url.pathname + c.url.search);
    const summary = html`<aside class="card summary">
      <div class="eyebrow">Your order</div>
      <h3>${p.name}</h3>
      ${f.length ? html`<ul class="feat">${f.map((x) => html`<li>${icon("check")}<span>${x}</span></li>`)}</ul>` : ""}
      <dl class="sum-lines">
        ${cycles.map((cy) => html`<div data-cycle-line="${cy}"${cy === picked ? "" : raw(" hidden")}><dt>${CYCLES[cy].label}</dt><dd>${money(productPrice(p, cy))}</dd></div>`)}
        ${p.setup_fee ? html`<div><dt>Set-up</dt><dd>${money(p.setup_fee)}</dd></div>` : ""}
      </dl>
      ${cycles.map((cy) => html`<div class="sum-total" data-cycle-line="${cy}"${cy === picked ? "" : raw(" hidden")}><span>Due today</span><b>${money(productPrice(p, cy) + (p.setup_fee || 0))}</b></div>
        ${perLong[cy] ? html`<p class="small muted" data-cycle-line="${cy}"${cy === picked ? "" : raw(" hidden")}>Then ${money(productPrice(p, cy))} a ${perLong[cy]}, the same price every time it renews. Cancel any time.</p>` : ""}`)}
    </aside>`;
    const form = html`<form method="post" class="stack order-form">${csrf(c)}
        <section class="card">
          <h3 class="step-title"><span>1</span>How would you like to pay?</h3>
          <fieldset class="cycles" data-cycle-pick><legend class="sr">Billing period</legend>
          ${cycles.map((cy) => html`<label class="cycle"><input type="radio" name="cycle" value="${cy}" ${cy === picked ? raw("checked") : ""}><span><b>${CYCLES[cy].label}</b>${priceLabel(productPrice(p, cy), cy)}${cy === "annually" && p.price_monthly ? html`<em>${Math.round(100 - (productPrice(p, cy) / (p.price_monthly * 12)) * 100)}% less than monthly</em>` : ""}</span></label>`)}
          </fieldset>
        </section>
        <section class="card">
          <h3 class="step-title"><span>2</span>${p.needs_domain ? "Your domain" : "Reference"}</h3>
          ${p.needs_domain ? field({ label: "Domain name", name: "label", required: true, placeholder: "example.co.uk", hint: "The main address for your website. Keep it registered wherever it is now, you can add more domains later." }) : field({ label: "Reference", name: "label", optional: true, hint: "Anything that helps you recognise this service." })}
        </section>
        ${guest
          ? html`<section class="card">
              <h3 class="step-title"><span>3</span>Your details</h3>
              <p class="muted small">Already with us? <a href="/login?next=${next}">Sign in</a> and we'll fill this in.</p>
              ${canRegister ? html`<div class="grid2">${accountFields(c)}</div>` : html`<p>New accounts are made by invitation. <a href="/login?next=${next}">Sign in</a> to order.</p>`}
            </section>`
          : ""}
        <section class="card promo">
          <div class="promo-row">${field({ label: "Discount code", name: "code", optional: true, value: normCode(c.url.searchParams.get("code")), autocomplete: "off" })}<button type="button" class="btn" data-promo-apply="/order/${p.slug || p.id}/code">Apply</button></div>
          <p class="small" data-promo-note aria-live="polite"></p>
        </section>
        ${p.setup_fee ? html`<p class="small muted">A one-off set-up fee of ${money(p.setup_fee)} is added to the first invoice.</p>` : ""}
        ${field({ type: "checkbox", name: "save_card", value: 1, label: "Save my card so renewals are paid automatically", hint: "You can remove it any time from your account." })}
        <button class="btn btn-primary btn-lg btn-block"${guest && !canRegister ? raw(" disabled") : ""}>Continue to secure payment</button>
        <p class="small muted center">${icon("shield")} Card payments are handled by Stripe. We never see your card number.</p>
      </form>`;
    return publicPage(c, {
      title: `Order ${p.name}`, active: "order",
      body: html`<div class="checkout">${form}${summary}</div>`,
    });
  });

  // Checks a discount code for the order page, before the order is placed.
  r.get("/order/:id/code", O, async (c) => {
    const p = await findProduct(c, c.params.id);
    if (!p) return json({ ok: false, message: "No such product." }, 404);
    const cycle = c.url.searchParams.get("cycle");
    const price = productPrice(p, cycle);
    if (price === null) return json({ ok: false, message: "Pick how you'd like to pay first." });
    const res = await checkPromo(c.env, c.url.searchParams.get("code"), { product: p, cycle, clientId: c.client?.id });
    if (res.error) return json({ ok: false, message: res.error });
    const first = price + (p.setup_fee || 0);
    const off = discountOn(res.promo, first);
    return json({ ok: true, code: res.promo.code, message: `${res.promo.code}: ${describePromo(res.promo)}. You'll pay ${money(first - off)} today instead of ${money(first)}.` });
  });

  r.post("/order/:id", O, async (c) => {
    const p = await findProduct(c, c.params.id);
    if (!p) return notFound(c);
    const back = `/order/${p.slug || p.id}`;
    const cycle = c.form.get("cycle");
    if (productPrice(p, cycle) === null) return redirect(back, "Pick how you'd like to pay.", "err");
    let promo = null;
    if (normCode(c.form.get("code"))) {
      const res = await checkPromo(c.env, c.form.get("code"), { product: p, cycle, clientId: c.client?.id });
      if (res.error) return redirect(`${back}?cycle=${cycle}`, res.error, "err");
      promo = res.promo;
    }
    let label = clean(c.form.get("label"), 120).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (p.needs_domain && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(label)) return redirect(`${back}?cycle=${cycle}`, "Enter a domain like example.co.uk.", "err");
    if (!p.needs_domain) label = clean(c.form.get("label"), 120);
    const cookies = [];
    let client = c.client;
    let actor = c.actor;
    if (!client) {
      if (c.s.allow_registration !== "1") return redirect(`/login?next=${encodeURIComponent(back)}`);
      const res = await signUp(c, c.form);
      if (res.error) return redirect(res.existing ? `/login?next=${encodeURIComponent(`${back}?cycle=${cycle}`)}` : `${back}?cycle=${cycle}`, res.error, "err");
      client = res.client;
      actor = { kind: "client", id: client.id, name: client.email };
      cookies.push(res.cookie);
    } else {
      const pendingOrders = await one(c.env, "SELECT COUNT(*) AS n FROM services WHERE client_id = ? AND status = 'pending'", client.id);
      if (pendingOrders.n >= 5) return redirect("/invoices", "You have several unpaid orders. Pay or cancel those first.", "err");
    }
    const { invoice } = await placeOrder(c.env, c.s, client, p, { cycle, label, actor, ctx: c.ctx, promo });
    if (invoice.status === "paid") return redirect("/services", "Thanks! Your order is being set up.", "ok", cookies);
    if (c.s.stripe_secret_key) {
      try {
        const url = await checkoutForInvoice(c.env, c.s, client, invoice, { saveCard: c.form.get("save_card") === "1" });
        return redirect(url, null, "ok", cookies);
      } catch (e) {
        console.error("checkout after order failed", e?.message || e);
      }
    }
    return redirect(`/invoices/${invoice.id}`, "Order placed. Pay the invoice below to get started.", "ok", cookies);
  });

  // ---- account ---------------------------------------------------------------------
  r.get("/account", C, (c) => {
    const cl = c.client;
    return clientPage(c, {
      title: "My details", active: "account",
      body: html`<section class="card narrow"><form method="post" class="grid2">${csrf(c)}
        ${field({ label: "First name", name: "first_name", value: cl.first_name, required: true })}
        ${field({ label: "Last name", name: "last_name", value: cl.last_name, required: true })}
        ${field({ label: "Email", name: "email", type: "email", value: cl.email, required: true, wide: true, hint: "Invoices and replies to your tickets go here." })}
        ${field({ label: "Company", name: "company", value: cl.company, optional: true, wide: true })}
        ${field({ label: "Address", name: "address1", value: cl.address1, wide: true })}
        ${field({ label: "Address line 2", name: "address2", value: cl.address2, optional: true, wide: true })}
        ${field({ label: "Town or city", name: "city", value: cl.city })}
        ${field({ label: "County", name: "region", value: cl.region, optional: true })}
        ${field({ label: "Postcode", name: "postcode", value: cl.postcode })}
        ${field({ label: "Country", name: "country", value: cl.country })}
        ${field({ label: "Phone", name: "phone", type: "tel", value: cl.phone, optional: true })}
        ${field({ label: "VAT number", name: "vat_number", value: cl.vat_number, optional: true })}
        <div class="wide">${field({ label: "Current password", name: "current_password", type: "password", autocomplete: "current-password", hint: "Only needed to change your email." })}</div>
        <div class="wide"><button class="btn btn-primary">Save details</button></div>
      </form></section>`,
    });
  });

  r.post("/account", C, async (c) => {
    const f = c.form;
    const cl = c.client;
    const email = clean(f.get("email"), 254).toLowerCase();
    const fields = {};
    for (const k of ["first_name", "last_name", "company", "address1", "address2", "city", "region", "postcode", "country", "phone", "vat_number"]) fields[k] = clean(f.get(k), 200);
    if (email !== cl.email.toLowerCase()) {
      if (!c.session.staff_id && !(await verifyPassword(f.get("current_password") || "", cl.password_hash)))
        return redirect("/account", "Enter your current password to change your email.", "err");
      if (await one(c.env, "SELECT id FROM clients WHERE email = ? AND id != ?", email, cl.id)) return redirect("/account", "Another account uses that email.", "err");
      fields.email = email;
      fields.email_verified = 0;
    }
    await update(c.env, "clients", cl.id, fields);
    if (cl.stripe_customer && c.s.stripe_secret_key) {
      c.ctx.waitUntil(stripe(c.s, "POST", `/customers/${cl.stripe_customer}`, { email: fields.email || cl.email, name: fields.company || `${fields.first_name} ${fields.last_name}` }).catch(() => {}));
    }
    await log(c.env, c.actor, cl.id, "client.updated", fields.email ? `Email changed to ${fields.email}` : "Details updated");
    return redirect("/account", "Saved.");
  });

  r.post("/account/verify", C, async (c) => {
    const { makeToken } = await import("../lib/auth.js");
    const { sendEmail } = await import("../lib/email.js");
    const t = await makeToken(c.env, "verify", c.client.id, 72);
    await sendEmail(c.env, c.s, { to: c.client.email, clientId: c.client.id, subject: "Confirm your email address", lines: ["Please confirm your email address.", { button: { label: "Confirm my email", url: `${baseUrl(c.env)}/verify/${t}` } }] });
    return redirect("/", "Sent. Check your inbox.");
  });

  r.get("/account/payment", C, async (c) => {
    const cl = c.client;
    if (c.url.searchParams.get("checkout") && c.s.stripe_secret_key) {
      try {
        const session = await stripe(c.s, "GET", `/checkout/sessions/${c.url.searchParams.get("checkout")}`);
        if (Number(session.metadata?.purser_client) === cl.id) await handleCheckoutSession(c.env, c.s, session, c.ctx);
      } catch (e) {
        console.error(e);
      }
      return redirect("/account/payment", "Card saved.");
    }
    const credit = await all(c.env, "SELECT * FROM credit_log WHERE client_id = ? ORDER BY id DESC LIMIT 20", cl.id);
    return clientPage(c, {
      title: "Payment method", active: "payment",
      body: html`<div class="cols">
      <section class="card"><div class="card-head"><h3>Saved card</h3></div>
        ${cl.stripe_pm
          ? html`<div class="saved-card">${icon("card")}<div><b>${cl.stripe_pm_label}</b><small>${cl.auto_charge ? "Invoices are paid with this card on their due date." : "Not charged automatically."}</small></div></div>
            <form method="post" action="/account/payment" class="stack">${csrf(c)}
              ${field({ type: "checkbox", name: "auto_charge", value: cl.auto_charge, label: "Pay invoices with this card automatically" })}
              <div class="btn-row"><button class="btn btn-primary" name="action" value="save">Save</button><button class="btn" name="action" value="replace">Use a different card</button><button class="btn btn-danger-ghost" name="action" value="remove" data-confirm="Remove this card?">Remove card</button></div>
            </form>`
          : html`<p class="muted">Save a card and we'll pay your invoices with it on their due date, so your services never lapse.</p>
            <form method="post" action="/account/payment">${csrf(c)}<button class="btn btn-primary" name="action" value="replace" ${c.s.stripe_secret_key ? "" : raw("disabled")}>${icon("card")} Add a card</button></form>`}
        <p class="small muted">Cards are stored by Stripe. We never see your full card number.</p>
      </section>
      <section class="card"><div class="card-head"><h3>Account credit</h3><b>${money(cl.credit)}</b></div>
        ${credit.length ? html`<div class="list">${credit.map((x) => html`<div class="row"><div>${x.description}<small>${fmtDate(x.created_at)}</small></div><b class="${x.amount < 0 ? "neg" : "pos"}">${money(x.amount)}</b></div>`)}</div>` : empty("Credit you have with us shows here and is used on your next invoice.")}
      </section></div>`,
    });
  });

  r.post("/account/payment", C, async (c) => {
    const cl = c.client;
    const action = c.form.get("action");
    if (action === "replace") {
      try {
        return redirect(await checkoutForCard(c.env, c.s, cl));
      } catch (e) {
        return redirect("/account/payment", `Couldn't start Stripe: ${e.message}`, "err");
      }
    }
    if (action === "remove" && cl.stripe_pm) {
      await stripe(c.s, "POST", `/payment_methods/${cl.stripe_pm}/detach`).catch(() => {});
      await update(c.env, "clients", cl.id, { stripe_pm: null, stripe_pm_label: null });
      await log(c.env, c.actor, cl.id, "card.removed");
      return redirect("/account/payment", "Card removed.");
    }
    await update(c.env, "clients", cl.id, { auto_charge: c.form.get("auto_charge") === "1" ? 1 : 0 });
    return redirect("/account/payment", "Saved.");
  });

  r.get("/account/security", C, (c) =>
    clientPage(c, {
      title: "Security", active: "security",
      body: html`<section class="card narrow"><div class="card-head"><h3>Change password</h3></div>
      <form method="post" class="stack">${csrf(c)}
        ${field({ label: "Current password", name: "current", type: "password", autocomplete: "current-password", required: !c.session.staff_id })}
        ${field({ label: "New password", name: "password", type: "password", autocomplete: "new-password", required: true, hint: "At least 10 characters." })}
        ${field({ type: "checkbox", name: "others", value: 1, label: "Sign out everywhere else" })}
        <button class="btn btn-primary">Change password</button></form></section>`,
    }),
  );

  r.post("/account/security", C, async (c) => {
    if (!c.session.staff_id && !(await verifyPassword(c.form.get("current") || "", c.client.password_hash)))
      return redirect("/account/security", "Your current password isn't right.", "err");
    const err = passwordProblem(c.form.get("password"));
    if (err) return redirect("/account/security", err, "err");
    await update(c.env, "clients", c.client.id, { password_hash: await hashPassword(c.form.get("password")) });
    if (c.form.get("others") === "1") await run(c.env, "DELETE FROM sessions WHERE kind = 'client' AND subject_id = ? AND id != ?", c.client.id, c.session.id);
    await log(c.env, c.actor, c.client.id, "client.password_changed");
    return redirect("/account/security", "Password changed.");
  });
}

// Shared by the client and admin invoice pages; printable.
export function invoicePage(c, inv, items, admin, extra = "") {
  const s = c.s;
  const owed = inv.total - inv.paid;
  const unpaid = inv.status === "unpaid";
  const page = admin ? null : clientPage;
  const body = html`
  <div class="invoice-actions no-print">
    <a class="btn btn-sm" href="${admin ? `/admin/invoices` : "/invoices"}">← Invoices</a>
    <button class="btn btn-sm" data-print>${icon("print")} Print or save PDF</button>
  </div>
  ${!admin && unpaid ? html`<section class="card pay-box no-print">
    <div><h3>${money(owed)} to pay</h3><p class="muted">Due ${fmtDate(inv.due)}${inv.charge_error ? html` · last card payment failed: ${inv.charge_error}` : ""}</p></div>
    <div class="pay-actions">
      ${c.client.credit > 0 ? html`<form method="post" action="/invoices/${inv.id}/credit">${csrf(c)}<button class="btn">Use ${money(Math.min(c.client.credit, owed))} credit</button></form>` : ""}
      ${s.stripe_secret_key ? html`<form method="post" action="/invoices/${inv.id}/pay" class="stack-sm">${csrf(c)}
        <button class="btn btn-primary">${icon("card")} Pay by card</button>
        ${!c.client.stripe_pm ? html`<label class="check small"><input type="checkbox" name="save_card" value="1" checked> <span>Save card for future invoices</span></label>` : ""}
      </form>` : ""}
    </div>
    ${s.bank_details ? html`<details class="bank"><summary>Pay by bank transfer instead</summary><div>${textBlock(s.bank_details)}<p class="small">Use <b>${inv.number}</b> as the reference.</p></div></details>` : ""}
  </section>` : ""}
  ${extra}
  <article class="card invoice">
    <header class="inv-head">
      <div><div class="inv-brand">${s.company_name}</div><div class="small muted pre">${s.company_address}</div>${s.company_vat ? html`<div class="small muted">VAT ${s.company_vat}</div>` : ""}</div>
      <div class="inv-meta"><h2>Invoice ${inv.number}</h2>${invoiceBadge(inv)}
        <dl><dt>Date</dt><dd>${fmtDate(inv.issued)}</dd><dt>Due</dt><dd>${fmtDate(inv.due)}</dd>${inv.paid_at ? html`<dt>Paid</dt><dd>${fmtDate(inv.paid_at)}</dd>` : ""}</dl></div>
    </header>
    <div class="inv-to"><small>Bill to</small><div class="pre">${inv.bill_to}</div></div>
    <table class="table inv-lines"><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${items.map((i) => html`<tr><td>${i.description}</td><td class="num">${money(i.amount)}</td></tr>`)}</tbody>
    <tfoot>
      <tr><td class="num">Subtotal</td><td class="num">${money(inv.subtotal)}</td></tr>
      ${inv.tax_label ? html`<tr><td class="num">${inv.tax_label} at ${inv.tax_rate}%</td><td class="num">${money(inv.tax)}</td></tr>` : ""}
      <tr class="total"><td class="num">Total</td><td class="num">${money(inv.total)}</td></tr>
      ${inv.paid ? html`<tr><td class="num">Paid</td><td class="num">${money(-inv.paid)}</td></tr><tr class="total"><td class="num">Balance</td><td class="num">${money(Math.max(0, owed))}</td></tr>` : ""}
    </tfoot></table>
    ${inv.notes ? html`<div class="inv-notes">${textBlock(inv.notes)}</div>` : ""}
  </article>`;
  return page ? page(c, { title: `Invoice ${inv.number}`, active: "invoices", body }) : body;
}
