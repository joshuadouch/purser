// Billing engine: invoices, payments, credit, service lifecycle and the
// Berth provisioning that follows payment.
import { all, batch, insert, one, run, stmt, update } from "./db.js";
import { sendEmail } from "./email.js";
import { nextInvoiceNumber } from "./settings.js";
import { CYCLES, addDays, cycleEnd, fmtDate, fullName, money, nowIso, today } from "./util.js";
import { BerthError, accountRef, berth, berthReady, externalId, parseLimits } from "./berth.js";
import { cardLabel, stripe } from "./stripe.js";
import { discountOn } from "./promo.js";

export const SYSTEM = { kind: "system", id: null, name: "System" };
export const baseUrl = (env) => (env.PUBLIC_URL || "https://clientarea.ratlan.net").replace(/\/+$/, "");

export async function log(env, actor, clientId, action, detail = "") {
  await run(
    env,
    "INSERT INTO activity (at, actor_kind, actor_id, actor_name, client_id, action, detail) VALUES (?,?,?,?,?,?,?)",
    nowIso(), actor?.kind || "system", actor?.id ?? null, actor?.name || "System", clientId ?? null, action, String(detail).slice(0, 1000),
  );
}

export const getClient = (env, id) => one(env, "SELECT * FROM clients WHERE id = ?", id);
export const getInvoice = (env, id) => one(env, "SELECT * FROM invoices WHERE id = ?", id);
export const getItems = (env, id) => all(env, "SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id", id);
export const getService = (env, id) =>
  one(env, "SELECT s.*, p.name AS product_name, p.type AS product_type, p.berth_plan FROM services s JOIN products p ON p.id = s.product_id WHERE s.id = ?", id);

export function billTo(client) {
  return [
    client.company,
    fullName(client),
    client.address1,
    client.address2,
    [client.city, client.region].filter(Boolean).join(", "),
    client.postcode,
    client.country,
    client.vat_number ? `VAT: ${client.vat_number}` : "",
  ]
    .filter((x) => x && x.trim())
    .join("\n");
}

export function taxFor(s, client, items) {
  const on = s.tax_enabled === "1" && !client.tax_exempt;
  const rate = on ? Number(s.tax_rate) || 0 : 0;
  const taxable = items.filter((i) => i.taxed !== 0 && i.taxed !== false).reduce((a, i) => a + i.amount, 0);
  const subtotal = items.reduce((a, i) => a + i.amount, 0);
  const tax = Math.round((taxable * rate) / 100);
  return { subtotal, tax, total: subtotal + tax, rate, label: on ? s.tax_label : "" };
}

