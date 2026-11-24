// Sign-in, registration and password resets for clients and staff.
import { html } from "../lib/html.js";
import { all, insert, one, run } from "../lib/db.js";
import {
  clearAttempts, createSession, destroySession, hashPassword, makeToken, passwordProblem, readSession, recordAttempt,
  tooManyAttempts, turnstileOk, useToken, peekToken, verifyPassword, verifyTotp,
} from "../lib/auth.js";
import { redirect, safeNext, touchLogin, forbidden } from "../lib/http.js";
import { authPage, csrf, field, turnstile } from "../lib/ui.js";
import { sendEmail } from "../lib/email.js";
import { baseUrl, log, notifyAdmin } from "../lib/billing.js";
import { clean, isEmail, nowIso } from "../lib/util.js";

export default function (r) {
  r.get("/favicon.ico", () => redirect("/favicon.svg"));

  // ---- client sign-in -------------------------------------------------------
  r.get("/login", async (c) => {
    if (await readSession(c.env, c.req, "client")) return redirect(safeNext(c.url.searchParams.get("next")) || "/");
    return authPage(c, {
      title: "Sign in",
      body: html`<form method="post" class="stack">
        <input type="hidden" name="next" value="${c.url.searchParams.get("next") || ""}">
        ${field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email" })}
        ${field({ label: "Password", name: "password", type: "password", required: true, autocomplete: "current-password" })}
        ${turnstile(c)}
        <button class="btn btn-primary btn-block">Sign in</button>
      </form>
      <div class="auth-links"><a href="/forgot">Forgotten your password?</a>${c.s.allow_registration === "1" ? html`<a href="/register">Create an account</a>` : ""}</div>`,
    });
  });

  r.post("/login", async (c) => {
    const email = clean(c.form.get("email"), 254).toLowerCase();
    const key = `c:${email}`;
    const ipKey = `ip:${c.req.headers.get("cf-connecting-ip") || "?"}`;
    if ((await tooManyAttempts(c.env, key)) || (await tooManyAttempts(c.env, ipKey, 30)))
      return redirect("/login", "Too many attempts. Wait 15 minutes and try again.", "err");
    if (!(await turnstileOk(c.s, c.form, c.req))) return redirect("/login", "Please complete the check and try again.", "err");
    const client = await one(c.env, "SELECT * FROM clients WHERE email = ?", email);
    if (!client || client.status === "closed" || !(await verifyPassword(c.form.get("password"), client.password_hash))) {
      await recordAttempt(c.env, key);
      await recordAttempt(c.env, ipKey);
      return redirect("/login", "That email and password don't match.", "err");
    }
    await clearAttempts(c.env, key);
    await touchLogin(c.env, "clients", client.id);
    await log(c.env, { kind: "client", id: client.id, name: client.email }, client.id, "client.login", c.req.headers.get("cf-connecting-ip") || "");
    const ck = await createSession(c.env, c.req, "client", client.id);
    return redirect(safeNext(c.form.get("next")) || "/", null, "ok", [ck]);
  });

  r.post("/logout", async (c) => {
    const sess = await readSession(c.env, c.req, "client");
    if (sess && c.form.get("_csrf") !== sess.csrf) return forbidden(c);
    const ck = await destroySession(c.env, sess, "client");
    if (sess?.staff_id) return redirect(`/admin/clients/${sess.subject_id}`, null, "ok", [ck]);
    return redirect("/login", "You're signed out.", "ok", [ck]);
  });

  // ---- registration ------------------------------------------------------------
  r.get("/register", (c) => {
    if (c.s.allow_registration !== "1") return redirect("/login", "New accounts are made by invitation. Get in touch and we'll set one up.", "err");
    return authPage(c, {
      title: "Create your account",
      wide: true,
      body: html`<form method="post" class="grid2">
        ${field({ label: "First name", name: "first_name", required: true, autocomplete: "given-name" })}
        ${field({ label: "Last name", name: "last_name", required: true, autocomplete: "family-name" })}
        ${field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email", wide: true })}
        ${field({ label: "Company", name: "company", optional: true, autocomplete: "organization", wide: true })}
        ${field({ label: "Address", name: "address1", required: true, autocomplete: "address-line1", wide: true })}
        ${field({ label: "Town or city", name: "city", required: true, autocomplete: "address-level2" })}
        ${field({ label: "Postcode", name: "postcode", required: true, autocomplete: "postal-code" })}
        ${field({ label: "Phone", name: "phone", type: "tel", optional: true, autocomplete: "tel" })}
        ${field({ label: "Country", name: "country", value: "United Kingdom", autocomplete: "country-name" })}
        ${field({ label: "Password", name: "password", type: "password", required: true, autocomplete: "new-password", hint: "At least 10 characters.", wide: true })}
        ${c.s.terms_url ? html`<div class="wide">${field({ type: "checkbox", name: "terms", label: html`I agree to the <a href="${c.s.terms_url}" target="_blank" rel="noopener">terms of service</a>` })}</div>` : ""}
        <div class="wide">${turnstile(c)}</div>
        <div class="wide"><button class="btn btn-primary btn-block">Create account</button></div>
      </form>
      <div class="auth-links"><a href="/login">I already have an account</a></div>`,
    });
  });

  r.post("/register", async (c) => {
    if (c.s.allow_registration !== "1") return redirect("/login");
    const f = c.form;
    const ipKey = `reg:${c.req.headers.get("cf-connecting-ip") || "?"}`;
    if (await tooManyAttempts(c.env, ipKey, 5, 60)) return redirect("/register", "Too many sign-ups from here. Try again later.", "err");
    if (!(await turnstileOk(c.s, f, c.req))) return redirect("/register", "Please complete the check and try again.", "err");
    const email = clean(f.get("email"), 254).toLowerCase();
    if (!isEmail(email)) return redirect("/register", "Enter a valid email address.", "err");
    const pwErr = passwordProblem(f.get("password"));
    if (pwErr) return redirect("/register", pwErr, "err");
    if (c.s.terms_url && f.get("terms") !== "1") return redirect("/register", "Please agree to the terms to continue.", "err");
    for (const k of ["first_name", "last_name", "address1", "city", "postcode"]) if (!clean(f.get(k))) return redirect("/register", "Please fill in every required field.", "err");
    await recordAttempt(c.env, ipKey);
    if (await one(c.env, "SELECT id FROM clients WHERE email = ?", email)) {
      return redirect("/login", "There's already an account with that email. Sign in, or reset your password.", "err");
    }
    const id = await insert(
      c.env,
      `INSERT INTO clients (email, password_hash, first_name, last_name, company, address1, city, postcode, country, phone, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      email, await hashPassword(f.get("password")), clean(f.get("first_name"), 80), clean(f.get("last_name"), 80), clean(f.get("company"), 120),
      clean(f.get("address1"), 200), clean(f.get("city"), 100), clean(f.get("postcode"), 20), clean(f.get("country"), 80) || "United Kingdom",
      clean(f.get("phone"), 40), nowIso(),
    );
    const actor = { kind: "client", id, name: email };
    await log(c.env, actor, id, "client.registered", email);
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
    const ck = await createSession(c.env, c.req, "client", id);
    return redirect("/", "Welcome! Your account is ready. We've sent you an email to confirm your address.", "ok", [ck]);
  });

  r.get("/verify/:token", async (c) => {
    const t = await useToken(c.env, "verify", c.params.token);
    if (!t) return redirect("/login", "That link has expired or was already used.", "err");
    await run(c.env, "UPDATE clients SET email_verified = 1 WHERE id = ?", t.subject_id);
    return redirect("/", "Thanks, your email address is confirmed.");
  });

  // ---- client password reset -------------------------------------------------
  r.get("/forgot", (c) =>
    authPage(c, {
      title: "Reset your password",
      body: html`<p class="muted">Enter your email and we'll send you a link to choose a new password.</p>
      <form method="post" class="stack">${field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email" })}${turnstile(c)}<button class="btn btn-primary btn-block">Send reset link</button></form>
      <div class="auth-links"><a href="/login">Back to sign in</a></div>`,
    }),
  );

  r.post("/forgot", async (c) => {
    const email = clean(c.form.get("email"), 254).toLowerCase();
    const key = `f:${c.req.headers.get("cf-connecting-ip") || "?"}`;
    if (await tooManyAttempts(c.env, key, 5, 60)) return redirect("/forgot", "Too many requests. Try again later.", "err");
    if (!(await turnstileOk(c.s, c.form, c.req))) return redirect("/forgot", "Please complete the check and try again.", "err");
    await recordAttempt(c.env, key);
    const client = await one(c.env, "SELECT * FROM clients WHERE email = ? AND status != 'closed'", email);
    if (client) await sendReset(c, client);
    return redirect("/login", "If that email has an account, a reset link is on its way.");
  });

  r.get("/reset/:token", async (c) => {
    if (!(await peekToken(c.env, "reset", c.params.token))) return redirect("/forgot", "That link has expired. Ask for a new one.", "err");
    return authPage(c, {
      title: "Choose a new password",
      body: html`<form method="post" class="stack">${field({ label: "New password", name: "password", type: "password", required: true, autocomplete: "new-password", hint: "At least 10 characters." })}<button class="btn btn-primary btn-block">Save password</button></form>`,
    });
  });

  r.post("/reset/:token", async (c) => {
    const pwErr = passwordProblem(c.form.get("password"));
    if (pwErr) return redirect(`/reset/${c.params.token}`, pwErr, "err");
    const t = await useToken(c.env, "reset", c.params.token);
    if (!t) return redirect("/forgot", "That link has expired. Ask for a new one.", "err");
    await run(c.env, "UPDATE clients SET password_hash = ?, email_verified = 1 WHERE id = ?", await hashPassword(c.form.get("password")), t.subject_id);
    await run(c.env, "DELETE FROM sessions WHERE kind = 'client' AND subject_id = ?", t.subject_id);
    await log(c.env, { kind: "client", id: t.subject_id, name: "client" }, t.subject_id, "client.password_reset");
    const ck = await createSession(c.env, c.req, "client", t.subject_id);
    return redirect("/", "Your new password is saved.", "ok", [ck]);
  });

  // ---- staff sign-in -------------------------------------------------------------
  r.get("/admin/login", async (c) => {
    const anyStaff = await one(c.env, "SELECT COUNT(*) AS n FROM staff");
    if (!anyStaff.n) return setupPage(c);
    const sess = await readSession(c.env, c.req, "staff");
    if (sess && !sess.pending_2fa) return redirect(safeNext(c.url.searchParams.get("next")) || "/admin");
    if (sess?.pending_2fa) {
      return authPage(c, {
        title: "Two-step check",
        body: html`<p class="muted">Enter the 6-digit code from your authenticator app.</p>
        <form method="post" action="/admin/login/2fa" class="stack"><input type="hidden" name="_csrf" value="${sess.csrf}"><input type="hidden" name="next" value="${c.url.searchParams.get("next") || ""}">
        ${field({ label: "Code", name: "code", inputmode: "numeric", autocomplete: "one-time-code", required: true, pattern: "[0-9 ]{6,7}" })}
        <button class="btn btn-primary btn-block">Continue</button></form>`,
      });
    }
    return authPage(c, {
      title: "Staff sign in",
      body: html`<form method="post" class="stack">
        <input type="hidden" name="next" value="${c.url.searchParams.get("next") || ""}">
        ${field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "username" })}
        ${field({ label: "Password", name: "password", type: "password", required: true, autocomplete: "current-password" })}
        <button class="btn btn-primary btn-block">Sign in</button>
      </form><div class="auth-links"><a href="/admin/forgot">Forgotten your password?</a></div>`,
    });
  });

  r.post("/admin/login", async (c) => {
    const email = clean(c.form.get("email"), 254).toLowerCase();
    const key = `s:${email}`;
    const ipKey = `sip:${c.req.headers.get("cf-connecting-ip") || "?"}`;
    if ((await tooManyAttempts(c.env, key, 6)) || (await tooManyAttempts(c.env, ipKey, 20)))
      return redirect("/admin/login", "Too many attempts. Wait 15 minutes and try again.", "err");
    const st = await one(c.env, "SELECT * FROM staff WHERE email = ? AND active = 1", email);
    if (!st || !(await verifyPassword(c.form.get("password"), st.password_hash))) {
      await recordAttempt(c.env, key);
      await recordAttempt(c.env, ipKey);
      return redirect("/admin/login", "That email and password don't match.", "err");
    }
    await clearAttempts(c.env, key);
    const next = safeNext(c.form.get("next"));
    const ck = await createSession(c.env, c.req, "staff", st.id, { pending2fa: Boolean(st.totp_secret) });
    if (st.totp_secret) return redirect(`/admin/login${next ? `?next=${encodeURIComponent(next)}` : ""}`, null, "ok", [ck]);
    await touchLogin(c.env, "staff", st.id);
    await log(c.env, { kind: "staff", id: st.id, name: st.name || st.email }, null, "staff.login", c.req.headers.get("cf-connecting-ip") || "");
    return redirect(next || "/admin", st.role === "admin" ? null : null, "ok", [ck]);
  });

  r.post("/admin/login/2fa", async (c) => {
    const sess = await readSession(c.env, c.req, "staff");
    if (!sess?.pending_2fa || c.form.get("_csrf") !== sess.csrf) return redirect("/admin/login");
    const key = `2fa:${sess.subject_id}`;
    if (await tooManyAttempts(c.env, key, 6)) return redirect("/admin/login", "Too many attempts. Wait 15 minutes.", "err");
    const st = await one(c.env, "SELECT * FROM staff WHERE id = ?", sess.subject_id);
    if (!st || !(await verifyTotp(st.totp_secret, c.form.get("code")))) {
      await recordAttempt(c.env, key);
      return redirect("/admin/login", "That code didn't work. Try the newest one.", "err");
    }
    await clearAttempts(c.env, key);
    await run(c.env, "UPDATE sessions SET pending_2fa = 0 WHERE id = ?", sess.id);
    await touchLogin(c.env, "staff", st.id);
    await log(c.env, { kind: "staff", id: st.id, name: st.name || st.email }, null, "staff.login", c.req.headers.get("cf-connecting-ip") || "");
    return redirect(safeNext(c.form.get("next")) || "/admin");
  });

  r.post("/admin/logout", async (c) => {
    const sess = await readSession(c.env, c.req, "staff");
    if (sess && c.form.get("_csrf") !== sess.csrf) return forbidden(c);
    const ck = await destroySession(c.env, sess, "staff");
    return redirect("/admin/login", "You're signed out.", "ok", [ck]);
  });

  // First run: the owner (ADMIN_EMAIL) gets an email link to set a password.
  r.post("/admin/setup", async (c) => {
    const anyStaff = await one(c.env, "SELECT COUNT(*) AS n FROM staff");
    const email = (c.env.ADMIN_EMAIL || "").toLowerCase();
    if (anyStaff.n || !isEmail(email)) return redirect("/admin/login");
    if (await tooManyAttempts(c.env, "setup", 3, 60)) return redirect("/admin/login", "A link was sent recently. Check your inbox.", "err");
    await recordAttempt(c.env, "setup");
    const id = await insert(c.env, "INSERT INTO staff (email, name, role, created_at) VALUES (?,?,?,?)", email, "Owner", "admin", nowIso());
    await sendStaffLink(c, { id, email }, true);
    return redirect("/admin/login", "Check the owner's inbox for a link to set the password.");
  });

  r.get("/admin/forgot", (c) =>
    authPage(c, {
      title: "Reset staff password",
      body: html`<form method="post" class="stack">${field({ label: "Email", name: "email", type: "email", required: true })}<button class="btn btn-primary btn-block">Send reset link</button></form><div class="auth-links"><a href="/admin/login">Back</a></div>`,
    }),
  );

  r.post("/admin/forgot", async (c) => {
    const key = `sf:${c.req.headers.get("cf-connecting-ip") || "?"}`;
    if (await tooManyAttempts(c.env, key, 5, 60)) return redirect("/admin/login", "Too many requests. Try again later.", "err");
    await recordAttempt(c.env, key);
    const st = await one(c.env, "SELECT * FROM staff WHERE email = ? AND active = 1", clean(c.form.get("email"), 254).toLowerCase());
    if (st) await sendStaffLink(c, st, false);
    return redirect("/admin/login", "If that's a staff email, a reset link is on its way.");
  });

  r.get("/admin/reset/:token", async (c) => {
    if (!(await peekToken(c.env, "staff-reset", c.params.token))) return redirect("/admin/login", "That link has expired.", "err");
    return authPage(c, {
      title: "Set your password",
      body: html`<form method="post" class="stack">${field({ label: "New password", name: "password", type: "password", required: true, autocomplete: "new-password", hint: "At least 10 characters." })}<button class="btn btn-primary btn-block">Save password</button></form>`,
    });
  });

  r.post("/admin/reset/:token", async (c) => {
    const pwErr = passwordProblem(c.form.get("password"));
    if (pwErr) return redirect(`/admin/reset/${c.params.token}`, pwErr, "err");
    const t = await useToken(c.env, "staff-reset", c.params.token);
    if (!t) return redirect("/admin/login", "That link has expired.", "err");
    await run(c.env, "UPDATE staff SET password_hash = ? WHERE id = ?", await hashPassword(c.form.get("password")), t.subject_id);
    await run(c.env, "DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ?", t.subject_id);
    return redirect("/admin/login", "Password saved. Sign in now.");
  });
}

function setupPage(c) {
  const email = c.env.ADMIN_EMAIL || "";
  return authPage(c, {
    title: "Set up Purser",
    body: email
      ? html`<p>There are no staff accounts yet. We'll email a link to the owner's address to set a password.</p>
        <form method="post" action="/admin/setup"><button class="btn btn-primary btn-block">Email the set-up link</button></form>`
      : html`<p>Set the <code>ADMIN_EMAIL</code> variable on the Worker first, then come back here.</p>`,
  });
}

export async function sendReset(c, client) {
  const t = await makeToken(c.env, "reset", client.id, 2);
  await sendEmail(c.env, c.s, {
    to: client.email, clientId: client.id,
    subject: `Reset your ${c.s.company_name} password`,
    lines: [
      `Hi ${client.first_name || "there"},`,
      "Someone (hopefully you) asked to reset your password. The link works for 2 hours.",
      { button: { label: "Choose a new password", url: `${baseUrl(c.env)}/reset/${t}` } },
      "If you didn't ask for this, you can ignore this email.",
    ],
  });
}

export async function sendStaffLink(c, st, first) {
  const t = await makeToken(c.env, "staff-reset", st.id, first ? 24 : 2);
  await sendEmail(c.env, c.s, {
    to: st.email,
    subject: first ? `Set up your ${c.s.company_name} admin account` : `Reset your ${c.s.company_name} admin password`,
    lines: [
      first ? "You've been given a staff account on the client area." : "Someone asked to reset your staff password.",
      { button: { label: "Set my password", url: `${baseUrl(c.env)}/admin/reset/${t}` } },
      `The link works for ${first ? "24" : "2"} hours.`,
    ],
  });
}
