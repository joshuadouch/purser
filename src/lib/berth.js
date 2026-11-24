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
