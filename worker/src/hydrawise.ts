import { agoLabel, whenLabel } from "./time";
import type { ZoneView } from "./types";

const BASE = "https://api.hydrawise.com/api/v1/";

export type ZoneAction = "run" | "stop" | "suspend" | "resume";

/**
 * Hydrawise REST v1 setzone.php query (without api_key).
 * Run `custom` is seconds. Suspend `custom` is a unix epoch to suspend until.
 * period_id=0 on suspend resumes the zone (documented by Hunter support replies).
 */
export function setZoneParams(input: {
  action: ZoneAction;
  relayId: number;
  runSeconds?: number;
  suspendUntilEpoch?: number;
}): Record<string, string> {
  const relay_id = String(input.relayId);
  if (input.action === "stop") return { action: "stop", relay_id };
  if (input.action === "resume") return { action: "suspend", relay_id, period_id: "0" };
  if (input.action === "run") {
    return {
      action: "run",
      relay_id,
      period_id: "999",
      custom: String(input.runSeconds ?? 0),
    };
  }
  return {
    action: "suspend",
    relay_id,
    period_id: "999",
    custom: String(input.suspendUntilEpoch ?? 0),
  };
}

export function hydrawiseUrl(endpoint: string, apiKey: string, params: Record<string, string>): string {
  const usp = new URLSearchParams();
  usp.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) usp.set(k, v);
  return `${BASE}${endpoint}?${usp.toString()}`;
}

export class HydrawiseError extends Error {
  constructor(
    readonly status: number,
    detail = "",
  ) {
    super(detail ? `Hydrawise HTTP ${status}: ${detail}` : `Hydrawise HTTP ${status}`);
    this.name = "HydrawiseError";
  }
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url);
  const text = await res.text();
  if (!res.ok) throw new HydrawiseError(res.status, text.replace(/\s+/g, " ").trim().slice(0, 180));
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

export async function fetchHydrawise(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  opts?: { controller?: boolean; knownController?: Record<string, unknown> },
): Promise<{ schedule: Record<string, unknown>; controller: Record<string, unknown> }> {
  const schedule = (await getJson(
    hydrawiseUrl("statusschedule.php", apiKey, {}),
    fetchImpl,
  )) as Record<string, unknown>;
  let controller = opts?.knownController || {};
  if (opts?.controller !== false) {
    try {
      const details = (await getJson(
        hydrawiseUrl("customerdetails.php", apiKey, { type: "controllers" }),
        fetchImpl,
      )) as { controllers?: Record<string, unknown>[] };
      const list = details.controllers || [];
      const found = list.find((c) => String(c.name || "") === "My Controller") || list[0];
      if (found) controller = found;
    } catch {
      /* keep the controller we already know */
    }
  }
  return { schedule, controller };
}

export async function sendZone(
  apiKey: string,
  input: {
    action: ZoneAction;
    relayId: number;
    runSeconds?: number;
    suspendUntilEpoch?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ message?: string; message_type?: string }> {
  const url = hydrawiseUrl("setzone.php", apiKey, setZoneParams(input));
  const json = (await getJson(url, fetchImpl)) as { message?: string; message_type?: string };
  return json;
}

type Relay = {
  relay_id?: number;
  relay?: number;
  name?: string;
  time?: number;
  run?: number;
  period?: number;
  timestr?: string;
};

export function presentZones(
  schedule: Record<string, unknown>,
  now: Date,
): ZoneView[] {
  const relays = (Array.isArray(schedule.relays) ? schedule.relays : []) as Relay[];
  const base = Number(schedule.time || Math.floor(now.getTime() / 1000));
  return [...relays]
    .sort((a, b) => Number(a.relay || 0) - Number(b.relay || 0))
    .map((z) => {
      const t = Number(z.time || 0);
      const run = Number(z.run || 0);
      const running = t === 1 || String(z.timestr || "").toLowerCase() === "now";
      let stateLabel = "אין תזמון";
      let nextLabel = "—";
      if (running) {
        stateLabel = "משקה עכשיו";
        nextLabel = run ? `נותרו כ-${Math.round(run / 60)} דק׳` : "פועל";
      } else if (t > 1) {
        stateLabel = "ממתין";
        nextLabel = whenLabel(base + t, now);
      }
      const per = Number(z.period || 0);
      const periodLabel = per && per % 86400 === 0 ? `כל ${per / 86400} ימים` : per ? `${Math.round(per / 3600)} שע׳` : "—";
      const relayId = z.relay_id == null ? null : Number(z.relay_id);
      return {
        relayId: Number.isFinite(relayId) ? relayId : null,
        relay: Number(z.relay || 0),
        name: String(z.name || `אזור ${z.relay ?? ""}`),
        running,
        stateLabel,
        nextLabel,
        durationLabel: run ? `${Math.round(run / 60)} דק׳` : "—",
        periodLabel,
      };
    });
}

export function controllerNote(controller: Record<string, unknown>, schedule: Record<string, unknown>, now: Date): string {
  const bits: string[] = [];
  const status = controller.status ? String(controller.status) : "";
  if (status && status !== "Unknown") bits.push(`סטטוס: ${status}`);
  if (schedule.message) bits.push(String(schedule.message));
  const last = Number(controller.last_contact || 0);
  if (last) bits.push(`קשר אחרון ${agoLabel(last, now)}`);
  return bits.join(" · ");
}
