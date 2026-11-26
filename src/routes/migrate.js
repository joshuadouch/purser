// Free migration requests: a public form, linked from the brand websites, that
// opens a Sales ticket. Signed-in clients get the ticket on their account. A
// visitor without an account gets a client record with no password and an
// email link to set one, so they can follow the ticket in the client area.
import { html } from "../lib/html.js";
import { insert, one } from "../lib/db.js";
import { makeToken, recordAttempt, tooManyAttempts, turnstileOk } from "../lib/auth.js";
import { optionalClient, redirect } from "../lib/http.js";
import { authPage, csrf, field, publicPage, turnstile } from "../lib/ui.js";
import { sendEmail } from "../lib/email.js";
import { baseUrl, log, SYSTEM } from "../lib/billing.js";
import { clean, fullName, isEmail, nowIso } from "../lib/util.js";
import { notifyStaff } from "./tickets.js";

const KINDS = [
  ["wordpress", "WordPress"],
  ["woocommerce", "WordPress with WooCommerce"],
  ["php", "Another PHP site (Laravel, Craft, Joomla, custom)"],
  ["static", "Plain HTML"],
  ["unsure", "Not sure"],
];
const EMAIL = [
  ["stay", "No, my email stays where it is"],
  ["move", "Yes, move my email too"],
  ["unsure", "Not sure"],
];
const STAGE = [
  ["ordered", "I've already ordered hosting"],
  ["ordering", "I'm about to order"],
  ["advice", "I'd like advice on which plan"],
];
const label = (list, v) => list.find(([k]) => k === v)?.[1] || "Not given";

// "https://www.Example.co.uk/shop" -> "example.co.uk/shop", for the subject line.
export const siteName = (s) => clean(s, 200).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();

