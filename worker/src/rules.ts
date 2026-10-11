import { jerusalemParts, pad2 } from "./time";
import type { CatalogItem, Snapshot } from "./types";

export type CompareOp = "lt" | "lte" | "gt" | "gte" | "eq";

export type Trigger =
  | { type: "manual" }
  | { type: "time"; time: string; days?: number[] }
  | {
      type: "sensor";
      deviceId?: string;
      deviceName?: string;
      metric: string;
      op: CompareOp;
      value: number;
    };

export type Condition =
  | { type: "sensor"; deviceId?: string; deviceName?: string; metric: string; op: CompareOp; value: number }
  | { type: "switch"; deviceId?: string; deviceName?: string; code?: string; on: boolean }
  | { type: "time_window"; start: string; end: string };

export type Action =
  | { type: "switch"; deviceId?: string; deviceName?: string; code?: string; detail?: string; on: boolean }
  | { type: "dimmer"; deviceId?: string; deviceName?: string; code?: string; detail?: string; on?: boolean; percent?: number }
  | { type: "curtain"; deviceId?: string; deviceName?: string; command: "open" | "close" | "stop"; position?: number }
  | { type: "ac"; deviceId?: string; deviceName?: string; power?: boolean; mode?: string; temp?: number; wind?: string }
  | { type: "zone"; zoneName?: string; relayId?: number; command: "run" | "stop" | "suspend"; minutes?: number; suspendHours?: number };

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  sourceText: string;
  summaryHe: string;
  cooldownMinutes: number;
  lastFiredAt?: string | null;
  lastFiredSlot?: string | null;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  createdAt: string;
  updatedAt: string;
  parsedBy?: "ai" | "local";
};

export type Draft = Omit<Rule, "id" | "createdAt" | "updatedAt" | "lastFiredAt" | "lastFiredSlot"> & {
  issues: string[];
  parsedBy: "ai" | "local";
  /** True when Workers AI was unavailable or returned an invalid rule. */
  usedFallback: boolean;
};

export type World = {
  now: Date;
  metrics: { deviceId: string; deviceName: string; metric: string; value: number }[];
  switches: { deviceId: string; deviceName: string; code: string; on: boolean }[];
  zones: { relayId: number; name: string; running: boolean }[];
};

const SLOT_WINDOW_MIN = 10;

const OP_HE: Record<CompareOp, string> = {
  lt: "מתחת ל-",
  lte: "לא יותר מ-",
  gt: "מעל ",
  gte: "לפחות ",
  eq: "בדיוק ",
};

const DAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export function compare(value: number, op: CompareOp, target: number): boolean {
  switch (op) {
    case "lt":
      return value < target;
    case "lte":
      return value <= target;
    case "gt":
      return value > target;
    case "gte":
      return value >= target;
    case "eq":
      return value === target;
    default:
      return false;
  }
}

export function shouldFire(rule: Pick<Rule, "enabled" | "trigger" | "conditions" | "cooldownMinutes" | "lastFiredAt" | "lastFiredSlot">, world: World): { fire: boolean; reason: string; slot?: string } {
  if (!rule.enabled) return { fire: false, reason: "disabled" };
  if (rule.trigger.type === "manual") return { fire: false, reason: "manual" };
  if (!conditionsPass(rule.conditions, world)) return { fire: false, reason: "conditions" };

  if (rule.trigger.type === "time") {
    const p = jerusalemParts(world.now);
    if (rule.trigger.days && rule.trigger.days.length && !rule.trigger.days.includes(p.weekday)) {
      return { fire: false, reason: "wrong-day" };
    }
    const [hh, mm] = rule.trigger.time.split(":").map(Number);
    const delta = p.hour * 60 + p.minute - (hh * 60 + mm);
    if (delta < 0 || delta >= SLOT_WINDOW_MIN) return { fire: false, reason: "outside-window" };
    const slot = `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(hh)}:${pad2(mm)}`;
    if (rule.lastFiredSlot === slot) return { fire: false, reason: "already-fired-slot" };
    return { fire: true, reason: "time", slot };
  }

  if (rule.trigger.type === "sensor") {
    const reading = findMetric(world, rule.trigger);
    if (!reading) return { fire: false, reason: "no-reading" };
    if (!compare(reading.value, rule.trigger.op, rule.trigger.value)) return { fire: false, reason: "threshold" };
    if (rule.lastFiredAt) {
      const elapsed = world.now.getTime() - new Date(rule.lastFiredAt).getTime();
      if (elapsed < rule.cooldownMinutes * 60_000) return { fire: false, reason: "cooldown" };
    }
    return { fire: true, reason: "sensor" };
  }
  return { fire: false, reason: "unknown" };
}

