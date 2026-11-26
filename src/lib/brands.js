// Brands: other shop fronts that sell through this client area (e.g. PureHost
// on purehost.co.uk). A brand swaps the name, logo, favicon, colours, website
// header and footer, and email look; billing, Stripe and Berth stay shared.
//
// Which brand a visitor sees, strongest first:
//   1. a signed-in client's own brand (clients.brand, set when they sign up),
//   2. ?brand=<slug> on any link (remembered in a cookie for a year),
//   3. the brand cookie,
//   4. the Referer, when it's a brand's website.
// Emails follow the recipient client's brand.
import { all, one } from "./db.js";
import { getCookie } from "./auth.js";

export const BRAND_COOKIE = "purser_brand";

// Brand columns that replace the setting of the same name.
const OVERRIDES = ["site_url", "logo_url", "brand_color", "site_links", "footer_links", "terms_url", "mail_from_name", "plans_url"];

export const listBrands = (env) => all(env, "SELECT * FROM brands ORDER BY name");
export const getBrand = (env, slug) => (slug ? one(env, "SELECT * FROM brands WHERE slug = ? AND active = 1", slug) : null);

// The settings as a brand's customers see them. `_base` keeps the house
// settings so a later step (a signed-in client, an email) can re-brand.
export function applyBrand(s, brand) {
  const base = s._base || s;
  if (!brand) return base;
  const out = { ...base, _base: base, brand: brand.slug, company_name: brand.name };
  for (const k of OVERRIDES) if (brand[k]) out[k] = brand[k];
  out.brand_icon = brand.icon_url || "";
  out.brand_css = brand.stylesheet || "";
  out.theme_color = brand.theme_color || "";
  out.email_mark = brand.email_mark || "";
  return out;
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const cookie = (v, age) => `${BRAND_COOKIE}=${v}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;

// Works out the visitor's brand before routing. Returns a redirect when a
// ?brand= link should be tidied away, otherwise null (c.s is branded in place).
export async function resolveBrand(c) {
  const p = c.url.pathname;
  if (p.startsWith("/webhooks/")) return null;
  const brands = (await listBrands(c.env)).filter((b) => b.active);
  c.brands = brands;
  if (p.startsWith("/admin")) return null;
  const param = c.url.searchParams.get("brand");
  if (param !== null) {
    const b = brands.find((x) => x.slug === param.toLowerCase());
    const set = b ? cookie(b.slug, 31536000) : cookie("", 0);
    if (c.req.method === "GET") {
      const u = new URL(c.url);
      u.searchParams.delete("brand");
      return new Response(null, { status: 302, headers: { Location: u.pathname + u.search, "Set-Cookie": set, "cache-control": "no-store" } });
    }
    c.setBrandCookie = set;
    c.s = applyBrand(c.s, b);
    return null;
  }
  let b = brands.find((x) => x.slug === getCookie(c.req, BRAND_COOKIE));
  const ref = hostOf(c.req.headers.get("referer") || "");
  if (ref && ref !== c.url.hostname) {
    const byRef = brands.find((x) => hostOf(x.site_url) === ref);
    if (byRef) b = byRef;
    // Arriving from the house website takes a visitor back to the house look.
    else if (ref === hostOf(c.s.site_url)) b = null;
    const want = b ? b.slug : "";
    if (want !== (getCookie(c.req, BRAND_COOKIE) || "")) c.setBrandCookie = b ? cookie(b.slug, 31536000) : cookie("", 0);
  }
  c.s = applyBrand(c.s, b);
  return null;
}

// A signed-in client always sees their own brand.
export function brandForClient(c, client) {
  if (!c.brands) return;
  const b = client.brand ? c.brands.find((x) => x.slug === client.brand) : null;
  if ((b?.slug || null) !== (c.s.brand || null)) c.s = applyBrand(c.s, b);
}

// Settings to email a client with: theirs if they have a brand, else the house.
export async function settingsForClient(env, s, clientId) {
  const base = s._base || s;
  if (!clientId) return base;
  const row = await one(env, "SELECT b.* FROM clients c JOIN brands b ON b.slug = c.brand WHERE c.id = ? AND b.active = 1", clientId);
  return applyBrand(base, row);
}
