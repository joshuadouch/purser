// The daily run: renewal invoices, reminders, card charges, suspensions,
// cancellations at the end of term, ticket auto-close and clean-up.
import { all, run } from "./db.js";
import { sendEmail } from "./email.js";
import {
  SYSTEM, baseUrl, cancelInvoice, chargeSavedCard, createInvoice, getClient, getInvoice, getService, log, notifyAdmin,
  suspendService, terminateService,
} from "./billing.js";
import { pruneAnalytics } from "./analytics.js";
import { addDays, cycleEnd, daysBetween, fmtDate, money, nowIso, today } from "./util.js";

export async function runDaily(env, s, ctx, day = today()) {
  const report = {};
  const step = async (name, fn) => {
    try {
      report[name] = await fn();
    } catch (e) {
      console.error(`cron ${name} failed`, e);
      report[name] = `error: ${e.message}`;
    }
  };
  await step("cancellations", () => endOfTermCancellations(env, s, day));
  await step("invoices", () => renewalInvoices(env, s, day, ctx));
  await step("charges", () => autoCharge(env, s, day, ctx));
  await step("reminders", () => reminders(env, s, day));
  await step("suspensions", () => overdueSuspensions(env, s, day));
  await step("terminations", () => overdueTerminations(env, s, day));
  await step("tickets", () => autoCloseTickets(env, s));
  await step("cleanup", () => cleanup(env));
  await step("analytics", () => pruneAnalytics(env));
  return report;
}

export async function renewalInvoices(env, s, day, ctx) {
  const horizon = addDays(day, Number(s.invoice_days_before) || 0);
  const due = await all(
    env,
    `SELECT s.*, p.name AS product_name FROM services s JOIN products p ON p.id = s.product_id
     WHERE s.status IN ('active','suspended') AND s.cycle != 'once' AND s.cancel_at_end = 0
       AND s.next_due IS NOT NULL AND s.next_due <= ? AND s.price >= 0
       AND NOT EXISTS (SELECT 1 FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
                       WHERE it.service_id = s.id AND it.period_start = s.next_due AND it.kind = 'service' AND i.status != 'cancelled')
     ORDER BY s.client_id, s.next_due`,
    horizon,
  );
  const groups = new Map();
  for (const svc of due) {
    const k = `${svc.client_id}|${svc.next_due}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(svc);
  }
  let made = 0;
  for (const [k, svcs] of groups) {
    const [clientId, nextDue] = k.split("|");
    const items = svcs.map((svc) => {
      const end = cycleEnd(svc.next_due, svc.cycle);
      return {
        service_id: svc.id, kind: "service", amount: svc.price, period_start: svc.next_due, period_end: end,
        description: `${svc.product_name}${svc.label ? ` - ${svc.label}` : ""} (${fmtDate(svc.next_due)} to ${fmtDate(addDays(end, -1))})`,
      };
    });
    await createInvoice(env, s, Number(clientId), items, { issued: day, due: nextDue, ctx });
    made++;
  }
  return made;
}

async function autoCharge(env, s, day, ctx) {
  if (!s.stripe_secret_key) return "stripe off";
  const retry = Number(s.auto_charge_retry_days) || 3;
  const rows = await all(
    env,
    `SELECT i.id FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.status = 'unpaid' AND i.due <= ? AND c.stripe_pm IS NOT NULL AND c.auto_charge = 1
       AND i.charge_attempts < 3 AND (i.last_charge_at IS NULL OR i.last_charge_at <= ?)`,
    day, addDays(day, -retry),
  );
  let ok = 0;
  for (const r of rows) {
    const inv = await getInvoice(env, r.id);
    const client = await getClient(env, inv.client_id);
    if ((await chargeSavedCard(env, s, inv, client, ctx)).ok) ok++;
  }
  return `${ok}/${rows.length}`;
}

async function reminders(env, s, day) {
  const before = Number(s.reminder_before_days) || 0;
  const steps = String(s.overdue_reminders || "").split(",").map((x) => parseInt(x, 10)).filter((n) => n > 0).sort((a, b) => a - b);
  // A free-month order waiting for its card owes nothing, so no reminders.
  const rows = await all(env, "SELECT * FROM invoices WHERE status = 'unpaid' AND due <= ? AND NOT (free_month = 1 AND total <= 0)", addDays(day, before));
  let sent = 0;
  for (const inv of rows) {
    const late = daysBetween(inv.due, day);
    const client = await getClient(env, inv.client_id);
    const owed = money(inv.total - inv.paid);
    const link = { button: { label: "Pay invoice", url: `${baseUrl(env)}/invoices/${inv.id}` } };
    if (late < 0 && before > 0 && inv.reminder_stage < 1) {
      const auto = client.stripe_pm && client.auto_charge;
      await sendEmail(env, s, {
        to: client.email, clientId: client.id,
        subject: `Invoice ${inv.number} is due ${fmtDate(inv.due)}`,
        lines: [
          `Hi ${client.first_name || "there"},`,
          auto
            ? `Just a heads-up: we'll charge ${owed} to your saved card (${client.stripe_pm_label}) on ${fmtDate(inv.due)} for invoice ${inv.number}.`
            : `A reminder that invoice ${inv.number} for ${owed} is due on ${fmtDate(inv.due)}.`,
          link,
        ],
      });
      await run(env, "UPDATE invoices SET reminder_stage = 1 WHERE id = ?", inv.id);
      sent++;
    } else if (late > 0) {
      const k = steps.filter((d) => d <= late).length;
      if (k > 0 && inv.reminder_stage < 1 + k) {
        const suspendIn = (Number(s.suspend_after_days) || 0) - late;
        await sendEmail(env, s, {
          to: client.email, clientId: client.id,
          subject: `Overdue: invoice ${inv.number}`,
          lines: [
            `Hi ${client.first_name || "there"},`,
            `Invoice ${inv.number} for ${owed} was due on ${fmtDate(inv.due)} and is now ${late} day${late === 1 ? "" : "s"} overdue.`,
            ...(Number(s.suspend_after_days) > 0 && suspendIn > 0
              ? [`Services on this invoice will be suspended in ${suspendIn} day${suspendIn === 1 ? "" : "s"} if it isn't paid.`]
              : []),
            link,
          ],
        });
        await run(env, "UPDATE invoices SET reminder_stage = ? WHERE id = ?", 1 + k, inv.id);
        sent++;
      }
    }
  }
  return sent;
}