function conditionsPass(conditions: Condition[], world: World): boolean {
  return conditions.every((c) => {
    if (c.type === "sensor") {
      const reading = findMetric(world, c);
      return Boolean(reading && compare(reading.value, c.op, c.value));
    }
    if (c.type === "switch") {
      const sw = world.switches.find((s) => (c.deviceId ? s.deviceId === c.deviceId : s.deviceName === c.deviceName) && (!c.code || s.code === c.code));
      return Boolean(sw && sw.on === c.on);
    }
    if (c.type === "time_window") {
      const p = jerusalemParts(world.now);
      const cur = p.hour * 60 + p.minute;
      const [sh, sm] = c.start.split(":").map(Number);
      const [eh, em] = c.end.split(":").map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      if (end >= start) return cur >= start && cur < end;
      return cur >= start || cur < end;
    }
    return false;
  });
}

function findMetric(world: World, spec: { deviceId?: string; deviceName?: string; metric: string }) {
  const rows = world.metrics.filter((m) => m.metric === spec.metric);
  if (spec.deviceId) return rows.find((m) => m.deviceId === spec.deviceId);
  if (spec.deviceName) return rows.find((m) => namesLoose(m.deviceName, spec.deviceName!));
  return rows[0];
}

export function worldFromSnapshot(snap: Snapshot, now: Date): World {
  const metrics: World["metrics"] = [];
  const switches: World["switches"] = [];
  const zones: World["zones"] = [];
  for (const section of snap.sections) {
    for (const d of section.devices) {
      if (d.metrics?.moisture != null) metrics.push({ deviceId: d.id, deviceName: d.name, metric: "moisture", value: d.metrics.moisture });
      if (d.metrics?.temperature != null) metrics.push({ deviceId: d.id, deviceName: d.name, metric: "temperature", value: d.metrics.temperature });
      if (typeof d.metrics?.battery === "number") metrics.push({ deviceId: d.id, deviceName: d.name, metric: "battery", value: d.metrics.battery });
      for (const sw of d.switches) switches.push({ deviceId: d.id, deviceName: d.name, code: sw.code, on: sw.on });
      for (const sw of d.dimmers) switches.push({ deviceId: d.id, deviceName: d.name, code: sw.code, on: sw.on });
    }
    for (const z of section.zones) {
      if (z.relayId != null) zones.push({ relayId: z.relayId, name: z.name, running: z.running });
    }
  }
  return { now, metrics, switches, zones };
}

function namesLoose(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b) || normalizeName(a).includes(normalizeName(b));
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'״׳]/g, "")
    .replace(/[–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "the", "a", "an", "את", "של", "ה", "תריס", "תריסי", "תריסים", "וילון", "וילונות",
  "shutter", "shutters", "curtain", "curtains", "light", "lights", "תאורה", "אור", "אורות",
  "מתג", "מתגים", "switch", "zone", "אזור", "השקיה",
]);

function applyAliases(s: string): string {
  return normalizeName(s)
    .replace(/\bair conditioner\b/g, "מזגן")
    .replace(/\bliving room\b/g, "סלון")
    .replace(/\bdining room\b/g, "פינת אוכל")
    .replace(/\bkitchen\b/g, "מטבח")
    .replace(/\bguest\b/g, "אורחים")
    .replace(/\bpath\b/g, "שביל")
    .replace(/\bback lawn\b/g, "back lawn")
    .replace(/\bfront lawn\b/g, "front lawn")
    .replace(/\bback dripping\b/g, "back dripping")
    .replace(/\bfront dripping\b/g, "front dripping")
    .replace(/הדשא האחורי|דשא אחורי|מדשאה אחורית/g, "back lawn")
    .replace(/הדשא הקדמי|דשא קדמי|מדשאה קדמית/g, "front lawn")
    .replace(/\bac\b/g, "מזגן");
}

export function phraseTokens(phrase: string): string[] {
  return applyAliases(phrase)
    .split(" ")
    .map((w) => w.replace(/^ה/, ""))
    .filter((w) => w && !STOP.has(w));
}

function nameHasTokens(name: string, toks: string[]): boolean {
  if (!toks.length) return false;
  const n = applyAliases(name);
  return toks.every((t) => n.includes(t));
}

