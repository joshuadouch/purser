// Support tickets, for clients and staff.
import { html, textBlock } from "../lib/html.js";
import { all, insert, one, run, update } from "../lib/db.js";
import { notFound, redirect, requireClient, requireStaff } from "../lib/http.js";
import { adminPage, badge, clientPage, csrf, empty, field, icon, pager, pageOffset } from "../lib/ui.js";
import { sendEmail } from "../lib/email.js";
import { baseUrl, log } from "../lib/billing.js";
import { ago, clean, fmtDateTime, fullName, int, nowIso } from "../lib/util.js";

const MAX_FILES = 5;
const MAX_SIZE = 10 * 1024 * 1024;
export const STATUSES = ["open", "answered", "customer-reply", "on-hold", "closed"];
const PRIORITIES = ["low", "medium", "high"];

async function saveFiles(env, form, ticketId, messageId) {
  const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.size > 0);
  if (files.length > MAX_FILES) throw new Error(`Attach up to ${MAX_FILES} files.`);
  for (const f of files) if (f.size > MAX_SIZE) throw new Error(`${f.name} is over 10 MB.`);
  if (files.length && !env.FILES) throw new Error("File uploads aren't set up.");
  for (const f of files) {
    const key = `tickets/${ticketId}/${crypto.randomUUID()}`;
    await env.FILES.put(key, f.stream(), { httpMetadata: { contentType: f.type || "application/octet-stream" } });
    await insert(
      env, "INSERT INTO attachments (ticket_id, message_id, name, size, type, r2_key, created_at) VALUES (?,?,?,?,?,?,?)",
      ticketId, messageId, clean(f.name, 200) || "file", f.size, (f.type || "application/octet-stream").slice(0, 100), key, nowIso(),
    );
  }
  return files.length;
}

// Files must be validated before a message is written, so check sizes up front.
function filesProblem(form) {
  const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.size > 0);
  if (files.length > MAX_FILES) return `Attach up to ${MAX_FILES} files.`;
  const big = files.find((f) => f.size > MAX_SIZE);
  return big ? `${big.name} is over 10 MB.` : null;
}