function form(c, v = {}) {
  const guest = !c.client;
  return html`<p class="muted">Tell us about the site and we'll open a ticket, check it over and reply with a plan and an honest time estimate. Moving is free on every plan, and your site stays live on your old host until you're happy with the copy.</p>
  <form method="post" class="grid2">${csrf(c)}
    ${guest ? html`
    ${field({ label: "Your name", name: "name", required: true, autocomplete: "name", value: v.name })}
    ${field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email", value: v.email })}` : ""}
    ${field({ label: "Website address", name: "site", required: true, placeholder: "example.co.uk", wide: true, value: v.site, maxlength: 200 })}
    ${field({ label: "Current host", name: "host", optional: true, placeholder: "e.g. 123 Reg, GoDaddy, a freelancer", value: v.host, maxlength: 120 })}
    ${field({ label: "What kind of site is it?", name: "kind", type: "select", options: KINDS, value: v.kind || "wordpress" })}
    ${field({ label: "Move your email as well?", name: "mail", type: "select", options: EMAIL, value: v.mail || "stay" })}
    ${field({ label: "Where are you up to?", name: "stage", type: "select", options: STAGE, value: v.stage || (c.client ? "ordered" : "ordering") })}
    ${field({ label: "Anything we should know?", name: "notes", type: "textarea", rows: 4, optional: true, wide: true, value: v.notes, hint: "Deadlines, how big the site is, anything unusual. Please don't send passwords here: we'll ask for access in the ticket." })}
    ${guest ? html`<div class="hp" aria-hidden="true" style="position:absolute;left:-9999px"><label>Leave this empty <input name="website_url" tabindex="-1" autocomplete="off"></label></div>
    <div class="wide">${turnstile(c)}</div>` : ""}
    <div class="wide"><button class="btn btn-primary btn-block">Request my free migration</button></div>
  </form>
  ${guest ? html`<div class="auth-links"><a href="/login?next=/migrate">I already have an account</a></div>` : ""}`;
}

export default function (r) {
  r.get("/migrate", optionalClient, (c) => {
    const v = { site: clean(c.url.searchParams.get("site"), 200) };
    if (c.client) return publicPage(c, { title: "Request a free migration", active: "tickets", body: html`<section class="card narrow">${form(c, v)}</section>` });
    return authPage(c, { title: "Request a free migration", wide: true, body: form(c, v) });
  });

  r.post("/migrate", optionalClient, async (c) => {
    const f = c.form;
    const site = clean(f.get("site"), 200);
    if (!site) return redirect(`/migrate`, "Tell us the address of the site you want to move.", "err");
    const again = `/migrate?site=${encodeURIComponent(site)}`;
    let client = c.client;
    let created = false;
    if (!client) {
      // Bots fill every field; people never see this one.
      if (clean(f.get("website_url"))) return redirect("/migrate/thanks");
      const ipKey = `mig:${c.req.headers.get("cf-connecting-ip") || "?"}`;
      if (await tooManyAttempts(c.env, ipKey, 5, 60)) return redirect(again, "Too many requests from here. Try again later, or email us.", "err");
      if (!(await turnstileOk(c.s, f, c.req))) return redirect(again, "Please complete the check and try again.", "err");
      const email = clean(f.get("email"), 254).toLowerCase();
      const name = clean(f.get("name"), 120);
      if (!isEmail(email) || !name) return redirect(again, "Add your name and a valid email address.", "err");
      await recordAttempt(c.env, ipKey);
      client = await one(c.env, "SELECT * FROM clients WHERE email = ?", email);
      if (client?.status === "closed") return redirect(again, "That account is closed. Email us and we'll help.", "err");
      if (!client) {
        const [first, ...rest] = name.split(/\s+/);
        const id = await insert(
          c.env, "INSERT INTO clients (email, first_name, last_name, created_at, brand, notes) VALUES (?,?,?,?,?,?)",
          email, first.slice(0, 80), rest.join(" ").slice(0, 80), nowIso(), c.s.brand || null, "Created by a free migration request.",
        );
        await log(c.env, SYSTEM, id, "client.created", `${email} (migration request)`);
        client = await one(c.env, "SELECT * FROM clients WHERE id = ?", id);
        created = true;
      }
    }

    const dept = await one(c.env, "SELECT id FROM departments WHERE visible = 1 AND name LIKE '%sales%' ORDER BY sort LIMIT 1");
    const subject = `Free migration: ${siteName(site)}`.slice(0, 150);
    const body = [
      `Please move my website.`,
      ``,
      `Website: ${site}`,
      `Current host: ${clean(f.get("host"), 120) || "Not given"}`,
      `Type of site: ${label(KINDS, f.get("kind"))}`,
      `Email: ${label(EMAIL, f.get("mail"))}`,
      `Stage: ${label(STAGE, f.get("stage"))}`,
      ...(clean(f.get("notes")) ? [``, clean(f.get("notes"), 5000)] : []),
    ].join("\n");
    const now = nowIso();
    const tid = await insert(
      c.env, "INSERT INTO tickets (client_id, department_id, subject, status, priority, last_reply_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      client.id, dept?.id ?? null, subject, "open", "medium", "client", now, now,
    );
    await insert(c.env, "INSERT INTO ticket_messages (ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?)", tid, "client", client.id, fullName(client), body, now);
    await log(c.env, c.actor || { kind: "client", id: client.id, name: client.email }, client.id, "ticket.opened", `#${tid} ${subject}`);
    const ticket = await one(c.env, "SELECT * FROM tickets WHERE id = ?", tid);
    c.ctx.waitUntil(notifyStaff(c, ticket, body, "new", client));

    if (c.client) return redirect(`/tickets/${tid}`, "Thanks! We'll reply here with a plan for moving your site.");

    // Guests: confirm by email. New contacts (and old ones who never set a
    // password) get a link to set one so they can follow the ticket.
    const link = client.password_hash ? `${baseUrl(c.env)}/tickets/${tid}` : `${baseUrl(c.env)}/reset/${await makeToken(c.env, "reset", client.id, 72)}`;
    c.ctx.waitUntil(
      sendEmail(c.env, c.s, {
        to: client.email, clientId: client.id,
        subject: `We've got your migration request (#${tid})`,
        lines: [
          `Hi ${client.first_name || "there"},`,
          `Thanks for asking us to move ${siteName(site)}. We'll look it over and reply with a plan, usually within one working day.`,
          client.password_hash
            ? "You can follow the request in your client area."
            : "Set a password to follow the request in the client area. You'll use the same account when you order hosting.",
          { button: { label: client.password_hash ? "View your request" : "Set my password", url: link } },
          created ? "If you didn't ask for this, ignore this email and nothing else will happen." : "",
        ].filter(Boolean),
      }).catch((e) => console.error("migration email failed", e?.message || e)),
    );
    return redirect("/migrate/thanks");
  });

  r.get("/migrate/thanks", (c) =>
    authPage(c, {
      title: "Request received",
      body: html`<p>Thanks! We've opened a ticket and sent you a confirmation email. We'll reply with a plan for moving your site, usually within one working day.</p>
      <p class="muted">If you're new, the email has a link to set a password so you can follow the ticket in the client area.</p>
      <div class="btn-row"><a class="btn btn-primary" href="${c.s.site_url || "/"}">Back to the website</a></div>`,
    }),
  );
}