function clockOk(time: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function metricHe(metric: string): string {
  if (metric === "moisture") return "לחות הקרקע";
  if (metric === "temperature") return "הטמפרטורה";
  if (metric === "battery") return "הסוללה";
  return metric;
}

function unit(metric: string): string {
  if (metric === "moisture" || metric === "battery") return "%";
  if (metric === "temperature") return "°";
  return "";
}

function daysHe(days?: number[]): string {
  if (!days || days.length === 0 || days.length === 7) return "כל יום";
  const set = [...days].sort((a, b) => a - b);
  if (set.join() === "0,1,2,3,4") return "בימי חול";
  if (set.join() === "5,6") return "בסוף השבוע";
  return "ביום " + set.map((d) => DAY_HE[d] || String(d)).join(", ");
}

export function summarizeRule(rule: { name: string; trigger: Trigger; conditions: Condition[]; actions: Action[]; cooldownMinutes: number }): string {
  const bits: string[] = [];
  if (rule.trigger.type === "manual") {
    bits.push(`סצנה ידנית «${rule.name}». מופעלת רק בלחיצה.`);
  } else if (rule.trigger.type === "time") {
    bits.push(`${daysHe(rule.trigger.days)} בשעה ${rule.trigger.time} (שעון ישראל).`);
  } else {
    const who = rule.trigger.deviceName ? `ב«${rule.trigger.deviceName}»` : "בחיישן הלחות";
    bits.push(`כאשר ${metricHe(rule.trigger.metric)} ${who} ${OP_HE[rule.trigger.op]}${rule.trigger.value}${unit(rule.trigger.metric)}.`);
  }
  if (rule.conditions.length) bits.push(`בתנאי ש${rule.conditions.map(summarizeCondition).join(" וגם ")}.`);
  bits.push(`פעולות: ${rule.actions.map(summarizeAction).join("; ")}.`);
  if (rule.trigger.type === "sensor") {
    bits.push(`המתנה של ${rule.cooldownMinutes} דקות בין הפעלות, כדי שלא יופעל שוב כל עוד התנאי עדיין מתקיים.`);
  }
  return bits.join(" ");
}

function summarizeCondition(c: Condition): string {
  if (c.type === "sensor") return `${metricHe(c.metric)} ${OP_HE[c.op]}${c.value}${unit(c.metric)}`;
  if (c.type === "switch") return `${c.deviceName || "מתג"} ${c.on ? "דולק" : "כבוי"}`;
  return `השעה בין ${c.start} ל-${c.end}`;
}

function who(name?: string, detail?: string): string {
  const base = name || "מתג";
  if (!detail || detail === "הפעלה") return base;
  return `${base} (${detail})`;
}

function summarizeAction(a: Action): string {
  if (a.type === "switch") return `${a.on ? "הדלקה" : "כיבוי"} של ${who(a.deviceName, a.detail)}`;
  if (a.type === "dimmer") {
    const bits = [`${a.on === false ? "כיבוי" : "הדלקה"} של ${who(a.deviceName, a.detail)}`];
    if (a.percent != null) bits.push(`בהירות ${a.percent}%`);
    return bits.join(" ");
  }
  if (a.type === "curtain") {
    const verb = a.command === "open" ? "פתיחה" : a.command === "close" ? "סגירה" : "עצירה";
    const pos = a.position != null ? ` ל-${a.position}%` : "";
    return `${verb} ${a.deviceName || "תריס"}${pos}`;
  }
  if (a.type === "ac") {
    const name = a.deviceName || "מזגן";
    if (a.power === false) return `כיבוי ${name}`;
    const mode = a.mode != null ? ` מצב ${AC_MODE_HE[a.mode] || a.mode}` : "";
    const temp = a.temp != null ? ` ${a.temp}°` : "";
    return `הפעלת ${name}${mode}${temp}`;
  }
  if (a.type === "zone") {
    const name = a.zoneName || "אזור";
    if (a.command === "stop") return `עצירת ${name}`;
    if (a.command === "suspend") return `השהיית ${name} ל-${a.suspendHours ?? 24} שעות`;
    return `השקיית ${name} ל-${a.minutes ?? 10} דקות`;
  }
  return "פעולה";
}

const AC_MODE_HE: Record<string, string> = { "0": "קירור", "1": "חימום", "2": "אוטומטי", "3": "מאוורר", "4": "ייבוש" };

type RawAction = {
  type?: string;
  deviceId?: string;
  deviceName?: string;
  zoneName?: string;
  relayId?: number;
  code?: string;
  on?: boolean;
  command?: string;
  position?: number;
  percent?: number;
  power?: boolean;
  mode?: string | number;
  temp?: number;
  wind?: string | number;
  minutes?: number;
  suspendHours?: number;
};

export function normalizeDraft(raw: unknown, catalog: CatalogItem[], sourceText: string, parsedBy: "ai" | "local"): Draft {
  const issues: string[] = [];
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const trigger = normalizeTrigger(obj.trigger, catalog, issues);
  const conditions = Array.isArray(obj.conditions) ? obj.conditions.map((c) => normalizeCondition(c, catalog, issues)).filter((c): c is Condition => Boolean(c)) : [];
  const actionsIn = Array.isArray(obj.actions) ? obj.actions : [];
  const actions = actionsIn.map((a) => normalizeAction(a as RawAction, catalog, issues)).filter((a): a is Action => Boolean(a));
  if (!actions.length) issues.push("לא זוהו פעולות. נסחו מה להדליק, לסגור או להשקות.");
  const hasZoneRun = actions.some((a) => a.type === "zone" && a.command === "run");
  let cooldown = Number(obj.cooldownMinutes);
  if (!Number.isFinite(cooldown) || cooldown < 0) cooldown = 0;
  const min = trigger?.type === "sensor" ? (hasZoneRun ? 180 : 30) : trigger?.type === "time" ? 10 : 0;
  if (!cooldown) cooldown = min;
  cooldown = Math.max(min, Math.round(cooldown));

  const safeTrigger: Trigger = trigger ?? { type: "manual" };
  if (!trigger) issues.push("לא הצלחתי להבין מתי להפעיל. נסו שעה, תנאי חיישן, או «סצנה:».");

  let name = typeof obj.name === "string" ? obj.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!name) name = deriveName(sourceText, safeTrigger, actions);

  const draft: Draft = {
    name,
    enabled: obj.enabled === false ? false : true,
    sourceText,
    summaryHe: "",
    cooldownMinutes: cooldown,
    trigger: safeTrigger,
    conditions,
    actions,
    parsedBy,
    usedFallback: false,
    issues,
  };
  draft.issues = [...new Set(issues)];
  draft.summaryHe = summarizeRule(draft);
  return draft;
}