// items: [{ service_id, kind, description, amount, period_start, period_end, taxed }]
export async function createInvoice(env, s, clientId, items, opts = {}) {
  const client = await getClient(env, clientId);
  if (!client) throw new Error("No such client");
  const t = taxFor(s, client, items);
  const number = await nextInvoiceNumber(env, s);
  const issued = opts.issued || today();
  const due = opts.due || addDays(issued, Number(s.payment_terms_days) || 0);
  const stage = opts.reminderStage ?? (dueWithin(due, Number(s.reminder_before_days) || 0) ? 1 : 0);
  const id = await insert(
    env,
    `INSERT INTO invoices (number, client_id, status, issued, due, subtotal, tax_rate, tax_label, tax, total, notes, bill_to, reminder_stage, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    number, clientId, "unpaid", issued, due, t.subtotal, t.rate, t.label, t.tax, t.total, opts.notes || "", billTo(client), stage, nowIso(),
  );
  await batch(
    env,
    items.map((i) =>
      stmt(
        env,
        "INSERT INTO invoice_items (invoice_id, service_id, kind, description, amount, taxed, period_start, period_end) VALUES (?,?,?,?,?,?,?,?)",
        id, i.service_id ?? null, i.kind || "custom", i.description, i.amount, i.taxed === false || i.taxed === 0 ? 0 : 1, i.period_start ?? null, i.period_end ?? null,
      ),
    ),
  );
  await log(env, opts.actor || SYSTEM, clientId, "invoice.created", `Invoice ${number} for ${money(t.total)}`);
  let inv = await getInvoice(env, id);
  if (t.total <= 0) {
    await markPaidIfSettled(env, s, inv, opts.ctx);
    return getInvoice(env, id);
  }
  if (opts.applyCredit !== false && s.auto_apply_credit === "1" && client.credit > 0) {
    await applyCredit(env, s, inv, Math.min(client.credit, t.total), opts.actor || SYSTEM, opts.ctx);
    inv = await getInvoice(env, id);
  }
  if (opts.email !== false && inv.status === "unpaid") await emailInvoice(env, s, inv, client);
  return inv;
}

const dueWithin = (due, days) => due <= addDays(today(), days);

export async function recalcInvoice(env, s, invoiceId) {
  const inv = await getInvoice(env, invoiceId);
  const client = await getClient(env, inv.client_id);
  const items = await getItems(env, invoiceId);
  const t = taxFor(s, client, items);
  await update(env, "invoices", invoiceId, { subtotal: t.subtotal, tax: t.tax, total: t.total, tax_rate: t.rate, tax_label: t.label });
}

// Records money against an invoice. Idempotent on (gateway, reference).
export async function recordPayment(env, s, { invoiceId, amount, gateway, reference = null, notes = "", actor = SYSTEM, ctx }) {
  const inv = await getInvoice(env, invoiceId);
  if (!inv) throw new Error("No such invoice");
  if (reference) {
    const dupe = await one(env, "SELECT id FROM transactions WHERE gateway = ? AND reference = ?", gateway, reference);
    if (dupe) return { duplicate: true };
  }
  try {
    await insert(
      env,
      "INSERT INTO transactions (client_id, invoice_id, gateway, reference, amount, notes, staff_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
      inv.client_id, inv.id, gateway, reference, amount, notes, actor.kind === "staff" ? actor.id : null, nowIso(),
    );
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return { duplicate: true };
    throw e;
  }
  await run(env, "UPDATE invoices SET paid = paid + ? WHERE id = ?", amount, inv.id);
  await log(env, actor, inv.client_id, "payment.received", `${money(amount)} by ${gateway} on ${inv.number}${reference ? ` (${reference})` : ""}`);
  const fresh = await getInvoice(env, inv.id);
  // Money paid on top of what was owed (or to a cancelled/paid invoice) becomes credit.
  const extra = fresh.status !== "unpaid" ? amount : Math.max(0, fresh.paid - fresh.total);
  if (extra > 0 && amount > 0) {
    await run(env, "UPDATE invoices SET paid = paid - ? WHERE id = ?", extra, inv.id);
    await addCredit(env, inv.client_id, extra, `Overpayment on ${inv.number}`, actor, inv.id);
  }
  await markPaidIfSettled(env, s, await getInvoice(env, inv.id), ctx);
  return { duplicate: false };
}

async function markPaidIfSettled(env, s, inv, ctx) {
  if (inv.status !== "unpaid" || inv.paid < inv.total) return false;
  const won = await one(env, "UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'unpaid' RETURNING id", nowIso(), inv.id);
  if (!won) return false;
  await onInvoicePaid(env, s, await getInvoice(env, inv.id), ctx);
  return true;
}

export async function addCredit(env, clientId, amount, description, actor = SYSTEM, invoiceId = null) {
  await run(env, "UPDATE clients SET credit = credit + ? WHERE id = ?", amount, clientId);
  await insert(
    env, "INSERT INTO credit_log (client_id, amount, description, invoice_id, staff_id, created_at) VALUES (?,?,?,?,?,?)",
    clientId, amount, description, invoiceId, actor.kind === "staff" ? actor.id : null, nowIso(),
  );
  await log(env, actor, clientId, amount >= 0 ? "credit.added" : "credit.removed", `${money(Math.abs(amount))}: ${description}`);
}

export async function applyCredit(env, s, inv, amount, actor = SYSTEM, ctx) {
  amount = Math.min(amount, inv.total - inv.paid);
  if (amount <= 0 || inv.status !== "unpaid") return 0;
  const ok = await one(env, "UPDATE clients SET credit = credit - ? WHERE id = ? AND credit >= ? RETURNING credit", amount, inv.client_id, amount);
  if (!ok) return 0;
  await insert(
    env, "INSERT INTO credit_log (client_id, amount, description, invoice_id, staff_id, created_at) VALUES (?,?,?,?,?,?)",
    inv.client_id, -amount, `Applied to ${inv.number}`, inv.id, actor.kind === "staff" ? actor.id : null, nowIso(),
  );
  await recordPayment(env, s, { invoiceId: inv.id, amount, gateway: "credit", actor, ctx });
  return amount;
}

export async function cancelInvoice(env, s, inv, actor) {
  if (inv.status !== "unpaid") return;
  await update(env, "invoices", inv.id, { status: "cancelled" });
  if (inv.paid > 0) {
    await run(env, "UPDATE invoices SET paid = 0 WHERE id = ?", inv.id);
    await addCredit(env, inv.client_id, inv.paid, `Payments on cancelled invoice ${inv.number}`, actor, inv.id);
  }
  // An unpaid order invoice being cancelled cancels the order.
  for (const it of await getItems(env, inv.id)) {
    if (!it.service_id) continue;
    await run(env, "UPDATE services SET status = 'cancelled' WHERE id = ? AND status = 'pending'", it.service_id);
  }
  await log(env, actor, inv.client_id, "invoice.cancelled", inv.number);
}

// ---- after payment ----------------------------------------------------------

async function onInvoicePaid(env, s, inv, ctx) {
  const items = await getItems(env, inv.id);
  const client = await getClient(env, inv.client_id);
  for (const it of items) {
    if (!it.service_id || it.kind !== "service") continue;
    const svc = await getService(env, it.service_id);
    if (!svc) continue;
    if (svc.status === "pending") {
      await activateService(env, s, svc, it, ctx);
    } else if (svc.next_due && it.period_start === svc.next_due && it.period_end) {
      await update(env, "services", svc.id, { next_due: it.period_end });
      if (svc.status === "suspended" && svc.suspend_reason.startsWith("Overdue")) {
        const still = await stillOverdue(env, s, svc.id);
        if (!still) await unsuspendService(env, s, await getService(env, svc.id), SYSTEM);
      }
    }
  }
  await sendEmail(env, s, {
    to: client.email,
    clientId: client.id,
    subject: `Payment received for invoice ${inv.number}`,
    lines: [
      `Hi ${client.first_name || "there"},`,
      `Thanks, we've received payment for invoice ${inv.number}.`,
      { rows: [["Invoice", inv.number], ["Amount", money(inv.total)], ["Paid", fmtDate(today())]] },
      { button: { label: "View invoice", url: `${baseUrl(env)}/invoices/${inv.id}` } },
    ],
  });
}

