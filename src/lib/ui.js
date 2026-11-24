// Page shells and small UI components shared by the client area and admin.
import { html, raw, esc } from "./html.js";
import { CYCLES, fmtDate, initials, money, pounds } from "./util.js";

export const ASSET_V = "7";

const I = {
  home: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.6"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
  pound: '<path d="M18 7a4 4 0 0 0-7.5-2C9.7 6.4 10 8.5 10 10v4c0 2-1 4-3 5h11M6 12h8"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  paperclip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  anchor: '<circle cx="12" cy="5" r="3"/><path d="M12 22V8M5 12H2a10 10 0 0 0 20 0h-3"/>',
};
export const icon = (n, cls = "") =>
  raw(`<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ""}</svg>`);

const head = (c, title) => html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${c.s.company_name}</title>
<meta name="theme-color" content="#fff8f2">
<link rel="icon" href="/favicon.svg?v=${ASSET_V}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css?v=${ASSET_V}">
${c.s.brand_color && /^#[0-9a-f]{6}$/i.test(c.s.brand_color) ? raw(`<style>:root{--accent:${c.s.brand_color}}</style>`) : ""}
<script src="/app.js?v=${ASSET_V}" defer></script>
</head>`;

export function flashBox(c) {
  if (!c.flash) return "";
  return html`<div class="flash flash-${c.flash.t === "err" ? "err" : "ok"}" role="status">${icon(c.flash.t === "err" ? "alert" : "check")}<span>${c.flash.m}</span></div>`;
}

function nav(items, active) {
  return items.map((g) =>
    html`<div class="nav-group">${g.title ? html`<div class="nav-title">${g.title}</div>` : ""}${g.items.map(
      (it) => html`<a href="${it.href}" class="nav-link${active === it.id ? " active" : ""}">${icon(it.icon)}<span>${it.label}</span>${it.count ? html`<b class="count">${it.count}</b>` : ""}</a>`,
    )}</div>`,
  );
}

function shell(c, { title, active, body, groups, home, who, sub, logout, banner, topActions, kicker }) {
  const brand = html`<a class="brand" href="${home}"><span class="brand-mark"><img src="/favicon.svg?v=${ASSET_V}" alt=""></span><span>${c.s.company_name}</span>${kicker ? html`<em>${kicker}</em>` : ""}</a>`;
  return new Response(
    String(html`${head(c, title)}
<body class="app">
${banner || ""}
<aside class="side" id="side">
  ${brand}
  <nav>${nav(groups, active)}</nav>
  <div class="side-foot">
    <div class="who"><span class="dot"></span><div><b>${who}</b><small>${sub}</small></div></div>
    <form method="post" action="${logout}">${csrf(c)}<button class="icon-btn" title="Sign out" aria-label="Sign out">${icon("logout")}</button></form>
  </div>
</aside>
<div class="scrim" data-close-menu></div>
<main class="main">
  <header class="top">
    <button class="icon-btn menu-btn" data-open-menu aria-label="Menu">${icon("menu")}</button>
    <h1 class="top-title">${title}</h1>
    <div class="top-actions">${topActions || ""}<span class="avatar">${initials(who)}</span></div>
  </header>
  <div class="content">${flashBox(c)}${body}</div>
</main>
</body></html>`),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

// ---- website layout --------------------------------------------------------------
// The client area dressed as part of the public website: same header, menu and
// footer, so customers never feel they've left it.
export const usesSite = (s) => /^https?:\/\//.test(s.site_url || "");
const siteHref = (s, u) => (/^(https?:|mailto:)/.test(u) ? u : s.site_url.replace(/\/+$/, "") + (u.startsWith("/") ? u : "/" + u));
const linkLines = (s, v) =>
  String(v || "")
    .split("\n")
    .map((l) => l.split("|").map((x) => x.trim()))
    .filter(([l, u]) => l && u)
    .map(([label, u]) => ({ label, href: siteHref(s, u) }));

function logo(c) {
  return c.s.logo_url
    ? html`<img src="${c.s.logo_url.startsWith("/") ? `${c.s.logo_url}?v=${ASSET_V}` : c.s.logo_url}" alt="${c.s.company_name}" height="38">`
    : html`<span class="brand-mark"><img src="/favicon.svg?v=${ASSET_V}" alt=""></span><b>${c.s.company_name}</b>`;
}

function siteHeader(c, { signedIn }) {
  const links = linkLines(c.s, c.s.site_links);
  return html`<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <div class="site-wrap head-in">
    <a class="site-logo" href="${c.s.site_url}" aria-label="${c.s.company_name} home">${logo(c)}</a>
    <nav class="site-nav" aria-label="Website">${links.map((l) => html`<a href="${l.href}">${l.label}</a>`)}</nav>
    <div class="head-cta">${signedIn
      ? html`<a class="btn btn-sm${c.url.pathname === "/" ? " btn-primary" : ""}" href="/">${icon("user")}<span>Your account</span></a><form method="post" action="/logout" class="inline">${csrf(c)}<button class="icon-btn" title="Sign out" aria-label="Sign out">${icon("logout")}</button></form>`
      : html`<a class="login" href="/login">Log in</a><a class="btn btn-primary btn-sm" href="${siteHref(c.s, "/hosting/#plans")}">Get started</a>`}</div>
    <button class="icon-btn site-menu-btn" aria-label="Menu" aria-expanded="false" data-site-menu>${icon("menu")}</button>
  </div>
</header>`;
}

function siteFooter(c) {
  const links = linkLines(c.s, c.s.footer_links);
  return html`<footer class="site-foot"><div class="site-wrap foot-in">
  <a class="site-logo" href="${c.s.site_url}">${logo(c)}</a>
  <nav aria-label="Footer">${links.map((l) => html`<a href="${l.href}">${l.label}</a>`)}</nav>
  <small>© ${new Date().getUTCFullYear()} ${c.s.company_name}. Payments are handled securely by Stripe.</small>
</div></footer>`;
}

function sitePage(c, { title, body, signedIn, tabs, pageHead, cls }) {
  return new Response(
    String(html`${head(c, title)}
<body class="site${cls ? " " + cls : ""}">
${c.session?.staff_id && c.client ? html`<div class="impersonate">Signed in as ${c.client.email} from the admin area. <a href="/admin/clients/${c.client.id}">Back to admin</a></div>` : ""}
${siteHeader(c, { signedIn })}
${tabs || ""}
<main id="main" class="site-main"><div class="site-wrap">${pageHead || ""}${flashBox(c)}${body}</div></main>
${siteFooter(c)}
</body></html>`),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

const CLIENT_TABS = [
  ["home", "/", "home", "Overview"],
  ["services", "/services", "server", "Services"],
  ["invoices", "/invoices", "file", "Invoices", "unpaid"],
  ["tickets", "/tickets", "help", "Support", "answered"],
  ["order", "/order", "cart", "Order"],
  ["account", "/account", "user", "Account"],
];

function clientTabs(c, active) {
  const acct = ["account", "payment", "security"].includes(active) ? "account" : active;
  return html`<nav class="acct-tabs" aria-label="Your account"><div class="site-wrap"><div class="acct-tabs-in">${CLIENT_TABS.map(
    ([id, href, ic, label, count]) =>
      html`<a href="${href}"${acct === id ? raw(' class="on" aria-current="page"') : ""}>${icon(ic)}<span>${label}</span>${count && c.counts?.[count] ? html`<b class="count">${c.counts[count]}</b>` : ""}</a>`,
  )}</div></div></nav>`;
}

const ACCOUNT_SUB = [
  ["account", "/account", "My details"],
  ["payment", "/account/payment", "Payment method"],
  ["security", "/account/security", "Security"],
];

export function clientPage(c, { title, active, body, topActions }) {
  const cl = c.client;
  if (usesSite(c.s)) {
    const sub = ["account", "payment", "security"].includes(active)
      ? html`<div class="tabs">${ACCOUNT_SUB.map(([id, href, l]) => html`<a class="${active === id ? "on" : ""}" href="${href}">${l}</a>`)}</div>`
      : "";
    return sitePage(c, {
      title, signedIn: true,
      tabs: clientTabs(c, active),
      pageHead: html`<div class="page-head"><h1>${title}</h1><div class="top-actions">${topActions ?? html`<a class="btn btn-primary btn-sm" href="/order">${icon("plus")}<span>Order</span></a>`}</div></div>${sub}`,
      body,
    });
  }
  const banner = c.session?.staff_id
    ? html`<div class="impersonate">Signed in as ${cl.email} from the admin area. <a href="/admin/clients/${cl.id}">Back to admin</a></div>`
    : "";
  return shell(c, {
    title, active, body, banner,
    home: "/",
    who: cl.company || [cl.first_name, cl.last_name].filter(Boolean).join(" ") || cl.email,
    sub: cl.email,
    logout: "/logout",
    topActions: topActions ?? html`<a class="btn btn-primary btn-sm" href="/order">${icon("plus")}<span class="hide-sm">Order</span></a>`,
    groups: [
      { title: "Overview", items: [{ id: "home", href: "/", icon: "home", label: "Dashboard" }] },
      {
        title: "Billing",
        items: [
          { id: "services", href: "/services", icon: "server", label: "Services" },
          { id: "invoices", href: "/invoices", icon: "file", label: "Invoices", count: c.counts?.unpaid },
          { id: "order", href: "/order", icon: "cart", label: "Order" },
        ],
      },
      { title: "Help", items: [{ id: "tickets", href: "/tickets", icon: "help", label: "Support", count: c.counts?.answered }] },
      {
        title: "Account",
        items: [
          { id: "account", href: "/account", icon: "user", label: "My details" },
          { id: "payment", href: "/account/payment", icon: "card", label: "Payment method" },
          { id: "security", href: "/account/security", icon: "shield", label: "Security" },
        ],
      },
    ],
  });
}

export function adminPage(c, { title, active, body, topActions }) {
  const st = c.staff;
  const isAdmin = st.role === "admin";
  return shell(c, {
    title, active, body, topActions, kicker: "admin",
    home: "/admin",
    who: st.name || st.email,
    sub: st.role === "admin" ? "Administrator" : "Support",
    logout: "/admin/logout",
    groups: [
      { title: "Overview", items: [{ id: "home", href: "/admin", icon: "home", label: "Dashboard" }] },
      {
        title: "Customers",
        items: [
          { id: "clients", href: "/admin/clients", icon: "users", label: "Clients" },
          { id: "services", href: "/admin/services", icon: "server", label: "Services" },
          { id: "tickets", href: "/admin/tickets", icon: "help", label: "Tickets", count: c.counts?.awaiting },
        ],
      },
      {
        title: "Billing",
        items: [
          { id: "invoices", href: "/admin/invoices", icon: "file", label: "Invoices" },
          { id: "transactions", href: "/admin/transactions", icon: "pound", label: "Transactions" },
          ...(isAdmin ? [{ id: "products", href: "/admin/products", icon: "box", label: "Products" }] : []),
        ],
      },
      {
        title: "System",
        items: [
          ...(isAdmin ? [{ id: "settings", href: "/admin/settings", icon: "settings", label: "Settings" }] : []),
          { id: "activity", href: "/admin/activity", icon: "activity", label: "Activity" },
          { id: "emails", href: "/admin/emails", icon: "mail", label: "Email log" },
          { id: "me", href: "/admin/me", icon: "shield", label: "My account" },
        ],
      },
    ],
  });
}

// A page anyone can see (ordering) in the website layout, signed in or not.
export function publicPage(c, { title, body, active }) {
  if (c.client) return clientPage(c, { title, active, body, topActions: "" });
  return sitePage(c, { title, signedIn: false, pageHead: html`<div class="page-head"><h1>${title}</h1></div>`, body });
}

export function authPage(c, { title, body, wide }) {
  if (usesSite(c.s) && !c.url.pathname.startsWith("/admin")) {
    return sitePage(c, {
      title, signedIn: Boolean(c.client), cls: "site-auth",
      body: html`<div class="auth-wrap${wide ? " wide" : ""}"><div class="auth-card"><h1>${title}</h1>${body}</div></div>`,
    });
  }
  return new Response(
    String(html`${head(c, title)}
<body class="auth">
<div class="auth-wrap${wide ? " wide" : ""}">
  <div class="auth-brand"><span class="brand-mark"><img src="/favicon.svg?v=${ASSET_V}" alt=""></span>${c.s.company_name}</div>
  <div class="auth-card">
    <h1>${title}</h1>
    ${flashBox(c)}
    ${body}
  </div>
</div>
</body></html>`),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export const csrf = (c) => (c.session ? html`<input type="hidden" name="_csrf" value="${c.session.csrf}">` : "");

export function turnstile(c) {
  if (!c.s.turnstile_site_key || !c.s.turnstile_secret) return "";
  return html`<div class="cf-turnstile" data-sitekey="${c.s.turnstile_site_key}" data-theme="light"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
}