function deriveName(text: string, trigger: Trigger, actions: Action[]): string {
  if (trigger.type === "manual") {
    const scene = text.replace(/^(?:scene|סצנה)\s*[:：\-]\s*/i, "").trim();
    if (/movie|cinema|סרט/.test(scene)) return "ערב סרט";
    return scene.slice(0, 40) || "סצנה";
  }
  if (trigger.type === "time") return `שגרה ${trigger.time}`;
  const zone = actions.find((a) => a.type === "zone");
  if (zone && zone.type === "zone") return `השקיה · ${zone.zoneName || "אזור"}`;
  return "תרחיש חיישן";
}

function normalizeTrigger(raw: unknown, catalog: CatalogItem[], issues: string[]): Trigger | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.type === "manual") return { type: "manual" };
  if (t.type === "time") {
    const time = clockOk(String(t.time || "")) ? String(t.time) : "";
    if (!time) {
      issues.push("שעה לא תקינה. השתמשו בפורמט 19:00.");
      return null;
    }
    const days = Array.isArray(t.days) ? [...new Set(t.days.map(Number).filter((n) => n >= 0 && n <= 6))] : undefined;
    return { type: "time", time, days: days && days.length ? days : undefined };
  }
  if (t.type === "sensor") {
    const metric = String(t.metric || "moisture");
    const op = normalizeOp(t.op);
    const value = Number(t.value);
    if (!op || !Number.isFinite(value)) {
      issues.push("תנאי החיישן לא ברור.");
      return null;
    }
    const sensor = attachSensor(String(t.deviceName || ""), t.deviceId, metric, catalog, issues);
    return { type: "sensor", deviceId: sensor.deviceId, deviceName: sensor.deviceName, metric: sensor.metric, op, value };
  }
  return null;
}

function normalizeCondition(raw: unknown, catalog: CatalogItem[], issues: string[]): Condition | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (c.type === "sensor") {
    const metric = String(c.metric || "moisture");
    const op = normalizeOp(c.op);
    const value = Number(c.value);
    if (!op || !Number.isFinite(value)) return null;
    const sensor = attachSensor(String(c.deviceName || ""), c.deviceId, metric, catalog, issues);
    return { type: "sensor", deviceId: sensor.deviceId, deviceName: sensor.deviceName, metric: sensor.metric, op, value };
  }
  if (c.type === "time_window" && clockOk(String(c.start)) && clockOk(String(c.end))) {
    return { type: "time_window", start: String(c.start), end: String(c.end) };
  }
  if (c.type === "switch") {
    const bound = bindDevice(String(c.deviceName || ""), catalog, (d) => Boolean(d.switches?.length));
    if (!bound && c.deviceId == null) {
      issues.push("תנאי מתג לא משויך למכשיר.");
      return null;
    }
    return { type: "switch", deviceId: bound?.id || String(c.deviceId), deviceName: bound?.name, code: typeof c.code === "string" ? c.code : undefined, on: Boolean(c.on) };
  }
  return null;
}

function normalizeOp(op: unknown): CompareOp | null {
  const map: Record<string, CompareOp> = {
    lt: "lt", "<": "lt", below: "lt", under: "lt",
    lte: "lte", "<=": "lte",
    gt: "gt", ">": "gt", above: "gt", over: "gt",
    gte: "gte", ">=": "gte",
    eq: "eq", "=": "eq", "==": "eq",
  };
  return map[String(op || "").toLowerCase()] || null;
}

