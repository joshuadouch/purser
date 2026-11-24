// Creating a client account from a form: used by /register and by ordering
// without an account.
import { html } from "./html.js";
import { insert, one } from "./db.js";
import { createSession, hashPassword, makeToken, passwordProblem, recordAttempt, tooManyAttempts, turnstileOk } from "./auth.js";
import { sendEmail } from "./email.js";
import { baseUrl, log, notifyAdmin } from "./billing.js";
import { field, turnstile } from "./ui.js";
import { clean, isEmail, nowIso } from "./util.js";

// The account fields, shared by the registration and checkout forms.
export const accountFields = (c, v = {}) => html`
  ${field({ label: "First name", name: "first_name", required: true, autocomplete: "given-name", value: v.first_name })}
  ${field({ label: "Last name", name: "last_name", required: true, autocomplete: "family-name", value: v.last_name })}
  ${field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email", wide: true, value: v.email })}
  ${field({ label: "Company", name: "company", optional: true, autocomplete: "organization", wide: true, value: v.company })}
  ${field({ label: "Address", name: "address1", required: true, autocomplete: "address-line1", wide: true, value: v.address1 })}
  ${field({ label: "Town or city", name: "city", required: true, autocomplete: "address-level2", value: v.city })}
  ${field({ label: "Postcode", name: "postcode", required: true, autocomplete: "postal-code", value: v.postcode })}
  ${field({ label: "Phone", name: "phone", type: "tel", optional: true, autocomplete: "tel", value: v.phone })}
  ${field({ label: "Country", name: "country", value: v.country || "United Kingdom", autocomplete: "country-name" })}
  ${field({ label: "Password", name: "password", type: "password", required: true, autocomplete: "new-password", hint: "At least 10 characters.", wide: true })}
  ${c.s.terms_url ? html`<div class="wide">${field({ type: "checkbox", name: "terms", label: html`I agree to the <a href="${c.s.terms_url}" target="_blank" rel="noopener">terms of service</a>` })}</div>` : ""}
  <div class="wide">${turnstile(c)}</div>`;

// Returns { client, cookie } or { error, existing }.
export async function signUp(c, f) {
  const ipKey = `reg:${c.req.headers.get("cf-connecting-ip") || "?"}`;
  if (await tooManyAttempts(c.env, ipKey, 5, 60)) return { error: "Too many sign-ups from here. Try again later." };
  if (!(await turnstileOk(c.s, f, c.req))) return { error: "Please complete the check and try again." };
  const email = clean(f.get("email"), 254).toLowerCase();
  if (!isEmail(email)) return { error: "Enter a valid email address." };
  for (const k of ["first_name", "last_name", "address1", "city", "postcode"]) if (!clean(f.get(k))) return { error: "Please fill in every required field." };
  const pwErr = passwordProblem(f.get("password"));
  if (pwErr) return { error: pwErr };
  if (c.s.terms_url && f.get("terms") !== "1") return { error: "Please agree to the terms to continue." };
  await recordAttempt(c.env, ipKey);
  if (await one(c.env, "SELECT id FROM clients WHERE email = ?", email)) {
    return { error: "There's already an account with that email. Sign in, or reset your password.", existing: true };
  }
  const id = await insert(
    c.env,
    `INSERT INTO clients (email, password_hash, first_name, last_name, company, address1, city, postcode, country, phone, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    email, await hashPassword(f.get("password")), clean(f.get("first_name"), 80), clean(f.get("last_name"), 80), clean(f.get("company"), 120),
    clean(f.get("address1"), 200), clean(f.get("city"), 100), clean(f.get("postcode"), 20), clean(f.get("country"), 80) || "United Kingdom",
    clean(f.get("phone"), 40), nowIso(),
  );
  await log(c.env, { kind: "client", id, name: email }, id, "client.registered", email);
  const t = await makeToken(c.env, "verify", id, 72);
  await sendEmail(c.env, c.s, {
    to: email, clientId: id,
    subject: `Welcome to ${c.s.company_name}`,
    lines: [
      `Hi ${clean(f.get("first_name"))},`,
      `Thanks for creating an account. Please confirm your email address so we can reach you about invoices and support.`,
      { button: { label: "Confirm my email", url: `${baseUrl(c.env)}/verify/${t}` } },
    ],
  });
  await notifyAdmin(c.env, c.s, `New client: ${email}`, [`${clean(f.get("first_name"))} ${clean(f.get("last_name"))} (${email}) created an account.`, { button: { label: "Open client", url: `${baseUrl(c.env)}/admin/clients/${id}` } }]);
  const cookie = await createSession(c.env, c.req, "client", id);
  const client = await one(c.env, "SELECT * FROM clients WHERE id = ?", id);
  return { client, cookie };
}