const LABELS = {
  "customer-reply": "Customer reply",
  "on-hold": "On hold",
};
const TONES = {
  active: "green", paid: "green", answered: "green", sent: "green",
  pending: "amber", unpaid: "amber", "customer-reply": "amber", open: "blue", "on-hold": "grey",
  suspended: "red", overdue: "red", failed: "red",
  cancelled: "grey", terminated: "grey", closed: "grey", refunded: "grey", skipped: "grey",
  high: "red", medium: "amber", low: "grey",
};
export const badge = (status, label) =>
  html`<span class="badge b-${TONES[status] || "grey"}">${label || LABELS[status] || String(status).replace(/^./, (x) => x.toUpperCase())}</span>`;

export function invoiceBadge(inv) {
  if (inv.status === "unpaid" && inv.due < new Date().toISOString().slice(0, 10)) return badge("overdue");
  return badge(inv.status);
}

export function field(o) {
  const id = "f_" + o.name.replace(/\W/g, "_");
  const common = { id, name: o.name, required: o.required, placeholder: o.placeholder, autocomplete: o.autocomplete, disabled: o.disabled };
  let control;
  if (o.type === "textarea") {
    control = html`<textarea ${attrsOf(common)} rows="${o.rows || 4}">${o.value ?? ""}</textarea>`;
  } else if (o.type === "select") {
    control = html`<select ${attrsOf(common)}>${o.options.map((opt) => {
      const [v, l] = Array.isArray(opt) ? opt : [opt, opt];
      return html`<option value="${v}"${String(v) === String(o.value ?? "") ? raw(" selected") : ""}>${l}</option>`;
    })}</select>`;
  } else if (o.type === "checkbox") {
    return html`<label class="check"><input type="checkbox" ${attrsOf({ ...common, value: "1", checked: Boolean(Number(o.value)) || o.value === true })}> <span>${o.label}</span>${o.hint ? html`<small>${o.hint}</small>` : ""}</label>`;
  } else if (o.type === "money") {
    control = html`<div class="money-in"><span>£</span><input ${attrsOf({ ...common, type: "text", inputmode: "decimal", value: o.value === null || o.value === undefined || o.value === "" ? "" : pounds(o.value) })}></div>`;
  } else {
    control = html`<input ${attrsOf({ ...common, type: o.type || "text", value: o.value ?? "", min: o.min, max: o.max, step: o.step, maxlength: o.maxlength, pattern: o.pattern, inputmode: o.inputmode })}>`;
  }
  return html`<div class="field${o.wide ? " wide" : ""}"><label for="${id}">${o.label}${o.optional ? html` <small>optional</small>` : ""}</label>${control}${o.hint ? html`<small class="hint">${o.hint}</small>` : ""}</div>`;
}

