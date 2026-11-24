// Stripe webhooks. Every handler is idempotent: Stripe retries, and the
// Checkout success redirect may already have recorded the payment.
import { json } from "../lib/http.js";
import { verifyStripeSignature } from "../lib/stripe.js";
import { SYSTEM, getClient, handleCheckoutSession, log, notifyAdmin, recordPayment } from "../lib/billing.js";
import { money } from "../lib/util.js";

export default function (r) {
  r.post("/webhooks/stripe", async (c) => {
    const body = await c.req.text();
    const ok = await verifyStripeSignature(c.s.stripe_webhook_secret, c.req.headers.get("stripe-signature"), body);
    if (!ok) return json({ error: "bad signature" }, 400);
    const event = JSON.parse(body);
    const o = event.data?.object || {};
    try {
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          await handleCheckoutSession(c.env, c.s, o, c.ctx);
          break;
        case "payment_intent.succeeded": {
          const inv = Number(o.metadata?.purser_invoice);
          if (inv) await recordPayment(c.env, c.s, { invoiceId: inv, amount: o.amount_received, gateway: "stripe", reference: o.id, ctx: c.ctx });
          break;
        }
        case "charge.dispute.created": {
          await notifyAdmin(c.env, c.s, "A card payment was disputed", [
            `A customer disputed a charge of ${money(o.amount)} (${o.reason || "no reason given"}). Respond in Stripe before the deadline.`,
            { button: { label: "Open Stripe", url: `https://dashboard.stripe.com/disputes/${o.id}` } },
          ]);
          const clientId = Number(o.metadata?.purser_client);
          if (clientId && (await getClient(c.env, clientId))) await log(c.env, SYSTEM, clientId, "payment.disputed", money(o.amount));
          break;
        }
      }
    } catch (e) {
      console.error("stripe webhook", event.type, e);
      return json({ error: e.message }, 500);
    }
    return json({ received: true });
  });
}
