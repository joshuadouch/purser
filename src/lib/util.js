// Dates, money and crypto helpers shared across the app.

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return today(d);
}

// Adds months keeping the day of the month where it can (31 Jan + 1 month = 28/29 Feb).
export function addMonths(date, n) {
  const [y, m, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return today(target);
}

export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

export const CYCLES = {
  monthly: { label: "Monthly", months: 1, per: "/mo" },
  quarterly: { label: "Quarterly", months: 3, per: "/qtr" },
  annually: { label: "Annually", months: 12, per: "/yr" },
  once: { label: "One-off", months: 0, per: "" },
};
export const cycleEnd = (start, cycle) => (CYCLES[cycle]?.months ? addMonths(start, CYCLES[cycle].months) : null);

export function fmtDate(d) {
  if (!d) return "";
  const t = new Date(d.length === 10 ? d + "T00:00:00Z" : d);
  if (isNaN(t)) return d;
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

export function fmtDateTime(d) {
  if (!d) return "";
  const t = new Date(d);
  return t.toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
  });
}

export function ago(d) {
  if (!d) return "";
  const s = Math.max(0, (Date.now() - Date.parse(d)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(d);
}

const SYMBOLS = { GBP: "£", USD: "$", EUR: "€" };
// Amounts are whole pence (integers) everywhere.
export function money(pence, currency = "GBP") {
  const n = Number(pence || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const str = (abs / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${SYMBOLS[currency] ?? currency + " "}${str}`;
}

// "12.5" / "£1,200.00" -> pence. Returns null for blank or invalid input.
export function parseMoney(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[£$€,\s]/g, "");
  if (s === "") return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.replace("-", "").split(".");
  const p = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return s.startsWith("-") ? -p : p;
}

export const pounds = (p) => (p === null || p === undefined ? "" : (p / 100).toFixed(2));

const enc = new TextEncoder();
export const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256(s) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
export async function hmacHex(secret, msg, hash = "SHA-256") {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const int = (v, d = null) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
export const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
export const fullName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(" ") || c?.email || "";
export const initials = (s) =>
  String(s || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
