// Admin → Analytics: website visits through to sign-ups, orders and payments.
import { html, raw } from "../lib/html.js";
import { requireStaff } from "../lib/http.js";
import { adminPage, empty, stat } from "../lib/ui.js";
import { report } from "../lib/analytics.js";
import { addDays, fmtDate, fullName, money, today } from "../lib/util.js";

const RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["365", "12 months"]];
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(a && (100 * a) / b < 10 ? 1 : 0)}%` : "–");

export default function (r) {
  r.get("/admin/analytics", requireStaff, async (c) => {
    const q = c.url.searchParams;
    const days = RANGES.some(([k]) => k === q.get("days")) ? q.get("days") : "30";
    const brands = [["", c.s._base?.company_name || c.s.company_name], ...(c.brands || []).map((b) => [b.slug, b.name])];
    const brandQ = q.get("brand");
    const brand = brandQ === null || brandQ === "all" ? null : brands.some(([k]) => k === brandQ) ? brandQ : null;
    const since = `${addDays(today(), -(Number(days) - 1))}T00:00:00Z`;
    const d = await report(c.env, { since, brand });
    const t = d.totals;
    const link = (o) => {
      const u = new URLSearchParams({ days, brand: brand === null ? "all" : brand, ...o });
      return `?${u}`;
    };
    const brandName = (slug) => brands.find(([k]) => k === slug)?.[1] || slug || brands[0][1];

    // Funnel: one series, so no legend; each bar is a share of visits.
    const steps = [
      ["Visits", t.visits, "landed on a website or order page"],
      ["Reached the client area", t.reached, "clicked through to sign up or order"],
      ["Signed up", t.signups, "created an account"],
      ["Ordered", t.ordered, "placed an order"],
      ["Paid", t.paid, "first invoice paid (or free)"],
    ];
    const funnel = html`<div class="funnel">${steps.map(([label, n, sub], i) => {
      const w = t.visits ? Math.max(n ? 1.5 : 0, (100 * n) / t.visits) : 0;
      const prev = i ? steps[i - 1][1] : null;
      return html`<div class="fn-row" title="${label}: ${n}${i ? ` (${pct(n, prev)} of the step before, ${pct(n, t.visits)} of visits)` : ""}">
        <div class="fn-label"><b>${label}</b><small>${sub}</small></div>
        <div class="fn-track"><span class="fn-bar" style="${raw(`width:${w.toFixed(2)}%`)}"></span></div>
        <div class="fn-num"><b>${n.toLocaleString("en-GB")}</b><small>${i ? `${pct(n, prev)} of previous` : `${t.pages.toLocaleString("en-GB")} pages`}</small></div>
      </div>`;
    })}</div>`;

    // Visits per day, with days that had a paid order marked in the tooltip.
    const byDay = new Map(d.daily.map((x) => [x.day, x]));
    const dayList = [];
    for (let i = Number(days) - 1; i >= 0; i--) dayList.push(addDays(today(), -i));
    const peak = Math.max(1, ...d.daily.map((x) => x.visits));
    const chart = dayList.length <= 90
      ? html`<div class="vchart" role="img" aria-label="Visits per day">${dayList.map((day) => {
          const x = byDay.get(day) || { visits: 0, ordered: 0, paid: 0 };
          return html`<span class="vbar${x.paid ? " has-paid" : ""}" style="${raw(`height:${x.visits ? Math.max(4, (100 * x.visits) / peak).toFixed(1) : 0}%`)}" title="${fmtDate(day)}: ${x.visits} visit${x.visits === 1 ? "" : "s"}, ${x.ordered} order${x.ordered === 1 ? "" : "s"}, ${x.paid} paid"></span>`;
        })}</div>
        <div class="vchart-axis"><span>${fmtDate(dayList[0])}</span><span>Peak ${peak} a day</span><span>${fmtDate(dayList.at(-1))}</span></div>`
      : "";

    const table = (rows, head, fmt = (k) => k) =>
      rows.length
        ? html`<div class="table-wrap"><table class="table an-table"><thead><tr><th>${head}</th><th class="num">Visits</th><th class="num hide-sm">To client area</th><th class="num">Sign-ups</th><th class="num">Orders</th><th class="num">Paid</th><th class="num hide-sm">Visit → paid</th><th class="num">Revenue</th><th class="num hide-sm">Monthly value</th></tr></thead>
          <tbody>${rows.map((x) => html`<tr><td class="an-key">${fmt(x.k)}</td><td class="num">${x.visits}</td><td class="num hide-sm">${x.reached}</td><td class="num">${x.signups}</td><td class="num">${x.ordered}</td><td class="num">${x.paid}</td><td class="num hide-sm">${pct(x.paid, x.visits)}</td><td class="num">${money(x.revenue)}</td><td class="num hide-sm">${money(x.mrr)}</td></tr>`)}</tbody></table></div>`
        : empty("Nothing yet for this period.");

    return adminPage(c, {
      title: "Analytics", active: "analytics",
      body: html`
      <div class="an-filters">
        <div class="tabs">${RANGES.map(([k, l]) => html`<a class="${days === k ? "on" : ""}" href="${link({ days: k })}">${l}</a>`)}</div>
        <div class="tabs">${[["all", "All brands"], ...brands].map(([k, l]) => html`<a class="${(brand === null ? "all" : brand) === k ? "on" : ""}" href="${link({ brand: k })}">${l}</a>`)}</div>
      </div>
      <div class="stats">
        ${stat("activity", "teal", "Visits", t.visits.toLocaleString("en-GB"), `${t.pages.toLocaleString("en-GB")} page views`)}
        ${stat("users", "purple", "Sign-ups", t.signups, `${pct(t.signups, t.visits)} of visits`)}
        ${stat("cart", "amber", "Paid orders", t.paid, `${pct(t.paid, t.visits)} of visits · ${t.ordered} ordered`)}
        ${stat("pound", "green", "Revenue", money(t.revenue), `${money(t.mrr)} a month added`)}
      </div>
      <section class="card"><div class="card-head"><h3>Funnel</h3><span class="muted small">Last ${RANGES.find(([k]) => k === days)[1]}${brand === null ? "" : ` · ${brandName(brand)}`}</span></div>${funnel}</section>
      ${chart ? html`<section class="card"><div class="card-head"><h3>Visits per day</h3><span class="muted small">Darker bars had a paid order</span></div>${chart}</section>` : ""}
      <section class="card"><div class="card-head"><h3>Where visits came from</h3><span class="muted small">source / medium</span></div>${table(d.channels, "Source")}</section>
      <section class="card"><div class="card-head"><h3>Campaigns</h3><span class="muted small">utm_campaign on your links and ads</span></div>${table(d.campaigns, "Campaign")}</section>
      <section class="card"><div class="card-head"><h3>Landing pages</h3><span class="muted small">the first page of each visit</span></div>${table(d.landings, "Page", (k) => html`<code>${k}</code>`)}</section>
      <div class="cols">
        <section class="card"><div class="card-head"><h3>Most viewed pages</h3></div>
          ${d.pages.length ? html`<table class="table"><tbody>${d.pages.map((x) => html`<tr><td><code>${x.path}</code></td><td class="num">${x.views.toLocaleString("en-GB")}</td></tr>`)}</tbody></table>` : empty("No page views yet.")}</section>
        <section class="card"><div class="card-head"><h3>Devices</h3></div>${d.devices.length ? html`<table class="table"><thead><tr><th>Device</th><th class="num">Visits</th><th class="num">Orders</th><th class="num">Paid</th></tr></thead><tbody>${d.devices.map((x) => html`<tr><td>${x.k || "unknown"}</td><td class="num">${x.visits}</td><td class="num">${x.ordered}</td><td class="num">${x.paid}</td></tr>`)}</tbody></table>` : empty("No visits yet.")}</section>
      </div>
      <section class="card"><div class="card-head"><h3>Recent sign-ups and orders</h3></div>
        ${d.recent.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th>Came from</th><th class="hide-sm">Landing page</th><th class="hide-sm">Brand</th><th>Stage</th><th class="num">Revenue</th></tr></thead><tbody>
            ${d.recent.map((v) => html`<tr${v.client_id ? raw(` data-href="/admin/clients/${v.client_id}"`) : ""}><td>${v.client_id ? html`<a href="/admin/clients/${v.client_id}">${fullName(v) || v.email || `#${v.client_id}`}</a>` : "–"}<small class="muted block">${fmtDate(v.first_at)}</small></td>
              <td>${v.source} / ${v.medium}${v.campaign ? html`<small class="muted block">${v.campaign}</small>` : ""}</td><td class="hide-sm"><code>${v.landing}</code></td><td class="hide-sm">${brandName(v.brand)}</td>
              <td>${v.paid_at ? "Paid" : v.order_at ? "Ordered" : "Signed up"}</td><td class="num">${money(v.revenue)}</td></tr>`)}</tbody></table></div>`
          : empty("No sign-ups or orders from tracked visits yet.")}</section>
      <p class="small muted">Visits are counted from ratlan.net, purehost.co.uk and anyone landing straight on an order page. Nothing identifies a person: no IP addresses or browser details are kept, and visitors whose browser asks not to be tracked aren't counted. Visits that never become a customer are deleted after 13 months.</p>`,
    });
  });
}
