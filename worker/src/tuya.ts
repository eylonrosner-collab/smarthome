import { productionEphemeral, type Ephemeral } from "./ephemeral";

/**
 * Tuya OpenAPI signing, matching the working Python client:
 *   stringToSign = METHOD \n sha256(body) \n \n canonicalPath
 *   sign = HMAC-SHA256(accessSecret, accessId + token + t + stringToSign) as uppercase hex
 * Query parameters are sorted by key so the signed path matches Tuya's rule.
 */

export function canonicalPath(path: string): string {
  const q = path.indexOf("?");
  if (q < 0) return path;
  const pathname = path.slice(0, q);
  const query = path.slice(q + 1);
  if (!query) return pathname;
  const pairs: [string, string][] = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const value = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1));
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${pathname}?${qs}`;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(buf);
}

export async function hmacSha256Upper(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(sig).toUpperCase();
}

export async function buildTuyaSign(opts: {
  accessId: string;
  accessSecret: string;
  token?: string;
  t: string;
  method: string;
  path: string;
  body?: string;
}): Promise<{ sign: string; path: string; contentHash: string; stringToSign: string }> {
  const path = canonicalPath(opts.path);
  const body = opts.body ?? "";
  const contentHash = await sha256Hex(body);
  const method = opts.method.toUpperCase();
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const token = opts.token ?? "";
  const sign = await hmacSha256Upper(opts.accessSecret, opts.accessId + token + opts.t + stringToSign);
  return { sign, path, contentHash, stringToSign };
}

export type TuyaResponse<T = unknown> = {
  success?: boolean;
  code?: number | string;
  msg?: string;
  result?: T;
};

/** Trial IoT Core monthly API quota (28841004). Shown on the dashboard and on commands. */
export const TUYA_QUOTA_MESSAGE = "מכסת הקריאות של Tuya נגמרה החודש";
/** After that error, make no Tuya calls. Kept in memory / Cache API, not KV. */
export const TUYA_BACKOFF_MS = 60 * 60_000;
const QUOTA_KEY = "tuya_quota";

export function isTuyaQuota(code?: number | string, msg?: string): boolean {
  if (String(code ?? "") === "28841004") return true;
  return /28841004|trial quota is exhausted|iot core trial quota/i.test(msg || "");
}

export function isQuotaError(err: unknown): boolean {
  return err instanceof TuyaError && (String(err.code) === "28841004" || err.message === TUYA_QUOTA_MESSAGE);
}

/** Trial IoT Core rejects commands once the controllable-device pool is used up. */
export function tuyaUserMessage(msg?: string): string {
  const text = msg || "";
  if (isTuyaQuota(undefined, text)) return TUYA_QUOTA_MESSAGE;
  if (/controllable device pool quota|quota is insufficient/i.test(text)) {
    return "מכסת השליטה של Tuya נגמרה. זו מגבלה של תוכנית הניסיון ב-IoT Core, לא תקלה בלוח. שדרוג התוכנית או המתנה לחידוש המכסה יחזירו את הפקודות.";
  }
  return text || "Tuya דחה את הפקודה";
}

export async function tuyaQuotaActive(store: Ephemeral, nowMs: number): Promise<boolean> {
  try {
    const row = await store.get<{ until?: number }>(QUOTA_KEY);
    return Boolean(row && Number(row.until) > nowMs);
  } catch {
    return false;
  }
}

export async function armTuyaQuota(store: Ephemeral, nowMs: number): Promise<void> {
  try {
    await store.put(QUOTA_KEY, { until: nowMs + TUYA_BACKOFF_MS }, Math.ceil(TUYA_BACKOFF_MS / 1000) + 60);
  } catch {
    /* this isolate still records the backoff below when the caller checks the thrown error */
  }
}

export class TuyaError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
    this.name = "TuyaError";
  }
}

type TokenCache = { access: string; refresh: string; expireAt: number };

export class TuyaClient {
  private token?: TokenCache;

  constructor(
    private readonly opts: {
      accessId: string;
      accessSecret: string;
      base?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
      store?: Ephemeral;
    },
  ) {}

  private cache(): Ephemeral {
    return this.opts.store ?? productionEphemeral;
  }

  private tokenKey(): string {
    return `tuya_token:${this.opts.accessId}`;
  }

  private base(): string {
    return (this.opts.base || "https://openapi.tuyaeu.com").replace(/\/$/, "");
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async request<T = unknown>(method: string, path: string, bodyObj?: unknown): Promise<TuyaResponse<T>> {
    if (await tuyaQuotaActive(this.cache(), this.now())) {
      throw new TuyaError(TUYA_QUOTA_MESSAGE, 28841004);
    }
    const isTokenCall = path.startsWith("/v1.0/token");
    const token = isTokenCall ? "" : await this.getToken();
    const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    const t = String(this.now());
    const signed = await buildTuyaSign({
      accessId: this.opts.accessId,
      accessSecret: this.opts.accessSecret,
      token,
      t,
      method,
      path,
      body,
    });
    const headers: Record<string, string> = {
      client_id: this.opts.accessId,
      sign: signed.sign,
      t,
      sign_method: "HMAC-SHA256",
      access_token: token,
      "Content-Type": "application/json",
    };
    const res = await (this.opts.fetchImpl ?? fetch)(this.base() + signed.path, {
      method: method.toUpperCase(),
      headers,
      body: body ? body : undefined,
    });
    let json: TuyaResponse<T>;
    try {
      json = (await res.json()) as TuyaResponse<T>;
    } catch (err) {
      if (isQuotaError(err)) throw err;
      throw new TuyaError(`Tuya HTTP ${res.status}`);
    }
    if (isTuyaQuota(json.code, json.msg)) {
      await armTuyaQuota(this.cache(), this.now());
      throw new TuyaError(TUYA_QUOTA_MESSAGE, 28841004);
    }
    return json;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expireAt > this.now()) return this.token.access;
    const shared = await this.cache().get<TokenCache>(this.tokenKey());
    if (shared?.access && shared.expireAt > this.now()) {
      this.token = shared;
      return shared.access;
    }
    if (this.token?.refresh) {
      const refreshed = await this.request<{
        access_token: string;
        refresh_token: string;
        expire_time: number;
      }>("GET", `/v1.0/token/${this.token.refresh}`);
      if (refreshed.success && refreshed.result?.access_token) {
        await this.remember(refreshed.result);
        return this.token!.access;
      }
    }
    const fresh = await this.request<{
      access_token: string;
      refresh_token: string;
      expire_time: number;
    }>("GET", "/v1.0/token?grant_type=1");
    if (!fresh.success || !fresh.result?.access_token) {
      throw new TuyaError(`token ${fresh.code ?? ""} ${fresh.msg ?? "failed"}`.trim(), fresh.code);
    }
    await this.remember(fresh.result);
    return this.token!.access;
  }

  private async remember(result: { access_token: string; refresh_token: string; expire_time: number }) {
    const skew = 60_000;
    this.token = {
      access: result.access_token,
      refresh: result.refresh_token,
      expireAt: this.now() + Math.max(30, result.expire_time) * 1000 - skew,
    };
    const ttl = Math.max(60, Math.ceil((this.token.expireAt - this.now()) / 1000));
    await this.cache().put(this.tokenKey(), this.token, ttl);
  }

  async listDevices(): Promise<Record<string, unknown>[]> {
    const devs: Record<string, unknown>[] = [];
    let last = "";
    for (let page = 0; page < 50; page++) {
      const path =
        "/v2.0/cloud/thing/device?" + (last ? `last_id=${encodeURIComponent(last)}&` : "") + "page_size=20";
      const r = await this.request<unknown>("GET", path);
      if (!r.success) throw new TuyaError(`device list ${r.code ?? ""} ${r.msg ?? ""}`.trim(), r.code);
      const batch = unwrapDeviceList(r.result);
      const seen = new Set(devs.map((d) => String(d.id)));
      const fresh = batch.filter((d) => d.id && !seen.has(String(d.id)));
      if (!fresh.length) break;
      devs.push(...fresh);
      last = String(batch[batch.length - 1]?.id ?? "");
      if (batch.length < 20) break;
    }
    return devs;
  }

  /**
   * One call for up to 20 devices. Returns null when the endpoint is not permitted
   * so the caller can fall back to per-device status. Quota errors propagate.
   */
  async batchStatus(ids: string[]): Promise<Map<string, Record<string, unknown>> | null> {
    const out = new Map<string, Record<string, unknown>>();
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return out;
    for (let i = 0; i < unique.length; i += 20) {
      const chunk = unique.slice(i, i + 20);
      const query = new URLSearchParams({ device_ids: chunk.join(",") });
      let response: TuyaResponse<unknown>;
      try {
        response = await this.request<unknown>("GET", `/v1.0/iot-03/devices/status?${query.toString()}`);
      } catch (err) {
        if (isQuotaError(err)) throw err;
        return null;
      }
      if (!response.success) return null;
      for (const row of unwrapBatchStatus(response.result)) out.set(row.id, row.status);
    }
    return out;
  }

  async deviceStatus(id: string): Promise<Record<string, unknown> | null> {
    const v1 = await this.request<{ code: string; value: unknown }[]>("GET", `/v1.0/devices/${id}/status`);
    if (v1.success && Array.isArray(v1.result)) {
      const out: Record<string, unknown> = {};
      for (const s of v1.result) out[s.code] = s.value;
      return out;
    }
    const v2 = await this.request<{ properties?: { code: string; value: unknown }[] }>(
      "GET",
      `/v2.0/cloud/thing/${id}/shadow/properties`,
    );
    if (v2.success && v2.result?.properties) {
      const out: Record<string, unknown> = {};
      for (const p of v2.result.properties) out[p.code] = p.value;
      return out;
    }
    return null;
  }

  async gangNames(id: string): Promise<Record<string, string>> {
    try {
      const r = await this.request<{ identifier: string; name: string }[]>(
        "GET",
        `/v1.0/devices/${id}/multiple-names`,
      );
      if (!r.success || !Array.isArray(r.result)) return {};
      const names: Record<string, string> = {};
      for (const x of r.result) {
        if (x.identifier && x.identifier !== "main" && x.name) names[x.identifier] = x.name;
      }
      return names;
    } catch (err) {
      if (isQuotaError(err)) throw err;
      return {};
    }
  }

  async listRemotes(infraredId: string): Promise<{ remote_id?: string; remote_name?: string }[]> {
    const r = await this.request<unknown>("GET", `/v2.0/infrareds/${infraredId}/remotes`);
    if (!r.success || r.result == null) return [];
    const result = r.result as { remote_id?: string; remote_name?: string }[] | { remotes?: unknown[]; list?: unknown[] };
    if (Array.isArray(result)) return result;
    const list = (result.remotes || result.list || []) as { remote_id?: string; remote_name?: string }[];
    return Array.isArray(list) ? list : [];
  }

  async sendCommands(deviceId: string, commands: { code: string; value: unknown }[]): Promise<TuyaResponse> {
    return this.request("POST", `/v1.0/devices/${deviceId}/commands`, { commands });
  }

  /** IR air-conditioner multi-key command (Tuya IR Control Hub). */
  async sendAcCommand(
    infraredId: string,
    remoteId: string,
    body: { power: number; mode?: number; temp?: number; wind?: number },
  ): Promise<TuyaResponse> {
    return this.request(
      "POST",
      `/v2.0/infrareds/${infraredId}/air-conditioners/${remoteId}/scenes/command`,
      body,
    );
  }
}

function statusRecord(status: unknown): Record<string, unknown> {
  if (Array.isArray(status)) {
    const out: Record<string, unknown> = {};
    for (const item of status) {
      if (!item || typeof item !== "object") continue;
      const row = item as { code?: string; value?: unknown };
      if (row.code) out[row.code] = row.value;
    }
    return out;
  }
  if (status && typeof status === "object") return status as Record<string, unknown>;
  return {};
}

function unwrapBatchStatus(result: unknown): { id: string; status: Record<string, unknown> }[] {
  const list = Array.isArray(result)
    ? result
    : result && typeof result === "object"
      ? ((result as { list?: unknown; devices?: unknown; data?: unknown }).list ||
        (result as { devices?: unknown }).devices ||
        (result as { data?: unknown }).data ||
        [])
      : [];
  if (!Array.isArray(list)) return [];
  const out: { id: string; status: Record<string, unknown> }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: string; device_id?: string; status?: unknown };
    const id = String(row.id || row.device_id || "");
    if (!id) continue;
    out.push({ id, status: statusRecord(row.status) });
  }
  return out;
}

function unwrapDeviceList(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    const obj = result as { list?: unknown; devices?: unknown; data?: unknown };
    for (const key of [obj.list, obj.devices, obj.data]) {
      if (Array.isArray(key)) return key as Record<string, unknown>[];
    }
  }
  return [];
}