function attrsOf(o) {
  return raw(
    Object.entries(o)
      .filter(([, v]) => v !== false && v !== null && v !== undefined)
      .map(([k, v]) => (v === true ? k : `${k}="${esc(v)}"`))
      .join(" "),
  );
}

export const empty = (text, action) => html`<div class="empty">${text}${action ? html`<div>${action}</div>` : ""}</div>`;

export const cycleLabel = (c) => CYCLES[c]?.label || c;
export const priceLabel = (price, cycle) => html`${money(price)}${CYCLES[cycle]?.per ? html`<small>${CYCLES[cycle].per}</small>` : ""}`;

export const stat = (iconName, tone, label, value, sub, href) => {
  const inner = html`<div class="stat-head"><span class="stat-icon t-${tone}">${icon(iconName)}</span>${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub || raw("&nbsp;")}</div>`;
  return href ? html`<a class="stat" href="${href}">${inner}</a>` : html`<div class="stat">${inner}</div>`;
};

export const dateCell = (d) => html`<span class="nowrap">${fmtDate(d)}</span>`;

export function pager(c, total, per) {
  const page = Math.max(1, parseInt(c.url.searchParams.get("page") || "1", 10));
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return "";
  const link = (p) => {
    const u = new URL(c.url);
    u.searchParams.set("page", p);
    return u.pathname + u.search;
  };
  return html`<div class="pager">${page > 1 ? html`<a class="btn btn-sm" href="${link(page - 1)}">Previous</a>` : ""}<span>Page ${page} of ${pages}</span>${page < pages ? html`<a class="btn btn-sm" href="${link(page + 1)}">Next</a>` : ""}</div>`;
}
export const pageOffset = (c, per) => (Math.max(1, parseInt(c.url.searchParams.get("page") || "1", 10)) - 1) * per;