async function stillOverdue(env, s, serviceId) {
  const cutoff = addDays(today(), -(Number(s.suspend_after_days) || 0));
  const r = await one(
    env,
    `SELECT COUNT(*) AS n FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id
     WHERE it.service_id = ? AND i.status = 'unpaid' AND i.due <= ?`,
    serviceId, cutoff,
  );
  return r.n > 0;
}

async function activateService(env, s, svc, item, ctx) {
  const start = item?.period_start || today();
  const next = item?.period_end || cycleEnd(start, svc.cycle);
  await update(env, "services", svc.id, { status: "active", start_date: start, next_due: next });
  await log(env, SYSTEM, svc.client_id, "service.activated", `${svc.product_name}${svc.label ? ` (${svc.label})` : ""}`);
  if (svc.product_type === "hosting") {
    const job = provisionService(env, s, await getService(env, svc.id), SYSTEM);
    if (ctx?.waitUntil) ctx.waitUntil(job.catch((e) => console.error(e)));
    else await job;
  } else {
    await notifyAdmin(env, s, `New order: ${svc.product_name}`, [
      `${svc.product_name}${svc.label ? ` (${svc.label})` : ""} has been paid for and needs setting up by hand.`,
      { button: { label: "Open service", url: `${baseUrl(env)}/admin/services/${svc.id}` } },
    ]);
  }
}

