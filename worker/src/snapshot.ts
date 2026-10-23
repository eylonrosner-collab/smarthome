import { productionEphemeral, type Ephemeral } from "./ephemeral";
import { HYDRO_UNAVAILABLE, readHydrawise, zonesFromCache } from "./hydro-cache";
import { controllerNote } from "./hydrawise";
import { applyPrefs, loadPrefs } from "./prefs";
import { catalogItemFromDevice } from "./present";
import { jerusalemLabel } from "./time";
import type { TuyaClient } from "./tuya";
import { loadTuyaDevices, type TuyaScope } from "./tuya-cache";
import type { CatalogItem, DeviceView, Env, SectionId, SectionView, Snapshot, ZoneView } from "./types";

const SECTION_META: Record<SectionId, { icon: string; title: string }> = {
  garden: { icon: "🌱", title: "גינה והשקיה" },
  climate: { icon: "🌡️", title: "אקלים" },
  lights: { icon: "💡", title: "תאורה ומתגים" },
  curtains: { icon: "🪟", title: "תריסים" },
  power: { icon: "⚡", title: "חשמל ודוד" },
  other: { icon: "🧩", title: "אחר" },
};

const ORDER: SectionId[] = ["garden", "climate", "lights", "curtains", "power", "other"];
const CACHE_MS = 20_000;

let memory: { at: number; data: Snapshot } | null = null;

export type SnapshotOpts = {
  fresh?: boolean;
  now?: Date;
  client?: TuyaClient;
  store?: Ephemeral;
  /** Dashboard sweeps on a 30-minute floor. Cron asks only for sensor devices. */
  tuya?: TuyaScope;
};

export function invalidateSnapshot(): void {
  memory = null;
}

export function groupSnapshot(input: {
  devices: DeviceView[];
  zones: ZoneView[];
  controllerName: string;
  controllerNote: string;
  errors: string[];
  now: Date;
}): Snapshot {
  const buckets = new Map<SectionId, DeviceView[]>();
  for (const id of ORDER) buckets.set(id, []);
  for (const d of input.devices) buckets.get(d.section)?.push(d);
  const sections: SectionView[] = [];
  for (const id of ORDER) {
    const devices = (buckets.get(id) || []).slice().sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "he"));
    const zones = id === "garden" ? input.zones : [];
    if (!devices.length && !zones.length) continue;
    const meta = SECTION_META[id];
    sections.push({
      id,
      icon: meta.icon,
      title: meta.title,
      subtitle: id === "garden" ? `בקר ${input.controllerName}${input.controllerNote ? " · " + input.controllerNote : ""}` : id === "climate" ? "מזגנים ושלטי IR" : undefined,
      online: devices.filter((d) => d.online).length,
      total: devices.length,
      devices,
      zones,
    });
  }
  const online = input.devices.filter((d) => d.online).length;
  const catalog: CatalogItem[] = [
    ...input.zones.filter((z) => z.relayId != null).map((z) => ({
      kind: "zone" as const,
      id: `zone-${z.relayId}`,
      name: z.name,
      category: "zone",
      section: "zone" as const,
      relayId: z.relayId ?? undefined,
    })),
    ...input.devices.map(catalogItemFromDevice),
  ];
  return {
    updatedAt: input.now.toISOString(),
    updatedLabel: `${jerusalemLabel(input.now)} (שעון ישראל)`,
    stats: {
      devices: input.devices.length,
      online,
      offline: input.devices.length - online,
      zones: input.zones.length,
    },
    controller: { name: input.controllerName, note: input.controllerNote },
    sections,
    errors: input.errors,
    catalog,
  };
}

export async function buildSnapshot(env: Env, opts?: SnapshotOpts): Promise<Snapshot> {
  const raw = await loadRawSnapshot(env, opts);
  try {
    return applyPrefs(raw, await loadPrefs(env.RULES));
  } catch {
    return raw;
  }
}

async function loadRawSnapshot(env: Env, opts?: SnapshotOpts): Promise<Snapshot> {
  if (!opts?.fresh && memory && Date.now() - memory.at < CACHE_MS) return memory.data;
  const data = await buildFresh(env, opts?.now ?? new Date(), opts);
  memory = { at: Date.now(), data };
  return data;
}

async function buildFresh(env: Env, now: Date, opts?: SnapshotOpts): Promise<Snapshot> {
  const errors: string[] = [];
  const hydro = await readHydrawise(env.HYDRAWISE_API_KEY || "", now.getTime());
  const zones = zonesFromCache(hydro, now);
  const controllerName = String(hydro.controller.name || "Hydrawise");
  const note = controllerNote(hydro.controller, hydro.schedule || {}, now);
  if (!zones.length && hydro.error) errors.push(HYDRO_UNAVAILABLE);

  const tuya = await loadTuyaDevices(env, now, opts?.tuya ?? { mode: "dashboard" }, opts?.store ?? productionEphemeral, opts?.client);
  errors.push(...tuya.errors);
  return groupSnapshot({ devices: tuya.devices, zones, controllerName, controllerNote: note, errors, now });
}
