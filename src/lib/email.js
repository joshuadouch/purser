// Sends email through the Cloudflare Email Sending binding (MAILER) as a raw
// MIME message, and records every send in email_log.
import { insert } from "./db.js";
import { esc } from "./html.js";
import { nowIso } from "./util.js";

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const b64 = (s) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const headerText = (s) => (isAscii(oneLine(s)) ? oneLine(s) : `=?UTF-8?B?${b64(oneLine(s))}?=`);
const displayName = (s) => {
  const t = headerText(s);
  return t.startsWith("=?") || /^[\w .-]*$/.test(t) ? t : `"${t.replace(/["\\]/g, "\\$&")}"`;
};

export function quotedPrintable(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let enc = "";
      for (const byte of new TextEncoder().encode(line)) {
        enc += (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 ? String.fromCharCode(byte) : "=" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
      enc = enc.replace(/ $/, "=20");
      const out = [];
      while (enc.length > 76) {
        let cut = 75;
        if (enc[cut - 1] === "=") cut -= 1;
        else if (enc[cut - 2] === "=") cut -= 2;
        out.push(enc.slice(0, cut) + "=");
        enc = enc.slice(cut);
      }
      out.push(enc);
      return out.join("\r\n");
    })
    .join("\r\n");
}

export function buildMime({ from, fromName, to, replyTo, subject, text, html }) {
  const boundary = "purser-" + crypto.randomUUID();
  const head = [
    `From: ${displayName(fromName)} <${from}>`,
    `To: <${oneLine(to)}>`,
    replyTo ? `Reply-To: <${oneLine(replyTo)}>` : null,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  return [
    ...head,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

// msg: { to, subject, lines: [string | {button:{label,url}} | {rows:[[k,v]]}], clientId }
export async function sendEmail(env, s, msg) {
  const from = env.FROM_EMAIL || "no-reply@mail-service.ratlan.net";
  const fromName = s.mail_from_name || s.company_name;
  const { text, html } = render(s, msg);
  const to = oneLine(msg.to);
  let status = "sent";
  let error = null;
  try {
    if (!env.MAILER) {
      status = "skipped";
      error = "No MAILER binding";
    } else {
      const raw = buildMime({ from, fromName, to, replyTo: msg.replyTo || s.company_email || null, subject: msg.subject, text, html });
      const EmailMessage = env.__EmailMessage || (await import("cloudflare:email")).EmailMessage;
      await env.MAILER.send(new EmailMessage(from, to, raw));
    }
  } catch (e) {
    status = "failed";
    error = String(e?.message || e).slice(0, 500);
    console.error("email failed", to, error);
  }
  await insert(env, "INSERT INTO email_log (at, client_id, to_addr, subject, status, error) VALUES (?,?,?,?,?,?)", nowIso(), msg.clientId ?? null, to, msg.subject, status, error);
  return status === "sent";
}

function render(s, msg) {
  const color = /^#[0-9a-f]{6}$/i.test(s.brand_color) ? s.brand_color : "#5b3df5";
  const textParts = [];
  const htmlParts = [];
  for (const l of msg.lines) {
    if (typeof l === "string") {
      textParts.push(l);
      htmlParts.push(`<p style="margin:0 0 14px;line-height:1.55">${esc(l).replace(/\n/g, "<br>")}</p>`);
    } else if (l.button) {
      textParts.push(`${l.button.label}: ${l.button.url}`);
      htmlParts.push(
        `<p style="margin:22px 0"><a href="${esc(l.button.url)}" style="background:${color};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(l.button.label)}</a></p>`,
      );
    } else if (l.rows) {
      textParts.push(l.rows.map(([k, v]) => `${k}: ${v}`).join("\n"));
      htmlParts.push(
        `<table style="border-collapse:collapse;margin:0 0 16px;width:100%">${l.rows
          .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b6785;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`)
          .join("")}</table>`,
      );
    } else if (l.quote) {
      textParts.push(l.quote.split("\n").map((x) => "> " + x).join("\n"));
      htmlParts.push(`<div style="border-left:3px solid #e3def7;padding:4px 0 4px 14px;margin:0 0 16px;color:#38345a;white-space:pre-wrap">${esc(l.quote)}</div>`);
    }
  }
  const footer = `${s.company_name}${s.company_address ? " · " + s.company_address.split("\n").join(", ") : ""}`;
  const text = [...textParts, "", "--", footer].join("\n\n").replace(/\n{3,}/g, "\n\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f2fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1a33">
<table role="presentation" width="100%" style="background:#f4f2fb;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e7e3f5">
<tr><td style="background:${color};background-image:linear-gradient(120deg,${color},#c03fb5);padding:20px 28px;color:#fff;font-size:18px;font-weight:700">${esc(s.company_name)}</td></tr>
<tr><td style="padding:28px;font-size:15px">${htmlParts.join("")}</td></tr>
</table>
<p style="color:#8a86a3;font-size:12px;margin:16px 0 0">${esc(footer)}</p>
</td></tr></table></body></html>`;
  return { text, html };
}