// ---- Berth --------------------------------------------------------------------

export async function provisionService(env, s, svc, actor) {
  const client = await getClient(env, svc.client_id);
  if (!berthReady(s)) {
    await update(env, "services", svc.id, { provision_error: "Berth is not connected (Settings → Berth)" });
    await notifyAdmin(env, s, "A hosting order is waiting to be set up", [
      `Service #${svc.id} (${svc.product_name}${svc.label ? `, ${svc.label}` : ""}) for ${client.email} is paid but Berth isn't connected, so no account was made.`,
      { button: { label: "Open service", url: `${baseUrl(env)}/admin/services/${svc.id}` } },
    ]);
    return false;
  }
  try {
    let created;
    try {
      created = await berth(s, "POST", "/accounts", {
        email: client.email,
        name: client.company || fullName(client),
        plan: svc.berth_plan || undefined,
        external_id: externalId(svc.id),
        notes: `Purser service #${svc.id}${svc.label ? ` (${svc.label})` : ""}`,
      });
    } catch (e) {
      // Already made (a retry after a timeout, say): adopt it.
      if (e instanceof BerthError && e.status === 409 && e.data?.account_id) {
        const acc = await berth(s, "GET", `/accounts/${encodeURIComponent(e.data.account_id)}`);
        created = { account: acc, username: acc?.users?.[0]?.username || null, adopted: true };
      } else throw e;
    }
    const accId = created.account?.id || created.account?.account?.id;
    await update(env, "services", svc.id, { berth_account: accId, berth_username: created.username, provision_error: null });
    await log(env, actor, svc.client_id, "service.provisioned", `Berth account ${accId}${created.username ? ` (${created.username})` : ""}`);
    const mail = await provisionMail(env, s, { ...svc, berth_account: accId }, actor);
    if (!created.adopted) {
      await sendEmail(env, s, {
        to: client.email,
        clientId: client.id,
        subject: `Your hosting is ready${svc.label ? `: ${svc.label}` : ""}`,
        lines: [
          `Hi ${client.first_name || "there"},`,
          `Your ${svc.product_name} account is set up and ready to use.`,
          {
            rows: [
              ["Control panel", created.login_url || s.berth_url],
              ["Username", created.username || ""],
              ...(created.password ? [["Password", created.password]] : []),
            ],
          },
          ...(mail?.domain
            ? [`Email for ${mail.domain} is set up. Add your mailboxes on the Mail page of the control panel, then read your mail at ${mail.webmail || "webmail"} or in any mail app.`]
            : []),
          "You can also sign in to the control panel straight from your client area, without a password.",
          { button: { label: "Open your client area", url: `${baseUrl(env)}/services/${svc.id}` } },
          "Please change your password after signing in. We'll never ask you for it.",
        ],
      });
    }
    return true;
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await update(env, "services", svc.id, { provision_error: msg });
    await log(env, actor, svc.client_id, "service.provision_failed", msg);
    await notifyAdmin(env, s, "Setting up a hosting account failed", [
      `Berth refused to create the account for service #${svc.id} (${client.email}).`,
      { quote: msg },
      { button: { label: "Open service", url: `${baseUrl(env)}/admin/services/${svc.id}` } },
    ]);
    return false;
  }
}

