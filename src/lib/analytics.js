// Visit-to-order tracking, first party and cookie-light.
//
// The brand websites (ratlan.net, purehost.co.uk) send a small beacon to
// POST /v on each page view with a random per-tab visit id and where the visit
// came from (UTM tags, ad click ids, the referring site, the landing page).
// When the visitor follows a link into the client area the link carries
// ?_v=<visit id>, which becomes a session cookie (gone when the browser
// closes) so that a sign-up, an order and its payment can be tied back to the
// visit. Nothing identifies a person: no IP addresses or user agents are
// stored, and browsers that send Global Privacy Control or Do Not Track are
// never tracked (the website script stays quiet and the client area ignores them).
import { all, one, run } from "./db.js";
import { getCookie } from "./auth.js";
import { nowIso, today } from "./util.js";

export const VISIT_COOKIE = "purser_v";
const ID = /^[a-z0-9]{12,40}$/;

const s = (v, max = 120) => String(v ?? "").trim().slice(0, max);
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const SEARCH = [
  [/(^|\.)google\./, "google"], [/(^|\.)bing\.com$/, "bing"], [/(^|\.)duckduckgo\.com$/, "duckduckgo"], [/(^|\.)yahoo\./, "yahoo"],
  [/(^|\.)ecosia\.org$/, "ecosia"], [/(^|\.)search\.brave\.com$/, "brave"], [/(^|\.)yandex\./, "yandex"], [/(^|\.)qwant\.com$/, "qwant"],
];
const SOCIAL = [
  [/(^|\.)(facebook|fb)\.com$|^l\.facebook\.com$/, "facebook"], [/(^|\.)instagram\.com$/, "instagram"], [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "x"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "linkedin"], [/(^|\.)reddit\.com$/, "reddit"], [/(^|\.)youtube\.com$/, "youtube"], [/(^|\.)tiktok\.com$/, "tiktok"],
];
const AI = [[/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/, "chatgpt"], [/(^|\.)perplexity\.ai$/, "perplexity"], [/(^|\.)claude\.ai$/, "claude"], [/(^|\.)gemini\.google\.com$/, "gemini"], [/(^|\.)copilot\.microsoft\.com$/, "copilot"]];

// Turns raw arrival details into a source / medium pair, the way analytics
// tools group traffic: tagged links first, then ad click ids, then the referrer.
export function channel({ source, medium, ref, gclid, msclkid, fbclid } = {}) {
  source = s(source, 80).toLowerCase();
  medium = s(medium, 80).toLowerCase();
  if (source) return { source, medium: medium || "(not set)" };
  if (gclid) return { source: "google", medium: "cpc" };
  if (msclkid) return { source: "bing", medium: "cpc" };
  if (fbclid) return { source: "facebook", medium: "social" };
  const h = s(ref, 120).toLowerCase();
  if (!h) return { source: "(direct)", medium: "(none)" };
  for (const [re, name] of AI) if (re.test(h)) return { source: name, medium: "ai" };
  for (const [re, name] of SEARCH) if (re.test(h)) return { source: name, medium: "organic" };
  for (const [re, name] of SOCIAL) if (re.test(h)) return { source: name, medium: "social" };
  return { source: h, medium: "referral" };
}

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|httpclient|monitor/i;
export const optedOut = (req) => req.headers.get("sec-gpc") === "1" || req.headers.get("dnt") === "1";
const isBot = (req) => BOT.test(req.headers.get("user-agent") || "");
const device = (req) => (req.headers.get("sec-ch-ua-mobile") === "?1" || /Mobi|Android|iPhone/i.test(req.headers.get("user-agent") || "") ? "mobile" : "desktop");
const country = (req) => s(req.cf?.country, 2);

// Hosts that belong to us: a referrer from one of these isn't a "source".
function ownHosts(c) {
  const hs = new Set([c.url.hostname, hostOf(c.s?._base?.site_url || c.s?.site_url)]);
  for (const b of c.brands || []) {
    if (b.host) hs.add(b.host);
    if (b.site_url) hs.add(hostOf(b.site_url));
  }
  hs.delete("");
  return hs;
}

const brandSlug = (c, b) => {
  const want = s(b, 40).toLowerCase();
  return (c.brands || []).some((x) => x.slug === want) ? want : "";
};

async function upsertVisit(env, v) {
  const at = nowIso();
  await run(
    env,
    `INSERT INTO visits (id, brand, first_at, last_at, source, medium, campaign, referrer, landing, country, device, pages, reached_ca)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at, pages = visits.pages + excluded.pages,
       reached_ca = MAX(visits.reached_ca, excluded.reached_ca)`,
    v.id, v.brand, at, at, v.source, v.medium, v.campaign || "", v.referrer || "", v.landing || "/", v.country || "", v.device || "", v.pages || 0, v.reached_ca || 0,
  );
}

