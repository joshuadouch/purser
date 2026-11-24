// Purser: billing, support tickets and the client area, on Cloudflare Workers.
import { migrate } from "./lib/migrations.js";
import { loadSettings } from "./lib/settings.js";
import { FLASH, Router, notFound, parseForm, readFlash, sameOrigin, forbidden, withStatus } from "./lib/http.js";
import { authPage } from "./lib/ui.js";
import { html } from "./lib/html.js";
import { runDaily } from "./lib/cron.js";
import publicRoutes from "./routes/public.js";
import clientRoutes from "./routes/client.js";
import ticketRoutes from "./routes/tickets.js";
import adminRoutes from "./routes/admin.js";
import adminBillingRoutes from "./routes/admin-billing.js";
import adminSettingsRoutes from "./routes/admin-settings.js";
import webhookRoutes from "./routes/webhooks.js";

const router = new Router();
for (const register of [webhookRoutes, publicRoutes, clientRoutes, ticketRoutes, adminRoutes, adminBillingRoutes, adminSettingsRoutes]) register(router);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const c = { req, env, ctx, url, params: {}, flash: readFlash(req) };
    let res;
    try {
      await migrate(env);
      c.s = await loadSettings(env);
      const m = router.match(req.method, url.pathname);
      if (!m) res = notFound(c);
      else if (m.methodNotAllowed) res = new Response("Method not allowed", { status: 405 });
      else {
        c.params = m.params;
        const isWebhook = url.pathname.startsWith("/webhooks/");
        if (req.method === "POST" && !isWebhook) {
          if (!sameOrigin(c)) res = forbidden(c, "That request came from another site, so it was blocked.");
          else await parseForm(c);
        }
        if (!res) {
          for (const h of m.handlers) {
            res = await h(c);
            if (res) break;
          }
        }
        res ||= notFound(c);
      }
    } catch (e) {
      console.error("request failed", url.pathname, e?.stack || e);
      c.s ||= { company_name: "Client area", brand_color: "#5b3df5" };
      res = withStatus(
        authPage(c, { title: "Something went wrong", body: html`<p>Sorry, that didn't work. Please try again in a moment.</p><p class="muted small">${String(e?.message || e).slice(0, 200)}</p><p><a class="btn" href="/">Go back</a></p>` }),
        500,
      );
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
    // A flash message is shown once: clear it unless this response sets a new one.
    if (c.flash && !(out.headers.get("set-cookie") || "").includes(`${FLASH}=`)) {
      out.headers.append("Set-Cookie", `${FLASH}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    }
    return out;
  },

  async scheduled(event, env, ctx) {
    await migrate(env);
    const s = await loadSettings(env);
    const report = await runDaily(env, s, ctx);
    console.log("daily run", JSON.stringify(report));
  },
};
