// Client for Berth's provisioning API (/api/provision/ with a Bearer token).
export class BerthError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const berthReady = (s) => Boolean(s.berth_url && s.berth_token);

export async function berth(s, method, path, body) {
  if (!berthReady(s)) throw new BerthError("Berth is not connected yet (Settings → Berth)", 0);
  const url = s.berth_url.replace(/\/+$/, "") + "/api/provision" + path;
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${s.berth_token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new BerthError(`Could not reach Berth: ${e.message}`, 0);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!r.ok) throw new BerthError(data?.error || data?.message || `Berth answered ${r.status}`, r.status, data);
  return data;
}

export const externalId = (serviceId) => `purser-${serviceId}`;
export const accountRef = (svc) => (svc.berth_account ? encodeURIComponent(svc.berth_account) : `ext:${externalId(svc.id)}`);

export const berthPlans = async (s) => {
  const d = await berth(s, "GET", "/plans");
  return Array.isArray(d) ? d : d?.plans ?? [];
};

// The limits a Berth plan has, in the order Berth's plan page shows them.
// "per" says what a limit applies to; 0 means no limit.
export const PLAN_LIMITS = [
  ["max_sites", "Websites", "account"],
  ["disk_mb", "Storage (MB)", "account"],
  ["dns_zones", "DNS zones", "account"],
  ["cpu_percent", "CPU % (100 = 1 core)", "account"],
  ["ram_mb", "RAM (MB)", "account"],
  ["max_processes", "Processes", "account"],
  ["max_domains", "Domains", "site"],
  ["memory_mb", "PHP memory (MB)", "site"],
  ["workers", "PHP workers", "site"],
  ["upload_mb", "Upload size (MB)", "site"],
  ["db_connections", "Database connections", "site"],
  ["mail_domains", "Mail domains (0 = no mail)", "mail"],
  ["mailboxes", "Mailboxes", "mail"],
  ["mail_aliases", "Aliases", "mail"],
  ["mail_storage_mb", "Mail storage (MB)", "mail"],
];
export const PLAN_FLAGS = [
  ["allow_shell", "Allow PHP exec and shell functions"],
  ["no_sftp", "No SFTP"],
  ["no_sites", "Mail only: no websites"],
];

export function parseLimits(json) {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Creates or updates the product's plan in Berth with its limits.
export async function pushPlan(s, product) {
  const limits = parseLimits(product.berth_limits);
  const body = { name: product.berth_plan };
  for (const [k] of PLAN_LIMITS) body[k] = Math.max(0, parseInt(limits[k], 10) || 0);
  for (const [k] of PLAN_FLAGS) body[k] = Boolean(limits[k]);
  return berth(s, "PUT", `/plans/${encodeURIComponent(product.berth_plan)}`, body);
}