// POST /v from a brand website (sendBeacon, text/plain JSON).
export async function collect(c) {
  const none = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (optedOut(c.req) || isBot(c.req)) return none;
  const len = Number(c.req.headers.get("content-length") || 0);
  if (len > 4096) return none;
  let d;
  try {
    d = JSON.parse((await c.req.text()).slice(0, 4096));
  } catch {
    return none;
  }
  if (!d || !ID.test(String(d.v || ""))) return none;
  const ref = hostOf(d.r ? `https://${d.r}` : "");
  const mine = ownHosts(c);
  const ch = channel({ source: d.s, medium: d.m, ref: mine.has(ref) ? "" : ref, gclid: d.g === "g", msclkid: d.g === "m", fbclid: d.g === "f" });
  const path = s(d.p, 200).split("?")[0] || "/";
  await upsertVisit(c.env, {
    id: d.v, brand: brandSlug(c, d.b), ...ch, campaign: s(d.c, 120), referrer: mine.has(ref) ? "" : ref,
    landing: s(d.l, 200).split("?")[0] || path, country: country(c.req), device: device(c.req), pages: 1,
  });
  await run(
    c.env,
    `INSERT INTO page_views (day, brand, path, views) VALUES (?,?,?,1)
     ON CONFLICT(day, brand, path) DO UPDATE SET views = views + 1`,
    today(), brandSlug(c, d.b), path,
  );
  return none;
}