async function serveFile(c, ticketId) {
  const a = await one(c.env, "SELECT * FROM attachments WHERE id = ? AND ticket_id = ?", Number(c.params.aid), ticketId);
  if (!a || !c.env.FILES) return notFound(c);
  const obj = await c.env.FILES.get(a.r2_key);
  if (!obj) return notFound(c);
  return new Response(obj.body, {
    headers: {
      "content-type": a.type,
      "content-disposition": `attachment; filename="${a.name.replace(/["\\\r\n]/g, "_")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

async function thread(env, ticketId, withInternal) {
  const msgs = await all(env, `SELECT * FROM ticket_messages WHERE ticket_id = ? ${withInternal ? "" : "AND internal = 0"} ORDER BY id`, ticketId);
  const files = await all(env, "SELECT * FROM attachments WHERE ticket_id = ?", ticketId);
  for (const m of msgs) m.files = files.filter((f) => f.message_id === m.id);
  return msgs;
}

function renderThread(msgs, fileBase) {
  return html`<div class="thread">${msgs.map(
    (m) => html`<article class="msg msg-${m.author_kind}${m.internal ? " msg-internal" : ""}">
      <header><b>${m.author_name}</b>${m.author_kind === "staff" ? html`<span class="badge b-purple">Staff</span>` : ""}${m.internal ? html`<span class="badge b-amber">Internal note</span>` : ""}<time title="${fmtDateTime(m.created_at)}">${ago(m.created_at)}</time></header>
      <div class="msg-body">${textBlock(m.body)}</div>
      ${m.files.length ? html`<div class="files">${m.files.map((f) => html`<a href="${fileBase}/${f.id}">${icon("paperclip")} ${f.name} <small>${Math.ceil(f.size / 1024)} KB</small></a>`)}</div>` : ""}
    </article>`,
  )}</div>`;
}

const fileInput = html`<div class="field"><label for="f_files">Attachments <small>optional, up to 5 files of 10 MB</small></label><input id="f_files" type="file" name="files" multiple></div>`;

export async function notifyStaff(c, ticket, body, kind, client = c.client) {
  const dept = ticket.department_id ? await one(c.env, "SELECT * FROM departments WHERE id = ?", ticket.department_id) : null;
  const to = dept?.email || c.s.admin_notify_email || c.env.ADMIN_EMAIL;
  if (!to) return;
  await sendEmail(c.env, c.s, {
    to,
    subject: `[Ticket #${ticket.id}] ${kind === "new" ? "New: " : "Reply: "}${ticket.subject}`,
    lines: [
      `${client.email} ${kind === "new" ? "opened a ticket" : "replied"}${dept ? ` in ${dept.name}` : ""}.`,
      { quote: body.slice(0, 4000) },
      { button: { label: "Open ticket", url: `${baseUrl(c.env)}/admin/tickets/${ticket.id}` } },
    ],
  });
}

export default function (r) {
  const C = requireClient;
  const S = requireStaff;

  // ---- client -------------------------------------------------------------------
  r.get("/tickets", C, async (c) => {
    const rows = await all(c.env, "SELECT t.*, d.name AS dept FROM tickets t LEFT JOIN departments d ON d.id = t.department_id WHERE t.client_id = ? ORDER BY t.status = 'closed', t.updated_at DESC LIMIT 200", c.client.id);
    return clientPage(c, {
      title: "Support", active: "tickets",
      topActions: html`<a class="btn btn-primary btn-sm" href="/tickets/new">${icon("plus")}<span class="hide-sm">New ticket</span></a>`,
      body: html`<section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Subject</th><th class="hide-sm">Department</th><th class="hide-sm">Updated</th><th>Status</th></tr></thead><tbody>
      ${rows.map((t) => html`<tr data-href="/tickets/${t.id}"><td><a href="/tickets/${t.id}"><b>${t.subject}</b></a><small class="block muted">#${t.id}</small></td><td class="hide-sm">${t.dept || ""}</td><td class="hide-sm">${ago(t.updated_at)}</td><td>${badge(t.status, t.status === "customer-reply" ? "Awaiting reply" : t.status === "answered" ? "Answered" : null)}</td></tr>`)}
      </tbody></table>` : empty("You haven't opened any tickets.", html`<a class="btn btn-primary btn-sm" href="/tickets/new">Open a ticket</a>`)}</section>`,
    });
  });

  r.get("/tickets/new", C, async (c) => {
    const depts = await all(c.env, "SELECT * FROM departments WHERE visible = 1 ORDER BY sort, id");
    const services = await all(c.env, "SELECT s.id, s.label, p.name FROM services s JOIN products p ON p.id = s.product_id WHERE s.client_id = ? AND s.status IN ('active','suspended','pending') ORDER BY s.id DESC", c.client.id);
    return clientPage(c, {
      title: "New ticket", active: "tickets", topActions: "",
      body: html`<section class="card narrow"><form method="post" enctype="multipart/form-data" class="stack">${csrf(c)}
        <div class="grid2">
        ${field({ label: "Department", name: "department", type: "select", options: depts.map((d) => [d.id, d.name]) })}
        ${field({ label: "Related service", name: "service", type: "select", value: c.url.searchParams.get("service") || "", options: [["", "None"], ...services.map((s) => [s.id, `${s.name}${s.label ? ` (${s.label})` : ""}`])] })}
        </div>
        ${field({ label: "Subject", name: "subject", required: true, maxlength: 150 })}
        ${field({ label: "Message", name: "body", type: "textarea", rows: 8, required: true })}
        ${field({ label: "Priority", name: "priority", type: "select", value: "medium", options: [["low", "Low"], ["medium", "Normal"], ["high", "Urgent (something is down)"]] })}
        ${fileInput}
        <button class="btn btn-primary">Open ticket</button>
      </form></section>`,
    });
  });

  r.post("/tickets/new", C, async (c) => {
    const f = c.form;
    const subject = clean(f.get("subject"), 150);
    const body = clean(f.get("body"), 20000);
    if (!subject || !body) return redirect("/tickets/new", "Add a subject and a message.", "err");
    const fp = filesProblem(f);
    if (fp) return redirect("/tickets/new", fp, "err");
    const dept = await one(c.env, "SELECT id FROM departments WHERE id = ? AND visible = 1", int(f.get("department")));
    const svc = int(f.get("service")) ? await one(c.env, "SELECT id FROM services WHERE id = ? AND client_id = ?", int(f.get("service")), c.client.id) : null;
    const now = nowIso();
    const id = await insert(
      c.env, "INSERT INTO tickets (client_id, department_id, service_id, subject, status, priority, last_reply_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      c.client.id, dept?.id ?? null, svc?.id ?? null, subject, "open", PRIORITIES.includes(f.get("priority")) ? f.get("priority") : "medium", "client", now, now,
    );
    const mid = await insert(c.env, "INSERT INTO ticket_messages (ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?)", id, "client", c.client.id, fullName(c.client), body, now);
    await saveFiles(c.env, f, id, mid);
    await log(c.env, c.actor, c.client.id, "ticket.opened", `#${id} ${subject}`);
    const ticket = await one(c.env, "SELECT * FROM tickets WHERE id = ?", id);
    c.ctx.waitUntil(notifyStaff(c, ticket, body, "new"));
    return redirect(`/tickets/${id}`, "Ticket opened. We'll email you when we reply.");
  });

  const myTicket = async (c) => {
    const t = await one(c.env, "SELECT t.*, d.name AS dept FROM tickets t LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ?", Number(c.params.id));
    return t && t.client_id === c.client.id ? t : null;
  };

  r.get("/tickets/:id", C, async (c) => {
    const t = await myTicket(c);
    if (!t) return notFound(c);
    const msgs = await thread(c.env, t.id, false);
    return clientPage(c, {
      title: `Ticket #${t.id}`, active: "tickets", topActions: "",
      body: html`<section class="hero hero-sm"><div><h2>${t.subject}</h2><p>#${t.id}${t.dept ? ` · ${t.dept}` : ""} · opened ${ago(t.created_at)}</p></div><div>${badge(t.status)}</div></section>
      ${renderThread(msgs, `/tickets/${t.id}/files`)}
      <section class="card"><form method="post" action="/tickets/${t.id}/reply" enctype="multipart/form-data" class="stack">${csrf(c)}
        ${field({ label: t.status === "closed" ? "Reply to reopen this ticket" : "Your reply", name: "body", type: "textarea", rows: 5, required: true })}
        ${fileInput}
        <div class="btn-row"><button class="btn btn-primary">Send reply</button></div>
      </form>
      ${t.status !== "closed" ? html`<form method="post" action="/tickets/${t.id}/close" class="close-form">${csrf(c)}<button class="btn btn-sm btn-ghost">Mark as solved</button></form>` : ""}
      </section>`,
    });
  });

  r.post("/tickets/:id/reply", C, async (c) => {
    const t = await myTicket(c);
    if (!t) return notFound(c);
    const body = clean(c.form.get("body"), 20000);
    if (!body) return redirect(`/tickets/${t.id}`, "Write a reply first.", "err");
    const fp = filesProblem(c.form);
    if (fp) return redirect(`/tickets/${t.id}`, fp, "err");
    const now = nowIso();
    const mid = await insert(c.env, "INSERT INTO ticket_messages (ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?)", t.id, "client", c.client.id, fullName(c.client), body, now);
    await saveFiles(c.env, c.form, t.id, mid);
    await update(c.env, "tickets", t.id, { status: "customer-reply", last_reply_by: "client", updated_at: now });
    c.ctx.waitUntil(notifyStaff(c, t, body, "reply"));
    return redirect(`/tickets/${t.id}`, "Reply sent.");
  });

  r.post("/tickets/:id/close", C, async (c) => {
    const t = await myTicket(c);
    if (!t) return notFound(c);
    await update(c.env, "tickets", t.id, { status: "closed", updated_at: nowIso() });
    await log(c.env, c.actor, c.client.id, "ticket.closed", `#${t.id}`);
    return redirect("/tickets", "Ticket closed. Glad we could help.");
  });

  r.get("/tickets/:id/files/:aid", C, async (c) => {
    const t = await myTicket(c);
    if (!t) return notFound(c);
    // Files on internal notes stay private.
    const a = await one(c.env, "SELECT m.internal FROM attachments a JOIN ticket_messages m ON m.id = a.message_id WHERE a.id = ?", Number(c.params.aid));
    if (!a || a.internal) return notFound(c);
    return serveFile(c, t.id);
  });

  // ---- staff ------------------------------------------------------------------------
  r.get("/admin/tickets", S, async (c) => {
    const view = c.url.searchParams.get("view") || "awaiting";
    const dept = int(c.url.searchParams.get("dept"));
    const where = [];
    const p = [];
    if (view === "awaiting") where.push("t.status IN ('open','customer-reply')");
    else if (view === "mine") where.push("t.assigned_staff = ? AND t.status != 'closed'"), p.push(c.staff.id);
    else if (STATUSES.includes(view)) where.push("t.status = ?"), p.push(view);
    else if (view === "active") where.push("t.status != 'closed'");
    if (dept) where.push("t.department_id = ?"), p.push(dept);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (await one(c.env, `SELECT COUNT(*) AS n FROM tickets t ${w}`, ...p)).n;
    const rows = await all(
      c.env,
      `SELECT t.*, d.name AS dept, cl.email, cl.first_name, cl.last_name, cl.company, st.name AS staff_name FROM tickets t
       LEFT JOIN departments d ON d.id = t.department_id JOIN clients cl ON cl.id = t.client_id LEFT JOIN staff st ON st.id = t.assigned_staff
       ${w} ORDER BY CASE t.priority WHEN 'high' THEN 0 ELSE 1 END, t.updated_at ${view === "awaiting" ? "ASC" : "DESC"} LIMIT 50 OFFSET ?`,
      ...p, pageOffset(c, 50),
    );
    const depts = await all(c.env, "SELECT * FROM departments ORDER BY sort, id");
    const tabs = [["awaiting", "Awaiting reply"], ["mine", "Assigned to me"], ["active", "All open"], ["answered", "Answered"], ["on-hold", "On hold"], ["closed", "Closed"], ["all", "All"]];
    return adminPage(c, {
      title: "Tickets", active: "tickets",
      topActions: html`<a class="btn btn-primary btn-sm" href="/admin/tickets/new">${icon("plus")}<span class="hide-sm">New ticket</span></a>`,
      body: html`<div class="tabs">${tabs.map(([k, l]) => html`<a class="${view === k ? "on" : ""}" href="?view=${k}${dept ? `&dept=${dept}` : ""}">${l}</a>`)}</div>
      <form class="filters" method="get"><input type="hidden" name="view" value="${view}">${field({ label: "Department", name: "dept", type: "select", value: dept || "", options: [["", "All departments"], ...depts.map((d) => [d.id, d.name])] })}<button class="btn btn-sm">Filter</button></form>
      <section class="card">${rows.length ? html`<table class="table"><thead><tr><th>Subject</th><th>Client</th><th class="hide-sm">Department</th><th class="hide-sm">Updated</th><th>Status</th></tr></thead><tbody>
      ${rows.map((t) => html`<tr data-href="/admin/tickets/${t.id}"><td><a href="/admin/tickets/${t.id}"><b>${t.subject}</b></a><small class="block muted">#${t.id}${t.priority === "high" ? " · urgent" : ""}${t.staff_name ? ` · ${t.staff_name}` : ""}</small></td><td>${t.company || fullName(t)}<small class="block muted">${t.email}</small></td><td class="hide-sm">${t.dept || ""}</td><td class="hide-sm">${ago(t.updated_at)}</td><td>${badge(t.status)}</td></tr>`)}
      </tbody></table>${pager(c, total, 50)}` : empty("Nothing here. Nice.")}</section>`,
    });
  });

  r.get("/admin/tickets/new", S, async (c) => {
    const clientId = int(c.url.searchParams.get("client"));
    const client = clientId ? await one(c.env, "SELECT * FROM clients WHERE id = ?", clientId) : null;
    const depts = await all(c.env, "SELECT * FROM departments ORDER BY sort, id");
    const clients = client ? [] : await all(c.env, "SELECT id, email, company, first_name, last_name FROM clients WHERE status = 'active' ORDER BY email LIMIT 1000");
    return adminPage(c, {
      title: "New ticket", active: "tickets",
      body: html`<section class="card narrow"><p class="muted">Opens a ticket on the client's behalf and emails them your message.</p>
      <form method="post" enctype="multipart/form-data" class="stack">${csrf(c)}
        ${client ? html`<input type="hidden" name="client" value="${client.id}"><p><b>To:</b> ${client.email}</p>` : field({ label: "Client", name: "client", type: "select", options: clients.map((x) => [x.id, `${x.email}${x.company ? ` (${x.company})` : ""}`]) })}
        ${field({ label: "Department", name: "department", type: "select", options: depts.map((d) => [d.id, d.name]) })}
        ${field({ label: "Subject", name: "subject", required: true })}
        ${field({ label: "Message", name: "body", type: "textarea", rows: 8, required: true })}
        ${fileInput}
        <button class="btn btn-primary">Open and send</button></form></section>`,
    });
  });

  r.post("/admin/tickets/new", S, async (c) => {
    const f = c.form;
    const client = await one(c.env, "SELECT * FROM clients WHERE id = ?", int(f.get("client")));
    const subject = clean(f.get("subject"), 150);
    const body = clean(f.get("body"), 20000);
    if (!client || !subject || !body) return redirect("/admin/tickets/new", "Pick a client and write a subject and message.", "err");
    const fp = filesProblem(f);
    if (fp) return redirect("/admin/tickets/new", fp, "err");
    const now = nowIso();
    const id = await insert(
      c.env, "INSERT INTO tickets (client_id, department_id, subject, status, priority, assigned_staff, last_reply_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      client.id, int(f.get("department")), subject, "answered", "medium", c.staff.id, "staff", now, now,
    );
    const mid = await insert(c.env, "INSERT INTO ticket_messages (ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?)", id, "staff", c.staff.id, c.staff.name || c.staff.email, withSignature(c, body), now);
    await saveFiles(c.env, f, id, mid);
    await emailClientReply(c, { id, subject }, client, withSignature(c, body), true);
    await log(c.env, c.actor, client.id, "ticket.opened", `#${id} ${subject}`);
    return redirect(`/admin/tickets/${id}`, "Ticket opened and the client emailed.");
  });

  const staffTicket = (c) =>
    one(c.env, "SELECT t.*, d.name AS dept FROM tickets t LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ?", Number(c.params.id));

  r.get("/admin/tickets/:id", S, async (c) => {
    const t = await staffTicket(c);
    if (!t) return notFound(c);
    const [client, msgs, depts, staff, services, svc] = await Promise.all([
      one(c.env, "SELECT * FROM clients WHERE id = ?", t.client_id),
      thread(c.env, t.id, true),
      all(c.env, "SELECT * FROM departments ORDER BY sort, id"),
      all(c.env, "SELECT id, name, email FROM staff WHERE active = 1 ORDER BY name"),
      all(c.env, "SELECT s.id, s.label, s.status, p.name FROM services s JOIN products p ON p.id = s.product_id WHERE s.client_id = ? AND s.status != 'terminated' ORDER BY s.id DESC LIMIT 10", t.client_id),
      t.service_id ? one(c.env, "SELECT s.*, p.name AS product_name FROM services s JOIN products p ON p.id = s.product_id WHERE s.id = ?", t.service_id) : null,
    ]);
    return adminPage(c, {
      title: `Ticket #${t.id}`, active: "tickets",
      body: html`<section class="hero hero-sm"><div><h2>${t.subject}</h2><p>#${t.id} · ${client.company || fullName(client)} &lt;${client.email}&gt; · opened ${ago(t.created_at)}</p></div><div>${badge(t.status)} ${badge(t.priority, t.priority === "high" ? "Urgent" : null)}</div></section>
      <div class="cols cols-wide">
        <div>
          ${renderThread(msgs, `/admin/tickets/${t.id}/files`)}
          <section class="card"><form method="post" action="/admin/tickets/${t.id}/reply" enctype="multipart/form-data" class="stack">${csrf(c)}
            ${field({ label: "Reply", name: "body", type: "textarea", rows: 7, required: true, hint: c.staff.signature ? "Your signature is added automatically." : null })}
            ${fileInput}
            <div class="grid2">
              ${field({ label: "Then set status to", name: "status", type: "select", value: "answered", options: [["answered", "Answered"], ["on-hold", "On hold"], ["closed", "Closed"], ["open", "Open"]] })}
              <div class="field">${field({ type: "checkbox", name: "internal", label: "Internal note (client doesn't see it)" })}</div>
            </div>
            <button class="btn btn-primary">Send</button>
          </form></section>
        </div>
        <aside>
          <section class="card"><div class="card-head"><h3>Ticket</h3></div>
            <form method="post" action="/admin/tickets/${t.id}/update" class="stack">${csrf(c)}
              ${field({ label: "Status", name: "status", type: "select", value: t.status, options: STATUSES.map((s) => [s, s.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase())]) })}
              ${field({ label: "Priority", name: "priority", type: "select", value: t.priority, options: PRIORITIES.map((p) => [p, p[0].toUpperCase() + p.slice(1)]) })}
              ${field({ label: "Department", name: "department", type: "select", value: t.department_id || "", options: depts.map((d) => [d.id, d.name]) })}
              ${field({ label: "Assigned to", name: "assigned", type: "select", value: t.assigned_staff || "", options: [["", "Nobody"], ...staff.map((s) => [s.id, s.name || s.email])] })}
              <button class="btn btn-sm">Update</button>
            </form>
          </section>
          <section class="card"><div class="card-head"><h3>Client</h3><a href="/admin/clients/${client.id}">Open</a></div>
            <dl class="dl dl-tight"><dt>Name</dt><dd>${fullName(client)}</dd>${client.company ? html`<dt>Company</dt><dd>${client.company}</dd>` : ""}<dt>Email</dt><dd>${client.email}</dd>${client.phone ? html`<dt>Phone</dt><dd>${client.phone}</dd>` : ""}</dl>
            ${svc ? html`<p class="small"><b>About:</b> <a href="/admin/services/${svc.id}">${svc.product_name}${svc.label ? ` (${svc.label})` : ""}</a> ${badge(svc.status)}</p>` : ""}
            ${services.length ? html`<div class="list list-sm">${services.map((s) => html`<a class="row" href="/admin/services/${s.id}"><div>${s.name}<small>${s.label}</small></div>${badge(s.status)}</a>`)}</div>` : ""}
          </section>
        </aside>
      </div>`,
    });
  });

  r.post("/admin/tickets/:id/reply", S, async (c) => {
    const t = await staffTicket(c);
    if (!t) return notFound(c);
    const raw = clean(c.form.get("body"), 20000);
    if (!raw) return redirect(`/admin/tickets/${t.id}`, "Write something first.", "err");
    const fp = filesProblem(c.form);
    if (fp) return redirect(`/admin/tickets/${t.id}`, fp, "err");
    const internal = c.form.get("internal") === "1";
    const body = internal ? raw : withSignature(c, raw);
    const now = nowIso();
    const mid = await insert(c.env, "INSERT INTO ticket_messages (ticket_id, author_kind, author_id, author_name, body, internal, created_at) VALUES (?,?,?,?,?,?,?)", t.id, "staff", c.staff.id, c.staff.name || c.staff.email, body, internal ? 1 : 0, now);
    await saveFiles(c.env, c.form, t.id, mid);
    if (!internal) {
      const status = ["answered", "on-hold", "closed", "open"].includes(c.form.get("status")) ? c.form.get("status") : "answered";
      await update(c.env, "tickets", t.id, { status, last_reply_by: "staff", updated_at: now, assigned_staff: t.assigned_staff || c.staff.id });
      const client = await one(c.env, "SELECT * FROM clients WHERE id = ?", t.client_id);
      c.ctx.waitUntil(emailClientReply(c, t, client, body, false));
    }
    await log(c.env, c.actor, t.client_id, internal ? "ticket.note" : "ticket.replied", `#${t.id}`);
    return redirect(`/admin/tickets/${t.id}`, internal ? "Note added." : "Reply sent.");
  });

  r.post("/admin/tickets/:id/update", S, async (c) => {
    const t = await staffTicket(c);
    if (!t) return notFound(c);
    const f = c.form;
    await update(c.env, "tickets", t.id, {
      status: STATUSES.includes(f.get("status")) ? f.get("status") : t.status,
      priority: PRIORITIES.includes(f.get("priority")) ? f.get("priority") : t.priority,
      department_id: int(f.get("department")) ?? t.department_id,
      assigned_staff: int(f.get("assigned")),
    });
    return redirect(`/admin/tickets/${t.id}`, "Updated.");
  });

  r.get("/admin/tickets/:id/files/:aid", S, (c) => serveFile(c, Number(c.params.id)));
}

const withSignature = (c, body) => (c.staff.signature ? `${body}\n\n${c.staff.signature}` : body);

async function emailClientReply(c, t, client, body, isNew) {
  await sendEmail(c.env, c.s, {
    to: client.email, clientId: client.id,
    subject: `[Ticket #${t.id}] ${t.subject}`,
    lines: [
      `Hi ${client.first_name || "there"},`,
      isNew ? "We've opened a support ticket for you:" : "We've replied to your ticket:",
      { quote: body.slice(0, 8000) },
      { button: { label: "View and reply", url: `${baseUrl(c.env)}/tickets/${t.id}` } },
      "Please reply in the client area rather than to this email.",
    ],
  });
}
