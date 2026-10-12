import { catalogItemFromDevice } from "./present";
import type { DeviceView, Snapshot } from "./types";

export type ItemPref = { hidden?: boolean; name?: string };

export type Prefs = {
  devices: Record<string, ItemPref>;
  channels: Record<string, ItemPref>;
};

export type PrefPatch = { hidden?: boolean; name?: string | null };

const PREFS_KEY = "prefs";
const MAX_ITEMS = 300;
const MAX_NAME = 40;

export function emptyPrefs(): Prefs {
  return { devices: {}, channels: {} };
}

export function channelKey(deviceId: string, code: string): string {
  return `${deviceId}::${code}`;
}

export async function loadPrefs(kv: KVNamespace): Promise<Prefs> {
  const raw = await kv.get(PREFS_KEY, "json");
  return normalizePrefs(raw);
}

export async function savePrefs(kv: KVNamespace, prefs: Prefs): Promise<void> {
  await kv.put(PREFS_KEY, JSON.stringify(normalizePrefs(prefs)));
}

export function normalizePrefs(raw: unknown): Prefs {
  const src = raw && typeof raw === "object" ? (raw as { devices?: unknown; channels?: unknown }) : {};
  return {
    devices: cleanMap(src.devices),
    channels: cleanMap(src.channels),
  };
}

function cleanMap(raw: unknown): Record<string, ItemPref> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ItemPref> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[\w.:-]{1,160}$/.test(key)) continue;
    const item = cleanItem(value);
    if (item) out[key] = item;
    if (Object.keys(out).length >= MAX_ITEMS) break;
  }
  return out;
}

function cleanItem(value: unknown): ItemPref | null {
  if (!value || typeof value !== "object") return null;
  const src = value as { hidden?: unknown; name?: unknown };
  const item: ItemPref = {};
  if (src.hidden === true) item.hidden = true;
  if (typeof src.name === "string") {
    const name = tidyName(src.name);
    if (name) item.name = name;
  }
  return item.hidden || item.name ? item : null;
}

export function tidyName(value: string): string | null {
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || /[\u0000-\u001f]/.test(name) || name.length > MAX_NAME) return null;
  return name;
}

export function readPrefPatch(body: Record<string, unknown>): { patch?: PrefPatch; error?: string } {
  const patch: PrefPatch = {};
  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") return { error: "ערך ההסתרה לא תקין" };
    patch.hidden = body.hidden;
  }
  if ("name" in body) {
    if (body.name === null) patch.name = null;
    else if (typeof body.name !== "string") return { error: "השם לא תקין" };
    else {
      const name = body.name.replace(/\s+/g, " ").trim();
      if (!name) patch.name = null;
      else if (name.length > MAX_NAME || /[\u0000-\u001f]/.test(name)) return { error: "השם ארוך מדי או לא תקין" };
      else patch.name = name;
    }
  }
  if (patch.hidden === undefined && patch.name === undefined) return { error: "אין מה לעדכן" };
  return { patch };
}

export function validDeviceId(id: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(id);
}

export function validChannelCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,48}$/.test(code);
}

export async function updateDevicePref(kv: KVNamespace, id: string, patch: PrefPatch): Promise<Prefs> {
  if (!validDeviceId(id)) throw Object.assign(new Error("מזהה מכשיר לא תקין"), { name: "RuleRejected" });
  const prefs = await loadPrefs(kv);
  prefs.devices = applyPatch(prefs.devices, id, patch);
  await savePrefs(kv, prefs);
  return prefs;
}

export async function updateChannelPref(kv: KVNamespace, deviceId: string, code: string, patch: PrefPatch): Promise<Prefs> {
  if (!validDeviceId(deviceId) || !validChannelCode(code)) {
    throw Object.assign(new Error("מזהה מתג לא תקין"), { name: "RuleRejected" });
  }
  const prefs = await loadPrefs(kv);
  prefs.channels = applyPatch(prefs.channels, channelKey(deviceId, code), patch);
  await savePrefs(kv, prefs);
  return prefs;
}

function applyPatch(map: Record<string, ItemPref>, key: string, patch: PrefPatch): Record<string, ItemPref> {
  const next = { ...map };
  const current: ItemPref = { ...next[key] };
  if (patch.hidden === true) current.hidden = true;
  if (patch.hidden === false) delete current.hidden;
  if (patch.name === null) delete current.name;
  else if (typeof patch.name === "string") current.name = patch.name;
  if (!current.hidden && !current.name) delete next[key];
  else next[key] = current;
  if (Object.keys(next).length > MAX_ITEMS) {
    throw Object.assign(new Error("יותר מדי שמות שמורים"), { name: "RuleRejected" });
  }
  return next;
}

export function applyPrefs(snapshot: Snapshot, prefs: Prefs): Snapshot {
  const next = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  const stored = normalizePrefs(prefs);
  for (const section of next.sections) {
    for (const device of section.devices) applyDevice(device, stored);
    section.devices.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "he"));
  }
  const zones = next.catalog.filter((item) => item.kind === "zone");
  const devices = next.sections.flatMap((section) => section.devices).map(catalogItemFromDevice);
  next.catalog = [...zones, ...devices];
  return next;
}

function applyDevice(device: DeviceView, prefs: Prefs): void {
  const devicePref = prefs.devices[device.id];
  if (devicePref?.name) device.name = devicePref.name;
  device.hidden = Boolean(devicePref?.hidden);
  for (const sw of [...device.switches, ...device.dimmers]) {
    const pref = prefs.channels[channelKey(device.id, sw.code)];
    if (pref?.name) sw.label = pref.name;
    sw.hidden = Boolean(pref?.hidden);
  }
}
