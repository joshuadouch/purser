# Purser

Billing, support tickets and a client area for Ratlan hosting, on Cloudflare Workers. A small WHMCS that knows how to drive [Berth](https://github.com/joshuadouch/berth).

Live at **https://clientarea.ratlan.net** (staff: `/admin`).

## What it does

**Clients** sign up, order a plan, pay by card (Stripe Checkout) and can save the card so renewals are charged on the due date. They see their services, invoices and credit, open and reply to support tickets with attachments, sign straight into Berth with one click, reset their Berth password and cancel at the end of a term.

**Staff** get a dashboard (income, outstanding, MRR, tickets waiting), clients (edit, credit, log in as client, password resets), services (suspend, unsuspend, terminate, change plan, link an existing Berth account), invoices (manual invoices, edit lines, record bank/cash payments, apply credit, charge the saved card, refund through Stripe, print or save as PDF), tickets (departments, assignment, priorities, internal notes, signatures), products, settings, staff with admin/support roles and two-step sign-in, an activity log and an email log.

**Every day at 07:00 UTC** a cron run:

1. raises renewal invoices (7 days before the due date by default), one per client per due date, using credit first;
2. charges saved cards on the due date, retrying every 3 days, up to 3 tries;
3. sends a reminder before the due date and overdue notices (days 1, 3 and 7);
4. suspends services whose invoice is 7 days overdue (the Berth account is suspended too) and turns them back on as soon as it's paid;
5. optionally terminates long-overdue services (off by default);
6. ends services the client cancelled at the end of their term;
7. closes tickets answered 7 days ago with no reply.

All the day counts are in Admin → Settings → Billing.

## The website

The client area is dressed as part of the public website (ratlan.net): same header, menu, footer, logo and colours, with the account sections as a tab bar under the header. Admin → Settings → General → Website sets the website address, logo and the menu and footer links; leave the address blank for the plain sidebar layout.

Ordering works without an account. The website's plan buttons link to `/order/<slug>?cycle=monthly|annually` (the slug is the product's "web address name"). A visitor picks monthly or yearly, enters their domain and their details on one page, and goes straight to Stripe Checkout; their account is created on the way and they're signed in when they come back. Existing customers are sent to sign in first.

## Berth

A paid order for a **hosting** product creates a Berth account through its provisioning API with the product's Berth plan, `external_id` `purser-<service id>`, and emails the client their username, password and panel address. Suspensions, unsuspensions, plan changes and terminations go to Berth too.

Set it up in Admin → Settings → Berth: the Berth address (must be reachable from the internet) and a **Provisioning** API token from Berth → Settings → API tokens. Existing Berth customers can be added by hand: Clients → a client → Add service → "Existing customer", with their Berth account ID.

Berth's suspension blocks the customer's panel sign-in; their sites keep running.

## Stripe

Admin → Settings → Stripe: paste the secret key (a restricted key works), then press **Create webhook in Stripe**, which registers `https://clientarea.ratlan.net/webhooks/stripe` and saves its signing secret. Card payments are also recorded when the client lands back on the invoice, so a slow webhook never leaves an invoice looking unpaid.

## Cloudflare

| Piece | Name |
| --- | --- |
| Worker | `purser` (custom domain `clientarea.ratlan.net`, test address `purser.ratlan.workers.dev`) |
| D1 | `purser` (migrations run by the Worker itself on the first request after a deploy, see `src/lib/migrations.js`) |
| R2 | `purser-attachments` (ticket files) |
| Email | Cloudflare Email Sending from `no-reply@mail-service.ratlan.net` (`MAILER` binding, no fixed destination) |
| Cron | `0 7 * * *` |

Secrets (Worker → Settings → Variables and Secrets): `ADMIN_EMAIL` (the owner, who gets the first sign-in link and alerts). `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BERTH_TOKEN` and `TURNSTILE_SECRET` are optional: they can be entered in Admin → Settings instead, and a Worker secret wins over the saved value.

**First sign-in:** open `/admin`, press "Email the set-up link", and follow the link sent to `ADMIN_EMAIL`. Then turn on two-step sign-in under My account.

## Development

```bash
npm install
npm test        # end-to-end tests on node:sqlite with fake Stripe, Berth, R2 and email
npx wrangler dev
```

Plain JavaScript, no runtime dependencies. Pages are rendered on the server (`src/routes/`), with `src/lib/billing.js` holding the money logic and `src/lib/cron.js` the daily run. Amounts are whole pence everywhere.

Adding a database change: append a migration to `MIGRATIONS` in `src/lib/migrations.js`; never edit an old one.