function normalizeAction(raw: RawAction, catalog: CatalogItem[], issues: string[]): Action | null {
  if (!raw || typeof raw !== "object" || !raw.type) return null;
  if (raw.type === "zone") {
    const zone = resolveZone(raw.zoneName || "", raw.relayId, catalog);
    if (!zone) {
      issues.push(`לא נמצא אזור השקיה «${raw.zoneName || raw.relayId || ""}».`);
      return null;
    }
    const command = raw.command === "stop" || raw.command === "suspend" ? raw.command : "run";
    const minutes = clamp(Number(raw.minutes ?? 10), 1, 180);
    const suspendHours = clamp(Number(raw.suspendHours ?? 24), 1, 720);
    return { type: "zone", zoneName: zone.name, relayId: zone.relayId, command, minutes, suspendHours };
  }
  if (raw.type === "curtain") {
    const device = resolveDevice(raw, catalog, (d) => Boolean(d.curtain));
    if (!device) {
      issues.push(`לא נמצא תריס «${raw.deviceName || ""}».`);
      return null;
    }
    const command = raw.command === "open" || raw.command === "stop" ? raw.command : "close";
    const position = raw.position == null ? undefined : clamp(Number(raw.position), 0, 100);
    return { type: "curtain", deviceId: device.id, deviceName: device.name, command, position };
  }
  if (raw.type === "ac") {
    const device = resolveDevice(raw, catalog, (d) => Boolean(d.ac));
    if (!device) {
      issues.push(`לא נמצא מזגן «${raw.deviceName || ""}».`);
      return null;
    }
    const mode = raw.mode == null ? undefined : String(raw.mode);
    const wind = raw.wind == null ? undefined : String(raw.wind);
    const temp = raw.temp == null ? undefined : clamp(Number(raw.temp), 16, 30);
    return { type: "ac", deviceId: device.id, deviceName: device.name, power: asBool(raw.power) ?? true, mode, temp, wind };
  }
  if (raw.type === "dimmer") {
    const device = resolveDevice(raw, catalog, (d) => Boolean(d.dimmer || d.switches?.length));
    if (!device) {
      issues.push(`לא נמצא דימר «${raw.deviceName || ""}».`);
      return null;
    }
    const code = raw.code || device.switches?.[0]?.code;
    const sw = device.switches?.find((s) => s.code === code);
    return {
      type: "dimmer",
      deviceId: device.id,
      deviceName: device.name,
      code,
      detail: sw?.label,
      on: asBool(raw.on) ?? true,
      percent: raw.percent == null ? undefined : clamp(Number(raw.percent), 1, 100),
    };
  }
  if (raw.type === "switch") {
    const device = resolveDevice(raw, catalog, (d) => Boolean(d.switches?.length));
    if (!device) {
      issues.push(`לא נמצא מתג «${raw.deviceName || ""}».`);
      return null;
    }
    const code = raw.code && device.switches?.some((s) => s.code === raw.code) ? raw.code : device.switches?.[0]?.code;
    const sw = device.switches?.find((s) => s.code === code);
    return { type: "switch", deviceId: device.id, deviceName: device.name, code, detail: sw?.label, on: asBool(raw.on) ?? false };
  }
  issues.push("סוג פעולה לא נתמך.");
  return null;
}