async function overdueSuspensions(env, s, day) {
  const after = Number(s.suspend_after_days) || 0;
  if (after <= 0) return "off";
  const rows = await all(
    env,
    `SELECT DISTINCT it.service_id, i.number FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id
     JOIN services s ON s.id = it.service_id
     WHERE i.status = 'unpaid' AND i.due <= ? AND s.status = 'active'`,
    addDays(day, -after),
  );
  let n = 0;
  for (const r of rows) {
    const svc = await getService(env, r.service_id);
    if (!svc || svc.status !== "active") continue;
    try {
      await suspendService(env, s, svc, `Overdue invoice ${r.number}`, SYSTEM);
      const client = await getClient(env, svc.client_id);
      await sendEmail(env, s, {
        to: client.email, clientId: client.id,
        subject: `Service suspended: ${svc.product_name}${svc.label ? ` (${svc.label})` : ""}`,
        lines: [
          `Hi ${client.first_name || "there"},`,
          `We've suspended ${svc.product_name}${svc.label ? ` (${svc.label})` : ""} because invoice ${r.number} is overdue. It will be turned back on as soon as the invoice is paid.`,
          { button: { label: "Pay now", url: `${baseUrl(env)}/invoices` } },
        ],
      });
      n++;
    } catch (e) {
      await log(env, SYSTEM, svc.client_id, "service.suspend_failed", e.message);
    }
  }
  return n;
}

async function overdueTerminations(env, s, day) {
  const after = Number(s.terminate_after_days) || 0;
  if (after <= 0) return "off";
  const rows = await all(
    env,
    `SELECT DISTINCT it.service_id, i.id AS invoice_id FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id
     JOIN services s ON s.id = it.service_id
     WHERE i.status = 'unpaid' AND i.due <= ? AND s.status = 'suspended'`,
    addDays(day, -after),
  );
  let n = 0;
  for (const r of rows) {
    const svc = await getService(env, r.service_id);
    try {
      await terminateService(env, s, svc, SYSTEM, { deleteSites: true });
      await cancelInvoice(env, s, await getInvoice(env, r.invoice_id), SYSTEM);
      await notifyAdmin(env, s, `Terminated for non-payment: service #${svc.id}`, [
        `${svc.product_name}${svc.label ? ` (${svc.label})` : ""} was terminated after ${after} days overdue.`,
      ]);
      n++;
    } catch (e) {
      await log(env, SYSTEM, svc.client_id, "service.terminate_failed", e.message);
    }
  }
  return n;
}

async function endOfTermCancellations(env, s, day) {
  const rows = await all(env, "SELECT id FROM services WHERE cancel_at_end = 1 AND status IN ('active','suspended') AND next_due <= ?", day);
  for (const r of rows) {
    const svc = await getService(env, r.id);
    try {
      await terminateService(env, s, svc, SYSTEM, { deleteSites: false }).catch(async (e) => {
        // Sites still there: keep the account suspended and leave it to an admin.
        await suspendService(env, s, svc, "Cancelled at end of term", SYSTEM).catch(() => {});
        throw e;
      });
      await run(env, "UPDATE services SET status = 'cancelled' WHERE id = ?", svc.id);
    } catch (e) {
      await run(env, "UPDATE services SET status = 'cancelled' WHERE id = ?", svc.id);
      await notifyAdmin(env, s, `Cancelled service needs tidying: #${svc.id}`, [
        `${svc.product_name}${svc.label ? ` (${svc.label})` : ""} reached the end of its term and is cancelled. Berth kept the account (suspended): ${e.message}`,
        { button: { label: "Open service", url: `${baseUrl(env)}/admin/services/${svc.id}` } },
      ]);
    }
    for (const inv of await all(
      env,
      "SELECT DISTINCT i.* FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id WHERE it.service_id = ? AND i.status = 'unpaid'",
      svc.id,
    )) await cancelInvoice(env, s, inv, SYSTEM);
  }
  return rows.length;
}

async function autoCloseTickets(env, s) {
  const days = Number(s.ticket_autoclose_days) || 0;
  if (days <= 0) return "off";
  const r = await run(
    env, "UPDATE tickets SET status = 'closed', updated_at = ? WHERE status = 'answered' AND updated_at < ?",
    nowIso(), new Date(Date.now() - days * 86400000).toISOString(),
  );
  return r.meta.changes;
}

async function cleanup(env) {
  const n = nowIso();
  await run(env, "DELETE FROM sessions WHERE expires_at < ?", n);
  await run(env, "DELETE FROM tokens WHERE expires_at < ?", n);
  await run(env, "DELETE FROM login_attempts WHERE at < ?", new Date(Date.now() - 86400000).toISOString());
  return "ok";
}