// Sets the service's domain up as a mail domain in Berth when its plan
// includes mail. Failures are recorded on the service and sent to the admin;
// the hosting account itself is already made.
export async function provisionMail(env, s, svc, actor) {
  const product = svc.product_id ? await one(env, "SELECT berth_limits FROM products WHERE id = ?", svc.product_id) : null;
  const limits = parseLimits(product?.berth_limits);
  const domain = String(svc.label || "").trim().toLowerCase();
  if (!(parseInt(limits.mail_domains, 10) > 0) || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return null;
  try {
    const r = await berth(s, "POST", `/accounts/${accountRef(svc)}/plugins/mailcow`, { domain });
    await log(env, actor, svc.client_id, "service.mail", `Mail domain ${domain}${r?.created === false ? " (already set up)" : ""}`);
    return { domain, webmail: r?.webmail || "" };
  } catch (e) {
    const msg = `Mail domain ${domain}: ${String(e.message || e).slice(0, 400)}`;
    await update(env, "services", svc.id, { provision_error: msg });
    await log(env, actor, svc.client_id, "service.provision_failed", msg);
    await notifyAdmin(env, s, "Setting up a mail domain failed", [
      `The Berth account for service #${svc.id} was made, but adding ${domain} as a mail domain failed. Add it on Berth's Mail page, or fix the problem and press Set up again.`,
      { quote: msg },
      { button: { label: "Open service", url: `${baseUrl(env)}/admin/services/${svc.id}` } },
    ]);
    return null;
  }
}

export async function suspendService(env, s, svc, reason, actor) {
  if (svc.berth_account && berthReady(s)) await berth(s, "POST", `/accounts/${accountRef(svc)}/suspend`, { reason: `Purser: ${reason}` });
  await update(env, "services", svc.id, { status: "suspended", suspend_reason: reason });
  await log(env, actor, svc.client_id, "service.suspended", `${svc.product_name}${svc.label ? ` (${svc.label})` : ""}: ${reason}`);
}

export async function unsuspendService(env, s, svc, actor) {
  if (svc.berth_account && berthReady(s)) await berth(s, "POST", `/accounts/${accountRef(svc)}/unsuspend`);
  await update(env, "services", svc.id, { status: "active", suspend_reason: "" });
  await log(env, actor, svc.client_id, "service.unsuspended", `${svc.product_name}${svc.label ? ` (${svc.label})` : ""}`);
}

export async function terminateService(env, s, svc, actor, { deleteSites = false } = {}) {
  let note = "";
  if (svc.berth_account && berthReady(s)) {
    const r = await berth(s, "DELETE", `/accounts/${accountRef(svc)}${deleteSites ? "?delete_sites=1" : ""}`);
    note = r?.status === "terminating" ? " (Berth is deleting the sites after a final backup)" : "";
  }
  await update(env, "services", svc.id, { status: "terminated", next_due: null });
  await log(env, actor, svc.client_id, "service.terminated", `${svc.product_name}${svc.label ? ` (${svc.label})` : ""}${note}`);
  return note;
}

// ---- Stripe -------------------------------------------------------------------

export async function ensureStripeCustomer(env, s, client) {
  if (client.stripe_customer) return client.stripe_customer;
  const cus = await stripe(s, "POST", "/customers", {
    email: client.email,
    name: client.company || fullName(client) || undefined,
    metadata: { purser_client: client.id },
  }, `purser-customer-${client.id}`);
  await update(env, "clients", client.id, { stripe_customer: cus.id });
  return cus.id;
}

export async function checkoutForInvoice(env, s, client, inv, { saveCard }) {
  const due = inv.total - inv.paid;
  const customer = await ensureStripeCustomer(env, s, client);
  const session = await stripe(s, "POST", "/checkout/sessions", {
    mode: "payment",
    customer,
    client_reference_id: String(inv.id),
    line_items: [{ quantity: 1, price_data: { currency: s.currency.toLowerCase(), unit_amount: due, product_data: { name: `Invoice ${inv.number}` } } }],
    payment_intent_data: {
      metadata: { purser_invoice: inv.id, purser_client: client.id },
      description: `${s.company_name} invoice ${inv.number}`,
      setup_future_usage: saveCard ? "off_session" : undefined,
    },
    metadata: { purser_invoice: inv.id, purser_client: client.id, save_card: saveCard ? "1" : "0" },
    success_url: `${baseUrl(env)}/invoices/${inv.id}?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl(env)}/invoices/${inv.id}`,
  });
  return session.url;
}

export async function checkoutForCard(env, s, client) {
  const customer = await ensureStripeCustomer(env, s, client);
  const session = await stripe(s, "POST", "/checkout/sessions", {
    mode: "setup",
    customer,
    currency: s.currency.toLowerCase(),
    payment_method_types: ["card"],
    metadata: { purser_client: client.id, purpose: "save_card" },
    success_url: `${baseUrl(env)}/account/payment?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl(env)}/account/payment`,
  });
  return session.url;
}

export async function saveCard(env, s, clientId, pmId) {
  const pm = await stripe(s, "GET", `/payment_methods/${pmId}`);
  await update(env, "clients", clientId, { stripe_pm: pm.id, stripe_pm_label: cardLabel(pm) });
  const client = await getClient(env, clientId);
  if (client.stripe_customer) {
    await stripe(s, "POST", `/customers/${client.stripe_customer}`, { invoice_settings: { default_payment_method: pm.id } }).catch(() => {});
  }
  await log(env, SYSTEM, clientId, "card.saved", cardLabel(pm));
}

// Handles a finished Checkout Session (from the webhook or the success redirect).
export async function handleCheckoutSession(env, s, session, ctx) {
  const clientId = Number(session.metadata?.purser_client);
  if (session.mode === "setup") {
    if (session.status !== "complete" || !session.setup_intent) return;
    const si = typeof session.setup_intent === "string" ? await stripe(s, "GET", `/setup_intents/${session.setup_intent}`) : session.setup_intent;
    if (si.payment_method && clientId) await saveCard(env, s, clientId, typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id);
    return;
  }
  if (session.payment_status !== "paid") return;
  const invoiceId = Number(session.metadata?.purser_invoice);
  if (!invoiceId) return;
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  await recordPayment(env, s, { invoiceId, amount: session.amount_total, gateway: "stripe", reference: piId || session.id, ctx });
  if (session.metadata?.save_card === "1" && piId && clientId) {
    const pi = await stripe(s, "GET", `/payment_intents/${piId}`);
    if (pi.payment_method) await saveCard(env, s, clientId, typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method.id);
  }
}

export async function chargeSavedCard(env, s, inv, client, ctx) {
  const amount = inv.total - inv.paid;
  if (amount < 30 || !client.stripe_pm || !client.stripe_customer) return { ok: false, error: "Nothing to charge" };
  const attempt = inv.charge_attempts + 1;
  await update(env, "invoices", inv.id, { charge_attempts: attempt, last_charge_at: today() });
  try {
    const pi = await stripe(
      s, "POST", "/payment_intents",
      {
        amount, currency: s.currency.toLowerCase(), customer: client.stripe_customer, payment_method: client.stripe_pm,
        off_session: true, confirm: true, description: `${s.company_name} invoice ${inv.number}`,
        metadata: { purser_invoice: inv.id, purser_client: client.id, source: "auto" },
      },
      `purser-inv-${inv.id}-${attempt}`,
    );
    if (pi.status === "succeeded") {
      await recordPayment(env, s, { invoiceId: inv.id, amount: pi.amount_received || amount, gateway: "stripe", reference: pi.id, ctx });
      await update(env, "invoices", inv.id, { charge_error: null });
      return { ok: true };
    }
    if (pi.status === "processing") return { ok: true, pending: true };
    throw new Error(`Payment ${pi.status.replace(/_/g, " ")}`);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await update(env, "invoices", inv.id, { charge_error: msg });
    await log(env, SYSTEM, client.id, "payment.failed", `${inv.number}: ${msg}`);
    await sendEmail(env, s, {
      to: client.email, clientId: client.id,
      subject: `We couldn't take payment for invoice ${inv.number}`,
      lines: [
        `Hi ${client.first_name || "there"},`,
        `We tried to charge your saved card (${client.stripe_pm_label || "card"}) for invoice ${inv.number} but it didn't go through.`,
        { quote: msg },
        "Please pay the invoice online, or update your card.",
        { button: { label: "Pay invoice", url: `${baseUrl(env)}/invoices/${inv.id}` } },
      ],
    });
    return { ok: false, error: msg };
  }
}

// ---- emails -----------------------------------------------------------------------

export async function emailInvoice(env, s, inv, client) {
  client ||= await getClient(env, inv.client_id);
  const items = await getItems(env, inv.id);
  return sendEmail(env, s, {
    to: client.email, clientId: client.id,
    subject: `Invoice ${inv.number} from ${s.company_name}`,
    lines: [
      `Hi ${client.first_name || "there"},`,
      `Here's your invoice ${inv.number}${client.stripe_pm && client.auto_charge ? `. We'll charge your saved card (${client.stripe_pm_label}) on the due date.` : "."}`,
      { rows: [...items.map((i) => [i.description, money(i.amount)]), ...(inv.tax ? [[`${inv.tax_label} (${inv.tax_rate}%)`, money(inv.tax)]] : []), ["Total", money(inv.total)], ["Due", fmtDate(inv.due)]] },
      { button: { label: "View and pay", url: `${baseUrl(env)}/invoices/${inv.id}` } },
    ],
  });
}

export async function notifyAdmin(env, s, subject, lines) {
  const to = s.admin_notify_email || env.ADMIN_EMAIL;
  if (!to) return;
  await sendEmail(env, s, { to, subject: `[${s.company_name}] ${subject}`, lines });
}

// ---- orders --------------------------------------------------------------------

export function productPrice(p, cycle) {
  return { monthly: p.price_monthly, quarterly: p.price_quarterly, annually: p.price_annually, once: p.price_once }[cycle] ?? null;
}
export const productCycles = (p) => Object.keys(CYCLES).filter((c) => productPrice(p, c) !== null);

// promo: a row from promo_codes, already checked with checkPromo.
export async function placeOrder(env, s, client, product, { cycle, label, actor, ctx, invoice = true, promo = null }) {
  const price = productPrice(product, cycle);
  if (price === null) throw new Error("That billing cycle isn't offered for this product");
  // A recurring code lowers the price the service renews at, too.
  const renewPrice = promo?.recurring ? price - discountOn(promo, price) : price;
  const sid = await insert(
    env, "INSERT INTO services (client_id, product_id, label, cycle, price, status, promo_code, created_at) VALUES (?,?,?,?,?,?,?,?)",
    client.id, product.id, label || "", cycle, renewPrice, "pending", promo?.code || "", nowIso(),
  );
  await log(env, actor, client.id, "order.placed", `${product.name}${label ? ` (${label})` : ""}, ${CYCLES[cycle].label.toLowerCase()} at ${money(renewPrice)}${promo ? ` with code ${promo.code}` : ""}`);
  if (!invoice) return { serviceId: sid };
  const start = today();
  const end = cycleEnd(start, cycle);
  const desc = `${product.name}${label ? ` - ${label}` : ""}${end ? ` (${fmtDate(start)} to ${fmtDate(addDays(end, -1))})` : ""}`;
  const items = [{ service_id: sid, kind: "service", description: desc, amount: price, period_start: start, period_end: end }];
  if (product.setup_fee) items.push({ service_id: sid, kind: "setup", description: `${product.name} set-up fee`, amount: product.setup_fee });
  const off = promo ? discountOn(promo, items.reduce((a, i) => a + i.amount, 0)) : 0;
  if (off > 0) items.push({ service_id: sid, kind: "discount", description: `Discount code ${promo.code}`, amount: -off });
  const inv = await createInvoice(env, s, client.id, items, { due: start, actor, ctx });
  if (promo) {
    await insert(
      env, "INSERT INTO promo_redemptions (promo_id, client_id, service_id, invoice_id, amount, created_at) VALUES (?,?,?,?,?,?)",
      promo.id, client.id, sid, inv.id, off, nowIso(),
    );
  }
  await notifyAdmin(env, s, `New order from ${client.email}`, [
    `${fullName(client) || client.email} ordered ${product.name}${label ? ` (${label})` : ""}, ${CYCLES[cycle].label.toLowerCase()} at ${money(renewPrice)}${promo ? `, with discount code ${promo.code} (${money(off)} off the first invoice)` : ""}.`,
    { button: { label: "Open client", url: `${baseUrl(env)}/admin/clients/${client.id}` } },
  ]);
  return { serviceId: sid, invoice: inv };
}