function asBool(v: unknown): boolean | undefined {
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function resolveZone(name: string, relayId: number | undefined, catalog: CatalogItem[]): CatalogItem | null {
  const zones = catalog.filter((c) => c.kind === "zone");
  if (relayId != null) {
    const byId = zones.find((z) => z.relayId === Number(relayId));
    if (byId) return byId;
  }
  const toks = phraseTokens(name);
  const hits = zones.filter((z) => nameHasTokens(z.name, toks) || namesLoose(z.name, name));
  return hits[0] || null;
}

function resolveDevice(raw: RawAction, catalog: CatalogItem[], pred: (d: CatalogItem) => boolean): CatalogItem | null {
  const devices = catalog.filter((c) => c.kind === "device" && pred(c));
  if (raw.deviceId) {
    const byId = devices.find((d) => d.id === raw.deviceId);
    if (byId) return byId;
  }
  const phrase = raw.deviceName || "";
  const toks = phraseTokens(phrase);
  const hits = devices.filter((d) => nameHasTokens(d.name, toks) || (phrase && namesLoose(d.name, phrase)));
  if (raw.code) {
    const gang = devices.find((d) => d.switches?.some((s) => s.code === raw.code) && (d.id === raw.deviceId || nameHasTokens(d.name, toks)));
    if (gang) return gang;
  }
  return hits[0] || null;
}

const SOIL_MISSING_HE = "אין עדיין חיישן לחות קרקע בחשבון. אי אפשר לשמור את התרחיש עד שהחיישן מחובר.";

function canonicalMetric(metric: string): string {
  const m = metric.toLowerCase().replace(/\s+/g, "_");
  if (["moisture", "humidity", "soil_humidity", "soilhumidity", "humidity_value"].includes(m)) return "moisture";
  if (["temperature", "temp", "temp_current"].includes(m)) return "temperature";
  if (["battery", "battery_percentage", "battery_state"].includes(m)) return "battery";
  return m;
}

function attachSensor(
  phrase: string,
  rawId: unknown,
  metric: string,
  catalog: CatalogItem[],
  issues: string[],
): { deviceId?: string; deviceName?: string; metric: string } {
  const canonical = canonicalMetric(metric);
  const matches = (d: CatalogItem) => d.kind === "device" && (d.metrics || []).includes(canonical);
  const bound = bindDevice(phrase, catalog, matches);
  const deviceId = typeof rawId === "string" && catalog.some((c) => c.id === rawId && matches(c)) ? rawId : bound?.id;
  if (canonical === "moisture" && !deviceId) {
    const count = catalog.filter(matches).length;
    issues.push(count === 0 ? SOIL_MISSING_HE : "לא הצלחתי לשייך את התנאי לחיישן לחות קרקע. ציינו את שם החיישן.");
  }
  const deviceName = bound?.name || (phrase.trim() ? phrase.trim() : undefined);
  return { deviceId, deviceName, metric: canonical };
}

function bindDevice(phrase: string, catalog: CatalogItem[], pred: (d: CatalogItem) => boolean): CatalogItem | null {
  if (!phrase) {
    const all = catalog.filter((c) => c.kind === "device" && pred(c));
    return all.length === 1 ? all[0] : null;
  }
  return resolveDevice({ deviceName: phrase }, catalog, pred);
}

const SENSOR_RES: { re: RegExp; metric: string }[] = [
  { re: /soil moisture(?:\s+is)?\s+(below|under|above|over|less than)\s+(\d+(?:\.\d+)?)\s*%?/i, metric: "moisture" },
  { re: /moisture(?:\s+is)?\s+(below|under|above|over)\s+(\d+(?:\.\d+)?)\s*%?/i, metric: "moisture" },
  { re: /כש(?:אשר)?\s*ה?לחות(?:\s+ה?(?:קרקע|אדמה))?(?:\s+היא)?\s+(מתחת|מעל|שווה)\s+ל?-?\s*(\d+(?:\.\d+)?)\s*%?/, metric: "moisture" },
  { re: /לחות(?:\s+ה?(?:קרקע|אדמה))?(?:\s+היא)?\s+(מתחת|מעל|שווה)\s+ל?-?\s*(\d+(?:\.\d+)?)\s*%?/, metric: "moisture" },
  { re: /temperature(?:\s+is)?\s+(below|under|above|over)\s+(\d+(?:\.\d+)?)/i, metric: "temperature" },
  { re: /טמפרטורה(?:\s+היא)?\s+(מתחת|מעל|שווה)\s+ל?-?\s*(\d+(?:\.\d+)?)/, metric: "temperature" },
];

function opFromWord(word: string): CompareOp {
  const w = word.toLowerCase();
  if (w === "above" || w === "over" || w === "מעל") return "gt";
  if (w === "שווה") return "eq";
  return "lt";
}

function parseSensorPhrase(text: string): { metric: string; op: CompareOp; value: number; start: number; end: number } | null {
  for (const { re, metric } of SENSOR_RES) {
    const m = re.exec(text);
    if (!m || m.index == null) continue;
    return { metric, op: opFromWord(m[1]), value: Number(m[2]), start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function parseDays(text: string): number[] | undefined {
  if (/בימי חול|weekdays|ימי חול/.test(text)) return [0, 1, 2, 3, 4];
  if (/סוף השבוע|סופ"ש|סופ״ש|weekend/.test(text)) return [5, 6];
  const found: number[] = [];
  const table: [RegExp, number][] = [
    [/יום ראשון|\bsunday\b/i, 0],
    [/יום שני|\bmonday\b/i, 1],
    [/יום שלישי|\btuesday\b/i, 2],
    [/יום רביעי|\bwednesday\b/i, 3],
    [/יום חמישי|\bthursday\b/i, 4],
    [/יום שישי|\bfriday\b/i, 5],
    [/יום שבת|בשבת|\bsaturday\b/i, 6],
  ];
  for (const [re, day] of table) if (re.test(text)) found.push(day);
  return found.length ? found : undefined;
}

function parseClock(text: string): string | null {
  const m = /(?:בשעה|at|ב-?)\s*(\d{1,2})[:.](\d{2})/i.exec(text);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${pad2(hh)}:${pad2(mm)}`;
}

export function splitClauses(text: string): string[] {
  const prepped = text
    .replace(/והדלק/g, " ו הדלק")
    .replace(/וכבה/g, " ו כבה")
    .replace(/וסגור/g, " ו סגור")
    .replace(/ופתח/g, " ו פתח")
    .replace(/ועצור/g, " ו עצור")
    .replace(/והשק/g, " ו השק")
    .replace(/והפעל/g, " ו הפעל");
  return prepped
    .split(/\s+and\s+|\s+ו\s+|,\s*|;\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripScheduleWords(text: string): string {
  return text
    .replace(/כש(?:אשר)?\s*ה?לחות(?:\s+ה?(?:קרקע|אדמה))?(?:\s+היא)?\s+(?:מתחת|מעל|שווה)\s+ל?-?\s*\d+(?:\.\d+)?\s*%?/g, " ")
    .replace(/לחות(?:\s+ה?(?:קרקע|אדמה))?(?:\s+היא)?\s+(?:מתחת|מעל|שווה)\s+ל?-?\s*\d+(?:\.\d+)?\s*%?/g, " ")
    .replace(/when\s+(?:the\s+)?soil moisture(?:\s+is)?\s+(?:below|under|above|over|less than)\s+\d+(?:\.\d+)?\s*%?/gi, " ")
    .replace(/when\s+(?:the\s+)?moisture(?:\s+is)?\s+(?:below|under|above|over)\s+\d+(?:\.\d+)?\s*%?/gi, " ")
    .replace(/if\s+(?:the\s+)?soil moisture(?:\s+is)?\s+(?:below|under|above|over)\s+\d+(?:\.\d+)?\s*%?/gi, " ")
    .replace(/כל יום|מדי יום|every day|each day|daily|בימי חול|בסוף השבוע/gi, " ")
    .replace(/(?:בשעה|at|ב-?)\s*\d{1,2}[:.]\d{2}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type VerbKind = "on" | "off" | "open" | "close" | "stop" | "water";

function parseClause(clause: string): { kind: VerbKind; phrase: string; minutes?: number } | null {
  const water = /^(?:water|irrigate|השק(?:ה|ות)?|הפעל\s+השקיה)\s+(?:את\s+)?(?:ה\s*)?(.+?)\s+(?:for|למשך|ל-?)\s*(\d+)\s*(?:minutes|minute|min|דקות|דק)/i.exec(clause);
  if (water) return { kind: "water", phrase: water[1], minutes: Number(water[2]) };
  const patterns: [RegExp, VerbKind][] = [
    [/^(?:turn\s+on|switch\s+on|הדלק|הפעל)\s+(?:את\s+)?(?:ה\s*)?(.+)$/i, "on"],
    [/^(?:turn\s+off|switch\s+off|כבה)\s+(?:את\s+)?(?:ה\s*)?(.+)$/i, "off"],
    [/^(?:close|סגור)\s+(?:את\s+)?(?:ה\s*)?(.+)$/i, "close"],
    [/^(?:open|פתח)\s+(?:את\s+)?(?:ה\s*)?(.+)$/i, "open"],
    [/^(?:stop|עצור)\s+(?:את\s+)?(?:ה\s*)?(.+)$/i, "stop"],
  ];
  for (const [re, kind] of patterns) {
    const m = re.exec(clause.trim());
    if (m) return { kind, phrase: m[1].replace(/[.。]+$/, "").trim() };
  }
  return null;
}

function matchDevices(phrase: string, catalog: CatalogItem[], pred: (d: CatalogItem) => boolean): CatalogItem[] {
  const toks = phraseTokens(phrase);
  return catalog.filter((d) => d.kind === "device" && pred(d) && nameHasTokens(d.name, toks));
}

function actionsFromText(text: string, catalog: CatalogItem[]): RawAction[] {
  const actions: RawAction[] = [];
  for (const clause of splitClauses(text)) {
    const parsed = parseClause(clause);
    if (!parsed) continue;
    if (parsed.kind === "water") {
      actions.push({ type: "zone", zoneName: parsed.phrase, command: "run", minutes: parsed.minutes });
      continue;
    }
    if (parsed.kind === "open" || parsed.kind === "close" || (parsed.kind === "stop" && /תריס|וילון|shutter|curtain/i.test(parsed.phrase))) {
      const hits = matchDevices(parsed.phrase, catalog, (d) => Boolean(d.curtain));
      for (const d of hits) {
        actions.push({
          type: "curtain",
          deviceId: d.id,
          deviceName: d.name,
          command: parsed.kind === "open" ? "open" : parsed.kind === "stop" ? "stop" : "close",
        });
      }
      if (!hits.length) actions.push({ type: "curtain", deviceName: parsed.phrase, command: parsed.kind === "open" ? "open" : "close" });
      continue;
    }
    const wantsAc = /מזגן|ac|air/i.test(applyAliases(parsed.phrase));
    if (wantsAc) {
      const acs = matchDevices(parsed.phrase, catalog, (d) => Boolean(d.ac));
      for (const d of acs) actions.push({ type: "ac", deviceId: d.id, deviceName: d.name, power: parsed.kind === "on" });
      if (!acs.length) actions.push({ type: "ac", deviceName: parsed.phrase, power: parsed.kind === "on" });
      continue;
    }
    const toks = phraseTokens(parsed.phrase);
    const gangHits: { device: CatalogItem; code: string; label: string }[] = [];
    for (const d of catalog) {
      if (d.kind !== "device" || !d.switches) continue;
      for (const sw of d.switches) {
        if (nameHasTokens(sw.label, toks)) gangHits.push({ device: d, code: sw.code, label: sw.label });
      }
    }
    if (gangHits.length) {
      for (const g of gangHits) {
        const type = g.device.dimmer ? "dimmer" : "switch";
        actions.push({ type, deviceId: g.device.id, deviceName: g.device.name, code: g.code, on: parsed.kind === "on" });
      }
      continue;
    }
    const devices = matchDevices(parsed.phrase, catalog, (d) => Boolean(d.switches?.length));
    if (!devices.length) {
      actions.push({ type: "switch", deviceName: parsed.phrase, on: parsed.kind === "on" });
      continue;
    }
    for (const d of devices) {
      if (d.dimmer) {
        for (const sw of d.switches || []) actions.push({ type: "dimmer", deviceId: d.id, deviceName: d.name, code: sw.code, on: parsed.kind === "on" });
      } else {
        for (const sw of d.switches || []) actions.push({ type: "switch", deviceId: d.id, deviceName: d.name, code: sw.code, on: parsed.kind === "on" });
      }
    }
  }
  return actions;
}

function movieActions(catalog: CatalogItem[]): RawAction[] {
  const actions: RawAction[] = [];
  for (const d of catalog) {
    if (d.kind !== "device" || !/סלון/.test(d.name)) continue;
    if (d.curtain) actions.push({ type: "curtain", deviceId: d.id, deviceName: d.name, command: "close" });
    if (d.section === "lights") {
      for (const sw of d.switches || []) {
        actions.push({ type: d.dimmer ? "dimmer" : "switch", deviceId: d.id, deviceName: d.name, code: sw.code, on: false });
      }
    }
  }
  return actions;
}

export function parseRuleDeterministic(text: string, catalog: CatalogItem[]): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const scene = /^(?:scene|סצנה)\s*[:：\-]\s*(.+)$/i.exec(trimmed);
  const sensor = parseSensorPhrase(trimmed);
  const time = parseClock(trimmed);
  const days = parseDays(trimmed);
  const actionText = stripScheduleWords(scene ? scene[1] : trimmed);
  let actions = actionsFromText(actionText, catalog);
  let trigger: Record<string, unknown> | null = null;
  const conditions: Record<string, unknown>[] = [];
  let name: string | undefined;

  if (scene) {
    trigger = { type: "manual" };
    name = /movie|cinema|סרט/.test(scene[1]) ? "ערב סרט" : scene[1].trim().slice(0, 60);
    if (!actions.length && /movie|cinema|סרט/.test(scene[1])) actions = movieActions(catalog);
  } else if (time && sensor) {
    trigger = { type: "time", time, days };
    conditions.push({ type: "sensor", metric: sensor.metric, op: sensor.op, value: sensor.value });
  } else if (time) {
    trigger = { type: "time", time, days };
  } else if (sensor) {
    trigger = { type: "sensor", metric: sensor.metric, op: sensor.op, value: sensor.value };
  } else if (actions.length) {
    trigger = { type: "manual" };
    name = trimmed.slice(0, 40);
  } else {
    return null;
  }

  return { name, trigger, conditions, actions, sourceText: trimmed };
}

export type AiCaller = (text: string, catalog: CatalogItem[]) => Promise<unknown>;

export async function interpretRule(text: string, catalog: CatalogItem[], ai?: AiCaller): Promise<Draft> {
  const source = text.trim();
  let aiDraft: Draft | null = null;
  if (ai) {
    try {
      const raw = await ai(source, catalog);
      aiDraft = normalizeDraft(raw, catalog, source, "ai");
      if (!aiDraft.issues.length) return aiDraft;
    } catch {
      aiDraft = null;
    }
  }
  const localRaw = parseRuleDeterministic(source, catalog);
  const localDraft = localRaw
    ? normalizeDraft(localRaw, catalog, source, "local")
    : normalizeDraft({ trigger: null, actions: [] }, catalog, source, "local");
  if (ai && (aiDraft == null || localDraft.issues.length <= aiDraft.issues.length)) {
    localDraft.usedFallback = true;
    return localDraft;
  }
  return aiDraft ?? localDraft;
}

export function assertSavable(draft: Draft): void {
  if (draft.issues.length) {
    const err = new Error(draft.issues.join(" "));
    err.name = "RuleRejected";
    throw err;
  }
}
