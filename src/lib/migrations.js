// Schema migrations, applied by the Worker itself on the first request
// (and the first cron run) after a deploy. Append new entries; never edit old ones.
export const MIGRATIONS = [
  {
    id: 1,
    name: "initial schema",
    sql: [
      `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE clients (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '',
        address1 TEXT NOT NULL DEFAULT '',
        address2 TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        postcode TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT 'United Kingdom',
        phone TEXT NOT NULL DEFAULT '',
        vat_number TEXT NOT NULL DEFAULT '',
        tax_exempt INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        email_verified INTEGER NOT NULL DEFAULT 0,
        credit INTEGER NOT NULL DEFAULT 0,
        stripe_customer TEXT,
        stripe_pm TEXT,
        stripe_pm_label TEXT,
        auto_charge INTEGER NOT NULL DEFAULT 1,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_login TEXT
      )`,
      `CREATE TABLE staff (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL DEFAULT '',
        password_hash TEXT,
        totp_secret TEXT,
        role TEXT NOT NULL DEFAULT 'admin',
        active INTEGER NOT NULL DEFAULT 1,
        signature TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_login TEXT
      )`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        csrf TEXT NOT NULL,
        staff_id INTEGER,
        pending_2fa INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT,
        ua TEXT
      )`,
      `CREATE INDEX sessions_subject ON sessions (kind, subject_id)`,
      `CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE login_attempts (key TEXT NOT NULL, at TEXT NOT NULL)`,
      `CREATE INDEX login_attempts_key ON login_attempts (key, at)`,
      `CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'hosting',
        berth_plan TEXT NOT NULL DEFAULT '',
        price_monthly INTEGER,
        price_quarterly INTEGER,
        price_annually INTEGER,
        price_once INTEGER,
        setup_fee INTEGER NOT NULL DEFAULT 0,
        needs_domain INTEGER NOT NULL DEFAULT 1,
        visible INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE services (
        id INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES clients(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        label TEXT NOT NULL DEFAULT '',
        cycle TEXT NOT NULL DEFAULT 'monthly',
        price INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        start_date TEXT,
        next_due TEXT,
        cancel_at_end INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT NOT NULL DEFAULT '',
        suspend_reason TEXT NOT NULL DEFAULT '',
        berth_account TEXT,
        berth_username TEXT,
        provision_error TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX services_client ON services (client_id)`,
      `CREATE INDEX services_due ON services (status, next_due)`,
      `CREATE TABLE invoices (
        id INTEGER PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        client_id INTEGER NOT NULL REFERENCES clients(id),
        status TEXT NOT NULL DEFAULT 'unpaid',
        issued TEXT NOT NULL,
        due TEXT NOT NULL,
        subtotal INTEGER NOT NULL DEFAULT 0,
        tax_rate REAL NOT NULL DEFAULT 0,
        tax_label TEXT NOT NULL DEFAULT '',
        tax INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        paid INTEGER NOT NULL DEFAULT 0,
        paid_at TEXT,
        notes TEXT NOT NULL DEFAULT '',
        bill_to TEXT NOT NULL DEFAULT '',
        reminder_stage INTEGER NOT NULL DEFAULT 0,
        charge_attempts INTEGER NOT NULL DEFAULT 0,
        last_charge_at TEXT,
        charge_error TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX invoices_client ON invoices (client_id, status)`,
      `CREATE INDEX invoices_status ON invoices (status, due)`,
      `CREATE TABLE invoice_items (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id),
        service_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'custom',
        description TEXT NOT NULL,
        amount INTEGER NOT NULL,
        taxed INTEGER NOT NULL DEFAULT 1,
        period_start TEXT,
        period_end TEXT
      )`,
      `CREATE INDEX invoice_items_invoice ON invoice_items (invoice_id)`,
      `CREATE INDEX invoice_items_service ON invoice_items (service_id, period_start)`,
      `CREATE TABLE transactions (
        id INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL,
        invoice_id INTEGER,
        gateway TEXT NOT NULL,
        reference TEXT,
        amount INTEGER NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        staff_id INTEGER,
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX transactions_ref ON transactions (gateway, reference) WHERE reference IS NOT NULL`,
      `CREATE INDEX transactions_invoice ON transactions (invoice_id)`,
      `CREATE TABLE credit_log (
        id INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT NOT NULL,
        invoice_id INTEGER,
        staff_id INTEGER,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE departments (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        visible INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0
      )`,
      `INSERT INTO departments (name, description, sort) VALUES
        ('Technical support', 'Problems with a website, email or your control panel', 1),
        ('Billing', 'Invoices, payments and changes to your plan', 2),
        ('Sales', 'Questions before you order', 3)`,
      `CREATE TABLE tickets (
        id INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES clients(id),
        department_id INTEGER,
        service_id INTEGER,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'medium',
        assigned_staff INTEGER,
        last_reply_by TEXT NOT NULL DEFAULT 'client',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX tickets_client ON tickets (client_id, status)`,
      `CREATE INDEX tickets_status ON tickets (status, updated_at)`,
      `CREATE TABLE ticket_messages (
        id INTEGER PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        author_kind TEXT NOT NULL,
        author_id INTEGER,
        author_name TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        internal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX ticket_messages_ticket ON ticket_messages (ticket_id)`,
      `CREATE TABLE attachments (
        id INTEGER PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        type TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX attachments_message ON attachments (message_id)`,
      `CREATE TABLE activity (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id INTEGER,
        actor_name TEXT NOT NULL DEFAULT '',
        client_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE INDEX activity_client ON activity (client_id, at)`,
      `CREATE TABLE email_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        client_id INTEGER,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT
      )`,
    ],
  },
  {
    id: 2,
    name: "product slugs for website order links",
    sql: [
      `ALTER TABLE products ADD COLUMN slug TEXT`,
      `CREATE UNIQUE INDEX products_slug ON products (slug) WHERE slug IS NOT NULL AND slug != ''`,
    ],
  },
  {
    id: 3,
    name: "berth plan limits on products",
    sql: [`ALTER TABLE products ADD COLUMN berth_limits TEXT NOT NULL DEFAULT ''`],
  },
  {
    id: 4,
    name: "discount codes",
    sql: [
      `CREATE TABLE promo_codes (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'percent',
        value INTEGER NOT NULL,
        recurring INTEGER NOT NULL DEFAULT 0,
        product_ids TEXT NOT NULL DEFAULT '',
        cycles TEXT NOT NULL DEFAULT '',
        max_uses INTEGER NOT NULL DEFAULT 0,
        once_per_client INTEGER NOT NULL DEFAULT 1,
        expires TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE promo_redemptions (
        id INTEGER PRIMARY KEY,
        promo_id INTEGER NOT NULL REFERENCES promo_codes(id),
        client_id INTEGER NOT NULL REFERENCES clients(id),
        service_id INTEGER,
        invoice_id INTEGER,
        amount INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX promo_redemptions_promo ON promo_redemptions (promo_id)`,
      `ALTER TABLE services ADD COLUMN promo_code TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    id: 5,
    name: "mail services that share a hosting account",
    sql: [`ALTER TABLE services ADD COLUMN berth_addon INTEGER NOT NULL DEFAULT 0`],
  },
  {
    id: 6,
    name: "brands (PureHost)",
    sql: [
      `CREATE TABLE brands (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        site_url TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        icon_url TEXT NOT NULL DEFAULT '',
        stylesheet TEXT NOT NULL DEFAULT '',
        brand_color TEXT NOT NULL DEFAULT '',
        theme_color TEXT NOT NULL DEFAULT '',
        site_links TEXT NOT NULL DEFAULT '',
        footer_links TEXT NOT NULL DEFAULT '',
        plans_url TEXT NOT NULL DEFAULT '',
        terms_url TEXT NOT NULL DEFAULT '',
        mail_from_name TEXT NOT NULL DEFAULT '',
        email_mark TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
      `ALTER TABLE clients ADD COLUMN brand TEXT`,
      `INSERT INTO brands (slug, name, site_url, logo_url, icon_url, stylesheet, brand_color, theme_color, site_links, footer_links, plans_url, terms_url, mail_from_name, email_mark, created_at)
       VALUES ('purehost', 'PureHost', 'https://purehost.co.uk', '/brands/purehost/logo.svg', '/brands/purehost/favicon.svg', '/brands/purehost/theme.css', '#1650e0', '#f7faff',
        'Web hosting|/web-hosting/' || char(10) || 'WordPress|/wordpress-hosting/' || char(10) || 'Email|/email-hosting/' || char(10) || 'Free transfer|/website-transfer/' || char(10) || 'Support|/support/',
        'Terms|/legal/terms/' || char(10) || 'Privacy|/legal/privacy/' || char(10) || 'Acceptable use|/legal/acceptable-use/' || char(10) || 'Support|/support/',
        '/web-hosting/#plans', 'https://purehost.co.uk/legal/terms/', 'PureHost', 'https://purehost.co.uk/brand/mark-512.png', '2026-11-26T00:00:00.000Z')`,
    ],
  },
];

let applied = null;

// Runs pending migrations once per isolate. Two isolates racing on a fresh
// database is harmless: the loser's batch fails, rolls back, and it re-checks.
export function migrate(env) {
  if (!applied) {
    applied = doMigrate(env).catch((e) => {
      applied = null;
      throw e;
    });
  }
  return applied;
}

async function doMigrate(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT, at TEXT)").run();
  const done = new Set(((await env.DB.prepare("SELECT id FROM _migrations").all()).results ?? []).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    const stmts = m.sql.map((s) => env.DB.prepare(s));
    stmts.push(env.DB.prepare("INSERT INTO _migrations (id, name, at) VALUES (?, ?, ?)").bind(m.id, m.name, new Date().toISOString()));
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      const again = await env.DB.prepare("SELECT id FROM _migrations WHERE id = ?").bind(m.id).first();
      if (!again) throw e;
    }
  }
}

export const resetMigrationState = () => {
  applied = null;
};