// Every client-area request: picks up ?_v= from a website link (cookie set,
// redirected to the clean address), or starts a visit for someone who lands
// straight on an order or sign-up page. Sets c.visitId.
export async function trackArrival(c) {
  const p = c.url.pathname;
  if (p.startsWith("/admin") || p.startsWith("/webhooks/") || p === "/v") return null;
  const tracked = !optedOut(c.req) && !isBot(c.req);
  const fromLink = c.url.searchParams.get("_v");
  if (fromLink !== null && c.req.method === "GET") {
    const u = new URL(c.url);
    const a = u.searchParams.get("_a");
    u.searchParams.delete("_v");
    u.searchParams.delete("_a");
    const headers = { Location: u.pathname + u.search, "cache-control": "no-store" };
    if (tracked && ID.test(fromLink)) {
      // The website's beacon normally made the visit already; _a fills it in if it was blocked.
      let d = {};
      try {
        d = JSON.parse(a || "{}");
      } catch {}
      const ref = hostOf(d.r ? `https://${d.r}` : "");
      const mine = ownHosts(c);
      await upsertVisit(c.env, {
        id: fromLink, brand: brandSlug(c, d.b) || c.s.brand || "", ...channel({ source: d.s, medium: d.m, ref: mine.has(ref) ? "" : ref, gclid: d.g === "g", msclkid: d.g === "m", fbclid: d.g === "f" }),
        campaign: s(d.c, 120), referrer: mine.has(ref) ? "" : ref, landing: s(d.l, 200) || "/", country: country(c.req), device: device(c.req), reached_ca: 1,
      });
      headers["Set-Cookie"] = `${VISIT_COOKIE}=${fromLink}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    }
    return new Response(null, { status: 302, headers });
  }
  const have = getCookie(c.req, VISIT_COOKIE);
  if (have && ID.test(have)) {
    c.visitId = have;
    return null;
  }
  // Landed on the client area directly (an ad or a search result pointing at an
  // order page): start a visit here.
  if (tracked && c.req.method === "GET" && /^\/(order|register)(\/|$)/.test(p) && !/\/code$/.test(p) && !getCookie(c.req, "purser_c")) {
    const id = crypto.randomUUID().replace(/-/g, "");
    const q = c.url.searchParams;
    const ref = hostOf(c.req.headers.get("referer") || "");
    const mine = ownHosts(c);
    await upsertVisit(c.env, {
      id, brand: c.s.brand || "", ...channel({ source: q.get("utm_source"), medium: q.get("utm_medium"), ref: mine.has(ref) ? "" : ref, gclid: q.get("gclid"), msclkid: q.get("msclkid"), fbclid: q.get("fbclid") }),
      campaign: s(q.get("utm_campaign"), 120), referrer: mine.has(ref) ? "" : ref, landing: `${c.url.hostname}${p}`, country: country(c.req), device: device(c.req), pages: 1, reached_ca: 1,
    });
    c.visitId = id;
    c.setVisitCookie = `${VISIT_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }
  return null;
}

// ---- funnel steps -------------------------------------------------------------

export async function visitSignedUp(env, visitId, clientId) {
  if (!visitId) return;
  await run(env, "UPDATE clients SET visit_id = ? WHERE id = ? AND visit_id IS NULL", visitId, clientId);
  await run(env, "UPDATE visits SET client_id = ?, signup_at = COALESCE(signup_at, ?) WHERE id = ?", clientId, nowIso(), visitId);
}

const MONTHS = { monthly: 1, quarterly: 3, annually: 12 };
export const monthlyValue = (price, cycle) => (MONTHS[cycle] ? Math.round(price / MONTHS[cycle]) : 0);

// An order placed from the client area: the visit in this browser, or failing
// that the visit the client first signed up from.
export async function visitOrdered(env, visitId, client, serviceId) {
  const vid = visitId || client.visit_id;
  if (!vid) return;
  if (!(await one(env, "SELECT id FROM visits WHERE id = ?", vid))) return;
  await run(env, "UPDATE services SET visit_id = ? WHERE id = ?", vid, serviceId);
  await run(
    env,
    "UPDATE visits SET orders = orders + 1, order_at = COALESCE(order_at, ?), client_id = COALESCE(client_id, ?) WHERE id = ?",
    nowIso(), client.id, vid,
  );
}

// The first invoice of an order is paid: revenue and the monthly value it adds.
export async function visitPaid(env, svc, amount) {
  if (!svc?.visit_id) return;
  await run(
    env,
    "UPDATE visits SET paid_at = COALESCE(paid_at, ?), paid_orders = paid_orders + 1, revenue = revenue + ?, mrr = mrr + ? WHERE id = ?",
    nowIso(), Math.max(0, amount || 0), monthlyValue(svc.price, svc.cycle), svc.visit_id,
  );
}

// Visits that never became a customer are kept 13 months, page counts 25.
export async function pruneAnalytics(env) {
  const d = (m) => new Date(Date.now() - m * 30.5 * 86400000).toISOString();
  await run(env, "DELETE FROM visits WHERE client_id IS NULL AND first_at < ?", d(13));
  await run(env, "DELETE FROM page_views WHERE day < ?", d(25).slice(0, 10));
  return "ok";
}

// ---- report --------------------------------------------------------------------

export async function report(env, { since, brand }) {
  const where = `first_at >= ?1${brand === null ? "" : " AND brand = ?2"}`;
  const p = brand === null ? [since] : [since, brand];
  const sums = `COUNT(*) AS visits, COALESCE(SUM(pages),0) AS pages, COALESCE(SUM(reached_ca),0) AS reached,
    COUNT(signup_at) AS signups, COUNT(order_at) AS ordered, COUNT(paid_at) AS paid, COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(mrr),0) AS mrr`;
  const group = (col, extra = "", limit = 25) =>
    all(env, `SELECT ${col} AS k, ${sums} FROM visits WHERE ${where} ${extra} GROUP BY ${col} ORDER BY paid DESC, ordered DESC, visits DESC LIMIT ${limit}`, ...p);
  const [totals, daily, channels, campaigns, landings, devices, pages, recent] = await Promise.all([
    one(env, `SELECT ${sums} FROM visits WHERE ${where}`, ...p),
    all(env, `SELECT substr(first_at,1,10) AS day, COUNT(*) AS visits, COUNT(order_at) AS ordered, COUNT(paid_at) AS paid FROM visits WHERE ${where} GROUP BY day ORDER BY day`, ...p),
    group("source || ' / ' || medium"),
    group("campaign", "AND campaign != ''"),
    group("landing"),
    group("device", "", 5),
    all(env, `SELECT path, SUM(views) AS views FROM page_views WHERE day >= substr(?1,1,10)${brand === null ? "" : " AND brand = ?2"} GROUP BY path ORDER BY views DESC LIMIT 25`, ...p),
    all(
      env,
      `SELECT v.*, c.email, c.first_name, c.last_name FROM visits v LEFT JOIN clients c ON c.id = v.client_id
       WHERE v.first_at >= ?1${brand === null ? "" : " AND v.brand = ?2"} AND (v.signup_at IS NOT NULL OR v.order_at IS NOT NULL)
       ORDER BY COALESCE(v.paid_at, v.order_at, v.signup_at) DESC LIMIT 25`,
      ...p,
    ),
  ]);
  return { totals, daily, channels, campaigns, landings, devices, pages, recent };
}
